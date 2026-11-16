'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { processAvatar } = require('../avatar/process');
const { resolveCrop } = require('../avatar/crop');
const { createProcessor } = require('../image-compress/process');
const { isTarget } = require('../image-compress/policy');

sharp.concurrency(1);
sharp.cache(false);
let directory;
let processor;
const samples = {};
const pad = (data, size) => Buffer.concat([data, Buffer.alloc(Math.max(0, size - data.length))]);
const imageFile = async (name, data) => {
  const file = path.join(directory, name);
  await fs.writeFile(file, data);
  return file;
};

test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrooj-avatar-test-'));
  processor = createProcessor();
  samples.small = await sharp({ create: { width: 120, height: 80, channels: 3, background: 'red' } }).jpeg().toBuffer();
  samples.jpeg = await sharp(crypto.randomBytes(1500 * 1000 * 3), {
    raw: { width: 1500, height: 1000, channels: 3 },
  }).jpeg({ quality: 100 }).toBuffer();
  samples.png = await sharp(crypto.randomBytes(600 * 500 * 4), {
    raw: { width: 600, height: 500, channels: 4 },
  }).png().toBuffer();
  samples.webp = await sharp(crypto.randomBytes(800 * 600 * 3), {
    raw: { width: 800, height: 600, channels: 3 },
  }).webp({ lossless: true }).toBuffer();
  samples.gif = await sharp(crypto.randomBytes(320 * 240 * 12 * 3), {
    raw: { width: 320, height: 240 * 12, channels: 3, pageHeight: 240 },
  }).gif({ colours: 256, effort: 3, keepDuplicateFrames: true, loop: 2, delay: Array.from({ length: 12 }, (_, i) => 50 + 10 * i) }).toBuffer();
});

test.after(async () => {
  processor.dispose();
  await fs.rm(directory, { recursive: true, force: true });
});

test('avatar respects EXIF orientation and outputs a bounded WebP', async () => {
  const source = await sharp({ create: { width: 800, height: 400, channels: 3, background: 'blue' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await processAvatar(await imageFile('portrait.jpg', source), 'portrait.jpg');
  const meta = await sharp(result).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert.ok(result.length <= 100 * 1024);
});

test('small transparent avatars retain alpha without enlargement', async () => {
  const source = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#ff000080' } }).png().toBuffer();
  const result = await processAvatar(await imageFile('small.png', source), 'small.png');
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 60);
  assert.equal(meta.height, 60);
  assert.equal(meta.hasAlpha, true);
});

test('a real HEIC fixture converts through the packaged decoder', {
  skip: !process.env.HYDRO_AVATAR_HEIC_FIXTURE && 'Set HYDRO_AVATAR_HEIC_FIXTURE to a real HEIC image',
}, async () => {
  const result = await processAvatar(process.env.HYDRO_AVATAR_HEIC_FIXTURE, 'iphone.heic');
  const meta = await sharp(result).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, meta.height);
  assert.ok(meta.width <= 256 && meta.height <= 256 && result.length <= 100 * 1024);
  const preview = await processAvatar(process.env.HYDRO_AVATAR_HEIC_FIXTURE, 'iphone.heic', { preview: true });
  const previewMeta = await sharp(preview.data).metadata();
  assert.ok(preview.width >= previewMeta.width && preview.height >= previewMeta.height);
  assert.ok(previewMeta.width <= 1024 && previewMeta.height <= 1024);
  const cropped = await processAvatar(process.env.HYDRO_AVATAR_HEIC_FIXTURE, 'iphone.heic', {
    crop: { left: 0, top: 0, size: Math.min(80, preview.width, preview.height) },
  });
  assert.equal((await sharp(cropped).metadata()).width, 80);
});

test('crop coordinates reject malformed and out-of-bounds selections', () => {
  assert.deepEqual(resolveCrop(undefined, 120, 80), { left: 20, top: 0, width: 80, height: 80 });
  assert.deepEqual(resolveCrop({ left: 40, top: 0, size: 80 }, 120, 80), { left: 40, top: 0, width: 80, height: 80 });
  for (const crop of [[], 'crop', {}, { left: -1, top: 0, size: 10 }, { left: 0, top: 0, size: 0 },
    { left: 0.5, top: 0, size: 10 }, { left: 41, top: 0, size: 80 }, { left: 0, top: 1, size: 80 },
    { left: 0, top: NaN, size: 10 }]) {
    assert.throws(() => resolveCrop(crop, 120, 80), /裁剪/);
  }
});

test('selected area is cropped from the oriented original, including EXIF rotations and mirrors', async () => {
  const source = await sharp({ create: { width: 800, height: 400, channels: 3, background: 'red' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 400, channels: 3, background: 'blue' } }).png().toBuffer(), left: 400, top: 0 }])
    .png().toBuffer();
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const original = await sharp(source).jpeg({ quality: 100 }).withMetadata({ orientation }).toBuffer();
    const file = await imageFile('oriented-' + orientation + '.jpg', original);
    const preview = await processAvatar(file, 'camera.jpg', { preview: true });
    const turned = orientation >= 5;
    assert.equal(preview.width, turned ? 400 : 800);
    assert.equal(preview.height, turned ? 800 : 400);
    const crop = { left: turned ? 0 : 400, top: turned ? 400 : 0, size: 400 };
    const result = await processAvatar(file, 'camera.jpg', { crop });
    const actual = await sharp(result).stats();
    const oriented = await sharp(original).autoOrient().png().toBuffer();
    const selected = await sharp(oriented).extract({ left: crop.left, top: crop.top, width: crop.size, height: crop.size }).toBuffer();
    const expected = await sharp(selected).stats();
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(actual.channels[channel].mean - expected.channels[channel].mean) < 5, `orientation ${orientation}, channel ${channel}`);
    }
    assert.equal((await sharp(result).metadata()).width, 256);
  }
});

