import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { muxLivePhotoMov, pairLivePhotoJpeg } from '../lib/live-photo-format.js';
import { muxHeicStill } from '../lib/live-photo-heic.js';
import { makeLivePhotoPackage } from '../lib/live-photo-package.js';

const identifier = '01234567-89AB-CDEF-0123-456789ABCDEF';
const date = new Date('2026-10-10T01:02:04Z');
const jpeg = pairLivePhotoJpeg(Uint8Array.from([255, 216, 255, 218, 0, 2, 12, 34, 255, 217]), identifier);
const heic = muxHeicStill({
  sample: new Uint8Array(Buffer.from('AAAAJygBrwrbLE1AU3/7Ae73yE//7qXv6j29b/T1Ht620N4tu9NH22y2wA==', 'base64')),
  decoderConfig: new Uint8Array(Buffer.from('AQFgAAAAsAAAAAAAP/AA/P34+AAAFwOgAAEAGkABDAP//wFgAAADALAAAAMAAAMAPwAABDAkoQABAFRCAQMBYAAAAwCwAAADAAADAD8AAKAUIGFiAQ7kUggufhPQvqG9UP6qCPVUE+qqCvVVQX6qqgz1VVQb6qqqDvVVVUH+qqqqBD1VVVUpqAgICB/CAQSiAAEAB0QBwHLwWyQ=', 'base64')),
  width: 160, height: 96, assetIdentifier: identifier
});
const mov = muxLivePhotoMov({
  samples: [{ data: Uint8Array.from([0, 0, 0, 2, 0x65, 0]), timestamp: 0, duration: 500000, keyFrame: true }],
  decoderConfig: Uint8Array.from([1, 66, 0, 30, 255, 225, 0, 2, 0x67, 0, 1, 0, 2, 0x68, 0]),
  width: 32, height: 32, duration: 0.5, keyPhotoTime: 0.25, assetIdentifier: identifier
});
const fixture = (photoFormat = 'jpeg') => ({ assetIdentifier: identifier, photoFormat,
  photoExtension: photoFormat === 'heic' ? 'HEIC' : 'JPG', photo: photoFormat === 'heic' ? heic : jpeg, mov });

for (const format of ['jpeg', 'heic']) {
  test(`${format} package preserves paired bytes and keeps README outside the .pvt directory`, async () => {
    const result = fixture(format), output = makeLivePhotoPackage(result, { date });
    const stem = `Brclio-Live-${identifier}`, bundle = `${stem}.pvt`;
    assert.equal(output.stem, stem);
    assert.equal(output.bundleName, bundle);
    assert.deepEqual(output.files.map(file => file.name), [
      `${bundle}/${stem}.${result.photoExtension}`, `${bundle}/${stem}.MOV`, `${bundle}/metadata.plist`, 'README.txt'
    ]);
    assert.equal(output.files[0].data, result.photo);
    assert.equal(output.files[1].data, result.mov);
    assert.match(new TextDecoder().decode(output.files[2].data), /<key>PFVideoComplementMetadataVersionKey<\/key>\s*<string>1<\/string>/);
    assert.match(output.readme, /目标设备上确认/);
    assert.equal(output.zip.type, 'application/zip');
    assert.deepEqual(await output.zip.arrayBuffer(), await makeLivePhotoPackage(result, { date }).zip.arrayBuffer());
  });
}

test('package rejects unsafe identifiers, inconsistent formats and non-byte payloads', () => {
  for (const assetIdentifier of [undefined, '', '../bad', `${identifier}/file`, `${identifier}\n`, {}, '0123456789AB-CDEF-0123-456789ABCDEF']) {
    assert.throws(() => makeLivePhotoPackage({ ...fixture(), assetIdentifier }), /UUID/);
  }
  for (const changes of [{ photoFormat: 'png' }, { photoExtension: 'JPEG' }, { photoExtension: '../JPG' }, { photoFormat: 'heic' }, { photoFormat: '__proto__' }, { photoFormat: 'toString' }]) {
    assert.throws(() => makeLivePhotoPackage({ ...fixture(), ...changes }), /photoFormat/);
  }
  for (const key of ['photo', 'mov']) {
    for (const value of [new ArrayBuffer(1), new Uint8Array(), [], null]) {
      assert.throws(() => makeLivePhotoPackage({ ...fixture(), [key]: value }), /nonempty Uint8Array/);
    }
  }
});

