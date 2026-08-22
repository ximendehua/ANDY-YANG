'use strict';
// 把腾讯云 OCR 返回结果解析为二维表格矩阵（rows x cols），并附带逐格置信度用于标红复核。

// ---------- 表格场景：RecognizeTableOCR V2 ----------
// Cells 字段: ColTl/RowTl 左上角(0基), ColBr/RowBr 右下角(0基, 含跨度)，Text, Confidence
function parseTableResult(resp) {
  const detections = (resp && resp.TableDetections) || [];
  let cells = [];
  for (const t of detections) {
    if (t && Array.isArray(t.Cells)) cells = cells.concat(t.Cells);
  }
  if (!cells.length) return { table: [], conf: [], mode: 'table' };

  let maxRow = 0;
  let maxCol = 0;
  for (const c of cells) {
    maxRow = Math.max(maxRow, (c.RowBr || 0));
    maxCol = Math.max(maxCol, (c.ColBr || 0));
  }
  const rows = Math.max(maxRow, 1);
  const cols = Math.max(maxCol, 1);

  const table = Array.from({ length: rows }, () => Array(cols).fill(''));
  const conf = Array.from({ length: rows }, () => Array(cols).fill(null));

  for (const c of cells) {
    const r = Math.max(0, (c.RowTl || 0));
    const col = Math.max(0, (c.ColTl || 0));
    if (r < rows && col < cols) {
      // 取左上角单元格写入文本（合并单元格只标一处，下游导出天然兼容）
      table[r][col] = (c.Text || '').trim();
      conf[r][col] = typeof c.Confidence === 'number' ? c.Confidence : null;
    }
  }

  // 去除完全为空的尾行/尾列（轻度清洗）
  const out = { table: trimMatrix(table), conf: trimMatrix(conf), mode: 'table' };
  out.table = postProcessTable(out.table);
  return out;
}

// ---------- 自由手写场景：GeneralHandwritingOCR ----------
// 每行 TextDetection 当作一行；若 AdvanceInfo 含逐字 words(带 wordcoord) 则按水平空隙切分列。
function parseHandwritingResult(resp) {
  const dets = (resp && resp.TextDetections) || [];
  if (!dets.length) return { table: [], conf: [], mode: 'handwriting' };

  // 优先尝试用每行 TextDetection 的 Polygon 坐标按行/列聚类，
  // 对手写编号表（每行 1~4 个单元格）重建二维表效果更好。
  const clustered = clusterDetectionsIntoTable(dets);
  if (clustered.table.length && clustered.table.some((r) => r.some((c) => c !== ''))) {
    return clustered;
  }

  // 退化：逐行当作一个单元格
  const rows = [];
  for (const d of dets) {
    const words = extractWords(d);
    if (!words.length) continue;
    const cols = splitColumns(words);
    rows.push(cols);
  }
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const table = rows.map((r) => {
    const row = r.map((w) => w.text);
    while (row.length < maxCols) row.push('');
    return row;
  });
  const conf = rows.map((r) => {
    const row = r.map((w) => (typeof w.conf === 'number' ? w.conf : null));
    while (row.length < maxCols) row.push(null);
    return row;
  });
  const out = { table: postProcessTable(trimMatrix(table)), conf: trimMatrix(conf), mode: 'handwriting' };
  return out;
}

