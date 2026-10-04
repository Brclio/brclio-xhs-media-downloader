// Portable Apple Live Photo packaging. Media is encoded by WebCodecs; this file
// only writes containers. It has no Node APIs and can run in a browser worker.
// Apple timed metadata format:
// https://developer.apple.com/documentation/quicktime-file-format/timed_metadata_sample_descriptions
// The JPEG input must have its orientation rendered into its pixels (for example
// by canvas). Its old EXIF is replaced, avoiding conflicting pair identifiers.

export const LIVE_PHOTO_MIN_DURATION = 0.5;
export const LIVE_PHOTO_MAX_DURATION = 3;
const TIMESCALE = 1_000_000;
const CONTENT_KEY = "com.apple.quicktime.content.identifier";
const STILL_KEY = "com.apple.quicktime.still-image-time";
const encoder = new TextEncoder();

function bytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${label} must be bytes.`);
}

function join(...parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (length >= 0xfffffff0) throw new RangeError("Live Photo exceeds the 32-bit MOV size limit.");
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function u16(value) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value); return b; }
function u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value); return b; }
function i32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value); return b; }
function str(value) { return encoder.encode(value); }
function zeros(count) { return new Uint8Array(count); }
function atom(type, ...parts) { const payload = join(...parts); return join(u32(payload.length + 8), typeof type === "number" ? u32(type) : str(type), payload); }
function fullAtom(type, flags, ...parts) { return atom(type, u32(flags), ...parts); }
function fixed(value) { return u32(Math.round(value * 65536)); }
const matrix = join(fixed(1), u32(0), u32(0), u32(0), fixed(1), u32(0), u32(0), u32(0), u32(0x40000000));

function identifier(value) {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) {
    throw new TypeError("assetIdentifier must be a UUID.");
  }
  return value;
}

function number(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} is outside its supported range.`);
  return value;
}

function sampleList(input, label, durationUs, { video = false } = {}) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10000) throw new TypeError(`${label} must contain encoded samples.`);
  let previousEnd = 0;
  const result = input.map((sample, index) => {
    const data = bytes(sample?.data, `${label}[${index}].data`);
    if (!data.length) throw new TypeError(`${label} contains an empty sample.`);
    const timestamp = Math.round(number(sample.timestamp, "sample timestamp", 0, 4 * TIMESCALE));
    const duration = Math.round(number(sample.duration, "sample duration", 1, TIMESCALE));
    if (Math.abs(timestamp - previousEnd) > 2) throw new RangeError(`${label} must begin at zero and have contiguous timestamps in decode order.`);
    previousEnd = timestamp + duration;
    return { data, timestamp, duration, keyFrame: !!sample.keyFrame };
  });
  if (video && !result[0].keyFrame) throw new TypeError("The first video sample must be a key frame.");
  if (video && Math.abs(previousEnd - durationUs) > 3) throw new RangeError("Video samples must cover the selected duration exactly.");
  if (!video && (previousEnd < durationUs - 30000 || previousEnd > durationUs + 100000)) throw new RangeError("Audio must cover the video duration with at most one short encoder padding interval.");
  // Use differences of timestamps so rounding at 30 fps cannot accumulate.
  for (let index = 0; index < result.length - 1; index++) result[index].duration = result[index + 1].timestamp - result[index].timestamp;
  if (video) result.at(-1).duration = durationUs - result.at(-1).timestamp;
  return result;
}

function validateAvcConfig(config) {
  if (config.length < 7 || config[0] !== 1 || (config[4] & 3) !== 3) throw new TypeError("decoderConfig must be an AVC configuration record with four-byte NAL lengths.");
  let offset = 6;
  const spsCount = config[5] & 31;
  if (!spsCount) throw new TypeError("AVC configuration is missing SPS.");
  const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
  for (let index = 0; index < spsCount; index++) {
    if (offset + 2 > config.length) throw new TypeError("Truncated AVC configuration.");
    const length = view.getUint16(offset); offset += 2;
    if (!length || offset + length > config.length || (config[offset] & 31) !== 7) throw new TypeError("Invalid AVC SPS.");
    offset += length;
  }
  if (offset >= config.length || config[offset] === 0) throw new TypeError("AVC configuration is missing PPS.");
  const ppsCount = config[offset++];
  for (let index = 0; index < ppsCount; index++) {
    if (offset + 2 > config.length) throw new TypeError("Truncated AVC configuration.");
    const length = view.getUint16(offset); offset += 2;
    if (!length || offset + length > config.length || (config[offset] & 31) !== 8) throw new TypeError("Invalid AVC PPS.");
    offset += length;
  }
}

