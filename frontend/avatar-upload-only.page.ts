import { $, addPage, NamedPage, Notification } from '@hydrooj/ui-default';
import { openAvatarCrop } from './avatar-crop';
import './avatar-crop.css';

addPage(new NamedPage('home_account', () => {
  const container = document.querySelector('#upload_avatar');
  if (!container) return;
  container.querySelector('button.change-avatar')?.remove();
  const layout = container.querySelector('.changeAvatar');
  if (!layout) return;
  layout.innerHTML = `
    <div class="avatar-upload">
      <input class="textbox avatar-upload__file" type="file" accept=".jpg,.jpeg,.png,.webp,.heic,.heif" aria-label="选择头像图片">
      <span class="avatar-upload__status" role="status" hidden></span>
    </div>`;
  const input = layout.querySelector('input') as HTMLInputElement;
  const status = layout.querySelector('[role="status"]') as HTMLElement;
  $(input).on('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.size || file.size > 8 * 1024 * 1024) {
      Notification.error('图片不能为空，且大小不能超过 8 MiB。');
      input.value = '';
      return;
    }
    input.disabled = true;
    status.textContent = '正在准备裁剪…';
    status.hidden = false;
    try { await openAvatarCrop(file); }
    catch (error) { Notification.error(error.message || '头像处理失败，请重试。'); }
    finally {
      input.disabled = false;
      input.value = '';
      status.textContent = '';
      status.hidden = true;
    }
  });
}));
