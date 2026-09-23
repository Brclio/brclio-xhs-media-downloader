import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, glob, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { verifyAsar } from '../scripts/verify-promoted-installer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

test('packaged membership catalog and payment codes match the reviewed source bytes', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'brclio-packaged-membership-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const archive = path.join(temporary, 'app.asar');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  // Follow the real packaging selection, independently of the verifier's
  // reviewed-source list, so omitted new modules are caught before packaging.
  const include = pkg.build.files.filter(pattern => !pattern.startsWith('!'));
  const exclude = pkg.build.files.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
  for await (const name of glob(include, { cwd: root, exclude })) {
    if (!(await stat(path.join(root, name))).isFile()) continue;
    const destination = path.join(source, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, name), destination);
  }
  const verify = async () => {
    asar.uncache(archive);
    await asar.createPackage(source, archive);
    return verifyAsar(archive, root, pkg.version);
  };
  assert.ok(await verify() >= 27, 'The complete selected application is verified');
  for (const name of ['assets/membership/wechat-pay.png', 'assets/membership/alipay.png', 'assets/membership/wechat-contact.png']) {
    await t.test(`rejects missing or altered ${name}`, async () => {
      const destination = path.join(source, name);
      const original = await readFile(destination);
      await rm(destination);
      await assert.rejects(verify(), /not found|Unable to find/i);
      const changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1;
      await writeFile(destination, changed);
      await assert.rejects(verify(), /Packaged membership QR differs/);
      await writeFile(destination, original);
    });
  }
  await t.test('rejects a missing or modified membership plan catalog', async () => {
    const destination = path.join(source, 'lib/membership-plans.js');
    const original = await readFile(destination);
    await rm(destination);
    await assert.rejects(verify(), /exactly the reviewed application files/);
    await writeFile(destination, `${original}\n// changed after review\n`);
    await assert.rejects(verify(), /Packaged source differs.*membership-plans/);
    await writeFile(destination, original);
  });
});
