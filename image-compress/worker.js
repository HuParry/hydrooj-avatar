'use strict';

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const sharp = require('sharp');
const { LIMIT, MAX_PIXELS, MAX_TOTAL_PIXELS, MAX_FRAMES, failure, needsConversion, convertedFilename } = require('./policy');
sharp.concurrency(1);
sharp.cache(false);

const expected = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg', '.jfif': 'jpeg', '.png': 'png', '.apng': 'png',
  '.webp': 'webp', '.gif': 'gif', '.avif': 'avif',
};
const formatOf = meta => meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;

async function compress() {
  const extension = path.extname(workerData.filename || '').toLowerCase();
  const converted = workerData.convert && needsConversion(workerData.filename);
  const format = converted ? 'webp' : expected[extension];
  if (!format) throw failure('此图片格式暂不支持保留原格式压缩，请先转换为 JPG、PNG、WebP、GIF 或 AVIF，并控制在 500 KB 内。');
  const input = Buffer.from(workerData.data);
  if (!converted && format === 'png' && input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= input.length;) {
      const length = input.readUInt32BE(offset);
      if (length > input.length - offset - 12) break;
      if (input.toString('ascii', offset + 4, offset + 8) === 'acTL' && length >= 8 && input.readUInt32BE(offset + 8) > 1) {
        throw failure('暂不支持保留 APNG 动画压缩，请先转为 GIF 或动画 WebP，或将原文件控制在 500 KB 内。');
      }
      offset += length + 12;
    }
  }
  const source = converted ? await require('./decode').openImage(input, extension)
    : sharp(input, { animated: true, limitInputPixels: MAX_TOTAL_PIXELS, failOn: 'warning' });
  const before = await source.metadata();
  if (!converted && formatOf(before) !== format) throw failure('图片内容与文件扩展名不一致，请使用正确的图片文件。');
  const pages = converted ? 1 : before.pages || 1;
  const width = before.width;
  const height = converted ? before.height : before.pageHeight || before.height;
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_PIXELS
    || width * height * pages > MAX_TOTAL_PIXELS || pages > MAX_FRAMES) {
    throw failure('图片尺寸或动画帧数过大：单帧最多 5000 万像素、动画总计最多 1 亿像素和 500 帧。');
  }
  if (pages > 1 && !['gif', 'webp'].includes(format)) {
    throw failure('此动画格式无法在保留动画的情况下压缩，请先转换为 GIF 或 WebP。');
  }
  const orientedWidth = before.orientation >= 5 ? height : width;
  const orientedHeight = before.orientation >= 5 ? width : height;
  const options = {
    jpeg: { quality: 85, mozjpeg: true },
    png: { compressionLevel: 9, palette: true, quality: 90, colours: 256, effort: 4 },
    gif: {
      colours: 256, effort: 3, dither: 0.5, keepDuplicateFrames: true,
      interFrameMaxError: 0, interPaletteMaxError: 0, loop: before.loop, delay: before.delay,
    },
    webp: { quality: 85, effort: 2, alphaQuality: 100, loop: before.loop, delay: before.delay },
    avif: { quality: 65, effort: 2 },
  }[format];
  const encode = async (targetWidth, opts = options) => {
    let image = source.clone().autoOrient();
    if (targetWidth < orientedWidth) image = image.resize({ width: targetWidth, withoutEnlargement: true });
    return image[format](opts).toBuffer();
  };

  // Keep a cheap lossless attempt for small true-colour PNGs, such as diagrams.
  let output;
  if (format === 'png' && !before.isPalette && width * height <= 1000000) {
    const lossless = await encode(orientedWidth, { compressionLevel: 6 });
    if (lossless.length <= LIMIT) output = lossless;
  }

  if (!output) {
    // Estimate encoded bytes per pixel at a bounded size, including every animation frame.
    const needsProbe = width * height * pages > 2000000;
    const probeScale = Math.min(1, Math.sqrt(500000 / (width * height * pages)),
      1280 / Math.max(orientedWidth, orientedHeight));
    let targetWidth = needsProbe ? Math.max(1, Math.floor(orientedWidth * probeScale)) : orientedWidth;
    let candidate = await encode(targetWidth);
    let encodedWidth = targetWidth;
    let best = candidate.length <= LIMIT ? { data: candidate, width: targetWidth } : null;
    let upperWidth = orientedWidth + 1;
    if (needsProbe) {
      // A small preview loses fine detail, so bytes usually grow more slowly than pixel count.
      targetWidth = Math.max(1, Math.min(orientedWidth,
        Math.floor(targetWidth * (460000 / candidate.length) ** (1 / 1.75))));
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      if (targetWidth !== encodedWidth) {
        candidate = await encode(targetWidth);
        encodedWidth = targetWidth;
      }
      if (candidate.length <= LIMIT) {
        if (!best || targetWidth > best.width) best = { data: candidate, width: targetWidth };
        if (targetWidth === orientedWidth || candidate.length >= LIMIT * (needsProbe ? 0.85 : 0.6)) break;
        const next = Math.min(orientedWidth, upperWidth - 1,
          Math.floor(targetWidth * Math.sqrt(470000 / candidate.length)));
        if (next <= targetWidth * 1.05) break;
        targetWidth = next;
      } else {
        upperWidth = targetWidth;
        if (targetWidth === 1) break;
        const factor = Math.min(0.9, Math.max(0.25, Math.sqrt(460000 / candidate.length) * 0.95));
        const next = Math.max(1, best ? best.width + 1 : 1, Math.floor(targetWidth * factor));
        if (next >= targetWidth || (best && next <= best.width * 1.05)) break;
        targetWidth = next;
      }
    }
    output = best?.data;
  }
  if (!output || (!converted && output.length >= input.length)) throw failure('无法将图片压缩到 500 KB 内，请先手动缩小图片。');
  const after = await sharp(output, { animated: true, limitInputPixels: MAX_TOTAL_PIXELS }).metadata();
  if (formatOf(after) !== format || (after.pages || 1) !== pages) throw failure('图片格式或动画帧数校验失败，未保存图片。');
  if (pages > 1 && (JSON.stringify(before.delay) !== JSON.stringify(after.delay) || before.loop !== after.loop)) {
    throw failure('动画播放时间校验失败，未保存图片。');
  }
  if (before.hasAlpha && !after.hasAlpha) {
    const stats = await source.clone().stats();
    if (stats.channels[stats.channels.length - 1].min < 255) throw failure('图片透明度校验失败，未保存图片。');
  }
  await sharp(output, { animated: pages > 1, limitInputPixels: MAX_TOTAL_PIXELS, failOn: 'warning' }).stats();
  return { data: output, filename: converted ? convertedFilename(workerData.filename) : workerData.filename };
}

compress().then(
  result => parentPort.postMessage(result),
  error => parentPort.postMessage({
    error: error.imageCompression ? error.message : '图片无法正常解码或压缩，请检查文件是否完整及分辨率是否过大。',
  }),
);
