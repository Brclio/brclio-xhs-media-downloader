import { parentPort, workerData } from 'node:worker_threads';
import parse from '../../api/parse.js';
import image from '../../api/image.js';
import video, { createVideoHandler } from '../../api/video.js';
import { resolveOriginalVideos } from '../../lib/member-video-handler.js';
import { XhsError } from '../../lib/xhs.js';

const handlers = { '/api/parse': parse, '/api/image': image, '/api/video': video,
  // Only the HTTP gateway can dispatch this after authorizing a decrypted ticket.
  '/internal/member-video-download': createVideoHandler({ authorizeOriginal: async () => {} }) };
const headers = {};
let status = 200, body = '';
const response = {
  setHeader(name, value) { headers[name] = String(value); return this; },
  status(value) { status = value; return this; },
  json(value) { headers['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(value); return this; },
  send(value) { body = value; return this; },
};
try {
  if (workerData.route === '/internal/member-video-resolve') {
    response.json(await resolveOriginalVideos(workerData.request.text));
  } else await handlers[workerData.route](workerData.request, response);
  parentPort.postMessage({ status, headers, body });
} catch (error) {
  const known = error instanceof XhsError;
  parentPort.postMessage({ status: known ? error.statusCode : 503, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, ...(error.code ? { code: error.code } : {}), message: known ? error.message : '媒体服务暂时不可用。' }) });
}
