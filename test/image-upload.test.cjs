'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

const code = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../frontend/image-upload.page.ts')],
  bundle: true, format: 'cjs', write: false, external: ['@hydrooj/ui-default'] }).outputFiles[0].text;

function setup(page, kind, postFile) {
  const dom = new JSDOM(`<html data-page="${page}"><body><div><textarea data-editor></textarea><div id="editor"><textarea id="typing"></textarea></div></div></body></html>`, { url: 'https://oj.example/p/create' });
  const $ = require('jquery')(dom.window);
  const callbacks = [];
  const errors = [];
  let value = 'before after';
  let cursor = 7;
  const change = ({ from, to, insert }) => { value = value.slice(0, from) + insert + value.slice(to); cursor = from + insert.length; };
  const root = dom.window.document.querySelector('#editor');
  const editor = { isValid: true, $dom: $('textarea[data-editor]'), value: () => value };
  if (kind === 'monaco') {
    editor.editor = { hasTextFocus: () => dom.window.document.activeElement?.id === 'typing', getDomNode: () => root,
      getSelection: () => ({ start: cursor, end: cursor }),
      executeEdits: (source, edits) => edits.forEach(edit => change({ from: edit.range.start, to: edit.range.end, insert: edit.text })) };
    editor.model = { findMatches: marker => {
      const start = value.indexOf(marker);
      return start < 0 ? [] : [{ range: { start, end: start + marker.length } }];
    } };
  } else {
    const view = { dom: root, state: { doc: { toString: () => value },
      replaceSelection: text => ({ changes: { from: cursor, to: cursor, insert: text } }) }, dispatch: transaction => change(transaction.changes) };
    editor.markdownEditor = { getEditorView: () => view };
  }
  const ui = { $, Editor: { get: () => editor }, Notification: { error: message => errors.push(message) },
    uploadFiles: async (url, files, options) => {
      const data = new dom.window.FormData();
      data.append('filename', options.filenameCallback(files[0]));
      data.append('file', files[0]);
      data.append('operation', 'upload_file');
      if (options.type) data.append('type', options.type);
      try { await postFile(url, data); }
      catch (error) { errors.push(error.message); throw error; }
    }, addPage: page => callbacks.push(page), NamedPage: class {
      constructor(name, afterLoading) { this.name = name; this.afterLoading = afterLoading; }
    } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: () => ui,
    window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
    HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event,
    crypto: require('node:crypto').webcrypto,
    FormData: dom.window.FormData, MutationObserver: dom.window.MutationObserver });
  assert.deepEqual(Array.from(callbacks[0].name), ['problem_create', 'problem_edit']);
  callbacks[0].afterLoading();
  assert.equal(dom.window.document.querySelector('button, input[type=file]'), null);
  const paste = (files, firstText = false) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [
      ...(firstText ? [{ kind: 'string', type: 'text/plain' }] : []),
      ...files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    ] } });
    const typing = dom.window.document.querySelector('#typing');
    typing.focus();
    typing.dispatchEvent(event);
    return event;
  };
  return { dom, editor, errors, paste, exports: module.exports, value: () => value,
    append: text => { value += text; } };
}

test('HEIC paste works in both editors and uses the converted filename in create and edit routes', async () => {
  for (const kind of ['monaco', 'split']) for (const page of ['problem_create', 'problem_edit']) {
    const calls = [];
    let finish;
    const h = setup(page, kind, (url, data) => {
      calls.push({ url, data });
      return new Promise(resolve => { finish = resolve; });
    });
    try {
      const file = new h.dom.window.File(['heic fixture'], 'iphone.heic', { type: 'image/heic' });
      assert.equal(h.paste([file], true).defaultPrevented, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, page === 'problem_create' ? '/file' : './files');
      assert.equal(calls[0].data.get('file'), file);
      assert.equal(calls[0].data.get('type'), page === 'problem_edit' ? 'additional_file' : null);
      assert.match(calls[0].data.get('filename'), /\.heic$/);
      assert.equal(h.value(), 'before after');
      h.append(' newly typed content');
      finish({ imageFilename: 'converted.webp' });
      await new Promise(resolve => setImmediate(resolve));
      const saved = calls[0].data.get('filename').replace(/\.heic$/, '.webp');
      assert.equal(h.value(), `before ![image](file://${saved}) after newly typed content`);
      assert.deepEqual(h.errors, []);
    } finally { h.dom.window.close(); }
  }
});

test('native PNG/JPEG/GIF paste remains with Hydro and later clipboard image items are detected', async () => {
  const calls = [];
  const h = setup('problem_create', 'monaco', async (url, data) => { calls.push(data); return {}; });
  try {
    for (const type of ['image/png', 'image/jpeg', 'image/gif']) {
      const file = new h.dom.window.File(['image'], 'image', { type });
      assert.equal(h.paste([file]).defaultPrevented, false);
    }
    assert.equal(calls.length, 0);
    const png = new h.dom.window.File(['image'], 'clipboard.png', { type: 'image/png' });
    assert.equal(h.paste([png], true).defaultPrevented, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.match(h.value(), /file:\/\/[\w-]{21}\.png/);
  } finally { h.dom.window.close(); }
});

test('file selection supports WebP, AVIF and filename-only image types with clear failure messages', async () => {
  const h = setup('problem_edit', 'split', async () => { throw new Error('图片无法解码'); });
  try {
    for (const [name, type, extension] of [['a.webp', 'image/webp', 'webp'], ['a.avif', 'image/avif', 'avif'],
      ['a.HEIF', '', 'heif'], ['a.tiff', 'application/octet-stream', 'tiff'], ['a.svg.gz', '', 'svg.gz']]) {
      assert.equal(h.exports.imageExtension(new h.dom.window.File(['x'], name, { type })), extension);
    }
    await h.exports.uploadImages(h.editor, [new h.dom.window.File(['x'], 'a.heic', { type: 'image/heic' })]);
    assert.equal(h.value(), 'before after');
    assert.deepEqual(h.errors, ['图片无法解码']);
  } finally { h.dom.window.close(); }
});

test('clipboard file lists, drag and drop, and native editor file controls accept extended formats', async () => {
  const calls = [];
  const h = setup('problem_edit', 'split', async (url, data) => {
    calls.push({ url, filename: data.get('filename') });
    return { imageFilename: 'normalized.webp' };
  });
  try {
    const file = new h.dom.window.File(['HEIC bytes'], 'photo.HEIC');
    const typing = h.dom.window.document.querySelector('#typing');
    const paste = new h.dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { items: [], files: [file] } });
    typing.dispatchEvent(paste);
    const drop = new h.dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    typing.dispatchEvent(drop);
    const input = h.dom.window.document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    h.dom.window.document.querySelector('#editor').append(input);
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(paste.defaultPrevented, true);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.url === './files' && call.filename.endsWith('.heic')));
    assert.equal((h.value().match(/file:\/\/[\w-]{21}\.webp/g) || []).length, 3);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});