function validateAvcSample(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) throw new TypeError("Truncated AVC NAL length.");
    const length = view.getUint32(offset); offset += 4;
    if (!length || offset + length > data.length) throw new TypeError("Video samples must use length-prefixed AVC, not Annex B.");
    offset += length;
  }
}

/** Validate and normalize a WebCodecs output sequence. B-frame reordering is not
 * supported: use latencyMode: 'realtime', avc: { format: 'avc' } when encoding. */
export function validateLivePhotoOptions(options) {
  if (!options || typeof options !== "object") throw new TypeError("Live Photo options are required.");
  const assetIdentifier = identifier(options.assetIdentifier);
  const duration = number(options.duration, "duration", LIVE_PHOTO_MIN_DURATION, LIVE_PHOTO_MAX_DURATION);
  const durationUs = Math.round(duration * TIMESCALE);
  const keyPhotoTime = number(options.keyPhotoTime, "keyPhotoTime", 0, (durationUs - 1) / TIMESCALE);
  const width = number(options.width, "width", 2, 8192);
  const height = number(options.height, "height", 2, 8192);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new TypeError("Video dimensions must be integers.");
  const decoderConfig = bytes(options.decoderConfig, "decoderConfig");
  validateAvcConfig(decoderConfig);
  const samples = sampleList(options.samples, "Video samples", durationUs, { video: true });
  for (const sample of samples) validateAvcSample(sample.data);
  let audio;
  if (options.audio) {
    const sampleRate = number(options.audio.sampleRate, "audio sampleRate", 8000, 65535);
    const channels = number(options.audio.channels, "audio channels", 1, 2);
    if (!Number.isInteger(sampleRate) || !Number.isInteger(channels)) throw new TypeError("Audio configuration must use integer values.");
    const config = bytes(options.audio.decoderConfig, "audio decoderConfig");
    if (config.length < 2 || config.length > 64 || (config[0] >> 3) !== 2) throw new TypeError("Audio requires an AAC-LC AudioSpecificConfig.");
    const frequencyIndex = ((config[0] & 7) << 1) | (config[1] >> 7);
    let configChannels = (config[1] >> 3) & 15;
    const frequencies = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let configRate = frequencies[frequencyIndex];
    if (frequencyIndex === 15 && config.length >= 5) {
      configRate = ((config[1] & 127) << 17) | (config[2] << 9) | (config[3] << 1) | (config[4] >> 7);
      configChannels = (config[4] >> 3) & 15;
    }
    if (configRate !== sampleRate || configChannels !== channels) throw new TypeError("AAC configuration does not match its sample rate and channel count.");
    audio = { sampleRate, channels, decoderConfig: config, samples: sampleList(options.audio.samples, "Audio samples", durationUs) };
  }
  return { assetIdentifier, durationUs, keyTimeUs: Math.round(keyPhotoTime * TIMESCALE), width, height, decoderConfig, samples, audio };
}

function handler(type, name) {
  return fullAtom("hdlr", 0, u32(0), str(type), zeros(12), str(name), u16(0));
}

function movieHeader(duration, nextTrackId) {
  return fullAtom("mvhd", 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), fixed(1), u16(256), zeros(10), matrix, zeros(24), u32(nextTrackId));
}

function trackHeader(id, duration, width = 0, height = 0, audio = false) {
  return fullAtom("tkhd", 7, u32(0), u32(0), u32(id), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(audio ? 256 : 0), u16(0), matrix, fixed(width), fixed(height));
}

