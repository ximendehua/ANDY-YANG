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
    return normalizeHandwritingTable(clustered);
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
// 修复：旧版用 y0 > curBottom 判断，导致上下紧挨的行被全部合并成一行。
// 新版基于 cy 中心点的一维聚类，对手写编号表更稳定。
function clusterDetectionsIntoTable(dets) {
  let items = dets.map((d) => {
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
      w: x1 - x0,
    };
  }).filter((i) => i.text);

  if (!items.length) return { table: [], conf: [], mode: 'handwriting' };

  // 预处理：腾讯云手写体 OCR 偶尔会把左右/上下相邻的两个单元格数字合并成一串超长数字。
  // 例如 "18679"(规格型号列) 和 "19178"(外圈号列) 被合并为 "1867919178"。
  // 对明显超宽（>1.6倍中位宽）且纯数字长度≥8的检测框，按字符数中点拆成两个候选。
  items = splitMergedNumberDetections(items);

  // 按垂直中心排序
  items.sort((a, b) => a.cy - b.cy);

  // 行聚类：基于相邻 cy 间距的"突变"分行。
  // 表格内同一行文字的 cy 差通常只有 0~5px，而不同行之间至少 15px 以上。
  // 用 medianGap*2.5 并设置下限 15px，可稳定把各行分开，又不把同一行轻微错位的字拆开。
  const rowGaps = [];
  for (let i = 1; i < items.length; i++) rowGaps.push(items[i].cy - items[i - 1].cy);
  const medianRowGap = median(rowGaps) || 5;
  const rowGap = Math.max(medianRowGap * 2.5, 15);

  const rowGroups = [[items[0]]];
  let lastCy = items[0].cy;
  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    if (it.cy - lastCy > rowGap) {
      rowGroups.push([it]);
    } else {
      rowGroups[rowGroups.length - 1].push(it);
    }
    lastCy = it.cy;
  }

  // 列聚类：用全局 x 中心一维聚类，避免被某一行列数误导。
  // 阈值根据所有相邻中心点间隙的中位数自适应，列间大间隙会被分开。
  const xs = items.map((i) => i.cx).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  const medianGap = median(gaps) || 20;
  const colGap = Math.max(medianGap * 1.3, 16);
  const colCenters = cluster1D(items.map((i) => i.cx), colGap);
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
  const cellBoxes = [];
  for (const rg of rowGroups) {
    const cells = Array.from({ length: colCount }, () => ({ texts: [], confs: [], boxes: [] }));
    for (const it of rg) {
      cells[it.col].texts.push(it.text);
      cells[it.col].confs.push(it.conf);
      cells[it.col].boxes.push(it);
    }
    table.push(cells.map((c) => c.texts.join('')));
    conf.push(cells.map((c) => (c.confs.length ? Math.round(c.confs.reduce((a, b) => a + b, 0) / c.confs.length) : null)));
    cellBoxes.push(cells.map((c) => {
      if (!c.boxes.length) return null;
      const x0 = Math.min(...c.boxes.map((b) => b.x0));
      const x1 = Math.max(...c.boxes.map((b) => b.x1));
      const y0 = Math.min(...c.boxes.map((b) => b.y0));
      const y1 = Math.max(...c.boxes.map((b) => b.y1));
      return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    }));
  }

  return { table: postProcessTable(trimMatrix(table)), conf: trimMatrix(conf), cellBoxes: trimMatrix(cellBoxes), mode: 'handwriting' };
}

// 常见表头关键词，用于定位表头行和判断手写体 OCR 结构是否可靠
const HEADER_KEYWORDS = ['规格型号', '外圈号', '内圈号', '备注', '型号', '数量', '日期', '序号', '名称', '单位', '单价', '金额'];

