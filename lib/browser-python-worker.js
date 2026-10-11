// This worker receives HTML as data. It never loads or executes the note page.
const MAX_HTML_BYTES = 6 * 1024 * 1024;
let started = false;
self.onmessage = async event => {
  if (started) return;
  started = true;
  let py;
  try {
    const { html, noteId, kind, directImageUrl } = event.data || {};
    const directImage = kind === 'direct-image' && typeof directImageUrl === 'string' && directImageUrl.length <= 3000;
    if (!directImage && (typeof html !== 'string' || new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES
      || typeof noteId !== 'string' || !/^[A-Za-z0-9_-]{12,64}$/.test(noteId))) throw new Error('InvalidSource');
    const runtime = new URL('../assets/vendor/pyodide/314.0.7/', self.location.href);
    const { loadPyodide } = await import(new URL('pyodide.mjs', runtime).href);
    py = await loadPyodide({ indexURL: runtime.href, stdout() {}, stderr() {} });
    const response = await fetch(new URL('parser_core.py', runtime), { cache: 'no-cache', credentials: 'omit' });
    if (!response.ok) throw new Error('ParserUnavailable');
    py.runPython(await response.text());
    py.globals.set('note_html', directImage ? '' : html);
    py.globals.set('note_id', directImage ? '' : noteId);
    py.globals.set('direct_image_url', directImage ? directImageUrl : '');
    const code = directImage ? `
if not is_direct_image_url(direct_image_url):
    raise ValueError('UnsupportedImage')
asset_token = extract_original_asset_token(direct_image_url)
if not asset_token or not validate_asset_token(asset_token):
    raise ValueError('InvalidImage')
json.dumps({'title': '小红书图片', 'content': '', 'strategy': 'direct-image', 'images': [{'token': asset_token, 'url': build_no_watermark_url(asset_token), 'livePhoto': False, 'liveVideo': None}], 'videos': [], 'originalVideos': []}, ensure_ascii=False)
` : 'json.dumps(parse_note_html(note_html, note_id), ensure_ascii=False)';
    const parsed = JSON.parse(py.runPython(code));
    self.postMessage({ success: true, parsed });
  } catch {
    // Do not send traceback, HTML, media credentials or runtime details to the UI.
    self.postMessage({ success: false });
  } finally {
    py?.globals.delete('note_html'); py?.globals.delete('note_id'); py?.globals.delete('direct_image_url');
  }
};
