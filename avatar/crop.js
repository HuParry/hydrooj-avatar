'use strict';

exports.resolveCrop = (crop, width, height) => {
  if (crop == null) {
    const size = Math.min(width, height);
    return { left: Math.floor((width - size) / 2), top: Math.floor((height - size) / 2), width: size, height: size };
  }
  if (typeof crop !== 'object' || Array.isArray(crop)) throw new Error('图片裁剪参数无效。');
  const { left, top, size } = crop;
  if (![left, top, size].every(Number.isSafeInteger) || left < 0 || top < 0 || size < 1
    || left + size > width || top + size > height) {
    throw new Error('图片裁剪选区超出范围，请重新选择。');
  }
  return { left, top, width: size, height: size };
};