function edits(duration, offset = 0) {
  // An empty edit places the metadata sample at the key photo's movie time.
  // A normal edit caps an AAC track whose final sample contains encoder padding.
  const entries = offset ? join(u32(offset), i32(-1), fixed(1), u32(duration - offset), i32(0), fixed(1)) : join(u32(duration), i32(0), fixed(1));
  return atom("edts", fullAtom("elst", 0, u32(offset ? 2 : 1), entries));
}

function sampleTable(description, samples, offset, video = false) {
  const runs = [];
  for (const sample of samples) {
    if (runs.length && runs.at(-1).duration === sample.duration) runs.at(-1).count++;
    else runs.push({ count: 1, duration: sample.duration });
  }
  const sync = video ? fullAtom("stss", 0, u32(samples.filter(sample => sample.keyFrame).length), ...samples.flatMap((sample, index) => sample.keyFrame ? [u32(index + 1)] : [])) : zeros(0);
  return atom("stbl",
    fullAtom("stsd", 0, u32(1), description),
    fullAtom("stts", 0, u32(runs.length), ...runs.map(run => join(u32(run.count), u32(run.duration)))),
    fullAtom("stsc", 0, u32(1), u32(1), u32(samples.length), u32(1)),
    fullAtom("stsz", 0, u32(0), u32(samples.length), ...samples.map(sample => u32(sample.data.length))),
    fullAtom("stco", 0, u32(1), u32(offset)), sync);
}

function dataInfo() { return atom("dinf", fullAtom("dref", 0, u32(1), fullAtom("url ", 1))); }

function track({ id, duration, samples, offset, description, type, width = 0, height = 0, start = 0 }) {
  const mediaDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
  const minHeader = type === "vide" ? fullAtom("vmhd", 1, zeros(8)) : type === "soun" ? fullAtom("smhd", 0, zeros(4)) : atom("gmhd", fullAtom("gmin", 0, u16(64), u16(32768), u16(32768), u16(32768), zeros(4)));
  return atom("trak", trackHeader(id, duration, width, height, type === "soun"), edits(duration, start),
    atom("mdia", fullAtom("mdhd", 0, u32(0), u32(0), u32(TIMESCALE), u32(mediaDuration), u16(0x55c4), u16(0)),
      handler(type, type === "meta" ? "Core Media Metadata" : type === "vide" ? "Video" : "Audio"),
      atom("minf", minHeader, dataInfo(), sampleTable(description, samples, offset, type === "vide"))));
}

function avcDescription(width, height, decoderConfig) {
  return atom("avc1", zeros(6), u16(1), zeros(16), u16(width), u16(height), fixed(72), fixed(72), u32(0), u16(1), zeros(32), u16(24), u16(65535), atom("avcC", decoderConfig));
}

function descriptor(tag, payload) {
  const sizes = [payload.length & 127];
  for (let remaining = Math.floor(payload.length / 128); remaining; remaining = Math.floor(remaining / 128)) sizes.unshift((remaining & 127) | 128);
  return join(new Uint8Array([tag, ...sizes]), payload);
}

function audioDescription(audio) {
  const decoder = descriptor(4, join(new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(192000), u32(192000), descriptor(5, audio.decoderConfig)));
  const es = descriptor(3, join(u16(2), new Uint8Array([0]), decoder, descriptor(6, new Uint8Array([2]))));
  return atom("mp4a", zeros(6), u16(1), zeros(8), u16(audio.channels), u16(16), zeros(4), fixed(audio.sampleRate), fullAtom("esds", 0, es));
}

function metadataDescription() {
  // mebx uses a different keys table from movie-level metadata: numbered atoms
  // contain keyd + dtyp. 65 is Apple's well-known signed int8 metadata datatype.
  return atom("mebx", zeros(6), u16(1), atom("keys", atom(1, atom("keyd", str("mdta"), str(STILL_KEY)), atom("dtyp", u32(0), u32(65)))));
}

function movieMetadata(assetIdentifier) {
  // QuickTime's meta atom has no ISO full-box version/flags prefix.
  return atom("meta", handler("mdta", ""), fullAtom("keys", 0, u32(1), atom("mdta", str(CONTENT_KEY))), atom("ilst", atom(1, atom("data", u32(1), u32(0), str(assetIdentifier)))));
}

