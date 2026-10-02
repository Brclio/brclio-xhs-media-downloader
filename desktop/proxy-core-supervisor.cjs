// The open stdin pipe is a lifetime lease from the app. EOF also arrives when
// the app crashes, so an update proxy never survives its owning app process.
const { spawn } = require('node:child_process');
const { rmSync } = require('node:fs');
const [executable, directory, config] = process.argv.slice(2);
const core = spawn(executable, ['-d', directory, '-f', config], {
  stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  core.kill();
  const timer = setTimeout(() => core.kill('SIGKILL'), 1500);
  timer.unref();
}
process.stdin.resume();
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
core.on('error', () => process.exit(1));
core.on('exit', code => {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* app also cleans on normal shutdown */ }
  process.exit(stopping ? 0 : (code || 1));
});
