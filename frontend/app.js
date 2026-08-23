'use strict';
// 前端逻辑：拍照 -> 压缩 -> 调后端识别 -> 可编辑表格 -> 导出/保存到 WPS。

const $ = (id) => document.getElementById(id);
let currentMode = 'auto';
let currentEngine = 'cloud'; // 'cloud' 云端高精度（推荐）/ 'local' 本地体验
let tableData = []; // 二维数组（当前激活图）
let confData = []; // 二维置信度（可为空）
let backendAvailable = true; // 是否为本地 Node 服务（非纯静态托管）
let images = [];        // 多图：{id,name,dataUrl,table,conf,status,mode,demo,local,err}
let activeId = null;    // 当前查看/编辑的图片 id
let imgSeq = 0;

// ---------- 选择/拍照 ----------
$('captureBox').addEventListener('click', () => $('fileInput').click());
$('shootBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = {
        id: ++imgSeq,
        name: file.name || ('图片' + imgSeq),
        dataUrl: reader.result,
        table: [],
        conf: [],
        status: 'pending', // pending | processing | done | error
      };
      images.push(img);
      renderImgList();
      setActive(img.id);
      $('recognizeBtn').disabled = false;
    };
    reader.readAsDataURL(file);
  });
  e.target.value = ''; // 允许再次选择同一文件
});

// ---------- 图片列表（多图） ----------
function renderImgList() {
  const box = $('imgList');
  box.classList.remove('hidden');
  box.innerHTML = '';
  const stateMap = { pending: '待识别', processing: '识别中', done: '已识别', error: '失败' };
  images.forEach((img) => {
    const el = document.createElement('div');
    el.className = 'img-item' + (img.id === activeId ? ' active' : '');
    const showRetry = img.status === 'done' || img.status === 'error';
    el.innerHTML =
      '<div class="img-thumb"><img src="' + img.dataUrl + '" alt=""/>' +
      (showRetry ? '<div class="img-retry" title="重新识别" data-rid="' + img.id + '">↻</div>' : '') +
      '</div>' +
      '<div class="img-meta"><div class="img-name">' + escapeHtml(img.name) + '</div>' +
      '<div class="img-state ' + img.status + '">' + (stateMap[img.status] || img.status) + '</div></div>';
    el.addEventListener('click', () => setActive(img.id));
    const retry = el.querySelector('.img-retry');
    if (retry) {
      retry.addEventListener('click', (ev) => {
        ev.stopPropagation();
        recognizeOne(img);
      });
    }
    box.appendChild(el);
  });
}

// 切换当前查看/编辑的图片（tableData/confData 直接引用该图的数组，编辑即同步）
function setActive(id) {
  activeId = id;
  const img = images.find((i) => i.id === id);
  if (!img) return;
  tableData = img.table;
  confData = img.conf;
  renderImgList();
  if (img.status === 'done' && img.table.length) {
    $('resultCard').classList.remove('hidden');
    renderTable();
    const modeLabels = { auto: '自动', handwriting: '自由手写', table: '格子表格', hybrid: '融合识别' };
    $('modeTag').textContent = modeLabels[img.mode] || '格子表格';
    $('demoTag').classList.toggle('hidden', !img.demo);
  } else {
    $('resultCard').classList.add('hidden');
  }
}

// ---------- 模式切换 ----------
$('modeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  currentMode = btn.dataset.mode;
  [...$('modeSeg').children].forEach((b) => b.classList.toggle('active', b === btn));
});

// ---------- 引擎切换 ----------
$('engineSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.engine === 'cloud' && !backendAvailable) {
    setStatus('当前为纯静态模式，没有后端服务，云端高精度不可用。请选择「本地免费」。', 'err');
    return;
  }
  currentEngine = btn.dataset.engine;
  [...$('engineSeg').children].forEach((b) => b.classList.toggle('active', b === btn));
  updateEngineHint();
});

function updateEngineHint() {
  if (!backendAvailable) {
    $('engineHint').innerHTML = '当前为纯静态公网版，没有后端，「云端高精度」不可用。请在本地启动 Node 后端并填入腾讯云密钥；或看 README「专业方案」部署到 Render。';
    return;
  }
  if (currentEngine === 'local') {
    $('engineHint').textContent = '本地体验：无需密钥、零费用，但对手写编号/连笔识别弱（实测易乱码），仅供预览流程。要 96% 准确率请用「云端高精度」。';
  } else {
    $('engineHint').textContent = '云端高精度：自动融合腾讯云「表格识别」（拿结构/表头）+「手写体识别」（拿手写数字），印刷格子表+工整书写下准确率 96–99%。';
  }
}

