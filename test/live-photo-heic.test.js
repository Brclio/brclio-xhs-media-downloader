import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { muxHeicStill, pairLivePhotoHeic } from "../lib/live-photo-heic.js";

const id = "01234567-89AB-CDEF-0123-456789ABCDEF";
const secondId = "FEDCBA98-7654-3210-FEDC-BA9876543210";
// A real 160×96 blue image encoded by Apple's HEVC WebCodecs encoder. Keeping
// this tiny fixture in the test makes browser/Node checks independent of codecs.
const sample = new Uint8Array(Buffer.from("AAAAJygBrwrbLE1AU3/7Ae73yE//7qXv6j29b/T1Ht620N4tu9NH22y2wA==", "base64"));
const config = new Uint8Array(Buffer.from("AQFgAAAAsAAAAAAAP/AA/P34+AAAFwOgAAEAGkABDAP//wFgAAADALAAAAMAAAMAPwAABDAkoQABAFRCAQMBYAAAAwCwAAADAAADAD8AAKAUIGFiAQ7kUggufhPQvqG9UP6qCPVUE+qqCvVVQX6qqgz1VVQb6qqqDvVVVUH+qqqqBD1VVVUpqAgICB/CAQSiAAEAB0QBwHLwWyQ=", "base64"));
const encode = value => new Uint8Array(Buffer.from(value, "latin1"));
const concat = (...parts) => new Uint8Array(Buffer.concat(parts));
function integer(value, width) { const output = Buffer.alloc(width); output.writeUIntBE(value, 0, width); return output; }
const short = value => integer(value, 2), uint = value => integer(value, 4);
const atom = (type, ...parts) => { const body = concat(...parts); return concat(uint(body.length + 8), encode(type), body); };
const full = (type, version, flags, ...parts) => atom(type, uint(version * 0x1000000 + flags), ...parts);
function atoms(data, start = 0, end = data.length) {
  const output = [], view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (start < end) {
    let size = view.getUint32(start), header = 8;
    if (size === 1) { size = Number(view.getBigUint64(start + 8)); header = 16; }
    if (!size) size = end - start;
    assert.ok(size >= header && start + size <= end);
    output.push({ type: Buffer.from(data.subarray(start + 4, start + 8)).toString("latin1"), start, data: start + header, end: start + size });
    start += size;
  }
  return output;
}
function metadata(data) {
  const top = atoms(data), meta = top.find(box => box.type === "meta");
  assert.ok(meta);
  return { top, meta, children: atoms(data, meta.data + 4, meta.end) };
}
// Independent reader checks item-table references and actual bytes at offsets;
// merely finding a UUID string cannot pass these assertions.
function inspect(data) {
  const { children } = metadata(data), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const info = children.find(box => box.type === "iinf"), locations = children.find(box => box.type === "iloc"), idat = children.find(box => box.type === "idat");
  const items = atoms(data, info.data + (data[info.data] ? 8 : 6), info.end).map(box => ({ id: data[box.data] === 3 ? view.getUint32(box.data + 4) : view.getUint16(box.data + 4), type: Buffer.from(data.subarray(box.data + (data[box.data] === 3 ? 10 : 8), box.data + (data[box.data] === 3 ? 14 : 12))).toString("latin1") }));
  let position = locations.data + 4;
  const version = data[locations.data], first = data[position++], second = data[position++];
  function number(width) { let value = 0; for (let index = 0; index < width; index++) value = value * 256 + data[position++]; return value; }
  const count = number(version === 2 ? 4 : 2), payloads = new Map();
  for (let index = 0; index < count; index++) {
    const itemId = number(version === 2 ? 4 : 2), method = version ? number(2) : 0;
    assert.equal(number(2), 0);
    const base = number(second >>> 4), extents = number(2), parts = [];
    for (let extent = 0; extent < extents; extent++) {
      if (version) number(second & 15);
      const offset = base + number(first >>> 4) + (method ? idat.data : 0), length = number(first & 15);
      assert.ok(offset + length <= data.length);
      parts.push(data.subarray(offset, offset + length));
    }
    payloads.set(itemId, concat(...parts));
  }
  assert.equal(position, locations.end);
  const exifItems = items.filter(item => item.type === "Exif");
  assert.equal(exifItems.length, 1);
  const exif = payloads.get(exifItems[0].id), exifView = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const tiff = 4 + exifView.getUint32(0);
  assert.equal(Buffer.from(exif.subarray(tiff, tiff + 2)).toString(), "MM");
  const ifd = tiff + exifView.getUint32(tiff + 4);
  const exifIfd = tiff + exifView.getUint32(ifd + 2 + 12 + 8);
  assert.equal(exifView.getUint16(exifIfd + 2), 0x927c);
  const note = tiff + exifView.getUint32(exifIfd + 10);
  assert.equal(Buffer.from(exif.subarray(note, note + 10)).toString(), "Apple iOS\0");
  assert.equal(exifView.getUint16(note + 16), 17);
  const value = note + exifView.getUint32(note + 24);
  const identifier = Buffer.from(exif.subarray(value, value + exifView.getUint32(note + 20) - 1)).toString();
  return { items, payloads, identifier, exif };
}
function fixture({ method = 0, version = 0, oldExif, grid = false, duplicate = false, badOffset = false, badReference = false, split = false, zeroMdat = false } = {}) {
  const definitions = [{ id: 1, type: "hvc1", data: sample }];
  if (grid) definitions.push({ id: 2, type: "grid", data: new Uint8Array([0, 0, 0, 0, 0, 160, 0, 96]) });
  if (oldExif) definitions.push({ id: 3, type: "Exif", data: oldExif });
  const primary = grid ? 2 : 1;
  const ftyp = atom("ftyp", encode("heic"), uint(0), encode("mif1heic"));
  const media = concat(...definitions.map(item => item.data));
  const makeMeta = start => {
    let offset = 0;
    const entries = definitions.map(item => full("infe", 2, 0, short(item.id), short(0), encode(item.type), new Uint8Array(1)));
    if (duplicate) entries.push(entries[0]);
    const locations = definitions.map(item => {
      const absolute = method ? offset : start + offset;
      offset += item.data.length;
      const extents = split && item.id === 1 ? [concat(uint(absolute), uint(20)), concat(uint(absolute + 20), uint(item.data.length - 20))] : [concat(uint(badOffset ? 0xffffff : absolute), uint(item.data.length))];
      return concat(short(item.id), ...(version ? [short(method)] : []), short(0), short(extents.length), ...extents);
    });
    const refs = [];
    if (grid) refs.push(atom("dimg", short(2), short(1), short(badReference ? 99 : 1)));
    if (oldExif) refs.push(atom("cdsc", short(3), short(1), short(badReference ? 99 : primary)));
    const iprp = atom("iprp", atom("ipco", atom("hvcC", config), full("ispe", 0, 0, uint(160), uint(96))), full("ipma", 0, 0, uint(grid ? 2 : 1), short(1), new Uint8Array([2, 129, 130]), ...(grid ? [short(2), new Uint8Array([1, 130])] : [])));
    return full("meta", 0, 0, full("hdlr", 0, 0, uint(0), encode("pict"), new Uint8Array(13)), full("pitm", 0, 0, short(primary)), full("iloc", version, 0, new Uint8Array([0x44, 0]), short(definitions.length), ...locations), full("iinf", 0, 0, short(entries.length), ...entries), ...(refs.length ? [full("iref", 0, 0, ...refs)] : []), iprp, ...(method ? [atom("idat", media)] : []));
  };
  const meta = makeMeta(ftyp.length + makeMeta(0).length + 8);
  const mdat = atom("mdat", media);
  if (zeroMdat) mdat.fill(0, 0, 4);
  return concat(ftyp, meta, ...(method ? [] : [mdat]));
}

