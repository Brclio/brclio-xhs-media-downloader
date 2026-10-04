import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxLivePhotoMov, pairLivePhotoJpeg, validateLivePhotoOptions } from "../lib/live-photo-format.js";

const id = "01234567-89AB-CDEF-0123-456789ABCDEF";
const config = Uint8Array.from([1, 66, 0, 30, 255, 225, 0, 2, 0x67, 0, 1, 0, 2, 0x68, 0]);
function options() {
  return { samples: [{ data: Uint8Array.from([0, 0, 0, 2, 0x65, 0]), timestamp: 0, duration: 500000, keyFrame: true }], decoderConfig: config, width: 32, height: 32, duration: 0.5, keyPhotoTime: 0.25, assetIdentifier: id };
}

// A reader independent of the container writer. It checks actual table offsets
// and sample bytes; finding strings alone would accept an ordinary tagged MOV.
function atoms(bytes, start = 0, end = bytes.length) {
  const items = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset < end;) {
    assert.ok(offset + 8 <= end, "complete atom header");
    const size = view.getUint32(offset);
    assert.ok(size >= 8 && offset + size <= end, "valid atom size");
    items.push({ type: Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("latin1"), start: offset, data: offset + 8, end: offset + size });
    offset += size;
  }
  return items;
}
function child(bytes, parent, type) { const result = atoms(bytes, parent.data, parent.end).find(item => item.type === type); assert.ok(result, `found ${type}`); return result; }
function uint(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset); }

test("MOV contains matching movie identifier and a timed int8 mebx sample at the key-photo time", () => {
  const data = muxLivePhotoMov(options());
  const boxes = atoms(data);
  const moov = boxes.find(box => box.type === "moov");
  const tracks = atoms(data, moov.data, moov.end).filter(box => box.type === "trak");
  assert.equal(tracks.length, 2);
  const meta = child(data, moov, "meta");
  const list = child(data, meta, "ilst");
  const item = atoms(data, list.data, list.end)[0];
  const value = child(data, item, "data");
  assert.equal(Buffer.from(data.subarray(value.data + 8, value.end)).toString(), id);
  const metadataTrack = tracks[1];
  const edit = child(data, child(data, metadataTrack, "edts"), "elst");
  assert.equal(uint(data, edit.data + 4), 2);
  assert.equal(uint(data, edit.data + 8), 250000);
  assert.equal(uint(data, edit.data + 12), 0xffffffff);
  const stbl = child(data, child(data, child(data, metadataTrack, "mdia"), "minf"), "stbl");
  const stsd = child(data, stbl, "stsd");
  const sample = atoms(data, stsd.data + 8, stsd.end)[0];
  assert.equal(sample.type, "mebx");
  const key = atoms(data, child(data, { ...sample, data: sample.data + 8 }, "keys").data, sample.end)[0];
  const keyd = child(data, key, "keyd");
  assert.equal(Buffer.from(data.subarray(keyd.data, keyd.end)).toString(), "mdtacom.apple.quicktime.still-image-time");
  const dtyp = child(data, key, "dtyp");
  assert.equal(uint(data, dtyp.data + 4), 65);
  const stco = child(data, stbl, "stco");
  const payloadOffset = uint(data, stco.data + 8);
  assert.deepEqual([...data.subarray(payloadOffset, payloadOffset + 9)], [0, 0, 0, 9, 0, 0, 0, 1, 255]);
});

test("JPEG pairs through the Apple maker note while preserving image scan bytes and replacing stale EXIF", () => {
  const source = Uint8Array.from([255, 216, 255, 225, 0, 10, 69, 120, 105, 102, 0, 0, 0, 0, 255, 218, 0, 2, 12, 34, 255, 217]);
  const data = pairLivePhotoJpeg(source, id);
  assert.deepEqual([...data.slice(-8)], [255, 218, 0, 2, 12, 34, 255, 217]);
  const tiffStart = 12;
  assert.equal(Buffer.from(data.subarray(tiffStart, tiffStart + 2)).toString(), "MM");
  const view = new DataView(data.buffer);
  const ifd = tiffStart + view.getUint32(tiffStart + 4);
  assert.equal(view.getUint16(ifd), 2);
  const exif = tiffStart + view.getUint32(ifd + 2 + 12 + 8);
  assert.equal(view.getUint16(exif + 2), 0x927c);
  const note = tiffStart + view.getUint32(exif + 10);
  assert.equal(Buffer.from(data.subarray(note, note + 10)).toString(), "Apple iOS\0");
  assert.equal(view.getUint16(note + 16), 17);
  const uuid = note + view.getUint32(note + 24);
  assert.equal(Buffer.from(data.subarray(uuid, uuid + 36)).toString(), id);
  assert.equal(Buffer.from(data).toString().split("Exif\0\0").length, 2);
  assert.equal(Buffer.from(pairLivePhotoJpeg(data, id)).toString().split("Exif\0\0").length, 2);
});

