import createEncoder from '../assets/vendor/heic/heic-encoder.js';

let used = false;
self.onmessage = async event => {
  if (used) return;
  used = true;
  let encoder, input = 0;
  try {
    const { width, height, rgba } = event.data || {};
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1440)
      || !(rgba instanceof ArrayBuffer) || rgba.byteLength !== width * height * 4)
      throw new Error('封面像素数据无效。');
    encoder = await createEncoder({
      locateFile: name => new URL(`../assets/vendor/heic/${name}`, import.meta.url).href,
      print: () => {}, printErr: () => {}
    });
    input = encoder._malloc(rgba.byteLength);
    if (!input) throw new Error('本地编码内存不足，请缩小素材。');
    encoder.HEAPU8.set(new Uint8Array(rgba), input);
    if (!encoder._encode_heic(input, rgba.byteLength, width, height))
      throw new Error(encoder.UTF8ToString(encoder._get_error()) || 'HEVC 编码失败。');
    const size = encoder._get_result_size(), pointer = encoder._get_result_data();
    if (!pointer || size < 24 || size > 20 * 1024 * 1024) throw new Error('HEIC 文件大小无效。');
    // Copy while the C++ result is still alive; never return a view of a freed
    // std::vector or transfer the WebAssembly linear memory itself.
    const data = encoder.HEAPU8.slice(pointer, pointer + size);
    const box = new DataView(data.buffer), text = (at, count) => String.fromCharCode(...data.subarray(at, at + count));
    const ftypSize = box.getUint32(0);
    if (text(4, 4) !== 'ftyp' || ftypSize < 20 || ftypSize > data.byteLength
      || !Array.from({ length: Math.floor((ftypSize - 8) / 4) }, (_, index) => text(8 + index * 4, 4))
        .some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand)))
      throw new Error('编码器未生成真实的 HEIC 文件。');
    self.postMessage({ buffer: data.buffer }, [data.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error?.message || '本地编码失败。').slice(0, 400) });
  } finally {
    if (input) encoder?._free(input);
    encoder?._release_heic();
    self.close();
  }
};
