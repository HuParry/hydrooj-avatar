import { $, ActionDialog, Notification, request } from '@hydrooj/ui-default';

type Crop = { x: number, y: number, size: number };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function cropPayload(crop: Crop, width: number, height: number) {
  const size = clamp(Math.round(crop.size), 1, Math.min(width, height));
  return { left: clamp(Math.round(crop.x), 0, width - size), top: clamp(Math.round(crop.y), 0, height - size), size };
}

export async function openAvatarCrop(file: File) {
  const body = $(`
    <div class="avatar-crop">
      <h1>裁剪头像</h1>
      <p class="avatar-crop__intro">拖动方形选区，保留你想展示的部分。</p>
      <div class="avatar-crop__loading" role="status">正在生成图片预览…</div>
      <div class="avatar-crop__grid" hidden>
        <div>
          <div class="avatar-crop__stage">
            <div class="avatar-crop__image-wrap">
              <img class="avatar-crop__image" alt="待裁剪的头像" draggable="false">
              <div class="avatar-crop__selection" tabindex="0" role="group" aria-label="头像裁剪选区，可用方向键移动">
                <span class="avatar-crop__third avatar-crop__third--v1"></span><span class="avatar-crop__third avatar-crop__third--v2"></span>
                <span class="avatar-crop__third avatar-crop__third--h1"></span><span class="avatar-crop__third avatar-crop__third--h2"></span>
                <span class="avatar-crop__handle" aria-hidden="true"></span>
              </div>
            </div>
          </div>
          <div class="avatar-crop__tools">
            <label>选区大小 <input type="range" min="5" max="100" step="0.1" value="100" aria-label="调整选区大小"></label>
            <button type="button" class="button small rounded avatar-crop__reset">重置选区</button>
          </div>
          <p class="avatar-crop__hint">拖动选区移动 · 拖动右下角调整大小 · 方向键微调</p>
        </div>
        <aside class="avatar-crop__previews">
          <div class="avatar-crop__preview-title">头像预览</div>
          <canvas width="128" height="128" class="avatar-crop__preview" aria-label="方形头像预览"></canvas>
          <span class="avatar-crop__caption">方形显示</span>
          <canvas width="128" height="128" class="avatar-crop__preview avatar-crop__preview--round" aria-label="圆形头像预览"></canvas>
          <span class="avatar-crop__caption">圆形显示</span>
        </aside>
      </div>
      <p class="avatar-crop__error" role="alert" hidden></p>
    </div>`);
  const actions = $(`
    <span class="avatar-crop__actions">
      <button type="button" class="button rounded" data-action="cancel">取消</button>
      <button type="button" class="button rounded primary avatar-crop__save" disabled>确认并保存</button>
    </span>`);
  let saving = false;
  let alive = true;
  let finishImageLoad: (() => void) | undefined;
  let ready = false;
  let width = 0;
  let height = 0;
  let scale = 1;
  let crop: Crop = { x: 0, y: 0, size: 1 };
  let dragging: { id: number, clientX: number, clientY: number, crop: Crop, resize: boolean } | null = null;
  const dialog = new ActionDialog({
    classes: 'avatar-crop-dialog', width: '760px', $body: body, $action: actions,
    onDispatch: () => !saving,
  });
  const image = body.find('img')[0] as HTMLImageElement;
  const stage = body.find('.avatar-crop__stage')[0] as HTMLElement;
  const wrap = body.find('.avatar-crop__image-wrap')[0] as HTMLElement;
  const selection = body.find('.avatar-crop__selection')[0] as HTMLElement;
  const slider = body.find('input[type="range"]')[0] as HTMLInputElement;
  const save = actions.find('.avatar-crop__save')[0] as HTMLButtonElement;
  const error = body.find('[role="alert"]')[0] as HTMLElement;
  const form = (preview = false) => {
    const data = new FormData();
    data.append('file', file);
    if (preview) data.append('preview', '1');
    else data.append('crop', JSON.stringify(cropPayload(crop, width, height)));
    return data;
  };
  const paint = () => {
    selection.style.left = `${crop.x * scale}px`;
    selection.style.top = `${crop.y * scale}px`;
    selection.style.width = `${crop.size * scale}px`;
    selection.style.height = `${crop.size * scale}px`;
    slider.value = String(crop.size / Math.min(width, height) * 100);
    selection.setAttribute('aria-label', `头像裁剪选区，${Math.round(crop.size)} × ${Math.round(crop.size)} 像素，可用方向键移动`);
    body.find('canvas').each((index, canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, crop.x / width * image.naturalWidth, crop.y / height * image.naturalHeight,
        crop.size / width * image.naturalWidth, crop.size / height * image.naturalHeight, 0, 0, canvas.width, canvas.height);
    });
  };
  const layout = () => {
    if (!ready) return;
    scale = Math.min((stage.clientWidth - 32) / width, (stage.clientHeight - 32) / height, 1);
    scale = Math.max(scale, 0.0001);
    wrap.style.width = `${width * scale}px`;
    wrap.style.height = `${height * scale}px`;
    paint();
  };
  const resize = (size: number) => {
    const centerX = crop.x + crop.size / 2;
    const centerY = crop.y + crop.size / 2;
    crop.size = clamp(size, Math.max(1, Math.min(width, height) * 0.05), Math.min(width, height));
    crop.x = clamp(centerX - crop.size / 2, 0, width - crop.size);
    crop.y = clamp(centerY - crop.size / 2, 0, height - crop.size);
    paint();
  };
  const reset = () => {
    const size = Math.min(width, height);
    crop = { x: (width - size) / 2, y: (height - size) / 2, size };
    paint();
  };
  slider.addEventListener('input', () => resize(Math.min(width, height) * Number(slider.value) / 100));
  body.find('.avatar-crop__reset').on('click', reset);
  selection.addEventListener('pointerdown', event => {
    if (!ready || saving || (event.button !== 0 && event.pointerType !== 'touch')) return;
    event.preventDefault();
    selection.focus();
    selection.setPointerCapture(event.pointerId);
    dragging = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, crop: { ...crop }, resize: (event.target as HTMLElement).classList.contains('avatar-crop__handle') };
  });
  selection.addEventListener('pointermove', event => {
    if (!dragging || dragging.id !== event.pointerId || saving) return;
    const dx = (event.clientX - dragging.clientX) / scale;
    const dy = (event.clientY - dragging.clientY) / scale;
    if (dragging.resize) {
      crop.size = clamp(dragging.crop.size + (dx + dy) / 2, Math.max(1, Math.min(width, height) * 0.05), Math.min(width - crop.x, height - crop.y));
    } else {
      crop.x = clamp(dragging.crop.x + dx, 0, width - crop.size);
      crop.y = clamp(dragging.crop.y + dy, 0, height - crop.size);
    }
    paint();
  });
  const stopDragging = () => { dragging = null; };
  selection.addEventListener('pointerup', stopDragging);
  selection.addEventListener('pointercancel', stopDragging);
  selection.addEventListener('lostpointercapture', stopDragging);
  selection.addEventListener('keydown', event => {
    if (!ready || saving) return;
    const step = (event.shiftKey ? 10 : 1) / scale;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    crop.x = clamp(crop.x + offset[0], 0, width - crop.size);
    crop.y = clamp(crop.y + offset[1], 0, height - crop.size);
    paint();
  });
  $(save).on('click', async () => {
    if (!ready || saving) return;
    saving = true;
    actions.find('button').prop('disabled', true);
    slider.disabled = true;
    body.find('.avatar-crop__reset').prop('disabled', true);
    save.textContent = '正在保存…';
    error.hidden = true;
    try {
      await request.postFile('/home/avatar', form());
      saving = false;
      dialog.close();
      Notification.success('头像已更新。');
      window.location.reload();
    } catch (cause) {
      error.textContent = cause.message || '头像保存失败，请重试。';
      error.hidden = false;
      saving = false;
      actions.find('button').prop('disabled', false);
      slider.disabled = false;
      body.find('.avatar-crop__reset').prop('disabled', false);
      save.textContent = '确认并保存';
    }
  });
  const observer = new ResizeObserver(layout);
  observer.observe(stage);
  const closed = dialog.open();
  void (async () => {
    try {
      const preview = await request.postFile('/home/avatar', form(true));
      if (!alive) return;
      if (typeof preview.preview !== 'string' || !preview.preview.startsWith('data:image/webp;base64,')
        || !Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height) || preview.width < 1 || preview.height < 1) {
        throw new Error('图片预览无效，请重新选择。');
      }
      width = preview.width;
      height = preview.height;
      await new Promise<void>((resolve, reject) => {
        finishImageLoad = resolve;
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('图片预览加载失败。'));
        image.src = preview.preview;
      });
      if (!alive) return;
      body.find('.avatar-crop__loading').hide();
      (body.find('.avatar-crop__grid')[0] as HTMLElement).hidden = false;
      ready = true;
      reset();
      layout();
      save.disabled = false;
      selection.focus();
    } catch (cause) {
      if (!alive) return;
      body.find('.avatar-crop__loading').hide();
      error.textContent = cause.message || '无法生成预览，请重新选择图片。';
      error.hidden = false;
    }
  })();
  try { await closed; }
  finally {
    alive = false;
    observer.disconnect();
    finishImageLoad?.();
    image.onload = null;
    image.onerror = null;
  }
}
