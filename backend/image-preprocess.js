'use strict';
// 云端识别前的图像预处理：仅做安全兜底，避免破坏原图。
// 腾讯云 OCR（表格/手写体）对灰度/彩色照片识别效果最佳，
// 过度二值化/中值滤波反而会让手写笔画断裂、产生噪声。

const Jimp = require('jimp');

async function preprocessForCloud(base64Image) {
  let image = await Jimp.read(Buffer.from(base64Image, 'base64'));

  // 1. 裁掉纯黑/纯白外边框，保留 2px 边距
  image = image.autocrop({ leaveBorder: 2 });

  // 2. 限制最大边，既控制接口体大小又保证文字分辨率
  const maxDim = 2400;
  if (image.getWidth() > maxDim || image.getHeight() > maxDim) {
    image.scaleToFit(maxDim, maxDim);
  }

  // 3. 转为灰度（腾讯云对灰度图同样稳定，且能减少彩色干扰）
  image.grayscale();

  // 4. 自动对比度拉伸（histogram stretch），让淡字变黑、白底更白
  stretchContrast(image);

  // 5. 轻微锐化，提升手写笔画边缘
  unsharpMask(image, 0.3);

  // 注意：不要再做 Otsu 二值化或中值滤波，会损失灰度细节并引入 JPEG 伪影。
  const buf = await image.quality(95).getBufferAsync(Jimp.MIME_JPEG);
  return buf.toString('base64');
}

// 对比度拉伸：把当前 min~max 映射到 5~250，避免纯黑/纯白溢出
function stretchContrast(image) {
  let min = 255, max = 0;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
    const v = this.bitmap.data[idx];
    if (v < min) min = v;
    if (v > max) max = v;
  });
  const range = max - min || 1;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
    const v = this.bitmap.data[idx];
    const nv = Math.round(((v - min) / range) * 245) + 5;
    this.bitmap.data[idx] = nv;
    this.bitmap.data[idx + 1] = nv;
    this.bitmap.data[idx + 2] = nv;
  });
}

// 轻微反锐化掩膜：原图 + amount * (原图 - 模糊图)
function unsharpMask(image, amount) {
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const src = Buffer.from(image.bitmap.data);

  // 一维盒式模糊（两次）近似高斯模糊
  const tmp = Buffer.alloc(w * h);
  const blurred = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let k = -1; k <= 1; k++) {
        const px = x + k;
        if (px >= 0 && px < w) { sum += src[(y * w + px) << 2]; cnt++; }
      }
      tmp[y * w + x] = Math.round(sum / cnt);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0, cnt = 0;
      for (let k = -1; k <= 1; k++) {
        const py = y + k;
        if (py >= 0 && py < h) { sum += tmp[py * w + x]; cnt++; }
      }
      blurred[y * w + x] = Math.round(sum / cnt);
    }
  }

  for (let i = 0; i < w * h; i++) {
    const v = src[i << 2];
    const nv = Math.round(v + amount * (v - blurred[i]));
    const val = nv < 0 ? 0 : nv > 255 ? 255 : nv;
    image.bitmap.data[i << 2] = val;
    image.bitmap.data[(i << 2) + 1] = val;
    image.bitmap.data[(i << 2) + 2] = val;
  }
}

module.exports = { preprocessForCloud };