// 把 TextDetection 行按 y 坐标聚类成行、x 坐标聚类成列
function clusterDetectionsIntoTable(dets) {
  const items = dets.map((d) => {
    const poly = d.Polygon || [];
    const xs = poly.map((p) => p.X);
    const ys = poly.map((p) => p.Y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return {
      text: (d.DetectedText || '').trim(),
      conf: typeof d.Confidence === 'number' ? d.Confidence : null,
      x0, x1, y0, y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: y1 - y0,
    };
  }).filter((i) => i.text);

  if (!items.length) return { table: [], conf: [], mode: 'handwriting' };

  items.sort((a, b) => a.cy - b.cy);

  // 行聚类：如果两行在 y 方向上几乎不重叠且间隙较大，才拆成新行
  const rowGroups = [];
  let cur = [items[0]];
  let curBottom = items[0].y1;
  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    const minH = Math.min(curBottom - Math.min(...cur.map((c) => c.y0)), it.h);
    const gap = it.y0 - curBottom;
    if (gap > minH * 0.35 && it.y0 > curBottom) {
      rowGroups.push(cur);
      cur = [it];
      curBottom = it.y1;
    } else {
      cur.push(it);
      curBottom = Math.max(curBottom, it.y1);
    }
  }
  rowGroups.push(cur);

  // 列模板：用列数最多的上行（通常是表头）确定各列中心
  const rowsWithCols = rowGroups.map((rg) => rg.slice().sort((a, b) => a.cx - b.cx));
  const headerRow = rowsWithCols.reduce((best, rg) => (rg.length > best.length ? rg : best), rowsWithCols[0]);
  const colCenters = headerRow.map((it) => it.cx);
  const colCount = colCenters.length;

  items.forEach((it) => {
    let best = 0;
    let bestD = Infinity;
    colCenters.forEach((c, idx) => {
      const d = Math.abs(c - it.cx);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    it.col = best;
  });

  const table = [];
  const conf = [];
  for (const rg of rowGroups) {
    const cells = Array.from({ length: colCount }, () => ({ texts: [], confs: [] }));
    for (const it of rg) {
      cells[it.col].texts.push(it.text);
      cells[it.col].confs.push(it.conf);
    }
    table.push(cells.map((c) => c.texts.join(' ')));
    conf.push(cells.map((c) => (c.confs.length ? Math.round(c.confs.reduce((a, b) => a + b, 0) / c.confs.length) : null)));
  }

  return { table: postProcessTable(trimMatrix(table)), conf: trimMatrix(conf), mode: 'handwriting' };
}

// 一维聚类：把相近的值合并成一列/一行中心
function cluster1D(vals, gap) {
  if (!vals.length) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= gap) {
      groups[groups.length - 1].push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

// 从单个 TextDetection 抽取字词及其包围盒
function extractWords(d) {
  let info = null;
  try {
    info = typeof d.AdvanceInfo === 'string' ? JSON.parse(d.AdvanceInfo) : d.AdvanceInfo;
  } catch (e) {
    info = null;
  }
  const out = [];
  if (info && Array.isArray(info.words) && info.words.length) {
    for (const w of info.words) {
      const wc = w.wordcoord || w.WordCoordPoint || null;
      if (wc && typeof wc.x === 'number') {
        out.push({
          text: (w.char != null ? w.char : w.text || '').toString(),
          x: wc.x,
          y: wc.y,
          w: wc.w || 0,
          h: wc.h || 0,
          conf: w.conf != null ? w.conf : d.Confidence,
        });
      }
    }
  }
  if (out.length) return out;

  // 退化：整行作为一个词（单列）
  const poly = d.Polygon || [];
  const xs = poly.map((p) => p.X);
  const ys = poly.map((p) => p.Y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  out.push({ text: (d.DetectedText || '').trim(), x, y, w, h, conf: d.Confidence });
  return out;
}

// 按水平空隙把一行内的词聚成列
function splitColumns(words) {
  if (words.length === 1) return [{ ...words[0] }];
  const sorted = words.slice().sort((a, b) => a.x - b.x);
  const heights = sorted.map((w) => (w.h > 0 ? w.h : 20));
  const medianH = median(heights);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w));
  }
  const gapThreshold = Math.max(medianH * 0.8, 6); // 空隙超过字高 0.8 视为换列

  const cols = [];
  let cur = [sorted[0]];
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > gapThreshold) {
      cols.push(mergeWords(cur));
      cur = [sorted[i + 1]];
    } else {
      cur.push(sorted[i + 1]);
    }
  }
  cols.push(mergeWords(cur));
  return cols;
}

