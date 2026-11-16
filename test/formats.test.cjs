'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const sharp = require('sharp');
const bmp = require('bmp-ts');
const { createProcessor } = require('../image-compress/process');
const { isImageName, isTarget, needsConversion } = require('../image-compress/policy');

sharp.concurrency(1);
sharp.cache(false);
let processor;
test.before(() => { processor = createProcessor(); });
test.after(() => processor.dispose());

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="40" height="60" fill="red"/></svg>');
const png = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const ico = images => {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + i * 16;
    header[entry] = image.width === 256 ? 0 : image.width;
    header[entry + 1] = image.height === 256 ? 0 : image.height;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, ...images.map(image => image.data)]);
};

test('all native formats remain supported alongside convertible formats', () => {
  for (const name of ['a.jpg', 'a.jpeg', 'a.jpe', 'a.jfif', 'a.png', 'a.apng', 'a.gif', 'a.webp', 'a.avif']) {
    assert.equal(isImageName(name), true, name);
    assert.equal(needsConversion(name), false, name);
  }
  for (const name of ['a.HEIC', 'a.heif', 'a.hif', 'a.bmp', 'a.tif', 'a.tiff', 'a.ico', 'a.cur', 'a.svg', 'a.svgz', 'a.svg.gz']) {
    assert.equal(needsConversion(name), true, name);
    assert.equal(isTarget(`problem/main/1/additional_file/${name}`), true, name);
    assert.equal(isTarget(`problem/main/1/testdata/${name}`), false, name);
  }
});

test('small native attachments pass through byte for byte with their filename', async () => {
  const data = await png(80, 60, '#12345680');
  const result = await processor.prepare(data, 'transparent.png');
  assert.equal(result.data, data);
  assert.equal(result.filename, 'transparent.png');
});

test('SVG, SVGZ and SVG.GZ convert even below 500 KB and retain transparent areas', async () => {
  for (const [name, data] of [['图.svg', svg], ['图.svgz', gzipSync(svg)], ['图.svg.gz', gzipSync(svg)]]) {
    const result = await processor.prepare(data, name);
    const meta = await sharp(result.data).metadata();
    assert.equal(result.filename, '图.webp');
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 80);
    assert.equal(meta.height, 60);
    assert.equal(meta.hasAlpha, true);
    const stats = await sharp(result.data).stats();
    assert.equal(stats.channels[3].min, 0);
    assert.equal(stats.channels[3].max, 255);
    assert.ok(result.data.length <= 500000);
  }
});

test('TIFF converts with orientation corrected and BMP keeps opaque pixels opaque', async () => {
  const tiff = await sharp(await png(80, 60, 'red')).tiff().withMetadata({ orientation: 6 }).toBuffer();
  const converted = await processor.prepare(tiff, 'camera.tif');
  const metadata = await sharp(converted.data).metadata();
  assert.equal(converted.filename, 'camera.webp');
  assert.equal(metadata.width, 60);
  assert.equal(metadata.height, 80);
  const input = bmp.encode({ data: Buffer.from(Array(80 * 60).fill([0, 0, 0, 255]).flat()), width: 80, height: 60 }).data;
  const result = await processor.prepare(input, 'red.bmp');
  const { data, info } = await sharp(result.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 80);
  assert.ok(data[0] > 240 && data[1] < 10 && data[2] < 10);
  for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255);
});

test('ICO and CUR select the largest icon and preserve alpha', async () => {
  const input = ico([
    { width: 16, height: 16, data: await png(16, 16, 'red') },
    { width: 64, height: 48, data: await png(64, 48, '#0000ff80') },
  ]);
  for (const extension of ['ico', 'cur']) {
    const result = await processor.prepare(input, `icon.${extension}`);
    const metadata = await sharp(result.data).metadata();
    assert.equal(result.filename, 'icon.webp');
    assert.equal(metadata.width, 64);
    assert.equal(metadata.height, 48);
    const stats = await sharp(result.data).stats();
    assert.ok(stats.channels[2].mean > 240);
    assert.ok(Math.abs(stats.channels[3].mean - 128) <= 1);
  }
});

test('conversion rejects malformed files and oversized embedded images before decoding', async () => {
  await assert.rejects(processor.prepare(Buffer.from('not heic'), 'fake.heic'), /解码|压缩/);
  const huge = await png(16, 16, 'red');
  huge.writeUInt32BE(20000, 16);
  await assert.rejects(processor.prepare(ico([{ width: 16, height: 16, data: huge }]), 'huge.ico'), /尺寸过大/);
  await assert.rejects(processor.prepare(gzipSync(Buffer.alloc(21 * 1024 * 1024)), 'large.svgz'), /解码|压缩/);
});

test('APNG below the limit passes through and oversized animations are not flattened', async () => {
  const still = await png(16, 16, 'red');
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4);
  chunk.writeUInt32BE(2, 8);
  const animated = Buffer.concat([still.subarray(0, 33), chunk, still.subarray(33)]);
  assert.equal((await processor.prepare(animated, 'animation.apng')).data, animated);
  await assert.rejects(processor.prepare(Buffer.concat([animated, Buffer.alloc(500000)]), 'animation.apng'), /APNG 动画/);
});

test('real HEIC and HEIF attachments decode and use a WebP filename', {
  skip: !process.env.HYDRO_AVATAR_HEIC_FIXTURE && 'Set HYDRO_AVATAR_HEIC_FIXTURE to a real HEIC image',
}, async () => {
  const input = await fs.readFile(process.env.HYDRO_AVATAR_HEIC_FIXTURE);
  for (const extension of ['heic', 'heif']) {
    const result = await processor.prepare(input, `iphone.${extension}`);
    const metadata = await sharp(result.data).metadata();
    assert.equal(result.filename, 'iphone.webp');
    assert.equal(metadata.format, 'webp');
    assert.ok(metadata.width > 0 && metadata.height > 0 && result.data.length <= 500000);
  }
});

test('Hydro upload hook updates both parameter sources and returns the actual saved filename', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydro-image-convert-'));
  const file = path.join(dir, 'upload.svg');
  await fs.writeFile(file, svg);
  const hooks = new Map();
  const Module = require('node:module');
  const originalLoad = Module._load;
  const api = { StorageModel: { put: async () => {} }, PRIV: { PRIV_CREATE_FILE: 1 },
    ValidationError: class extends Error { constructor(field, unused, message) { super(message); } } };
  Module._load = function (name, ...args) { return name === 'hydrooj' ? api : originalLoad.call(this, name, ...args); };
  try { require('../image-compress').apply({ on: (event, callback) => hooks.set(event, callback) }); }
  finally { Module._load = originalLoad; }
  try {
    const h = { args: { filename: '图.svg', type: 'additional_file', operation: 'upload_file' },
      request: { body: { filename: '图.svg' }, files: { file: { filepath: file, originalFilename: '图.svg' } } }, response: { body: {} } };
    await hooks.get('handler/before-operation/ProblemFiles')(h);
    assert.equal(h.args.filename, '图.webp');
    assert.equal(h.request.body.filename, '图.webp');
    assert.equal(h.request.files.file.originalFilename, '图.webp');
    assert.equal(h.response.body.imageFilename, '图.webp');
    assert.equal((await sharp(await fs.readFile(file)).metadata()).format, 'webp');
    assert.ok(h.request.files.file.size <= 500000);
  } finally { hooks.get('dispose')(); await fs.rm(dir, { recursive: true, force: true }); }
});
