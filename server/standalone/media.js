import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}

const busy = () => new HttpError(503, 'SERVER_BUSY', '服务繁忙，请稍后重试。');
const unavailable = () => new HttpError(503, 'MEDIA_UNAVAILABLE', '媒体服务暂时不可用。');
const timeout = () => new HttpError(504, 'REQUEST_TIMEOUT', '请求超时，请稍后重试。');

/** Each job has a concurrency cap and can be terminated even during a stalled upstream body. */
export function createMediaRuntime({ python = 'python3', timeoutMs = 25_000, nodeConcurrency = 4, pythonConcurrency = 2,
  nodeWorker = new URL('./media-worker.mjs', import.meta.url), pythonWorker = fileURLToPath(new URL('./python-worker.py', import.meta.url)),
} = {}) {
  const jobs = new Set();
  let nodeActive = 0, pythonActive = 0, closed = false;

  function runNode(route, request, signal) {
    if (signal?.aborted) return Promise.reject(timeout());
    if (closed || nodeActive >= nodeConcurrency) return Promise.reject(busy());
    nodeActive += 1;
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(nodeWorker, { workerData: { route, request }, env: { NODE_ENV: 'production' },
          // Do not inherit --test/--inspect/--env-file or preload hooks from the parent.
          execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 } });
      } catch { nodeActive -= 1; reject(unavailable()); return; }
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        jobs.delete(abort);
        // Keep the slot reserved until the isolate has actually stopped.
        worker.terminate().then(() => {
          nodeActive -= 1;
          error ? reject(error) : resolve(value);
        }, () => {
          nodeActive -= 1;
          reject(error || unavailable());
        });
      };
      const abort = () => finish(timeout());
      const timer = setTimeout(abort, timeoutMs);
      jobs.add(abort);
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', value => finish(null, value));
      worker.once('error', () => finish(unavailable()));
      worker.once('exit', () => { if (!done) finish(unavailable()); });
      if (signal?.aborted) abort();
    });
  }

  function runPython(request, signal, health = false) {
    if (signal?.aborted) return Promise.reject(timeout());
    if (closed || pythonActive >= pythonConcurrency) return Promise.reject(busy());
    pythonActive += 1;
    return new Promise((resolve, reject) => {
      // Child processes receive no account, GitHub, SMTP, or application secrets.
      const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
        .filter(key => process.env[key]).map(key => [key, process.env[key]]));
      const child = spawn(python, ['-I', '-B', pythonWorker, ...(health ? ['--health'] : [])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      let size = 0, stderrSize = 0, done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        jobs.delete(abort);
        if (error) child.kill('SIGKILL');
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(timeout());
      const timer = setTimeout(abort, health ? Math.min(timeoutMs, 10_000) : timeoutMs);
      jobs.add(abort);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 6_000_000) { finish(unavailable()); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize > 32_768) finish(unavailable()); });
      child.stdin.on('error', () => finish(unavailable()));
      child.once('error', () => finish(unavailable()));
      child.once('close', code => {
        pythonActive -= 1;
        if (done) return;
        if (code !== 0) { finish(unavailable()); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
          if (health) {
            if (value.ok !== true) throw new Error('Python health failed');
          } else {
            if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599 || typeof value.body !== 'string') throw new Error('Invalid Python response');
            value.body = Buffer.from(value.body, 'base64');
          }
          finish(null, value);
        } catch { finish(unavailable()); }
      });
      if (signal?.aborted) abort();
      child.stdin.end(health ? '' : JSON.stringify(request));
    });
  }
  return { runNode, runPython, check: () => runPython(null, null, true), close() { closed = true; for (const abort of [...jobs]) abort(); } };
}