// 手写体 OCR 聚类后常夹杂表格外文字（如左上角编号、标题），且会产生多余空列。
// 本函数：定位表头行 → 删除表头前游离行 → 只保留表头非空列。
function normalizeHandwritingTable(parsed) {
  let { table, conf, mode, cellBoxes } = parsed;
  if (!table.length) return parsed;

  // 1. 找表头行
  let headerIdx = -1;
  let headerScore = 0;
  for (let r = 0; r < table.length; r++) {
    let score = 0;
    for (const cell of table[r]) {
      if (!cell) continue;
      for (const kw of HEADER_KEYWORDS) {
        if (cell.includes(kw)) score++;
      }
    }
    if (score > headerScore) {
      headerScore = score;
      headerIdx = r;
    }
  }

  // 2. 删除表头之前的行
  const startRow = headerIdx > 0 ? headerIdx : 0;

  // 3. 确定保留哪些列：以表头行的非空列为锚点
  const keepCols = [];
  if (headerIdx >= 0) {
    const headerRow = table[headerIdx];
    for (let c = 0; c < headerRow.length; c++) {
      if (headerRow[c] && headerRow[c].trim()) keepCols.push(c);
    }
  }
  // 兜底：删除全空列
  if (!keepCols.length) {
    for (let c = 0; c < table[0].length; c++) {
      if (table.slice(startRow).some((row) => row[c] && row[c].trim())) keepCols.push(c);
    }
  }

  // 4. 重建表格
  const newTable = [];
  const newConf = [];
  const newCellBoxes = [];
  for (let r = startRow; r < table.length; r++) {
    newTable.push(keepCols.map((c) => table[r][c] || ''));
    newConf.push(keepCols.map((c) => (conf[r] ? conf[r][c] : null)));
    newCellBoxes.push(keepCols.map((c) => (cellBoxes && cellBoxes[r] ? cellBoxes[r][c] : null)));
  }

  return { table: postProcessTable(trimMatrix(newTable)), conf: trimMatrix(newConf), cellBoxes: trimMatrix(newCellBoxes), mode };
}

// 拆分被手写体 OCR 错误合并的相邻单元格数字。
// 场景 A（左右合并）：两个同行单元格被框在一起，如 "18679"+"19178" → "1867919178"。
//   特征：纯数字、长度≥8、宽度明显超过同列中位宽（>1.6 倍）。
// 场景 B（上下合并）：两个同列相邻行被框在一起，如 "18663"+"18779" → "1866318779"。
//   特征：纯数字、长度≥8、宽度正常但高度/长度异常。
// 拆分时按字符数中点切开，并分别赋予合理的中心坐标，便于后续行/列聚类。
function splitMergedNumberDetections(items) {
  const widths = items.map((i) => i.w).filter((w) => w > 0);
  const medianW = median(widths) || 70;
  const heights = items.map((i) => i.h).filter((h) => h > 0);
  const medianH = median(heights) || 35;

  // 临时列中心，用于判断左右/上下合并
  const colCenters = cluster1D(items.map((i) => i.cx), medianW * 0.8);
  const colGroups = colCenters.map(() => []);
  for (const it of items) {
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
    colGroups[best].push(it);
  }

  const out = [];
  for (const it of items) {
    const text = it.text || '';
    if (!/^\d{8,}$/.test(text)) {
      out.push(it);
      continue;
    }

    const sameColItems = colGroups[it.col] || [];
    const sameColWidths = sameColItems.map((i) => i.w).filter((w) => w > 0);
    const colMedianW = median(sameColWidths) || medianW;

    // 场景 A：超宽 → 左右拆分
    if (it.w > colMedianW * 1.6) {
      const mid = Math.floor(text.length / 2);
      const left = { ...it, text: text.slice(0, mid), x1: it.cx, cx: (it.x0 + it.cx) / 2 };
      const right = { ...it, text: text.slice(mid), x0: it.cx, cx: (it.cx + it.x1) / 2 };
      left.w = left.cx - left.x0;
      right.w = right.x1 - right.cx;
      out.push(left, right);
      continue;
    }

    // 场景 B：高度异常 或 数字长度≥9（表格里极少有真 9 位以上编号）→ 上下拆分
    if (it.h > medianH * 1.3 || text.length >= 9) {
      const mid = Math.floor(text.length / 2);
      const top = { ...it, text: text.slice(0, mid), y1: it.cy, cy: (it.y0 + it.cy) / 2 };
      const bottom = { ...it, text: text.slice(mid), y0: it.cy, cy: (it.cy + it.y1) / 2 };
      top.h = top.cy - top.y0;
      bottom.h = bottom.y1 - bottom.cy;
      out.push(top, bottom);
      continue;
    }

    out.push(it);
  }
  return out;
}