test("WebCodecs HEVC mux writes a genuine HEIC and Apple Exif identifier", () => {
  const output = muxHeicStill({ sample, decoderConfig: config, width: 160, height: 96, assetIdentifier: id });
  const result = inspect(output);
  assert.equal(result.identifier, id);
  assert.deepEqual(result.payloads.get(1), sample);
  assert.deepEqual(result.items.map(item => item.type), ["hvc1", "Exif"]);
});
test("pairs iloc v0/v1, idat-relative extents, grids and split image data without transcoding", () => {
  for (const options of [{}, { version: 1, split: true }, { version: 1, method: 1 }, { grid: true }, { zeroMdat: true }]) {
    const source = fixture(options), original = source.slice(), output = pairLivePhotoHeic(source, id);
    assert.deepEqual(source, original, "does not modify input");
    const result = inspect(output);
    assert.deepEqual(result.payloads.get(1), sample);
    assert.equal(result.identifier, id);
  }
});
test("replaces old Exif and cdsc instead of retaining a conflicting pairing UUID", () => {
  const oldExif = inspect(muxHeicStill({ sample, decoderConfig: config, width: 160, height: 96, assetIdentifier: id })).exif;
  for (const options of [{ oldExif }, { oldExif, version: 1, method: 1 }]) {
    const output = pairLivePhotoHeic(fixture(options), secondId);
    assert.equal(inspect(output).identifier, secondId);
    assert.equal(Buffer.from(output).includes(Buffer.from(id)), false);
    assert.deepEqual(inspect(output).payloads.get(1), sample);
    assert.equal(inspect(pairLivePhotoHeic(output, id)).identifier, id);
  }
});
test("rejects malformed containers, missing data, undefined references and duplicate items", () => {
  const source = fixture(), meta = metadata(source).meta;
  for (const malformed of [fixture({ badOffset: true }), fixture({ grid: true, badReference: true }), fixture({ duplicate: true }), source.subarray(0, source.length - 1), concat(source, source.subarray(meta.start, meta.end)), concat(source, atom("moov"))]) assert.throws(() => pairLivePhotoHeic(malformed, id), /Invalid HEIC/);
  const corrupted = source.slice();
  corrupted.set(uint(7), 0);
  assert.throws(() => pairLivePhotoHeic(corrupted, id), /box size/);
  assert.throws(() => pairLivePhotoHeic(new Uint8Array([255, 216, 255, 217]), id), /Invalid HEIC/);
});
test("rejects wrong image codecs, absent parameter sets and non-key HEVC samples", () => {
  for (const [from, to] of [["hvc1", "av01"], ["hvcC", "av1C"]]) {
    const source = fixture();
    source.set(encode(to), Buffer.from(source).indexOf(from));
    assert.throws(() => pairLivePhotoHeic(source, id), /HEVC|hvcC/);
  }
  const source = fixture(), info = metadata(source).children.find(box => box.type === "iprp");
  const hvcC = atoms(source, atoms(source, info.data, info.end)[0].data, atoms(source, info.data, info.end)[0].end)[0];
  source[hvcC.data + 22] = 0;
  assert.throws(() => pairLivePhotoHeic(source, id), /Invalid HEIC/);
  assert.throws(() => pairLivePhotoHeic(fixture(), "bad-id"), /UUID/);
  const delta = sample.slice(); delta[4] = 2;
  assert.throws(() => muxHeicStill({ sample: delta, decoderConfig: config, width: 160, height: 96, assetIdentifier: id }), /key frame/);
  assert.throws(() => muxHeicStill({ sample: sample.subarray(1), decoderConfig: config, width: 160, height: 96, assetIdentifier: id }), /Invalid HEIC/);
  assert.throws(() => muxHeicStill({ sample, decoderConfig: config, width: 0, height: 96, assetIdentifier: id }), /width/);
});
test("native ImageIO decodes HEIC pixels and reads MakerApple 17", { skip: process.platform !== "darwin" }, () => {
  const temporary = mkdtempSync(pathJoin(tmpdir(), "brclio-heic-test-"));
  try {
    const file = pathJoin(temporary, "image.heic"), swift = pathJoin(temporary, "inspect.swift");
    writeFileSync(file, muxHeicStill({ sample, decoderConfig: config, width: 160, height: 96, assetIdentifier: id }));
    writeFileSync(swift, `import Foundation\nimport ImageIO\nlet source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!\nlet image = CGImageSourceCreateImageAtIndex(source, 0, nil)!\nlet properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary\nlet maker = properties[kCGImagePropertyMakerAppleDictionary] as! NSDictionary\nlet result: [String: Any] = ["type": CGImageSourceGetType(source)! as String, "count": CGImageSourceGetCount(source), "width": image.width, "height": image.height, "identifier": maker["17"]!]\nprint(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)\n`);
    const result = JSON.parse(execFileSync("swift", [swift, file], { encoding: "utf8", timeout: 30000 }));
    assert.deepEqual(result, { type: "public.heic", count: 1, width: 160, height: 96, identifier: id });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
