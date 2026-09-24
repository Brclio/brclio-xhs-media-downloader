import { clipboard, ClipboardItem, nativeImage } from 'electron';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { imageDimensionsFromHeader } from '../lib/image-dimensions.js';

// Electron 44 maps text/uri-list to native copied files: one NSPasteboardItem per
// file on macOS, CF_HDROP on Windows. Multiple image/png items instead overwrite
// one another in the OS writer. Keep the whole list in a single atomic write.
// https://github.com/electron/electron/blob/v44.4.3/shell/browser/api/electron_api_clipboard_item.cc
export async function writeImageFiles(files) {
  const uris = files.map(file => pathToFileURL(file).href).join('\r\n');
  await clipboard.write([new ClipboardItem({
    'text/uri-list': new Blob([uris], { type: 'text/uri-list' })
  })]);
}

export async function writeSingleImage(file) {
  const bytes = await readFile(file);
  const pngOrJpeg = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  const dimensions = imageDimensionsFromHeader(bytes.subarray(0, 1024 * 1024));
  // nativeImage decodes PNG/JPEG only. Other formats and large/unknown canvases
  // remain usable as original files without decoding them in the main process.
  if (!pngOrJpeg || !dimensions || dimensions.width <= 0 || dimensions.height <= 0
    || dimensions.width * dimensions.height > 20_000_000) {
    await writeImageFiles([file]);
    return { kind: 'files' };
  }
  // Using bytes avoids Electron interpreting a title ending in @2x as HiDPI.
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('这张原图无法解码，请下载原图后重试。');
  const { width, height } = image.getSize();
  if (width * height > 20_000_000) throw new Error('单张图片像素过大，请改用下载原图。');
  const png = image.toPNG();
  if (png.length > 120 * 1024 ** 2) throw new Error('图片转换后超过 120 MB，请改用下载原图。');
  await clipboard.write([new ClipboardItem({
    'image/png': new Blob([png], { type: 'image/png' })
  })]);
  return { kind: 'image' };
}
