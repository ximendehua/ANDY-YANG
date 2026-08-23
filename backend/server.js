'use strict';
// 拍照成表 · 后端服务
// 职责：1) 托管前端 H5；2) /api/recognize 调腾讯云 OCR 并解析成表格；3) /api/save-wps 存金山文档。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { recognizeTable, recognizeHandwriting } = require('./tencent-ocr');
const { parseTableResult, parseHandwritingResult, mergeTableAndHandwriting, fillBlanksFromTable, fixLeadingDigitDrop, fixColumnDigitLength } = require('./parse');
const { saveToKdocs } = require('./wps');
const { preprocessForCloud } = require('./image-preprocess');
const demo = require('./demo-data');

// 每次发布时手动更新，便于前端确认后端版本
const VERSION = 'ac913c6-20260823-ocrfix-v4';

const ROOT = __dirname;
const FRONTEND = path.join(ROOT, '..', 'frontend');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

function loadConfig() {
  const cfg = {
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY,
    kdocsToken: process.env.KDOCS_TOKEN,
    kdocsApiBase: process.env.KDOCS_API_BASE,
  };
  const cfgPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
    } catch (e) {
      console.log('[warn] config.json 解析失败，已忽略');
    }
  }
  return cfg;
}
const cfg = loadConfig();
const hasCreds = !!(cfg.secretId && cfg.secretKey);
if (!hasCreds) {
  console.log('[warn] 未检测到腾讯云密钥(secretId/secretKey)，进入 DEMO 演示模式（返回示例数据，不调用真实 OCR）。');
}
if (!cfg.kdocsToken) {
  console.log('[warn] 未配置金山文档令牌(kdocsToken)，“保存到金山文档”将降级为返回 CSV 供本地用 WPS 打开。');
}

function sendJSON(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(FRONTEND, safe);
  if (!filePath.startsWith(FRONTEND)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function tableToCsv(table) {
  return table
    .map((r) =>
      r
        .map((c) => {
          const s = String(c == null ? '' : c).replace(/"/g, '""');
          return /[",\n]/.test(s) ? '"' + s + '"' : s;
        })
        .join(',')
    )
    .join('\n');
}

function averageConfidence(confMatrix) {
  if (!confMatrix || !confMatrix.length) return 0;
  const flat = confMatrix.flat().filter((c) => typeof c === 'number');
  if (!flat.length) return 0;
  return flat.reduce((a, b) => a + b, 0) / flat.length;
}

async function handleRecognize(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const image = body.image; // base64（不含 data: 前缀）
  const mode = body.mode || 'auto';
  if (!image) return sendJSON(res, 400, { ok: false, error: '缺少图片数据' });

  if (!hasCreds) {
    const dm = mode === 'handwriting' ? demo.handwriting : demo.table;
    return sendJSON(res, 200, {
      ok: true,
      demo: true,
      mode: mode === 'handwriting' ? 'handwriting' : 'table',
      table: dm.table,
      conf: dm.conf,
      note: 'DEMO 示例数据（未配置腾讯云密钥，请到 backend/config.json 填入 secretId/secretKey）',
    });
  }

  try {
    // 云端识别前先做图像预处理：转正、灰度、对比度拉伸、Otsu 二值化、中值去噪
    let processed = image;
    try {
      processed = await preprocessForCloud(image);
    } catch (preErr) {
      console.log('[warn] 图像预处理失败，使用原图:', preErr.message);
    }

    if (mode === 'handwriting') {
      const resp = await recognizeHandwriting(processed, cfg);
      const parsed = parseHandwritingResult(resp);
      return sendJSON(res, 200, { ok: true, demo: false, mode: 'handwriting', ...parsed });
    }

    if (mode === 'table') {
      const resp = await recognizeTable(processed, cfg);
      const parsed = parseTableResult(resp);
      return sendJSON(res, 200, { ok: true, demo: false, mode: 'table', ...parsed });
    }

    // mode === 'auto'：优先选手写体 OCR 聚类结果（修复后发现手写编号表结构更准确），
    // 再用表格 OCR 兜底填补漏检/空白格，最后做列级长度修正。
    let tableResp = null;
    let hwResp = null;
    try {
      tableResp = await recognizeTable(processed, cfg);
    } catch (e) {
      console.log('[info] 表格识别失败:', e.message);
    }
    try {
      hwResp = await recognizeHandwriting(processed, cfg);
    } catch (e) {
      console.log('[info] 手写体识别失败:', e.message);
    }

    // 优先：手写体 OCR 聚类 + 规范化
    if (hwResp) {
      const hwParsed = parseHandwritingResult(hwResp);
      if (hwParsed.table.length && hwParsed.table[0].length) {
        if (tableResp) {
          fillBlanksFromTable(hwParsed, tableResp);
          fixLeadingDigitDrop(hwParsed, tableResp);
        }
        fixColumnDigitLength(hwParsed);
        const { cellBoxes, ...out } = hwParsed;
        return sendJSON(res, 200, { ok: true, demo: false, mode: 'auto', ...out });
      }
    }

    if (tableResp && hwResp) {
      const merged = mergeTableAndHandwriting(tableResp, hwResp);
      if (merged && merged.table.length && merged.table[0].length) {
        return sendJSON(res, 200, { ok: true, demo: false, ...merged });
      }
    }

    // 任一失败时的回退
    if (tableResp) {
      const parsed = parseTableResult(tableResp);
      if (parsed.table.length && parsed.table[0].length) {
        return sendJSON(res, 200, { ok: true, demo: false, mode: 'table', ...parsed });
      }
    }
    if (hwResp) {
      const parsed = parseHandwritingResult(hwResp);
      return sendJSON(res, 200, { ok: true, demo: false, mode: 'handwriting', ...parsed });
    }

    throw new Error('表格识别与手写体识别均失败');
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message });
  }
}

async function handleSaveWps(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const table = body.table;
  const title = body.title || '拍照成表';
  if (!table || !Array.isArray(table)) return sendJSON(res, 400, { ok: false, error: '缺少表格数据' });

  if (!cfg.kdocsToken) {
    const csv = tableToCsv(table);
    return sendJSON(res, 200, {
      ok: false,
      reason: 'no_kdocs_token',
      csv: Buffer.from(csv, 'utf8').toString('base64'),
      note: '未配置金山文档令牌，已返回 CSV（前端会自动下载，可用 WPS 打开）。',
    });
  }
  try {
    const url = await saveToKdocs(table, title, cfg.kdocsToken, cfg.kdocsApiBase);
    return sendJSON(res, 200, { ok: true, url });
  } catch (e) {
    return sendJSON(res, 200, { ok: false, reason: 'kdocs_error', error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (req.method === 'GET' && urlPath === '/api/health') {
    return sendJSON(res, 200, { ok: true, backend: true, hasCreds, hasKdocs: !!cfg.kdocsToken, version: VERSION });
  }
  if (req.method === 'GET' && urlPath === '/api/version') {
    return sendJSON(res, 200, { ok: true, version: VERSION });
  }
  if (req.method === 'POST' && urlPath === '/api/recognize') return handleRecognize(req, res);
  if (req.method === 'POST' && urlPath === '/api/save-wps') return handleSaveWps(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end('method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`拍照成表服务已启动: http://${HOST}:${PORT}  (本机访问 http://localhost:${PORT})`);
});
