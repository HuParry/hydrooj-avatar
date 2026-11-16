'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { LIMIT, MAX_INPUT, failure, needsConversion } = require('./policy');

exports.createProcessor = ({ waitMs = 30000, workMs = 45000, maxQueued = 3 } = {}) => {
  let active = false;
  let stopped = false;
  const queue = [];
  const workers = new Set();

  function drain() {
    if (active || stopped || !queue.length) return;
    const job = queue.shift();
    clearTimeout(job.timer);
    active = true;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      active = false;
      drain();
    });
  }

  function enqueue(run) {
    if (stopped) return Promise.reject(failure('图片压缩服务正在重载，请稍后重试。'));
    if (active && queue.length >= maxQueued) return Promise.reject(failure('图片处理繁忙，请稍后重试上传。'));
    return new Promise((resolve, reject) => {
      const job = { run, resolve, reject };
      job.timer = setTimeout(() => {
        const index = queue.indexOf(job);
        if (index !== -1) {
          queue.splice(index, 1);
          reject(failure('图片处理排队超时，请稍后重试上传。'));
        }
      }, waitMs);
      queue.push(job);
      drain();
    });
  }

  async function readInput(file) {
    if (Buffer.isBuffer(file)) {
      if (file.length > MAX_INPUT) throw failure('图片原文件不能超过 20 MiB。');
      return file;
    }
    if (typeof file === 'string') {
      if ((await fs.stat(file)).size > MAX_INPUT) throw failure('图片原文件不能超过 20 MiB。');
      const data = await fs.readFile(file);
      if (data.length > MAX_INPUT) throw failure('图片原文件不能超过 20 MiB。');
      return data;
    }
    if (!file || typeof file[Symbol.asyncIterator] !== 'function') throw failure('无法读取上传的图片。');
    const chunks = [];
    let size = 0;
    for await (const chunk of file) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > MAX_INPUT) throw failure('图片原文件不能超过 20 MiB。');
      chunks.push(data);
    }
    return Buffer.concat(chunks);
  }

  function convert(data, filename, prepare = false) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { data, filename, convert: prepare },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      workers.add(worker);
      let settled = false;
      const timer = setTimeout(() => finish(failure('图片压缩超时，请先缩小图片后再上传。')), workMs);
      async function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { await worker.terminate(); } catch {}
        workers.delete(worker);
        if (error) reject(error);
        else resolve(result);
      }
      worker.once('message', result => {
        if (result.error) return finish(failure(result.error));
        const output = Buffer.from(result.data || []);
        if (!output.length || output.length > LIMIT) return finish(failure('图片压缩结果未通过 500 KB 校验。'));
        return finish(null, prepare ? { data: output, filename: result.filename } : output);
      });
      worker.once('error', () => finish(failure('图片处理失败，请检查图片或稍后重试。')));
      worker.once('exit', () => {
        if (!settled) finish(failure('图片处理意外结束，请稍后重试。'));
      });
    });
  }

  return {
    async prepare(file, filename) {
      if (!needsConversion(filename)) return { data: await this.compress(file, filename), filename };
      return enqueue(async () => convert(await readInput(file), filename, true));
    },
    async compress(file, filename) {
      if (stopped) throw failure('图片压缩服务正在重载，请稍后重试。');
      if (Buffer.isBuffer(file) && file.length <= LIMIT) return file;
      if (typeof file === 'string') {
        const size = (await fs.stat(file)).size;
        if (size <= LIMIT) return file;
        if (size > MAX_INPUT) throw failure('图片原文件不能超过 20 MiB。');
      }
      return enqueue(async () => {
        const data = await readInput(file);
        if (data.length <= LIMIT) return data;
        return convert(data, filename);
      });
    },
    dispose() {
      stopped = true;
      for (const job of queue.splice(0)) {
        clearTimeout(job.timer);
        job.reject(failure('图片压缩服务正在重载，请稍后重试。'));
      }
      for (const worker of workers) worker.terminate().catch(() => {});
    },
  };
};
