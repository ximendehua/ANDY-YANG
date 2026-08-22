'use strict';
// 云端识别前的图像预处理：自动旋转、对比度拉伸、去噪、二值化。
// 使用 Jimp 纯 JS 实现，方便部署到 Render 等容器。

const Jimp = require('jimp');

async function preprocessForCloud(base64Image) {
  let image = await Jimp.read(Buffer.from(base64Image, 'base64'));

  // 1. 根据 EXIF Orientation 自动转正
  image = image.autocrop({ leaveBorder: 2 });

  // 2. 限制最大边，既控制大小又保证文字分辨率
  const maxDim = 2000;
  if (image.getWidth() > maxDim || image.getHeight() > maxDim) {
    image.scaleToFit(maxDim, maxDim);
  }

  // 3. 灰度化
  image.grayscale();

  // 4. 自动对比度拉伸（histogram stretch）
  stretchContrast(image);

  // 5. 自适应二值化（Otsu 近似）
  otsuBinarize(image);

  // 6. 轻微中值去噪（3x3）
  medianFilter(image, 1);

  const buf = await image.getBufferAsync(Jimp.MIME_JPEG);
  return buf.toString('base64');
}

// 对比度拉伸：把当前 min~max 映射到 0~255
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
    const nv = Math.round(((v - min) / range) * 255);
    this.bitmap.data[idx] = nv;
    this.bitmap.data[idx + 1] = nv;
    this.bitmap.data[idx + 2] = nv;
  });
}

// Otsu 二值化
function otsuBinarize(image) {
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const total = w * h;
  const hist = new Array(256).fill(0);
  image.scan(0, 0, w, h, function (x, y, idx) {
    hist[this.bitmap.data[idx]]++;
  });

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, wF = 0;
  let maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }

  image.scan(0, 0, w, h, function (x, y, idx) {
    const v = this.bitmap.data[idx];
    const nv = v < threshold ? 0 : 255;
    this.bitmap.data[idx] = nv;
    this.bitmap.data[idx + 1] = nv;
    this.bitmap.data[idx + 2] = nv;
  });
}

// 3x3 中值滤波，radius=1
function medianFilter(image, radius) {
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const src = Buffer.from(image.bitmap.data);
  const setPixel = (x, y, v) => {
    const idx = (y * w + x) << 2;
    image.bitmap.data[idx] = v;
    image.bitmap.data[idx + 1] = v;
    image.bitmap.data[idx + 2] = v;
  };
  const getPixel = (x, y) => {
    const idx = (y * w + x) << 2;
    return src[idx];
  };

  for (let y = radius; y < h - radius; y++) {
    for (let x = radius; x < w - radius; x++) {
      const vals = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          vals.push(getPixel(x + dx, y + dy));
        }
      }
      vals.sort((a, b) => a - b);
      setPixel(x, y, vals[Math.floor(vals.length / 2)]);
    }
  }
}

module.exports = { preprocessForCloud };