function mergeWords(arr) {
  const text = arr.map((w) => w.text).join('');
  const x = Math.min(...arr.map((w) => w.x));
  const y = Math.min(...arr.map((w) => w.y));
  const w = Math.max(...arr.map((w) => w.x + w.w)) - x;
  const h = Math.max(...arr.map((w) => w.y + w.h)) - y;
  const confs = arr.map((w) => (typeof w.conf === 'number' ? w.conf : null)).filter((c) => c != null);
  const conf = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
  return { text, x, y, w, h, conf };
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 去除全空尾行/全空尾列
function trimMatrix(m) {
  if (!m.length) return m;
  const cols = m[0].length;
  let lastRow = -1;
  for (let r = m.length - 1; r >= 0; r--) {
    if (m[r].some((v) => v !== '' && v != null)) {
      lastRow = r;
      break;
    }
  }
  if (lastRow < 0) return [m[0].map(() => '')];
  let lastCol = -1;
  for (let c = cols - 1; c >= 0; c--) {
    if (m.some((row) => row[c] !== '' && row[c] != null)) {
      lastCol = c;
      break;
    }
  }
  return m.slice(0, lastRow + 1).map((row) => row.slice(0, lastCol + 1));
}

// ---------- 后处理：针对手写编号/数字的通用校正 ----------
// 目标：把 OCR 常见的“混入字母/符号”纠正为规范数字，提升表格最终结果准确率。
function postProcessTable(table) {
  if (!table.length) return table;
  return table.map((row) => row.map((cell) => correctNumberCell(cell)));
}

// 规则：
// 1. 若单元格包含连续数字串（≥3 位），优先提取并返回；
// 2. 对数字中混入的 OCR 混淆字符做替换（O→0, l|I→1, Z→2, S→5, B→8, g/q→9），
//    但只在没有中文、且校正结果仍像编号时才生效；
// 3. 保留中文/英文单词等明显非数字内容，避免把乱码硬改成数字。
function correctNumberCell(text) {
  if (text == null) return '';
  const s = String(text).trim();
  if (!s) return '';

  // 规格型号列：如 264-、2025-A 等，保留原样
  if (/^\d+[-–—]\w*$/.test(s)) return s;

  // 已经是纯数字或纯数字-，直接返回
  if (/^\d+([-–—]\d+)?$/.test(s)) return s;

  const digitMatches = s.match(/\d+/g) || [];
  const longestDigits = digitMatches.reduce((a, b) => (b.length > a.length ? b : a), '');

  // 先做 OCR 混淆校正（只对类数字字符做）
  const normalized = s
    .replace(/[Oo]/g, '0')
    .replace(/[l|I!]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[S$]/g, '5')
    .replace(/[B]/g, '8')
    .replace(/[gq]/g, '9')
    .replace(/[^0-9]/g, '');

  // 校正后得到 3 位以上数字，且原串里没有中文、且多数字符是"数字或易混字符"，才返回；
  // 避免"Da || el II"这种明显英文乱码被硬转成 11111。
  const hasChinese = /[\u4e00-\u9fa5]/.test(s);
  const hasDigit = /\d/.test(s); // 原串里必须有真数字，避免"IE"被硬转
  const noSpace = s.replace(/\s/g, '');
  const confusableCount = (noSpace.match(/[0-9OoIl|!ZzS$Bgq]/g) || []).length;
  if (
    !hasChinese &&
    hasDigit &&
    normalized.length >= 3 &&
    confusableCount >= noSpace.length * 0.55
  ) {
    return normalized;
  }

  // 否则返回最长连续数字串（只要够长）
  if (longestDigits.length >= 3) return longestDigits;

  return s;
}

// ---------- 融合：表格 OCR 结构 + 手写体 OCR 内容 ----------
// 表格 OCR 擅长找格子、认印刷表头；手写体 OCR 擅长认手写数字。
// 用表格 OCR 的单元格 Polygon 做“容器”，把落在该容器内的手写文本填进去。
function mergeTableAndHandwriting(tableResp, hwResp) {
  const tableDetections = (tableResp && tableResp.TableDetections) || [];
  let cells = [];
  for (const t of tableDetections) {
    if (t && Array.isArray(t.Cells)) cells = cells.concat(t.Cells);
  }
  if (!cells.length) return null;

  const hwItems = ((hwResp && hwResp.TextDetections) || []).map((d) => {
    const poly = d.Polygon || [];
    const xs = poly.map((p) => p.X);
    const ys = poly.map((p) => p.Y);
    return {
      text: (d.DetectedText || '').trim(),
      conf: typeof d.Confidence === 'number' ? d.Confidence : null,
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }).filter((i) => i.text);

  // 每个单元格：保留原表格文本；若有手写文本中心落在该单元格内，用手写文本覆盖
  const merged = cells.map((c) => {
    const poly = c.Polygon || [];
    const inner = hwItems.filter((hw) => pointInPolygon(hw.cx, hw.cy, poly));
    const hwText = inner.map((i) => i.text).join(' ');
    const hwConf = inner.length
      ? Math.round(inner.reduce((s, i) => s + (i.conf || 0), 0) / inner.length)
      : null;
    // 选择策略：
    // - 首行（表头）优先用表格 OCR，它认印刷体更准确；
    // - 其他行若手写体 OCR 识别到内容，优先用手写体（手写数字更准）。
    const isHeader = (c.RowTl || 0) === 0;
    const tableConf = typeof c.Confidence === 'number' ? c.Confidence : 0;
    const useHw = !isHeader && hwText && hwText.trim().length > 0;
    return {
      rowTl: c.RowTl || 0,
      rowBr: c.RowBr || 0,
      colTl: c.ColTl || 0,
      colBr: c.ColBr || 0,
      text: useHw ? hwText : (c.Text || ''),
      conf: useHw ? hwConf : tableConf,
      source: useHw ? 'hw' : 'table',
    };
  });

  let maxRow = 0;
  let maxCol = 0;
  for (const m of merged) {
    maxRow = Math.max(maxRow, m.rowBr);
    maxCol = Math.max(maxCol, m.colBr);
  }
  const rows = Math.max(maxRow, 1);
  const cols = Math.max(maxCol, 1);

  const table = Array.from({ length: rows }, () => Array(cols).fill(''));
  const conf = Array.from({ length: rows }, () => Array(cols).fill(null));

  for (const m of merged) {
    const r = Math.max(0, m.rowTl);
    const c = Math.max(0, m.colTl);
    if (r < rows && c < cols) {
      table[r][c] = m.text;
      conf[r][c] = m.conf;
    }
  }

  return { table: postProcessTable(trimMatrix(table)), conf: trimMatrix(conf), mode: 'hybrid' };
}

// 射线法判断点是否在多边形内
function pointInPolygon(x, y, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].X, yi = poly[i].Y;
    const xj = poly[j].X, yj = poly[j].Y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

module.exports = { parseTableResult, parseHandwritingResult, mergeTableAndHandwriting };