// ---------- 探测是否有后端（静态托管 vs 本地 Node） ----------
async function pingBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) throw new Error('no backend');
    const data = await resp.json();
    backendAvailable = !!(data.ok && data.backend);
    if (data.version) {
      const v = $('version');
      if (v) v.textContent = 'v:' + data.version.slice(0, 12);
    }
  } catch (e) {
    backendAvailable = false;
  }
  if (!backendAvailable) {
    currentEngine = 'local';
    [...$('engineSeg').children].forEach((b) => b.classList.toggle('active', b.dataset.engine === 'local'));
    $('saveKdocs').classList.add('hidden');
    const banner = document.createElement('div');
    banner.className = 'static-banner';
    banner.innerHTML = '当前为纯静态公网版：仅「本地体验」可用，手写编号识别差。要 96% 准确率，请按 README「专业方案」部署后端并填入腾讯云密钥。';
    document.querySelector('.container').prepend(banner);
  } else {
    currentEngine = 'cloud';
    [...$('engineSeg').children].forEach((b) => b.classList.toggle('active', b.dataset.engine === 'cloud'));
  }
  updateEngineHint();
}
pingBackend();

// ---------- 图片预处理：压缩 + 灰度 + 对比度增强 + 自适应二值化 ----------
// 目的：让手写数字/字迹在本地 Tesseract 中尽可能清晰。
function preprocessImage(dataUrl, maxDim = 1600, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, width, height);

      // 1) 灰度 + 对比度增强（保留灰度信息，比直接二值化更利于 Tesseract）
      enhanceHandwriting(ctx, width, height);

      // 2) 输出 JPEG base64（去掉 data:image 前缀）
      resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

// 手写体增强：灰度化 -> 自动对比度拉伸 -> 轻微锐化
function enhanceHandwriting(ctx, width, height) {
  const imgData = ctx.getImageData(0, 0, width, height);
  const d = imgData.data;
  const len = width * height;
  const gray = new Uint8Array(len);

  // 转灰度
  let min = 255, max = 0;
  for (let i = 0, j = 0; i < len; i++, j += 4) {
    const g = Math.round(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]);
    gray[i] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  // 自动对比度拉伸（把 min-max 映射到 0-255），让淡字变黑、白底更白
  const range = max - min || 1;
  for (let i = 0; i < len; i++) {
    gray[i] = Math.round(((gray[i] - min) / range) * 255);
  }

  // 轻微反锐化掩膜（Unsharp Mask）提升字迹边缘
  const sharpened = unsharpMask(gray, width, height, 0.5);

  // 回写 RGBA
  for (let i = 0, j = 0; i < len; i++, j += 4) {
    const v = sharpened[i];
    d[j] = d[j + 1] = d[j + 2] = v;
    d[j + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

// 简单高斯模糊 + 反锐化
function unsharpMask(src, w, h, amount) {
  const blurred = boxBlur(src, w, h, 1);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(src[i] + amount * (src[i] - blurred[i]));
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

function boxBlur(src, w, h, radius) {
  const out = new Uint8Array(w * h);
  // 两次一维均值滤波近似高斯
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let k = -radius; k <= radius; k++) {
        const px = x + k;
        if (px >= 0 && px < w) { sum += src[y * w + px]; cnt++; }
      }
      tmp[y * w + x] = Math.round(sum / cnt);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0, cnt = 0;
      for (let k = -radius; k <= radius; k++) {
        const py = y + k;
        if (py >= 0 && py < h) { sum += tmp[py * w + x]; cnt++; }
      }
      out[y * w + x] = Math.round(sum / cnt);
    }
  }
  return out;
}

// ---------- 单张识别 ----------
async function recognizeOne(img) {
  img.status = 'processing';
  renderImgList();
  setActive(img.id);
  setStatus('正在识别「' + img.name + '」…', '');
  try {
    const b64 = await preprocessImage(img.dataUrl);
    let data;
    if (currentEngine === 'local') data = await localRecognize(b64);
    else data = await cloudRecognize(b64);
    img.table = data.table || [];
    img.conf = data.conf || [];
    img.mode = data.mode;
    img.demo = data.demo;
    img.local = data.local;
    img.status = 'done';
    setStatus('「' + img.name + '」识别完成', 'ok');
    return true;
  } catch (err) {
    img.status = 'error';
    img.err = err.message;
    setStatus('「' + img.name + '」识别失败：' + err.message, 'err');
    return false;
  } finally {
    renderImgList();
    setActive(img.id);
  }
}

// ---------- 识别 ----------
$('recognizeBtn').addEventListener('click', async () => {
  let targets = images.filter((i) => i.status === 'pending' || i.status === 'error');
  if (!targets.length) {
    if (images.every((i) => i.status === 'done')) {
      const go = window.confirm('所有图片已识别完成，是否要全部重新识别？');
      if (!go) {
        setStatus('所有图片已识别完成。点击缩略图右上角 ↻ 可单张重新识别。', 'ok');
        return;
      }
      targets = [...images];
    } else {
      setStatus('没有待识别的图片。', '');
      return;
    }
  }
  $('recognizeBtn').disabled = true;
  let ok = 0;
  for (const img of targets) {
    if (await recognizeOne(img)) ok++;
  }
  $('recognizeBtn').disabled = false;
  const doneImgs = images.filter((i) => i.status === 'done');
  if (doneImgs.length) setActive(doneImgs[0].id);
  if (ok === targets.length) {
    setStatus('识别完成：共 ' + ok + ' 张。点击上方缩略图可切换查看/编辑，再分别导出或保存。', 'ok');
  } else {
    setStatus('识别完成：' + ok + ' / ' + targets.length + ' 张成功，' + (targets.length - ok) + ' 张失败（可再次点【开始识别】重试）。', 'err');
  }
});

// ---------- 云端高精度识别（走后端，需自备密钥） ----------
async function cloudRecognize(b64) {
  const resp = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64, mode: currentMode }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || '识别失败');
  return data;
}