// 判断手写体 OCR 聚类结果是否看起来可靠（能识别到表头关键词）
function handwritingLooksReliable(parsed) {
  const table = parsed.table || [];
  if (table.length < 2) return false;
  for (const row of table) {
    for (const cell of row) {
      if (!cell) continue;
      for (const kw of HEADER_KEYWORDS) {
        if (cell.includes(kw)) return true;
      }
    }
  }
  return false;
}

// 当手写体 OCR 漏检某个单元格时，用表格 OCR 的单元格内容按坐标兜底填补。
// 改进：不依赖手写体该格是否有 cellBox，而是按手写体已有行列的中心线对齐，
// 把表格 OCR 的单元格直接映射到对应 (r,c)，从而能补回完全漏检的格子。
function fillBlanksFromTable(hwParsed, tableResp) {
  if (!hwParsed || !hwParsed.table.length) return;
  const detections = (tableResp && tableResp.TableDetections) || [];
  let cells = [];
  for (const t of detections) {
    if (t && Array.isArray(t.Cells)) cells = cells.concat(t.Cells);
  }
  if (!cells.length) return;

  const table = hwParsed.table;
  const conf = hwParsed.conf;
  const boxes = hwParsed.cellBoxes || [];

  // 1. 计算手写体表格每行的 y 中心（基于非空 cellBox）
  const rowCount = table.length;
  const colCount = table[0] ? table[0].length : 0;
  const rowCenters = [];
  for (let r = 0; r < rowCount; r++) {
    const ys = [];
    if (boxes[r]) {
      for (let c = 0; c < colCount; c++) {
        const b = boxes[r][c];
        if (b && typeof b.cy === 'number') ys.push(b.cy);
      }
    }
    if (!ys.length) {
      // 该行所有 cellBox 为空，用上一行 + 平均行高估算
      const prev = rowCenters[rowCenters.length - 1];
      const avgGap = computeAvgRowGap(boxes);
      rowCenters.push(prev != null ? prev + avgGap : null);
    } else {
      rowCenters.push(ys.reduce((a, b) => a + b, 0) / ys.length);
    }
  }

  // 2. 计算每列的 x 中心（基于非空 cellBox）
  const colCenters = [];
  for (let c = 0; c < colCount; c++) {
    const xs = [];
    for (let r = 0; r < rowCount; r++) {
      const b = boxes[r] ? boxes[r][c] : null;
      if (b && typeof b.cx === 'number') xs.push(b.cx);
    }
    if (!xs.length) {
      const prev = colCenters[colCenters.length - 1];
      const avgGap = computeAvgColGap(boxes);
      colCenters.push(prev != null ? prev + avgGap : null);
    } else {
      colCenters.push(xs.reduce((a, b) => a + b, 0) / xs.length);
    }
  }

  // 3. 计算行列间距用于阈值
  const rowGap = computeAvgRowGap(boxes) || 20;
  const colGap = computeAvgColGap(boxes) || 30;

  // 4. 把表格 OCR 的每个非空单元格映射到手写体表格的 (r,c)
  for (const c of cells) {
    const text = (c.Text || '').trim();
    if (!text) continue;
    const poly = c.Polygon || [];
    if (!poly.length) continue;
    const cx = poly.reduce((s, p) => s + (p.X || 0), 0) / poly.length;
    const cy = poly.reduce((s, p) => s + (p.Y || 0), 0) / poly.length;

    let bestR = -1, bestRD = Infinity;
    for (let r = 0; r < rowCount; r++) {
      if (rowCenters[r] == null) continue;
      const d = Math.abs(rowCenters[r] - cy);
      if (d < bestRD) { bestRD = d; bestR = r; }
    }

    let bestC = -1, bestCD = Infinity;
    for (let col = 0; col < colCount; col++) {
      if (colCenters[col] == null) continue;
      const d = Math.abs(colCenters[col] - cx);
      if (d < bestCD) { bestCD = d; bestC = col; }
    }

    // 表头行不补；距离超过 2 倍行列间距视为跨行/列误匹配
    if (bestR === 0 || bestR < 0 || bestC < 0) continue;
    if (bestRD > rowGap * 2 || bestCD > colGap * 2) continue;

    if (!table[bestR][bestC] || !table[bestR][bestC].trim()) {
      table[bestR][bestC] = text;
      conf[bestR][bestC] = typeof c.Confidence === 'number' ? c.Confidence : 70;
    }
  }
}