test('preview preserves original geometry while limiting display pixels', async () => {
  const file = await imageFile('preview.png', samples.png);
  const before = await fs.readFile(file);
  const preview = await processAvatar(file, 'preview.png', { preview: true });
  assert.equal(preview.width, 600);
  assert.equal(preview.height, 500);
  assert.equal((await sharp(preview.data).metadata()).width, 600);
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(processAvatar(file, 'preview.png', { crop: { left: 599, top: 0, size: 5 } }), /选区超出/);
});

test('invalid and oversized avatar inputs are rejected', async () => {
  await assert.rejects(processAvatar(await imageFile('invalid.jpg', Buffer.from('invalid image')), 'invalid.jpg'), /无法解码/);
  await assert.rejects(processAvatar(await imageFile('large.png', Buffer.alloc(8 * 1024 * 1024 + 1)), 'large.png'), /8 MiB/);
});

test('attachment policy excludes judge data and non-image files', () => {
  for (const target of ['user/2/photo.PNG', 'problem/main/1/additional_file/图.png', 'contest/main/id/public/a.gif', 'contest/main/id/private/b.webp']) {
    assert.equal(isTarget(target), true, target);
  }
  for (const target of ['problem/main/1/testdata/input.png', 'submission/a.png', 'user/2/main.cpp', 'problem/main/1/additional_file/data.zip']) {
    assert.equal(isTarget(target), false, target);
  }
});

test('attachment size boundary passes exact bytes and compresses larger input', async () => {
  const exact = pad(samples.small, 500000);
  assert.equal(await processor.compress(exact, 'same.jpeg'), exact);
  const result = await processor.compress(pad(samples.small, 500001), 'same.jpeg');
  assert.ok(result.length <= 500000);
  assert.equal((await sharp(result).metadata()).format, 'jpeg');
});

test('large JPEG, transparent PNG and WebP keep their formats', async () => {
  for (const [format, name] of [['jpeg', 'photo.jpeg'], ['png', '截图.png'], ['webp', 'photo.webp']]) {
    assert.ok(samples[format].length > 500000);
    const result = await processor.compress(samples[format], name);
    const meta = await sharp(result).metadata();
    assert.equal(meta.format, format);
    assert.ok(result.length <= 500000 && result.length < samples[format].length);
    if (format === 'png') assert.equal(meta.hasAlpha, true);
  }
});

