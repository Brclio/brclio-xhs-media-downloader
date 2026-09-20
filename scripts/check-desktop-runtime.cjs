const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function checkRuntime(context) {
  const platform = context.electronPlatformName;
  const architecture = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch];
  const executable = platform === 'win32' ? 'xhs-python.exe' : 'xhs-python';
  const root = context.packager.projectDir;
  const osName = { darwin: 'mac', win32: 'win' }[platform] || 'linux';
  const directory = path.join(root, 'desktop-runtime', `${osName}-${architecture}`);
  const infoFile = path.join(directory, 'build-info.json');
  if ((!fs.existsSync(path.join(directory, 'python', executable)) && !(platform === 'win32' && fs.existsSync(path.join(directory, 'python/python.exe')))) || !fs.existsSync(infoFile)) {
    throw new Error('Missing bundled Python. Run npm run desktop:prepare on the target OS/architecture first.');
  }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const normalized = { AMD64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }[info.arch] || info.arch;
  if (info.platform !== platform || normalized !== architecture) {
    throw new Error(`Bundled Python is ${info.platform}/${normalized}; build requires ${platform}/${architecture}. Build on matching hardware (see desktop CI).`);
  }
  if (platform === process.platform && architecture === process.arch) {
    const frozen = path.join(directory, 'python', executable);
    const worker = fs.existsSync(frozen) ? frozen : path.join(directory, 'python/python.exe');
    const args = fs.existsSync(frozen) ? [] : [path.join(directory, 'python/desktop/python-worker.py')];
    const result = spawnSync(worker, args, { encoding: 'utf8', timeout: 20000, windowsHide: true,
      input: JSON.stringify({ path: '/api/python_parse', method: 'POST', headers: {},
        body: JSON.stringify({ text: 'https://ci.xiaohongshu.com/desktop-build-check?imageView2/format/jpg' }) }) });
    if (result.status !== 0) throw new Error('Bundled Python did not start: ' + (result.error?.message || result.stderr));
    const response = JSON.parse(result.stdout);
    const payload = JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'));
    if (response.status !== 200 || payload.engine !== 'python' || payload.count !== 1) {
      throw new Error('Bundled Python failed the real parser smoke check.');
    }
  }
};
