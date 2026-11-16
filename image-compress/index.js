'use strict';

const fs = require('node:fs/promises');
const { createProcessor } = require('./process');
const { isImageName, isTarget, LIMIT } = require('./policy');
const marker = Symbol.for('addon.image-compress.storage-put');

exports.apply = ctx => {
  const { StorageModel, ValidationError, PRIV } = require('hydrooj');
  const original = StorageModel.put;
  if (original[marker]) return;
  const processor = createProcessor();
  const compress = async (file, filename) => {
    try { return await processor.compress(file, filename); }
    catch (error) {
      throw new ValidationError('file', '', error.imageCompression
        ? error.message : '图片压缩失败，请检查图片或稍后重试。');
    }
  };

  async function put(target, file, ...args) {
    if (!isTarget(target)) return original.call(this, target, file, ...args);
    const result = await compress(file, target);
    if (Buffer.isBuffer(result) && result.length > LIMIT) throw new ValidationError('file', '', '图片不能超过 500 KB。');
    return original.call(this, target, result, ...args);
  }
  put[marker] = true;
  StorageModel.put = put;

  const beforeUpload = (kind) => async handler => {
    if (handler.args.operation !== 'upload_file') return;
    if (kind === 'problem' && handler.args.type !== 'additional_file') return;
    const file = handler.request.files?.file;
    if (!file || Array.isArray(file)) return;
    const filename = handler.args.filename || file.originalFilename;
    if (!isImageName(filename)) return;
    if (kind === 'user') handler.checkPriv(PRIV.PRIV_CREATE_FILE);
    let prepared;
    try { prepared = await processor.prepare(file.filepath, filename); }
    catch (error) { throw new ValidationError('file', '', error.imageCompression ? error.message : '图片无法解码或转换，请更换图片后重试。'); }
    const output = prepared.data;
    handler.args.filename = prepared.filename;
    if (handler.request.body) handler.request.body.filename = prepared.filename;
    file.originalFilename = prepared.filename;
    if (handler.response) handler.response.body = { ...handler.response.body, imageFilename: prepared.filename };
    if (Buffer.isBuffer(output)) {
      await fs.writeFile(file.filepath, output);
      file.size = output.length;
    } else {
      file.size = (await fs.stat(file.filepath)).size;
    }
  };
  ctx.on('handler/before-operation/ProblemFiles', beforeUpload('problem'));
  ctx.on('handler/before-operation/Files', beforeUpload('user'));
  ctx.on('handler/before-operation/ContestManagement', beforeUpload('contest'));
  ctx.on('dispose', () => {
    if (StorageModel.put === put) StorageModel.put = original;
    processor.dispose();
  });
  console.info('[image-compress] Active: image attachments <= 500000 bytes; testdata excluded.');
};