function computeAvgRowGap(boxes) {
  if (!boxes || !boxes.length) return 0;
  const centers = [];
  for (const row of boxes) {
    const ys = (row || []).filter((b) => b && typeof b.cy === 'number').map((b) => b.cy);
    if (ys.length) centers.push(ys.reduce((a, b) => a + b, 0) / ys.length);
  }
  if (centers.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 0;
}

function computeAvgColGap(boxes) {
  if (!boxes || !boxes.length) return 0;
  const colCount = boxes[0] ? boxes[0].length : 0;
  if (!colCount) return 0;
  const centers = [];
  for (let c = 0; c < colCount; c++) {
    const xs = [];
    for (const row of boxes) {
      const b = row ? row[c] : null;
      if (b && typeof b.cx === 'number') xs.push(b.cx);
    }
    if (xs.length) centers.push(xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  if (centers.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 0;
}

// 手写体 OCR 偶尔会漏检首位数字（如把 "19195" 识别成 "9195"）。
// 若表格 OCR 对应单元格是 "1xxxx" 且手写体结果是其后 4 位，则补回前导 1。
function fixLeadingDigitDrop(hwParsed, tableResp) {
  if (!hwParsed || !hwParsed.table.length || !hwParsed.cellBoxes) return;
  const detections = (tableResp && tableResp.TableDetections) || [];
  let cells = [];
  for (const t of detections) {
    if (t && Array.isArray(t.Cells)) cells = cells.concat(t.Cells);
  }
  if (!cells.length) return;

  const table = hwParsed.table;
  const conf = hwParsed.conf;
  const boxes = hwParsed.cellBoxes;

  for (let r = 0; r < table.length; r++) {
    for (let c = 0; c < table[r].length; c++) {
      const text = table[r][c];
      if (!text || !/^\d{3,4}$/.test(text)) continue;
      const b = boxes[r] ? boxes[r][c] : null;
      if (!b) continue;

      let bestCell = null;
      let bestD = Infinity;
      for (const cell of cells) {
        const poly = cell.Polygon || [];
        if (!poly.length) continue;
        const cx = poly.reduce((s, p) => s + (p.X || 0), 0) / poly.length;
        const cy = poly.reduce((s, p) => s + (p.Y || 0), 0) / poly.length;
        const d = Math.hypot(b.cx - cx, b.cy - cy);
        if (d < bestD) {
          bestD = d;
          bestCell = cell;
        }
      }

      if (bestCell && bestD < 120) {
        const cellText = (bestCell.Text || '').trim();
        const m = cellText.match(/^1(\d{3,4})$/);
        if (m && m[1] === text) {
          table[r][c] = cellText;
          conf[r][c] = typeof bestCell.Confidence === 'number' ? bestCell.Confidence : 80;
        }
      }
    }
  }
}

// 列级长度修正：若某列大多数单元格都是 n 位数字，而个别单元格是 n-1 位且以 6/8/9 开头，
// 则极有可能是首位 1 被漏检，补回前导 1。这对手写编号表常见。
function fixColumnDigitLength(hwParsed) {
  if (!hwParsed || !hwParsed.table.length) return;
  const table = hwParsed.table;
  const conf = hwParsed.conf;
  const cols = table[0].length;
  for (let c = 0; c < cols; c++) {
    const lengths = [];
    for (let r = 1; r < table.length; r++) {
      const text = table[r][c];
      if (text && /^\d+$/.test(text)) lengths.push(text.length);
    }
    if (!lengths.length) continue;
    lengths.sort((a, b) => a - b);
    const medianLen = lengths[Math.floor(lengths.length / 2)];
    if (medianLen <= 3) continue;
    for (let r = 1; r < table.length; r++) {
      const text = table[r][c];
      if (text && /^\d+$/.test(text) && text.length === medianLen - 1 && /^[689]/.test(text)) {
        table[r][c] = '1' + text;
        if (typeof conf[r][c] === 'number') conf[r][c] = Math.min(conf[r][c], 80);
      }
    }
  }
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

module.exports = { parseTableResult, parseHandwritingResult, mergeTableAndHandwriting, handwritingLooksReliable, fillBlanksFromTable, fixLeadingDigitDrop, fixColumnDigitLength };
