'use strict';

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const sharp = require('sharp');
const { LIMIT, MAX_PIXELS, MAX_TOTAL_PIXELS, MAX_FRAMES, failure } = require('./policy');
sharp.concurrency(1);
sharp.cache(false);

const expected = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.apng': 'png',
  '.webp': 'webp', '.gif': 'gif', '.avif': 'avif',
};
const formatOf = meta => meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;

async function compress() {
  const extension = path.extname(workerData.filename || '').toLowerCase();
  const format = expected[extension];
  if (!format) throw failure('此图片格式暂不支持保留原格式压缩，请先转换为 JPG、PNG、WebP、GIF 或 AVIF，并控制在 500 KB 内。');
  const input = Buffer.from(workerData.data);
  const before = await sharp(input, { animated: true, limitInputPixels: MAX_TOTAL_PIXELS, failOn: 'warning' }).metadata();
  if (formatOf(before) !== format) throw failure('图片内容与文件扩展名不一致，请使用正确的图片文件。');
  const pages = before.pages || 1;
  const width = before.width;
  const height = before.pageHeight || before.height;
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_PIXELS
    || width * height * pages > MAX_TOTAL_PIXELS || pages > MAX_FRAMES) {
    throw failure('图片尺寸或动画帧数过大：单帧最多 5000 万像素、动画总计最多 1 亿像素和 500 帧。');
  }
  if (pages > 1 && !['gif', 'webp'].includes(format)) {
    throw failure('此动画格式无法在保留动画的情况下压缩，请先转换为 GIF 或 WebP。');
  }
  const orientedWidth = before.orientation >= 5 ? height : width;
  let targetWidth = orientedWidth;
  let output;
  let options;
  const build = () => {
    let image = sharp(input, { animated: pages > 1, limitInputPixels: MAX_TOTAL_PIXELS, failOn: 'warning' }).autoOrient();
    if (targetWidth < orientedWidth) image = image.resize({ width: targetWidth, withoutEnlargement: true });
    return image;
  };
  const encode = async opts => {
    options = opts;
    output = await build()[format](opts).toBuffer();
    return output.length <= LIMIT;
  };
  let done = false;
  if (format === 'jpeg') done = await encode({ quality: 85, mozjpeg: true });
  if (format === 'png') {
    done = await encode({ compressionLevel: 9, adaptiveFiltering: true });
    if (!done) done = await encode({ compressionLevel: 9, palette: true, quality: 90, colours: 256, effort: 4 });
  }
  if (format === 'gif') {
    for (const colours of [256, 128, 64]) {
      done = await encode({
        colours, effort: 7, dither: 0.5, keepDuplicateFrames: true,
        interFrameMaxError: 0, interPaletteMaxError: 0,
        loop: before.loop, delay: before.delay,
      });
      if (done) break;
    }
  }
  if (format === 'webp') done = await encode({ quality: 85, effort: 4, alphaQuality: 100, loop: before.loop, delay: before.delay });
  if (format === 'avif') done = await encode({ quality: 65, effort: 4 });

  for (let attempt = 0; !done && attempt < 16; attempt++) {
    const factor = Math.min(0.9, Math.max(0.5, Math.sqrt(470000 / output.length) * 0.96));
    const next = Math.max(16, Math.floor(targetWidth * factor));
    if (next === targetWidth) break;
    targetWidth = next;
    done = await encode(options);
  }
  if (!done || output.length >= input.length) throw failure('无法将图片压缩到 500 KB 内，请先手动缩小图片。');
  const after = await sharp(output, { animated: true, limitInputPixels: MAX_TOTAL_PIXELS }).metadata();
  if (formatOf(after) !== format || (after.pages || 1) !== pages) throw failure('图片格式或动画帧数校验失败，未保存图片。');
  if (pages > 1 && (JSON.stringify(before.delay) !== JSON.stringify(after.delay) || before.loop !== after.loop)) {
    throw failure('动画播放时间校验失败，未保存图片。');
  }
  if (before.hasAlpha && !after.hasAlpha) {
    const stats = await sharp(input, { animated: pages > 1, limitInputPixels: MAX_TOTAL_PIXELS }).stats();
    if (stats.channels[stats.channels.length - 1].min < 255) throw failure('图片透明度校验失败，未保存图片。');
  }
  await sharp(output, { animated: pages > 1, limitInputPixels: MAX_TOTAL_PIXELS, failOn: 'warning' }).stats();
  return output;
}

compress().then(
  data => parentPort.postMessage({ data }),
  error => parentPort.postMessage({
    error: error.imageCompression ? error.message : '图片无法正常解码或压缩，请检查文件是否完整及分辨率是否过大。',
  }),
);
