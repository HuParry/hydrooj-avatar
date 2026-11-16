'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

let pending = 0;
let tail = Promise.resolve();

function runWorker(filepath, filename, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { filepath, filename, preview: options.preview, crop: options.crop },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('图片处理超时，请选择尺寸较小的图片。')), 30000);
    async function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error);
      else resolve(data);
    }
    worker.once('message', (result) => {
      if (result.error) finish(new Error(result.error));
      else finish(null, options.preview
        ? { data: Buffer.from(result.data), width: result.width, height: result.height }
        : Buffer.from(result.data));
    });
    worker.once('error', () => finish(new Error('图片处理失败，请更换图片后重试。')));
    worker.once('exit', () => {
      if (!settled) finish(new Error('图片处理意外结束，请更换图片后重试。'));
    });
  });
}

exports.processAvatar = async (filepath, filename, options = {}) => {
  if (pending >= 3) throw new Error('头像处理繁忙，请稍后重试。');
  pending++;
  const job = tail.then(() => runWorker(filepath, filename, options));
  tail = job.catch(() => {});
  try {
    return await job;
  } finally {
    pending--;
  }
};
