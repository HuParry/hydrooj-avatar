'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { StorageModel, UserModel, ValidationError } = require('hydrooj');
const { processAvatar } = require('./avatar/process');

const uploading = new Set();

exports.apply = (ctx) => {
  require('./image-compress').apply(ctx);
  ctx.on('handler/before/HomeAvatar#post', (handler) => {
    // Replace only this request's method, retaining Hydro's authentication and CSRF checks.
    handler.post = async function () {
      const uid = this.user._id;
      if (uploading.has(uid)) throw new ValidationError('file', '', '头像正在处理，请稍后重试。');
      uploading.add(uid);
      try {
        const file = this.request.files.file;
        if (this.args.avatar || !file) {
          throw new ValidationError('file', '', '请选择本地图片上传头像。');
        }
        const ext = path.extname(file.originalFilename || '').toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext)) {
          throw new ValidationError('file', '', '仅支持 JPG、PNG、WebP、HEIC 和 HEIF 图片。');
        }
        if (file.size > 8 * 1024 * 1024 || (await fs.stat(file.filepath)).size > 8 * 1024 * 1024) {
          throw new ValidationError('file', '', '图片大小不能超过 8 MiB。');
        }
        let output;
        try {
          if (this.args.preview === '1') {
            const preview = await processAvatar(file.filepath, file.originalFilename, { preview: true });
            this.response.body = {
              preview: 'data:image/webp;base64,' + preview.data.toString('base64'),
              width: preview.width,
              height: preview.height,
            };
            return;
          }
          let crop;
          if (this.args.crop != null) {
            if (typeof this.args.crop !== 'string' || this.args.crop.length > 256) throw new Error('图片裁剪参数无效。');
            try { crop = JSON.parse(this.args.crop); } catch { throw new Error('图片裁剪参数无效。'); }
          }
          output = await processAvatar(file.filepath, file.originalFilename, { crop });
        } catch (error) {
          throw new ValidationError('file', '', error.message);
        }

        const hash = createHash('sha256').update(output).digest('hex').slice(0, 16);
        const filename = '.avatar-' + hash + '.webp';
        const storagePath = 'user/' + uid + '/' + filename;
        const avatar = 'url:/file/' + uid + '/' + filename;
        const previous = this.user.avatar;
        await StorageModel.put(storagePath, output, uid);
        try {
          await UserModel.setById(uid, { avatar });
        } catch (error) {
          if (previous !== avatar) await StorageModel.del([storagePath]).catch(() => {});
          throw error;
        }
        const oldPrefix = 'url:/file/' + uid + '/';
        if (previous && previous !== avatar && previous.startsWith(oldPrefix)) {
          const oldName = previous.slice(oldPrefix.length);
          if (/^\.avatar(?:-[0-9a-f]{16})?\.(?:jpe?g|png|webp)$/.test(oldName)) {
            await StorageModel.del(['user/' + uid + '/' + oldName]).catch((error) => {
              console.error('[avatar-upload-only] Old avatar cleanup failed:', error.message);
            });
          }
        }
        this.back();
      } finally {
        uploading.delete(uid);
      }
    };
  });
};
