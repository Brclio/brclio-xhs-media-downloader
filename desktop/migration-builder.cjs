const { build } = require('../package.json');
const release = require('./migration/release.json');

function installer(suffix) {
  const name = 'Brclio-' + release.version + '-' + suffix;
  return [{ from: 'desktop-runtime/migration/${os}-${arch}/' + name, to: 'migration/' + name }];
}

// Keep the app identity, NSIS upgrade behavior and names shipped clients trust.
module.exports = {
  appId: build.appId,
  productName: build.productName,
  extraMetadata: { version: release.bridgeVersion, main: 'desktop/migration/main.js' },
  directories: { output: 'dist-desktop/migration', buildResources: build.directories.buildResources },
  files: ['desktop/migration/**', 'desktop/mac-update-cleanup.js', 'desktop/mac-architecture.js', '!node_modules/**'],
  mac: { ...build.mac, target: ['dmg'], extraResources: installer('mac-${arch}.dmg') },
  win: { target: ['nsis', 'portable'], extraResources: installer('windows-${arch}.exe') },
  nsis: build.nsis,
  portable: build.portable,
  toolsets: build.toolsets,
};