test('package rejects mislabeled media and truncated container bytes', () => {
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), photo: heic }), /JPG format/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture('heic'), photo: jpeg }), /HEIC photo/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), mov: jpeg }), /MOV/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), mov: mov.subarray(0, mov.length - 1) }), /invalid box size/);
  assert.throws(() => makeLivePhotoPackage({ ...fixture('heic'), photo: heic.subarray(0, heic.length - 1) }), /invalid box size/);
  const avif = heic.slice();
  avif.set(new TextEncoder().encode('avif'), 8);
  avif.set(new TextEncoder().encode('avif'), 20);
  assert.throws(() => makeLivePhotoPackage({ ...fixture('heic'), photo: avif }), /HEIC format/);
  const mp4 = mov.slice();
  mp4.set(new TextEncoder().encode('isom'), 8);
  mp4.set(new TextEncoder().encode('isom'), 16);
  assert.throws(() => makeLivePhotoPackage({ ...fixture(), mov: mp4 }), /QuickTime MOV/);
});

test('system unzip reads the package paths and plutil parses the metadata string', { skip: process.platform !== 'darwin' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'brclio-pvt-'));
  try {
    const bundlePaths = [];
    for (const format of ['jpeg', 'heic']) {
      const result = fixture(format), output = makeLivePhotoPackage(result, { date });
      const zipPath = join(directory, `${format}.zip`), destination = join(directory, format);
      writeFileSync(zipPath, new Uint8Array(await output.zip.arrayBuffer()));
      execFileSync('/usr/bin/unzip', ['-t', zipPath]);
      execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', destination]);
      assert.deepEqual(readdirSync(destination).sort(), [output.bundleName, 'README.txt'].sort());
      const bundlePath = join(destination, output.bundleName);
      bundlePaths.push(bundlePath);
      assert.deepEqual(readdirSync(bundlePath).sort(), [`${output.stem}.${result.photoExtension}`, `${output.stem}.MOV`, 'metadata.plist'].sort());
      assert.deepEqual(readFileSync(join(bundlePath, `${output.stem}.${result.photoExtension}`)), Buffer.from(result.photo));
      assert.deepEqual(readFileSync(join(bundlePath, `${output.stem}.MOV`)), Buffer.from(result.mov));
      const plistPath = join(bundlePath, 'metadata.plist');
      execFileSync('/usr/bin/plutil', ['-lint', plistPath]);
      assert.deepEqual(JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' })), {
        PFVideoComplementMetadataVersionKey: '1'
      });
    }
    // Query actual extracted directories: resolving the extension without a
    // directory/package constraint can produce an unrelated dynamic UTI.
    const swiftPath = join(directory, 'inspect-package.swift');
    writeFileSync(swiftPath, `import Foundation
import UniformTypeIdentifiers
var entries: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
  let values = try URL(fileURLWithPath: path).resourceValues(forKeys: [.isPackageKey, .typeIdentifierKey, .isDirectoryKey])
  let type = values.typeIdentifier.flatMap(UTType.init)
  entries.append([
    "isDirectory": values.isDirectory ?? false,
    "isPackage": values.isPackage ?? false,
    "typeIdentifier": values.typeIdentifier ?? "",
    "conformsToPackage": type?.conforms(to: .package) ?? false
  ])
}
print(String(decoding: try JSONSerialization.data(withJSONObject: entries), as: UTF8.self))
`);
    const entries = JSON.parse(execFileSync('/usr/bin/swift', [swiftPath, ...bundlePaths], { encoding: 'utf8' }));
    assert.deepEqual(entries, bundlePaths.map(() => ({
      isDirectory: true, isPackage: true,
      typeIdentifier: 'com.apple.private.live-photo-bundle', conformsToPackage: true
    })));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