test('animated GIF keeps every frame, delay and loop', async () => {
  assert.ok(samples.gif.length > 500000);
  const before = await sharp(samples.gif, { animated: true }).metadata();
  const result = await processor.compress(samples.gif, 'animation.gif');
  const after = await sharp(result, { animated: true }).metadata();
  assert.ok(result.length <= 500000);
  assert.equal(after.format, 'gif');
  assert.equal(after.pages, before.pages);
  assert.deepEqual(after.delay, before.delay);
  assert.equal(after.loop, before.loop);
});

test('path and import stream inputs work without altering import source files', async () => {
  const source = pad(samples.small, 600000);
  const file = await imageFile('import.jpg', source);
  for (const input of [file, Readable.from([source.subarray(0, 300000), source.subarray(300000)])]) {
    const result = await processor.compress(input, 'original.jpg');
    assert.ok(result.length <= 500000);
  }
  assert.deepEqual(await fs.readFile(file), source);
});

test('failed attachment compression rejects invalid formats and raw byte overflow', async () => {
  await assert.rejects(processor.compress(Buffer.alloc(600000), 'bad.png'), /解码|压缩/);
  await assert.rejects(processor.compress(samples.png, 'wrong.jpg'), /扩展名/);
  await assert.rejects(processor.compress(Buffer.alloc(600000), 'photo.heic'), /暂不支持/);
  await assert.rejects(processor.compress(Buffer.alloc(20 * 1024 * 1024 + 1), 'big.png'), /20 MiB/);
});

test('worker timeouts reject without leaving an active processor', async () => {
  const isolated = createProcessor({ workMs: 1 });
  try {
    await assert.rejects(isolated.compress(samples.png, 'timeout.png'), /压缩超时/);
  } finally {
    isolated.dispose();
  }
});

