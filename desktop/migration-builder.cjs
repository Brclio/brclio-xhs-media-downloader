const path = require('node:path');
const { Arch } = require('builder-util');
const { build } = require('../package.json');
const release = require('./migration/release.json');

function installer(suffix) {
  const name = 'Brclio-' + release.version + '-' + suffix;
  return [{ from: 'desktop-runtime/migration/${os}-${arch}/' + name, to: 'migration/' + name }];
}

async function verifyEmbeddedInstaller({ appOutDir, arch, electronPlatformName, packager }) {
  const asset = release.assets[electronPlatformName + '-' + Arch[arch]];
  if (!asset) throw new Error('Unsupported migration build target');
  const { verifyInstaller } = await import('./migration/release.js');
  const resources = packager.getResourcesDir(appOutDir);
  await verifyInstaller(path.join(resources, 'migration', asset.name), asset);
  console.log('Verified packaged Brclio installer:', asset.name, asset.sha256);
}

// Keep the app identity, NSIS upgrade behavior and names shipped clients trust.
module.exports = {
  appId: build.appId,
  productName: build.productName,
  extraMetadata: { version: release.bridgeVersion, main: 'desktop/migration/main.js' },
  directories: { output: 'dist-desktop/migration', buildResources: build.directories.buildResources },
  files: ['desktop/migration/**', 'desktop/mac-update-cleanup.js', 'desktop/mac-architecture.js', '!node_modules/**'],
  // osx-sign would sign the nested disk image and change its published bytes.
  // The outer app signature still seals this immutable resource.
  mac: { ...build.mac, target: ['dmg'], extraResources: installer('mac-${arch}.dmg'),
    signIgnore: ['/Contents/Resources/migration/Brclio-[0-9.]+-mac-(arm64|x64)\\.dmg$'] },
  afterPack: verifyEmbeddedInstaller,
  afterSign: verifyEmbeddedInstaller,
  win: { target: ['nsis', 'portable'], extraResources: installer('windows-${arch}.exe') },
  nsis: build.nsis,
  portable: build.portable,
  toolsets: build.toolsets,
};