// ---------- 本地免费识别（浏览器内 Tesseract.js，零密钥零费用） ----------
let _tessWorker = null;
async function localRecognize(b64) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('本地引擎未加载（需联网首次下载模型）。可改用「云端高精度」，或检查网络/CDN 访问。');
  }
  const dataUrl = 'data:image/jpeg;base64,' + b64;
  setStatus('正在加载本地识别引擎（首次需下载中文模型，约数 MB）…', '');
  if (!_tessWorker) {
    _tessWorker = await Tesseract.createWorker('chi_sim', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') setStatus('本地识别中… ' + Math.round(m.progress * 100) + '%', '');
      },
    });
  }
  setStatus('本地识别中…', '');
  const { data } = await _tessWorker.recognize(dataUrl, {}, { blocks: true });
  const words = [];
  (data.blocks || []).forEach((b) =>
    (b.paragraphs || []).forEach((p) =>
      (p.lines || []).forEach((l) =>
        (l.words || []).forEach((w) => {
          if (w.text && w.text.trim() && w.bbox) {
            words.push({ text: w.text.trim(), bbox: w.bbox, conf: w.confidence || 0 });
          }
        })
      )
    )
  );
  if (!words.length) {
    // 降级：只有纯文本时按换行拆成单列
    const lines = (data.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) throw new Error('未识别出文字，请确认图片清晰、手写工整。');
    return {
      table: lines.map((l) => [l]),
      conf: lines.map(() => [null]),
      demo: false, local: true,
      mode: currentMode === 'handwriting' ? 'handwriting' : 'table',
    };
  }
  const { table, conf } = clusterWords(words);
  return { table, conf, demo: false, local: true, mode: currentMode === 'handwriting' ? 'handwriting' : 'table' };
}

// 中位数工具
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 一维分簇：把一组数值按相邻间距 <= gap 归并，返回各簇中心
function cluster1D(vals, gap) {
  const sorted = [...vals].sort((a, b) => a - b);
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= gap) groups[groups.length - 1].push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

