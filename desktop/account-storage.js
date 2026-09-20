import { readFile, writeFile, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
export function accountError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}

/** Raw hardware IDs remain inside this function, never persisted or transmitted. */
export async function stableDeviceHash({ platform = process.platform, exec = execute } = {}) {
  let identifier;
  if (platform === 'darwin') {
    const { stdout } = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    identifier = /"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"/.exec(stdout)?.[1];
  } else if (platform === 'win32') {
    const command = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const { stdout } = await exec(command, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true });
    identifier = /MachineGuid\s+REG_SZ\s+([A-Fa-f0-9-]{36})/i.exec(stdout)?.[1];
  }
  if (!identifier || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(identifier)) {
    throw accountError('DEVICE_ID_UNAVAILABLE', '无法读取稳定的设备标识，授权已暂停。请检查系统权限后重试。');
  }
  return createHash('sha256').update(`cn.bornforthis.xhs-downloader/device/v1\n${platform}\n${identifier.toLowerCase()}`).digest('hex');
}

/** Keychain on macOS / DPAPI on Windows. No plaintext or basic_text fallback. */
export class SecureAccountStore {
  constructor({ directory, safeStorage, deviceIdentity = stableDeviceHash, platform = process.platform, deviceName = os.hostname() }) {
    this.filename = path.join(directory, 'account-v1.enc');
    this.safeStorage = safeStorage;
    this.deviceIdentity = deviceIdentity;
    this.platform = platform;
    this.deviceName = String(deviceName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) || platform;
  }
  assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw accountError('SECURE_STORAGE_UNAVAILABLE', '系统安全存储不可用。请解锁系统钥匙串或凭据服务后重新打开应用。');
    }
  }
  async load() {
    this.assertAvailable();
    let saved;
    try {
      const file = await lstat(this.filename);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024) throw new Error('Invalid secure account file');
      saved = JSON.parse(this.safeStorage.decryptString(await readFile(this.filename)));
      if (saved.version !== 1 || typeof saved.privateKey !== 'string' || typeof saved.publicKey !== 'string'
        || !/^[a-f\d]{64}$/.test(saved.stableIdHash) || !Array.isArray(saved.pendingLogoutTokens)
        || saved.pendingLogoutTokens.some(token => typeof token !== 'string')
        || (saved.token != null && typeof saved.token !== 'string')) throw new Error('Invalid account credentials');
    } catch (error) {
      if (error.code !== 'ENOENT') throw accountError('SECURE_STORAGE_UNAVAILABLE', '无法解密已保存的软件账号。原凭据已保留，请恢复系统安全存储后重试。');
    }
    let stableIdHash;
    try { stableIdHash = await this.deviceIdentity({ platform: this.platform }); }
    catch (error) { throw accountError('DEVICE_ID_UNAVAILABLE', error.code === 'DEVICE_ID_UNAVAILABLE' ? error.message : '无法读取稳定的设备标识，请检查系统权限后重试。'); }
    if (!/^[a-f\d]{64}$/.test(stableIdHash)) throw accountError('DEVICE_ID_UNAVAILABLE', '系统设备标识无效。');
    if (saved) {
      if (saved.stableIdHash !== stableIdHash) throw accountError('DEVICE_ID_CHANGED', '当前系统设备标识与已保存凭据不符，请联系管理员处理设备授权。');
      return saved;
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const credentials = { version: 1, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }), stableIdHash,
      token: null, pendingLogoutTokens: [], pendingRedemptions: {} };
    await this.save(credentials);
    return credentials;
  }
  async save(credentials) {
    this.assertAvailable();
    const ciphertext = this.safeStorage.encryptString(JSON.stringify(credentials));
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, ciphertext, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filename);
    } finally { await rm(temporary, { force: true }); }
  }
  device(credentials) {
    return { publicKey: credentials.publicKey, stableIdHash: credentials.stableIdHash, platform: this.platform, name: this.deviceName };
  }
}