/** Return a QuickTime MOV with a video track, optional AAC, shared identifier,
 * and the real boxed timed-metadata track marking the key image. */
export function muxLivePhotoMov(options) {
  const input = validateLivePhotoOptions(options);
  const ftyp = atom("ftyp", str("qt  "), u32(512), str("qt  "));
  const videoData = join(...input.samples.map(sample => sample.data));
  const audioData = input.audio ? join(...input.audio.samples.map(sample => sample.data)) : zeros(0);
  const timedData = atom(1, new Uint8Array([255]));
  const offset = ftyp.length + 8;
  const tracks = [track({ id: 1, duration: input.durationUs, samples: input.samples, offset, description: avcDescription(input.width, input.height, input.decoderConfig), type: "vide", width: input.width, height: input.height })];
  if (input.audio) tracks.push(track({ id: 2, duration: input.durationUs, samples: input.audio.samples, offset: offset + videoData.length, description: audioDescription(input.audio), type: "soun" }));
  tracks.push(track({ id: input.audio ? 3 : 2, duration: input.durationUs, samples: [{ data: timedData, duration: Math.min(33333, input.durationUs - input.keyTimeUs) }], offset: offset + videoData.length + audioData.length, description: metadataDescription(), type: "meta", start: input.keyTimeUs }));
  return join(ftyp, atom("mdat", videoData, audioData, timedData), atom("moov", movieHeader(input.durationUs, tracks.length + 1), ...tracks, movieMetadata(input.assetIdentifier)));
}

function exifEntry(tag, type, count, value) { return join(u16(tag), u16(type), u32(count), u32(value)); }

function appleExif(assetIdentifier) {
  const uuid = join(str(assetIdentifier), new Uint8Array([0]));
  const note = join(str("Apple iOS\0"), u16(1), str("MM"), u16(1), exifEntry(17, 2, uuid.length, 32), u32(0), uuid);
  const tiff = join(str("MM"), u16(42), u32(8), u16(2), exifEntry(0x010f, 2, 6, 38), exifEntry(0x8769, 4, 1, 44), u32(0), str("Apple\0"), u16(1), exifEntry(0x927c, 7, note.length, 62), u32(0), note);
  const payload = join(str("Exif\0\0"), tiff);
  return join(new Uint8Array([255, 225]), u16(payload.length + 2), payload);
}

/** Attach MakerApple[17] to an upright JPEG. EXIF is regenerated while other
 * JPEG segments and compressed pixel bytes are preserved exactly. */
export function pairLivePhotoJpeg(jpegBytes, assetIdentifier) {
  identifier(assetIdentifier);
  const jpeg = bytes(jpegBytes, "jpegBytes");
  if (jpeg.length < 4 || jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217) throw new TypeError("A complete JPEG image is required.");
  const segments = [jpeg.subarray(0, 2), appleExif(assetIdentifier)];
  let offset = 2;
  let foundImage = false;
  while (offset < jpeg.length - 2) {
    const start = offset;
    if (jpeg[offset++] !== 255) throw new TypeError("Invalid JPEG marker.");
    while (jpeg[offset] === 255) offset++;
    const marker = jpeg[offset++];
    if (marker === 0xda) { segments.push(jpeg.subarray(start)); foundImage = true; break; }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) throw new TypeError("Unexpected JPEG marker before image data.");
    if (offset + 2 > jpeg.length) throw new TypeError("Truncated JPEG segment.");
    const length = jpeg[offset] * 256 + jpeg[offset + 1];
    if (length < 2 || offset + length > jpeg.length) throw new TypeError("Truncated JPEG segment.");
    const isExif = marker === 0xe1 && length >= 8 && jpeg[offset + 2] === 69 && jpeg[offset + 3] === 120 && jpeg[offset + 4] === 105 && jpeg[offset + 5] === 102 && jpeg[offset + 6] === 0 && jpeg[offset + 7] === 0;
    if (!isExif) segments.push(jpeg.subarray(start, offset + length));
    offset += length;
  }
  if (!foundImage) throw new TypeError("JPEG has no image scan.");
  return join(...segments);
}