// 把 OCR 词（含 bbox）聚成二维表格
function clusterWords(words) {
  const items = words.map((w) => ({
    text: w.text,
    conf: w.conf,
    x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
    cy: (w.bbox.y0 + w.bbox.y1) / 2,
    h: w.bbox.y1 - w.bbox.y0,
  }));
  const medianH = median(items.map((i) => i.h)) || 12;
  const rowGap = medianH * 0.6;
  items.sort((a, b) => a.cy - b.cy);

  // 行聚类
  const rows = [];
  let cur = [items[0]];
  let curBottom = items[0].y1;
  for (let i = 1; i < items.length; i++) {
    if (items[i].cy - curBottom > rowGap && items[i].y0 > curBottom) {
      rows.push(cur);
      cur = [items[i]];
      curBottom = items[i].y1;
    } else {
      cur.push(items[i]);
      curBottom = Math.max(curBottom, items[i].y1);
    }
  }
  rows.push(cur);

  // 全局列聚类：按所有词的 x 中心分簇，保证各行列对齐
  const medianW = median(items.map((i) => i.x1 - i.x0)) || 12;
  const xGap = medianW * 0.6;
  const colCenters = cluster1D(items.map((i) => (i.x0 + i.x1) / 2), xGap);
  const colCount = colCenters.length;
  items.forEach((i) => {
    const xc = (i.x0 + i.x1) / 2;
    let best = 0;
    let bestD = Infinity;
    colCenters.forEach((c, idx) => {
      const d = Math.abs(c - xc);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    i.col = best;
  });

  // 逐行填表
  const table = [];
  const conf = [];
  rows.forEach((row) => {
    const cells = Array.from({ length: colCount }, () => ({ texts: [], confs: [] }));
    row.forEach((w) => {
      cells[w.col].texts.push(w.text);
      cells[w.col].confs.push(w.conf || 0);
    });
    table.push(cells.map((c) => c.texts.join(' ')));
    conf.push(
      cells.map((c) =>
        c.texts.length ? Math.round(c.confs.reduce((s, v) => s + v, 0) / c.texts.length) : null
      )
    );
  });
  return { table, conf };
}

// ---------- 渲染可编辑表格 ----------
function renderTable() {
  const t = $('resultTable');
  t.innerHTML = '';
  tableData.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((val, c) => {
      const td = document.createElement('td');
      const conf = confData[r] && confData[r][c];
      if (conf != null && conf < 90) td.className = 'low';
      const input = document.createElement('input');
      input.value = val;
      input.addEventListener('input', () => {
        tableData[r][c] = input.value;
      });
      td.appendChild(input);
      tr.appendChild(td);
    });
    t.appendChild(tr);
  });
}

// ---------- 行列增删 ----------
function addRow() {
  const cols = tableData[0] ? tableData[0].length : 1;
  tableData.push(Array(cols).fill(''));
  confData.push(Array(cols).fill(null));
  renderTable();
}
function addCol() {
  tableData.forEach((row) => row.push(''));
  confData.forEach((row) => row.push(null));
  renderTable();
}
function delRow() {
  if (tableData.length > 1) {
    tableData.pop();
    confData.pop();
    renderTable();
  }
}
function delCol() {
  if (tableData[0] && tableData[0].length > 1) {
    tableData.forEach((row) => row.pop());
    confData.forEach((row) => row.pop());
    renderTable();
  }
}
$('addRow').addEventListener('click', addRow);
$('addCol').addEventListener('click', addCol);
$('delRow').addEventListener('click', delRow);
$('delCol').addEventListener('click', delCol);

// ---------- 导出 ----------
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toCsv() {
  return tableData
    .map((r) => r.map((c) => {
      const s = String(c == null ? '' : c).replace(/"/g, '""');
      return /[",\n]/.test(s) ? '"' + s + '"' : s;
    }).join(','))
    .join('\n');
}
function toXls() {
  const rows = tableData.map((r) => '<tr>' + r.map((c) => `<td>${escapeHtml(c == null ? '' : c)}</td>`).join('') + '</tr>').join('');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body><table border="1">${rows}</table></body></html>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}
function activeName() {
  const img = images.find((i) => i.id === activeId);
  return '拍照成表_' + (img ? img.name.replace(/\.[^.]+$/, '') : '未命名');
}
$('expCsv').addEventListener('click', () => download(activeName() + '.csv', '﻿' + toCsv(), 'text/csv;charset=utf-8'));
$('expXls').addEventListener('click', () => download(activeName() + '.xls', toXls(), 'application/vnd.ms-excel'));

// ---------- 保存到金山文档 ----------
$('saveKdocs').addEventListener('click', async () => {
  setStatus('正在保存到金山文档…', '');
  try {
    const resp = await fetch('/api/save-wps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: tableData, title: activeName() + '-' + new Date().toLocaleString('zh-CN') }),
    });
    const data = await resp.json();
    if (data.ok && data.url) {
      setStatus('已保存到金山文档：', 'ok');
      const a = document.createElement('a');
      a.href = data.url;
      a.target = '_blank';
      a.textContent = data.url;
      $('status').appendChild(a);
    } else if (data.reason === 'no_kdocs_token' && data.csv) {
      download('拍照成表.csv', '﻿' + atob(data.csv), 'text/csv;charset=utf-8');
      setStatus('未配置金山文档令牌，已改为下载 CSV（可用 WPS 打开）。', 'ok');
    } else {
      throw new Error(data.error || data.note || '保存失败');
    }
  } catch (e) {
    setStatus('保存失败：' + e.message, 'err');
  }
});

function setStatus(msg, cls) {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status ' + (cls || '');
}