test("strict validation rejects mislabeled Annex B, missing codec config, reordered timestamps, and excessive duration", () => {
  assert.throws(() => validateLivePhotoOptions({ ...options(), duration: 3.1 }), /duration/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), keyPhotoTime: 0.5 }), /keyPhotoTime/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), assetIdentifier: "bad" }), /UUID/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), decoderConfig: new Uint8Array([1]) }), /configuration/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), samples: [{ ...options().samples[0], timestamp: 1000 }] }), /contiguous/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), samples: [{ ...options().samples[0], keyFrame: false }] }), /key frame/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), samples: [{ ...options().samples[0], data: new Uint8Array([0, 0, 0, 1, 0x65, 0]) }] }), /AVC/);
  assert.throws(() => validateLivePhotoOptions({ ...options(), audio: { sampleRate: 44100, channels: 2, decoderConfig: new Uint8Array([0x11, 0x90]), samples: [{ data: new Uint8Array([1]), timestamp: 0, duration: 500000 }] } }), /sample rate/);
  assert.throws(() => pairLivePhotoJpeg(new Uint8Array([255, 216, 255, 217]), id), /scan/);
});

test("AAC padding is capped by an edit while the media sample remains complete", () => {
  const input = options();
  input.audio = { sampleRate: 48000, channels: 2, decoderConfig: new Uint8Array([0x11, 0x90]), samples: [{ data: new Uint8Array([1, 2]), timestamp: 0, duration: 520000 }] };
  const data = muxLivePhotoMov(input);
  const moov = atoms(data).find(atom => atom.type === "moov");
  const audioTrack = atoms(data, moov.data, moov.end).filter(atom => atom.type === "trak")[1];
  const mdhd = child(data, child(data, audioTrack, "mdia"), "mdhd");
  assert.equal(uint(data, mdhd.data + 16), 520000);
  const edit = child(data, child(data, audioTrack, "edts"), "elst");
  assert.equal(uint(data, edit.data + 8), 500000);
});

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
test("independent ffprobe and decoder read real AVC/AAC output with a timed metadata track", { skip: !hasFFmpeg }, t => {
  const directory = mkdtempSync(join(tmpdir(), "brclio-live-photo-format-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixturePath = join(directory, "source.mov");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", fixturePath]);
  const fixture = readFileSync(fixturePath);
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_packets", "-of", "json", fixturePath]));
  function record(type) { const at = fixture.indexOf(type); assert.ok(at >= 4); return fixture.subarray(at + 4, at - 4 + fixture.readUInt32BE(at - 4)); }
  const videoPackets = info.packets.filter(packet => packet.stream_index === 0);
  const video = videoPackets.map((packet, index) => ({ data: fixture.subarray(Number(packet.pos), Number(packet.pos) + Number(packet.size)), timestamp: Math.round(index / 30 * 1e6), duration: Math.round((index + 1) / 30 * 1e6) - Math.round(index / 30 * 1e6), keyFrame: packet.flags.includes("K") }));
  const audioPackets = info.packets.filter(packet => packet.stream_index === 1 && Number(packet.pts_time) >= 0);
  const audio = audioPackets.map(packet => ({ data: fixture.subarray(Number(packet.pos), Number(packet.pos) + Number(packet.size)), timestamp: Math.round(Number(packet.pts_time) * 1e6), duration: Math.round(Number(packet.duration_time) * 1e6) }));
  const output = muxLivePhotoMov({ ...options(), duration: 1, keyPhotoTime: 0.5, samples: video, decoderConfig: record("avcC"), audio: { samples: audio, decoderConfig: new Uint8Array([0x11, 0x90]), sampleRate: 48000, channels: 2 } });
  const outputPath = join(directory, "paired.mov");
  writeFileSync(outputPath, output);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-show_packets", "-of", "json", outputPath]));
  assert.equal(probe.format.tags["com.apple.quicktime.content.identifier"], id);
  assert.equal(Number(probe.format.duration), 1);
  assert.equal(probe.streams[0].codec_name, "h264");
  assert.equal(probe.streams[0].width, 32);
  assert.equal(probe.streams[1].codec_name, "aac");
  assert.equal(probe.streams[1].sample_rate, "48000");
  assert.equal(probe.streams[1].channels, 2);
  const metadata = probe.streams.find(stream => stream.codec_tag_string === "mebx");
  assert.ok(metadata, "real timed metadata stream");
  const timedPacket = probe.packets.find(packet => packet.stream_index === metadata.index);
  assert.equal(Number(timedPacket.pts_time), 0.5);
  assert.equal(Number(timedPacket.size), 9);
  execFileSync("ffmpeg", ["-v", "error", "-i", outputPath, "-map", "0:v", "-map", "0:a", "-f", "null", "-"], { stdio: "pipe" });
});
