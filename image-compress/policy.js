'use strict';

const path = require('node:path');

exports.LIMIT = 500000;
exports.MAX_INPUT = 20 * 1024 * 1024;
exports.MAX_PIXELS = 50 * 1000 * 1000;
exports.MAX_TOTAL_PIXELS = 100 * 1000 * 1000;
exports.MAX_FRAMES = 500;
const extensions = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.gif', '.avif',
  '.svg', '.svgz', '.bmp', '.dib', '.tif', '.tiff', '.heic', '.heif', '.hif', '.ico', '.cur', '.jxl', '.jp2', '.j2k', '.jpx',
]);
const native = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.gif', '.avif']);
exports.isImageName = name => typeof name === 'string'
  && (extensions.has(path.extname(name).toLowerCase()) || /\.svg\.gz$/i.test(name));
exports.needsConversion = name => exports.isImageName(name) && !native.has(path.extname(name).toLowerCase());
exports.convertedFilename = name => name.replace(/(?:\.svg\.gz|\.[^./\\]+)$/i, '.webp');
exports.isTarget = target => typeof target === 'string'
  && (/^user\/[0-9]+\/.+/.test(target)
    || /^problem\/[^/]+\/[^/]+\/additional_file\/.+/.test(target)
    || /^contest\/[^/]+\/[^/]+\/(?:public|private)\/.+/.test(target))
  && exports.isImageName(target);
exports.failure = message => Object.assign(new Error(message), { imageCompression: true });
