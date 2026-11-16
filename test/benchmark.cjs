'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');

sharp.concurrency(1);
sharp.cache(false);

function noise(size) {
  const data = Buffer.allocUnsafe(size);
  let seed = 123456789;
  for (let i = 0; i < size; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data[i] = seed & 255;
  }
  return data;
}

const formatOf = meta => meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hydro-avatar-benchmark-'));
  const roots = process.env.HYDRO_AVATAR_BASELINE
    ? [['baseline', path.resolve(process.env.HYDRO_AVATAR_BASELINE)], ['optimized', path.resolve(__dirname, '..')]]
    : [['optimized', path.resolve(__dirname, '..')]];
  const processors = roots.map(([name, root]) => [name, require(path.join(root, 'image-compress/process')).createProcessor()]);
  const files = process.argv.slice(2).map(file => path.resolve(file));
  const write = async (name, data) => {
    assert.ok(data.length > 500000, `${name}: benchmark input must exceed 500 KB`);
    const file = path.join(directory, name);
    await fs.writeFile(file, data);
    files.push(file);
  };
  const results = [];
  try {
    await write('noise.webp', await sharp(noise(1500 * 1000 * 3), {
      raw: { width: 1500, height: 1000, channels: 3 },
    }).webp({ lossless: true, effort: 0 }).toBuffer());
    await write('large-noise.webp', await sharp(noise(2400 * 1200 * 3), {
      raw: { width: 2400, height: 1200, channels: 3 },
    }).webp({ lossless: true, effort: 0 }).toBuffer());
    await write('alpha.avif', await sharp(noise(800 * 600 * 4), {
      raw: { width: 800, height: 600, channels: 4 },
    }).avif({ quality: 100, effort: 0 }).toBuffer());
    await write('large-alpha.avif', await sharp(noise(1600 * 1500 * 4), {
      raw: { width: 1600, height: 1500, channels: 4 },
    }).avif({ quality: 100, effort: 0 }).toBuffer());
    const delay = Array.from({ length: 12 }, (_, i) => 50 + 10 * i);
    await write('animation.gif', await sharp(noise(320 * 240 * 12 * 3), {
      raw: { width: 320, height: 240 * 12, channels: 3, pageHeight: 240 },
    }).gif({ colours: 256, effort: 3, keepDuplicateFrames: true, loop: 2, delay }).toBuffer());
    await write('alpha-animation.webp', await sharp(noise(640 * 360 * 12 * 4), {
      raw: { width: 640, height: 360 * 12, channels: 4, pageHeight: 360 },
    }).webp({ lossless: true, effort: 0, loop: 3, delay }).toBuffer());

    for (const file of files) {
      const before = await sharp(file, { animated: true }).metadata();
      const stat = await fs.stat(file);
      const entry = { name: path.basename(file), inputBytes: stat.size, format: formatOf(before),
        width: before.width, height: before.pageHeight || before.height, frames: before.pages || 1, runs: [] };
      for (const [name, processor] of processors) {
        const started = performance.now();
        let output;
        try {
          output = await processor.compress(file, file);
        } catch (error) {
          const run = { name, ms: +(performance.now() - started).toFixed(2), error: error.message };
          entry.runs.push(run);
          console.log(JSON.stringify({ file: entry.name, ...run }));
          if (name === 'optimized') throw error;
          continue;
        }
        const ms = performance.now() - started;
        assert.ok(Buffer.isBuffer(output) && output.length <= 500000, `${entry.name}: invalid output size`);
        const after = await sharp(output, { animated: true }).metadata();
        assert.equal(formatOf(after), formatOf(before));
        assert.equal(after.pages || 1, before.pages || 1);
        if (before.hasAlpha) assert.equal(after.hasAlpha, true);
        if (entry.frames > 1) {
          assert.deepEqual(after.delay, before.delay);
          assert.equal(after.loop, before.loop);
        }
        const run = { name, ms: +ms.toFixed(2), outputBytes: output.length, width: after.width,
          height: after.pageHeight || after.height, frames: after.pages || 1, hasAlpha: after.hasAlpha };
        entry.runs.push(run);
        console.log(JSON.stringify({ file: entry.name, ...run }));
        if (process.env.HYDRO_AVATAR_BENCHMARK_OUTPUT) {
          const out = path.resolve(process.env.HYDRO_AVATAR_BENCHMARK_OUTPUT);
          await fs.mkdir(out, { recursive: true });
          await fs.writeFile(path.join(out, `${name}-${entry.name}`), output);
        }
      }
      results.push(entry);
    }
    if (process.env.HYDRO_AVATAR_BENCHMARK_OUTPUT) {
      await fs.writeFile(path.join(path.resolve(process.env.HYDRO_AVATAR_BENCHMARK_OUTPUT), 'results.json'), JSON.stringify(results, null, 2));
    }
  } finally {
    for (const [, processor] of processors) processor.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
