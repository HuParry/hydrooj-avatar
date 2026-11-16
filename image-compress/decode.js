'use strict';

const sharp = require('sharp');
const { gunzipSync } = require('node:zlib');
const { MAX_INPUT, MAX_PIXELS, MAX_FRAMES, failure } = require('./policy');

function checkDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 16384 || height > 16384 || width * height > MAX_PIXELS) {
    throw failure('图片尺寸过大：最多 5000 万像素且单边不超过 16384 像素。');
  }
}

function rawImage(data, width, height) {
  checkDimensions(width, height);
  return sharp(data, { raw: { width, height, channels: 4 }, limitInputPixels: MAX_PIXELS });
}

exports.openImage = async (input, extension) => {
  if (['.heic', '.heif', '.hif'].includes(extension)) {
    const images = await require('heic-decode').all({ buffer: input });
    try {
      const main = images[0];
      if (!main) throw failure('无法读取 HEIC/HEIF 主图。');
      checkDimensions(main.width, main.height);
      const { data, width, height } = await main.decode();
      return rawImage(Buffer.from(data.buffer, data.byteOffset, data.byteLength), width, height);
    } finally { images.dispose(); }
  }
  if (['.bmp', '.dib'].includes(extension)) {
    if (input.length < 26 || input.toString('ascii', 0, 2) !== 'BM') throw failure('无法读取 BMP 图片。');
    const shortHeader = input.readUInt32LE(14) === 12;
    const width = shortHeader ? input.readUInt16LE(18) : input.readInt32LE(18);
    const height = shortHeader ? input.readUInt16LE(20) : Math.abs(input.readInt32LE(22));
    checkDimensions(width, height);
    const decoded = require('bmp-ts').decode(input, { toRGBA: true });
    if ((!decoded.maskAlpha && decoded.bitPP !== 32)
      || (!decoded.maskAlpha && !decoded.data.some((value, i) => i % 4 === 3 && value))) {
      for (let i = 3; i < decoded.data.length; i += 4) decoded.data[i] = 255;
    }
    return rawImage(decoded.data, decoded.width, decoded.height);
  }
  if (['.ico', '.cur'].includes(extension)) {
    if (input.length < 22 || input.readUInt16LE(0) !== 0 || ![1, 2].includes(input.readUInt16LE(2))) {
      throw failure('无法读取 ICO/CUR 图片。');
    }
    const count = input.readUInt16LE(4);
    if (!count || count > MAX_FRAMES || input.length < 6 + count * 16) throw failure('图标包含过多图片或文件不完整。');
    let best;
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16;
      const length = input.readUInt32LE(offset + 8);
      const start = input.readUInt32LE(offset + 12);
      if (start < 6 + count * 16 || length < 24 || start + length > input.length) throw failure('图标图片数据不完整。');
      const png = input.readUInt32BE(start) === 0x89504e47;
      const width = png ? input.readUInt32BE(start + 16) : input.readInt32LE(start + 4);
      const height = png ? input.readUInt32BE(start + 20) : Math.abs(input.readInt32LE(start + 8)) / 2;
      checkDimensions(width, height);
      if (!best || width * height > best.area) best = { offset, length, start, area: width * height };
    }
    const single = Buffer.concat([input.subarray(0, 6), input.subarray(best.offset, best.offset + 16),
      input.subarray(best.start, best.start + best.length)]);
    single.writeUInt16LE(1, 4);
    single.writeUInt32LE(22, 18);
    const [image] = require('decode-ico')(single);
    return image.type === 'png' ? sharp(Buffer.from(image.data), { limitInputPixels: MAX_PIXELS, failOn: 'warning' })
      : rawImage(Buffer.from(image.data), image.width, image.height);
  }
  if (extension === '.svgz' || extension === '.gz') input = gunzipSync(input, { maxOutputLength: MAX_INPUT });
  const image = sharp(input, { page: 0, pages: 1, limitInputPixels: MAX_PIXELS, failOn: 'warning' });
  const metadata = await image.metadata();
  const expected = { '.svg': 'svg', '.svgz': 'svg', '.gz': 'svg', '.tif': 'tiff', '.tiff': 'tiff',
    '.jxl': 'jxl', '.jp2': 'jp2', '.j2k': 'jp2', '.jpx': 'jp2' }[extension];
  if (!expected || metadata.format !== expected) throw failure('图片内容与文件扩展名不一致，或服务器不支持该编码。');
  checkDimensions(metadata.width, metadata.height);
  return image;
};