test('package entry composes avatar and attachment handling and preserves existing files on failure', async () => {
  const calls = [];
  const originalPut = async (target, data, owner) => { calls.push(['put', target, data, owner]); return target; };
  const api = {
    StorageModel: { put: originalPut, del: async names => { calls.push(['del', names]); } },
    UserModel: { setById: async (uid, update) => { calls.push(['user', uid, update]); } },
    PRIV: { PRIV_CREATE_FILE: 42 },
    ValidationError: class ValidationError extends Error { constructor(field, unused, message) { super(message); } },
  };
  const handlers = new Map();
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (name, ...args) { return name === 'hydrooj' ? api : originalLoad.call(this, name, ...args); };
  try { require('../index').apply({ on: (event, callback) => handlers.set(event, callback) }); }
  finally { Module._load = originalLoad; }
  try {
    const file = await imageFile('new-avatar.jpg', samples.small);
    const handler = {
      user: { _id: 123, avatar: 'url:/file/123/.avatar.png' }, args: {}, response: {},
      request: { files: { file: { filepath: file, originalFilename: '原头像.jpg', size: samples.small.length } } },
      back() { calls.push(['back']); },
    };
    handlers.get('handler/before/HomeAvatar#post')(handler);
    handler.args = { preview: '1' };
    await handler.post();
    assert.equal(calls.length, 0, 'preview must not write storage, update user or delete the old avatar');
    assert.match(handler.response.body.preview, /^data:image\/webp;base64,/);
    assert.equal(handler.response.body.width, 120);
    assert.equal(handler.response.body.height, 80);
    for (const crop of ['not json', JSON.stringify({ left: 100, top: 0, size: 80 })]) {
      handler.args = { crop };
      await assert.rejects(handler.post(), /裁剪/);
      assert.equal(calls.length, 0, 'invalid crop must preserve existing avatar');
    }
    handler.args = { crop: JSON.stringify({ left: 10, top: 5, size: 60 }) };
    await handler.post();
    assert.match(calls[0][1], /^user\/123\/\.avatar-[0-9a-f]{16}\.webp$/);
    assert.equal((await sharp(calls[0][2]).metadata()).format, 'webp');
    assert.equal((await sharp(calls[0][2]).metadata()).width, 60);
    assert.equal(calls[1][0], 'user');
    assert.equal(calls[1][1], 123);
    assert.equal(calls[1][2].avatar, 'url:/file/123/' + calls[0][1].split('/').at(-1));
    assert.deepEqual(calls[2], ['del', ['user/123/.avatar.png']]);
    assert.deepEqual(calls[3], ['back']);

    calls.length = 0;
    const target = 'problem/main/1/additional_file/原文件.jpg';
    await api.StorageModel.put(target, Readable.from([pad(samples.small, 600000)]), 123);
    assert.equal(calls[0][1], target);
    assert.ok(calls[0][2].length <= 500000);
    const count = calls.length;
    await assert.rejects(api.StorageModel.put(target, Buffer.alloc(600000), 123), /解码|压缩/);
    assert.equal(calls.length, count);
    await api.StorageModel.put('problem/main/1/testdata/input.png', samples.png, 123);
    assert.equal(calls.at(-1)[2], samples.png);

    const upload = await imageFile('upload.jpg', pad(samples.small, 600000));
    const h = { args: { operation: 'upload_file', type: 'additional_file', filename: '原文件.jpg' }, request: { files: { file: { filepath: upload, size: 600000, originalFilename: 'camera.jpg' } } } };
    await handlers.get('handler/before-operation/ProblemFiles')(h);
    assert.equal(h.args.filename, '原文件.jpg');
    assert.equal(h.request.files.file.filepath, upload);
    assert.equal(h.request.files.file.size, (await fs.stat(upload)).size);
    assert.ok(h.request.files.file.size <= 500000);
    await fs.writeFile(upload, pad(samples.small, 600000));
    h.args.type = 'testdata';
    await handlers.get('handler/before-operation/ProblemFiles')(h);
    assert.equal((await fs.stat(upload)).size, 600000);
    h.checkPriv = () => { throw new Error('permission denied'); };
    await assert.rejects(handlers.get('handler/before-operation/Files')(h), /permission denied/);
  } finally {
    handlers.get('dispose')();
  }
  assert.equal(api.StorageModel.put, originalPut);
});

test('avatar page immediately exposes the upload control without a source selector or change button', async () => {
  const { JSDOM } = require('jsdom');
  const jquery = require('jquery');
  const esbuild = require('esbuild');
  const dom = new JSDOM('<div id="upload_avatar"><div class="changeAvatar"></div><button class="change-avatar" style="display:none">Change avatar</button></div>');
  const $ = jquery(dom.window);
  const registered = [];
  const ui = { $, addPage: p => registered.push(p), NamedPage: class NamedPage { constructor(name, afterLoading) { this.name = name; this.afterLoading = afterLoading; } } };
  const build = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../frontend/avatar-upload-only.page.ts')],
    bundle: true, format: 'cjs', write: false, loader: { '.css': 'empty' }, external: ['@hydrooj/ui-default'] });
  const code = build.outputFiles[0].text;
  try {
    vm.runInNewContext(code, { exports: {}, require: name => { assert.equal(name, '@hydrooj/ui-default'); return ui; }, document: dom.window.document, MutationObserver: dom.window.MutationObserver });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'home_account');
    registered[0].afterLoading();
    assert.equal(dom.window.document.querySelector('button.change-avatar'), null);
    assert.equal($('select').length, 0);
    assert.equal($('input[type=text]').length, 0);
    assert.notEqual($('input[type=file]').css('display'), 'none');
    assert.equal($('input[type=file]').attr('accept'), '.jpg,.jpeg,.png,.webp,.heic,.heif');
    assert.equal($('[role=status]').text(), '');
    assert.equal($('[role=status]')[0].hidden, true);
  } finally { dom.window.close(); }
});

