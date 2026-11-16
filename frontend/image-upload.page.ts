import { $, addPage, NamedPage, Editor, Notification, uploadFiles } from '@hydrooj/ui-default';
import { nanoid } from 'nanoid';

const extensions = /\.(jpe?g|jpe|jfif|png|apng|gif|webp|avif|heic|heif|hif|bmp|dib|tiff?|ico|cur|svg|svgz|jxl|jp2|j2k|jpx)$/i;
const mimeExtensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/apng': 'apng', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/heic-sequence': 'heic', 'image/heif-sequence': 'heif', 'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp', 'image/tiff': 'tiff', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/svg+xml': 'svg', 'image/jxl': 'jxl', 'image/jp2': 'jp2',
};

export function imageExtension(file: File) {
  if (/\.svg\.gz$/i.test(file.name)) return 'svg.gz';
  return mimeExtensions[file.type.toLowerCase()] || extensions.exec(file.name)?.[1].toLowerCase();
}

function codeMirror(editor: any) {
  return editor.markdownEditor?.getEditorView?.();
}

export function insertText(editor: any, text: string) {
  if (editor.detached) return;
  if (editor.editor) {
    editor.editor.executeEdits('image-upload', [{ range: editor.editor.getSelection(), text, forceMoveMarkers: true }]);
  } else if (codeMirror(editor)) {
    const view = codeMirror(editor);
    view.dispatch(view.state.replaceSelection(text));
  } else if (editor.markdownEditor?.insert) {
    editor.markdownEditor.insert(() => ({ targetValue: text, select: false }));
  } else {
    const textarea = editor.$dom[0] as HTMLTextAreaElement;
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export async function uploadImages(editor: any, files: File[]) {
  for (const file of files) {
    const ext = imageExtension(file);
    if (!ext) { Notification.error('暂不支持这种图片格式。'); continue; }
    if (!file.size || file.size > 20 * 1024 * 1024) {
      Notification.error('图片不能为空，且原文件不能超过 20 MiB。');
      continue;
    }
    const id = nanoid();
    const filename = `${id}.${ext}`;
    const editing = document.documentElement.getAttribute('data-page') === 'problem_edit';
    try {
      await uploadFiles(editing ? './files' : '/file', [file], {
        type: editing ? 'additional_file' : undefined,
        filenameCallback: () => filename,
      });
      const actual = /^(jpe?g|jpe|jfif|png|apng|webp|gif|avif)$/.test(ext) ? filename : `${id}.webp`;
      insertText(editor, `![image](file://${actual}) `);
    } catch {
      continue;
    }
  }
}

let installed = false;
addPage(new NamedPage(['problem_create', 'problem_edit'], () => {
  if (installed) return;
  installed = true;
  const getEditor = (textarea: Element) => Editor.get($(textarea));
  const activeEditor = (target: EventTarget | null) => {
    if (!(target instanceof Node)) return null;
    for (const textarea of document.querySelectorAll('textarea[data-editor]')) {
      const editor = getEditor(textarea);
      if (editor?.editor?.hasTextFocus()) return editor;
      if (editor?.editor?.getDomNode()?.contains(target)) return editor;
      const view = editor && codeMirror(editor);
      if (view?.dom?.contains(target)) return editor;
      if (editor?.markdownEditor && textarea.parentElement?.contains(target)) return editor;
      if (target === textarea && editor?.isValid) return editor;
    }
    return null;
  };
  window.addEventListener('paste', (event) => {
    if (event.defaultPrevented) return;
    const editor = activeEditor(event.target);
    if (!editor) return;
    if (/^image\/(png|jpe?g|gif)$/i.test(event.clipboardData?.items[0]?.type || '')) return;
    const itemFiles = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file')
      .map(item => item.getAsFile()).filter((file): file is File => !!file);
    const files = (itemFiles.length ? itemFiles : Array.from(event.clipboardData?.files || []))
      .filter(file => !!imageExtension(file) || file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void uploadImages(editor, files);
  }, { capture: true });
  window.addEventListener('dragover', (event) => {
    if (activeEditor(event.target) && Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  }, { capture: true });
  window.addEventListener('drop', (event) => {
    if (event.defaultPrevented) return;
    const editor = activeEditor(event.target);
    const files = Array.from(event.dataTransfer?.files || []).filter(file => !!imageExtension(file) || file.type.startsWith('image/'));
    if (!editor || !files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void uploadImages(editor, files);
  }, { capture: true });
  window.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const editor = activeEditor(input);
    const files = Array.from(input.files || []);
    if (!editor || !files.length || files.every(file => /^image\/(png|jpe?g|gif)$/i.test(file.type))) return;
    if (!files.every(file => !!imageExtension(file) || file.type.startsWith('image/'))) return;
    event.stopImmediatePropagation();
    void uploadImages(editor, files);
    input.value = '';
  }, { capture: true });
}));
