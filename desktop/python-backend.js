import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export class PythonBackend {
  constructor({ appDirectory, resourcesDirectory, packaged = false, command } = {}) {
    this.appDirectory = appDirectory;
    this.resourcesDirectory = resourcesDirectory;
    this.packaged = packaged;
    this.overrideCommand = command;
    this.available = false;
    this.children = new Set();
  }

  async initialize() {
    const filename = process.platform === 'win32' ? 'xhs-python.exe' : 'xhs-python';
    const runtimeDirectory = this.packaged ? path.join(this.resourcesDirectory, 'python')
      : path.join(this.appDirectory, 'desktop-runtime', `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`, 'python');
    const bundled = path.join(runtimeDirectory, filename);
    try {
      await access(bundled);
      this.command = bundled;
      this.args = [];
    } catch {
      const embedded = path.join(runtimeDirectory, 'python.exe');
      if (process.platform === 'win32') {
        try {
          await access(embedded);
          this.command = embedded;
          this.args = [path.join(runtimeDirectory, 'desktop/python-worker.py')];
        } catch { /* Native frozen worker or developer fallback below. */ }
      }
      if (!this.command && this.packaged) return false; // Never depend on an end user's Python install.
      if (!this.command) {
        this.command = this.overrideCommand || (process.platform === 'win32' ? 'python' : 'python3');
        this.args = [path.join(this.appDirectory, 'desktop/python-worker.py')];
      }
    }
    try {
      const health = JSON.parse(await this.run(['--health'], '', undefined, 15000));
      this.available = health.ok === true && health.engine === 'python';
    } catch { this.available = false; }
    return this.available;
  }

  run(extraArgs, input, signal, timeoutMs = 90000) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('请求已取消。'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.args, ...extraArgs], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      });
      this.children.add(child);
      const chunks = [];
      let length = 0;
      let settled = false;
      const complete = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.children.delete(child);
        error ? reject(error) : resolve(result);
      };
      const abort = () => { child.kill(); complete(new Error('请求已取消。')); };
      const timer = setTimeout(() => {
        child.kill(); complete(new Error('Python 本地后台请求超时。'));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => {
        length += chunk.length;
        if (length > 9 * 1024 * 1024) {
          child.kill(); complete(new Error('Python 后台响应过大。')); return;
        }
        chunks.push(chunk);
      });
      // Drain stderr; source errors must not leak input URLs or tokens into renderer logs.
      child.stderr.resume();
      child.once('error', (error) => complete(error));
      child.once('close', (code) => complete(code === 0 ? null : new Error('Python 本地后台已退出。'), Buffer.concat(chunks).toString('utf8')));
      child.stdin.on('error', (error) => complete(error));
      child.stdin.end(input);
    });
  }

  async request(request, signal) {
    if (!this.available) throw new Error('Python 后台不可用。');
    const response = JSON.parse(await this.run([], JSON.stringify(request), signal));
    const body = [204, 205, 304].includes(response.status) ? null : Buffer.from(response.body || '', 'base64');
    return new Response(body, { status: response.status, headers: response.headers });
  }

  close() {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