test('home_settings override preserves settings form and only customizes the account avatar area', () => {
  const nunjucks = require('nunjucks');
  class LayoutLoader extends nunjucks.Loader {
    getSource(name) {
      if (name === 'layout/home_base.html') return { src: '{% block home_content %}{% endblock %}', path: name };
      if (name === 'partials/setting.html') return { src: '<form id="settings-form"></form>', path: name };
      return null;
    }
  }
  const env = new nunjucks.Environment([new nunjucks.FileSystemLoader(path.join(__dirname, '../templates')), new LayoutLoader()], { autoescape: true });
  const context = { _: value => value, avatarUrl: () => '/file/123/local.webp', current: { uname: 'Tester', avatar: 'url:/file/123/local.webp' } };
  const account = env.render('home_settings.html', { ...context, category: 'account' });
  assert.match(account, /id="upload_avatar"/);
  assert.match(account, /style="display:none"/);
  assert.match(account, /id="settings-form"/);
  assert.doesNotMatch(account, /Gravatar/);
  const preference = env.render('home_settings.html', { ...context, category: 'preference' });
  assert.doesNotMatch(preference, /id="upload_avatar"/);
  assert.match(preference, /id="settings-form"/);
});

test('crop dialog cancels without saving and keeps the selection when a save fails', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<body></body>', { url: 'https://oj.example/home/settings/account' });
  const $ = require('jquery')(dom.window);
  const calls = [];
  const dialogs = [];
  const ui = {
    $, Notification: { success() {} },
    request: { postFile: async (url, data) => {
      calls.push({ url, data });
      if (data.get('preview')) return { preview: 'data:image/webp;base64,dGVzdA==', width: 800, height: 400 };
      throw new Error('测试保存失败');
    } },
    ActionDialog: class ActionDialog {
      constructor(options) {
        this.options = options;
        this.root = $('<div class="dialog"></div>').append(options.$body, options.$action);
        dialogs.push(this);
        this.root.on('click', '[data-action]', () => { if (options.onDispatch() !== false) this.close(); });
      }
      open() { this.root.appendTo('body'); return new Promise(resolve => { this.resolve = resolve; }); }
      close() { this.root.remove(); this.resolve('cancel'); }
    },
  };
  Object.defineProperty(dom.window.HTMLImageElement.prototype, 'src', { set() {
    Object.defineProperties(this, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    queueMicrotask(() => this.onload?.());
  } });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 480 });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 340 });
  const code = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../frontend/avatar-crop.ts')],
    bundle: true, format: 'cjs', write: false, external: ['@hydrooj/ui-default'] }).outputFiles[0].text;
  const module = { exports: {} };
  const ResizeObserver = class { observe() {} disconnect() {} };
  try {
    vm.runInNewContext(code, { module, exports: module.exports, require: () => ui, window: dom.window,
      FormData: dom.window.FormData, ResizeObserver });
    const file = new dom.window.File(['original photo'], 'photo.webp', { type: 'image/webp' });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const first = module.exports.openAvatarCrop(file);
    await tick();
    assert.equal($('.avatar-crop__save').prop('disabled'), false);
    $('[data-action=cancel]').trigger('click');
    await first;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.get('preview'), '1');

    const second = module.exports.openAvatarCrop(file);
    await tick();
    $('input[type=range]').val('50')[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    $('.avatar-crop__save').trigger('click');
    await tick();
    const save = calls.at(-1);
    assert.equal(save.url, '/home/avatar');
    assert.equal(save.data.get('file'), file, 'save sends the original photo');
    assert.equal(save.data.get('preview'), null);
    assert.deepEqual(JSON.parse(save.data.get('crop')), { left: 300, top: 100, size: 200 });
    assert.equal($('.avatar-crop__error').text(), '测试保存失败');
    assert.equal($('.avatar-crop__error')[0].hidden, false);
    assert.equal($('.avatar-crop__save').prop('disabled'), false);
    assert.equal($('.dialog').length, 1, 'failed save keeps the dialog open');
    $('[data-action=cancel]').trigger('click');
    await second;
    assert.equal(dialogs.length, 2);
  } finally { dom.window.close(); }
});
