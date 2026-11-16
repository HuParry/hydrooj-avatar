'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { resolveCrop } = require('./crop');

sharp.concurrency(1);
sharp.cache(false);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 50 * 1000 * 1000;
const MAX_OUTPUT = 100 * 1024;
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 16384 || height > 16384 || width * height > MAX_PIXELS) {
    throw new Error('图片尺寸过大，最多支持 5000 万像素且单边不超过 16384 像素。');
  }
}

async function convert() {
  const ext = path.extname(workerData.filename || '').toLowerCase();
  if (!EXTENSIONS.has(ext)) throw new Error('仅支持 JPG、PNG、WebP、HEIC 和 HEIF 图片。');
  const stat = await fs.stat(workerData.filepath);
  if (!stat.size || stat.size > MAX_BYTES) throw new Error('图片不能为空，且大小不能超过 8 MiB。');
  const input = await fs.readFile(workerData.filepath);
  let image;
  let width;
  let height;
  if (ext === '.heic' || ext === '.heif') {
    const decode = require('heic-decode');
    const images = await decode.all({ buffer: input });
    try {
      const main = images[0];
      if (!main) throw new Error('无法读取 HEIC 主图。');
      checkDimensions(main.width, main.height);
      const decoded = await main.decode();
      width = decoded.width;
      height = decoded.height;
      const { data } = decoded;
      image = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
        raw: { width, height, channels: 4 },
        limitInputPixels: MAX_PIXELS,
      });
    } finally {
      images.dispose();
    }
  } else {
    image = sharp(input, { limitInputPixels: MAX_PIXELS, animated: false, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw new Error('文件内容不是支持的图片格式。');
    }
    checkDimensions(metadata.width, metadata.height);
    width = metadata.orientation >= 5 ? metadata.height : metadata.width;
    height = metadata.orientation >= 5 ? metadata.width : metadata.height;
    image = image.autoOrient();
  }

  if (workerData.preview) {
    const data = await image.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer();
    return { data, width, height };
  }
  const region = resolveCrop(workerData.crop, width, height);
  image = image.extract(region);
  const side = Math.min(256, region.width);
  image = image.resize({
    width: side, height: side, fit: 'inside', withoutEnlargement: true,
  });
  for (const quality of [80, 65, 50, 35]) {
    const output = await image.clone().webp({ quality, effort: 4 }).toBuffer();
    if (output.length <= MAX_OUTPUT) return output;
  }
  throw new Error('图片压缩后仍超过 100 KiB，请更换图片。');
}

convert().then(
  (data) => parentPort.postMessage(workerData.preview ? data : { data }),
  (error) => {
    const friendly = /^(图片|仅支持|文件内容|无法读取)/.test(error.message);
    parentPort.postMessage({
      error: friendly ? error.message : '无法解码图片，文件可能损坏或使用了不支持的编码。',
    });
  },
);
