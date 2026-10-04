// Portable software HEIC gate. macOS additionally checks real ImageIO decoding.
// Run: electron scripts/verify-heic-encoder.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-heic-encoder-'));
app.setPath('userData', path.join(temporary, 'profile'));
const allowed = new Set(['/lib/live-photo-heic-encoder.js', '/lib/live-photo-heic-worker.js',
  '/assets/vendor/heic/heic-encoder.js', '/assets/vendor/heic/heic-encoder.wasm']);
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src blob:; style-src 'none'";
let window, server, finished = false;
const timeout = setTimeout(() => finish(new Error('Software HEIC verification timed out.')), 240000);
function finish(error, result) {
  if (finished) return;
  finished = true; clearTimeout(timeout); window?.destroy(); server?.closeAllConnections(); server?.close();
  if (error) console.error(error.stack || error);
  else console.log(JSON.stringify({ result: 'PASS', platform: process.platform, directory: temporary, ...result }));
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  const requests = [], rendererErrors = [];
  server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Software HEIC encoder</title>'); return; }
    if (!allowed.has(request.url)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', request.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    response.end(fs.readFileSync(path.join(root, request.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', details => { if (details.level === 'error') rendererErrors.push(details.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
  await window.loadURL(origin + '/');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const { encodeHeicCanvas } = await import('/lib/live-photo-heic-encoder.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const workers = new Set(), NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); workers.add(this); }
      terminate() { workers.delete(this); super.terminate(); }
    };
    const canvas = document.createElement('canvas');
    const paint = (width, height) => {
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#d94335'; context.fillRect(0, 0, width / 2, height);
      context.fillStyle = '#3764cc'; context.fillRect(width / 2, 0, width / 2, height);
      context.fillStyle = '#fdfaf2'; context.font = Math.max(20, width / 16) + 'px sans-serif'; context.fillText('HEIC local', width / 9, height / 2);
    };
    paint(320, 192);
    const started = performance.now(), fixture = await encodeHeicCanvas(canvas);
    const fixtureMs = performance.now() - started;
    check(fixture instanceof Uint8Array && fixture.length > 200, 'Encoder must return real HEIC bytes.');
    check(String.fromCharCode(...fixture.slice(4, 8)) === 'ftyp', 'HEIC must be an ISO BMFF container.');
    check(workers.size === 0, 'Completed worker must terminate.');
    const controller = new AbortController();
    const pending = encodeHeicCanvas(canvas, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    let cancelled = false;
    try { await pending; } catch (error) { cancelled = error.name === 'AbortError'; }
    check(cancelled && workers.size === 0, 'Cancellation must reject and terminate its worker.');
    const preaborted = new AbortController(); preaborted.abort();
    try { await encodeHeicCanvas(canvas, { signal: preaborted.signal }); throw new Error('Pre-abort did not reject'); }
    catch (error) { check(error.name === 'AbortError', 'Pre-abort must reject with AbortError.'); }
    paint(1440, 960);
    const largeStarted = performance.now(), large = await encodeHeicCanvas(canvas), largeMs = performance.now() - largeStarted;
    check(large.length > fixture.length && workers.size === 0, 'Production-size HEIC must finish and release memory.');
    const invalid = document.createElement('canvas'); invalid.width = 1441; invalid.height = 2;
    let rejected = false; try { await encodeHeicCanvas(invalid); } catch { rejected = true; }
    check(rejected && workers.size === 0, 'Out-of-limit dimensions must reject before worker launch.');
    return { fixture: Array.from(fixture), large: Array.from(large), fixtureMs, largeMs, cancellation: true, cleanup: true, limits: true };
  })()`, true);
  assert.deepEqual(rendererErrors, [], 'HEIC runtime must run with no JS unsafe-eval or renderer errors');
  for (const asset of allowed) assert(requests.includes(asset), `Local runtime asset must be requested: ${asset}`);
  const fixturePath = path.join(temporary, 'software-cover.HEIC'), largePath = path.join(temporary, 'software-large.HEIC');
  fs.writeFileSync(fixturePath, Buffer.from(result.fixture)); fs.writeFileSync(largePath, Buffer.from(result.large));
  const sizes = { fixture: result.fixture.length, large: result.large.length };
  delete result.fixture; delete result.large;
  let imageIO;
  if (process.platform === 'darwin') {
    const swift = path.join(temporary, 'decode.swift');
    fs.writeFileSync(swift, `import Foundation\nimport ImageIO\nimport CoreGraphics\nlet source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!\nlet type = CGImageSourceGetType(source)! as String\nlet image = CGImageSourceCreateImageAtIndex(source, 0, nil)!\nguard type == "public.heic" && image.width == Int(CommandLine.arguments[2])! && image.height == Int(CommandLine.arguments[3])! else { fatalError("Invalid HEIC image") }\nlet color = CGColorSpace(name: CGColorSpace.sRGB)!\nlet context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: color, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!\ncontext.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))\nlet pixels = context.data!.assumingMemoryBound(to: UInt8.self)\nlet left = (image.height / 4 * image.width + image.width / 4) * 4\nlet right = (image.height / 4 * image.width + image.width * 3 / 4) * 4\nguard pixels[left] > pixels[left + 2] + 60 && pixels[right + 2] > pixels[right] + 60 else { fatalError("HEIC pixels lost the red and blue source regions") }\nprint("ImageIO decoded public.heic \\(image.width)x\\(image.height) with correct red/blue pixels")\n`);
    const small = execFileSync('swift', [swift, fixturePath, '320', '192'], { encoding: 'utf8', timeout: 60000 }).trim();
    const large = execFileSync('swift', [swift, largePath, '1440', '960'], { encoding: 'utf8', timeout: 60000 }).trim();
    imageIO = { small, large };
  }
  const report = { ...result, sizes, strictCsp: csp, localRequests: [...new Set(requests)], imageIO, fixturePath, largePath };
  fs.writeFileSync(path.join(temporary, 'verification.json'), JSON.stringify(report, null, 2));
  finish(null, report);
}).catch(error => finish(error));
