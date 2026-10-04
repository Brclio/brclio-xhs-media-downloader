// Portable HEIC still-image packaging. HEVC pixels are never transcoded here.
// The Live Photo movie carries the same UUID as Exif MakerApple tag 17.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("latin1");
function fail(message) { throw new TypeError(`Invalid HEIC: ${message}`); }
function bytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${label} must be bytes.`);
}
function uuid(value) {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw new TypeError("assetIdentifier must be a UUID.");
  return value;
}
function join(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  if (size >= 0xfffffff0) throw new RangeError("HEIC exceeds the supported container size.");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
const str = value => textEncoder.encode(value);
function integer(value, size) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (size * 8)) throw new RangeError("HEIC integer is out of range.");
  const result = new Uint8Array(size);
  for (let offset = size - 1; offset >= 0; offset--) { result[offset] = value % 256; value = Math.floor(value / 256); }
  return result;
}
const u16 = value => integer(value, 2);
const u32 = value => integer(value, 4);
const u64 = value => integer(value, 8);
const atom = (type, ...parts) => { const payload = join(...parts); return join(u32(payload.length + 8), str(type), payload); };
const full = (type, version, flags, ...parts) => atom(type, new Uint8Array([version, flags >>> 16, flags >>> 8, flags]), ...parts);
function reader(data, start, end) {
  let position = start;
  return {
    get position() { return position; }, get remaining() { return end - position; },
    number(size) {
      if (size > 8 || size < 0 || position + size > end) fail("truncated integer");
      let value = 0;
      for (let index = 0; index < size; index++) value = value * 256 + data[position++];
      if (!Number.isSafeInteger(value)) fail("offset exceeds the safe integer range");
      return value;
    },
    skip(size) { if (size < 0 || position + size > end) fail("truncated field"); position += size; },
    string(size) { if (position + size > end) fail("truncated string"); const value = textDecoder.decode(data.subarray(position, position + size)); position += size; return value; },
    done() { if (position !== end) fail("unexpected trailing fields"); }
  };
}
function boxes(data, start = 0, end = data.length) {
  const result = [];
  for (let position = start; position < end;) {
    const read = reader(data, position, end);
    let size = read.number(4);
    const type = read.string(4);
    if (size === 1) size = read.number(8);
    if (size === 0) size = end - position;
    if (size < read.position - position || size > end - position) fail("invalid box size");
    result.push({ type, start: position, data: read.position, end: position + size });
    position += size;
    if (result.length > 100000) fail("too many boxes");
  }
  return result;
}
function one(list, type) {
  const matches = list.filter(box => box.type === type);
  if (matches.length !== 1) fail(`expected one ${type} box`);
  return matches[0];
}
function header(data, box, versions) {
  const read = reader(data, box.data, box.end);
  const version = read.number(1), flags = read.number(3);
  if (!versions.includes(version)) fail(`unsupported ${box.type} version`);
  return { read, version, flags };
}
function itemInfo(data, box) {
  const { read, version } = header(data, box, [0, 1]);
  const count = read.number(version ? 4 : 2);
  const entries = boxes(data, read.position, box.end);
  if (count !== entries.length) fail("incorrect item count");
  const result = new Map();
  for (const entry of entries) {
    if (entry.type !== "infe") fail("unknown item definition");
    const info = header(data, entry, [2, 3]);
    const id = info.read.number(info.version === 3 ? 4 : 2);
    if (!id || result.has(id) || info.read.number(2)) fail("duplicate or protected item");
    const type = info.read.string(4);
    if (!data.subarray(info.read.position, entry.end).includes(0)) fail("missing item name terminator");
    result.set(id, { id, type, box: entry });
  }
  return result;
}
function itemLocations(data, box, idat, top) {
  const { read, version } = header(data, box, [0, 1, 2]);
  const first = read.number(1), second = read.number(1);
  const offsetSize = first >>> 4, lengthSize = first & 15, baseSize = second >>> 4, indexSize = version ? second & 15 : 0;
  if ([offsetSize, lengthSize, baseSize, indexSize].some(size => size > 8) || !lengthSize) fail("unsupported item extent widths");
  const count = read.number(version === 2 ? 4 : 2);
  if (count > 100000) fail("too many items");
  const result = new Map();
  for (let index = 0; index < count; index++) {
    const id = read.number(version === 2 ? 4 : 2);
    const method = version ? read.number(2) : 0;
    if (!id || result.has(id) || method > 1 || read.number(2)) fail("unsupported item location");
    const base = read.number(baseSize), extentCount = read.number(2), extents = [];
    if (!extentCount) fail("item has no data extents");
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex++) {
      if (indexSize) read.number(indexSize);
      const offset = base + read.number(offsetSize), length = read.number(lengthSize);
      if (!Number.isSafeInteger(offset) || !length) fail("invalid item extent");
      const absolute = method ? (idat?.data ?? -data.length) + offset : offset;
      const container = method ? idat : top.find(candidate => candidate.type === "mdat" && absolute >= candidate.data && absolute + length <= candidate.end);
      if (!container || absolute < container.data || absolute + length > container.end) fail("item extent is outside its media data");
      extents.push({ offset, length, absolute });
    }
    result.set(id, { id, method, extents });
  }
  read.done();
  return result;
}
function references(data, box) {
  if (!box) return [];
  const { read, version } = header(data, box, [0, 1]);
  return boxes(data, read.position, box.end).map(entry => {
    const value = reader(data, entry.data, entry.end);
    const from = value.number(version ? 4 : 2), count = value.number(2), to = [];
    for (let index = 0; index < count; index++) to.push(value.number(version ? 4 : 2));
    value.done();
    return { type: entry.type, from, to };
  });
}
function validateHevcConfig(value) {
  if (value.length < 23 || value[0] !== 1 || (value[21] & 3) !== 3) fail("hvcC must contain HEVC with four-byte NAL lengths");
  const read = reader(value, 23, value.length), types = new Set();
  for (let array = 0; array < value[22]; array++) {
    const type = read.number(1) & 63, count = read.number(2);
    if (!count) fail("empty HEVC parameter array");
    for (let index = 0; index < count; index++) {
      const length = read.number(2);
      if (length < 2 || read.remaining < length || ((value[read.position] >>> 1) & 63) !== type) fail("invalid HEVC parameter NAL");
      read.skip(length);
    }
    types.add(type);
  }
  read.done();
  if (![32, 33, 34].every(type => types.has(type))) fail("HEVC configuration is missing VPS, SPS or PPS");
}
function validateHevcSample(image) {
  const read = reader(image, 0, image.length);
  let randomAccess = false;
  while (read.remaining) {
    const size = read.number(4);
    if (size < 2 || read.remaining < size || image[read.position] & 128 || !(image[read.position + 1] & 7)) fail("invalid length-prefixed HEVC sample");
    const type = (image[read.position] >>> 1) & 63;
    if (type <= 31 && (type < 16 || type > 23)) fail("HEIC requires an independently decodable HEVC key frame");
    randomAccess ||= type >= 16 && type <= 23;
    read.skip(size);
  }
  if (!randomAccess) fail("HEVC sample has no random access picture");
}
function properties(data, box) {
  const children = boxes(data, box.data, box.end), ipco = one(children, "ipco");
  const definitions = boxes(data, ipco.data, ipco.end), associations = new Map();
  for (const ipma of children.filter(child => child.type === "ipma")) {
    const { read, version, flags } = header(data, ipma, [0, 1]);
    if (flags & ~1) fail("unsupported property association flags");
    const count = read.number(4);
    if (count > 100000) fail("too many property associations");
    for (let index = 0; index < count; index++) {
      const id = read.number(version ? 4 : 2), total = read.number(1), indexes = associations.get(id) || [];
      for (let item = 0; item < total; item++) {
        const property = read.number(flags & 1 ? 2 : 1) & (flags & 1 ? 32767 : 127);
        if (property > definitions.length) fail("property index is outside ipco");
        if (property) indexes.push(definitions[property - 1]);
      }
      associations.set(id, indexes);
    }
    read.done();
  }
  return associations;
}
function parseHeic(data) {
  const top = boxes(data), ftyp = one(top, "ftyp"), meta = one(top, "meta");
  if (top.some(box => box.type === "moov")) fail("a still HEIC image is required");
  if (ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4) fail("invalid file type");
  const brands = [textDecoder.decode(data.subarray(ftyp.data, ftyp.data + 4))];
  for (let position = ftyp.data + 8; position < ftyp.end; position += 4) brands.push(textDecoder.decode(data.subarray(position, position + 4)));
  if (!brands.some(brand => ["heic", "heix", "hevc", "hevx"].includes(brand))) fail("file does not declare HEVC image compatibility");
  const metaHeader = header(data, meta, [0]), children = boxes(data, metaHeader.read.position, meta.end);
  const items = itemInfo(data, one(children, "iinf"));
  const idatBoxes = children.filter(box => box.type === "idat");
  if (idatBoxes.length > 1) fail("duplicate idat");
  const locations = itemLocations(data, one(children, "iloc"), idatBoxes[0], top);
  const refs = references(data, children.find(box => box.type === "iref"));
  if (children.filter(box => box.type === "iref").length > 1) fail("duplicate iref");
  const primaryHeader = header(data, one(children, "pitm"), [0, 1]);
  const primary = primaryHeader.read.number(primaryHeader.version ? 4 : 2);
  primaryHeader.read.done();
  const props = properties(data, one(children, "iprp"));
  for (const id of locations.keys()) if (!items.has(id)) fail("location references an undefined item");
  for (const ref of refs) if (!items.has(ref.from) || ref.to.some(id => !items.has(id))) fail("reference points to an undefined item");
  const active = new Set();
  function image(id, depth = 0) {
    if (depth > 16 || active.has(id)) fail("cyclic image derivation");
    const item = items.get(id);
    if (!item || !locations.has(id)) fail("missing primary image data");
    const payload = join(...locations.get(id).extents.map(extent => data.subarray(extent.absolute, extent.absolute + extent.length)));
    if (item.type === "hvc1") {
      const configs = (props.get(id) || []).filter(property => property.type === "hvcC");
      if (configs.length !== 1) fail("HEVC image is missing its hvcC property");
      validateHevcConfig(data.subarray(configs[0].data, configs[0].end));
      validateHevcSample(payload);
    } else if (item.type === "grid") {
      active.add(id);
      const tiles = refs.filter(ref => ref.from === id && ref.type === "dimg").flatMap(ref => ref.to);
      if (!tiles.length) fail("grid is missing image tiles");
      if (payload.length < 4 || payload[0] !== 0 || payload[1] > 1) fail("invalid grid descriptor");
      const descriptor = reader(payload, 4, payload.length), dimensionWidth = payload[1] & 1 ? 4 : 2;
      if (!descriptor.number(dimensionWidth) || !descriptor.number(dimensionWidth) || tiles.length !== (payload[2] + 1) * (payload[3] + 1)) fail("invalid grid size or tile count");
      descriptor.done();
      for (const tile of tiles) image(tile, depth + 1);
      active.delete(id);
    } else fail("primary image must use genuine HEVC");
  }
  image(primary);
  return { top, meta, children, items, locations, refs, primary };
}
function exifEntry(tag, type, count, value) { return join(u16(tag), u16(type), u32(count), u32(value)); }
function appleExif(identifier) {
  const value = join(str(identifier), new Uint8Array(1));
  const note = join(str("Apple iOS\0"), u16(1), str("MM"), u16(1), exifEntry(17, 2, value.length, 32), u32(0), value);
  const tiff = join(str("MM"), u16(42), u32(8), u16(2), exifEntry(0x010f, 2, 6, 38), exifEntry(0x8769, 4, 1, 44), u32(0), str("Apple\0"), u16(1), exifEntry(0x927c, 7, note.length, 62), u32(0), note);
  return join(u32(6), str("Exif\0\0"), tiff);
}
function locationBox(locations) {
  return full("iloc", 2, 0, new Uint8Array([0x88, 0]), u32(locations.length), ...locations.map(item => join(u32(item.id), u16(item.method), u16(0), u16(item.extents.length), ...item.extents.map(extent => join(u64(extent.offset), u64(extent.length))))));
}
function referenceBox(refs) { return full("iref", 1, 0, ...refs.map(ref => atom(ref.type, u32(ref.from), u16(ref.to.length), ...ref.to.map(u32)))); }
function pruneProperties(data, iprp, removed) {
  const children = boxes(data, iprp.data, iprp.end).map(child => {
    if (child.type !== "ipma") return data.subarray(child.start, child.end);
    const { read, version, flags } = header(data, child, [0, 1]);
    const count = read.number(4), entries = [];
    for (let index = 0; index < count; index++) {
      const id = read.number(version ? 4 : 2), total = read.number(1), properties = [];
      for (let property = 0; property < total; property++) {
        const value = read.number(flags & 1 ? 2 : 1);
        properties.push(u16(flags & 1 ? value : (value & 127) | (value & 128 ? 32768 : 0)));
      }
      if (!removed.has(id)) entries.push(join(u32(id), new Uint8Array([total]), ...properties));
    }
    read.done();
    return full("ipma", 1, 1, u32(entries.length), ...entries);
  });
  return atom("iprp", ...children);
}

/** Replace active Exif with an Apple Live Photo pairing UUID. Existing image
 * items, pixel bytes, orientation and colour properties are preserved exactly.
 * Old metadata is unlinked; no location metadata is copied into the new Exif. */
export function pairLivePhotoHeic(heicBytes, assetIdentifier) {
  uuid(assetIdentifier);
  const input = bytes(heicBytes, "heicBytes"), parsed = parseHeic(input);
  const removed = new Set([...parsed.items.values()].filter(item => item.type === "Exif").map(item => item.id));
  const newId = Math.max(...parsed.items.keys()) + 1;
  if (newId > 0xffffffff) fail("item identifier limit reached");
  const exif = appleExif(assetIdentifier), exifOffset = input.length + 8;
  const keptLocations = [...parsed.locations.values()].filter(item => !removed.has(item.id));
  const locations = [...keptLocations, { id: newId, method: 0, extents: [{ offset: exifOffset, length: exif.length }] }];
  const entries = [...parsed.items.values()].filter(item => !removed.has(item.id)).map(item => input.subarray(item.box.start, item.box.end));
  entries.push(full("infe", 3, 0, u32(newId), u16(0), str("Exif"), str("Exif\0")));
  const refs = parsed.refs.filter(ref => !removed.has(ref.from)).map(ref => ({ ...ref, to: ref.to.filter(id => !removed.has(id)) })).filter(ref => ref.to.length);
  refs.push({ type: "cdsc", from: newId, to: [parsed.primary] });
  const replacement = { iloc: locationBox(locations), iinf: full("iinf", 1, 0, u32(entries.length), ...entries), iref: referenceBox(refs), iprp: pruneProperties(input, one(parsed.children, "iprp"), removed) };
  const idat = parsed.children.find(child => child.type === "idat");
  if (idat) {
    const cleaned = input.slice(idat.start, idat.end);
    const kept = keptLocations.filter(item => item.method === 1).flatMap(item => item.extents);
    for (const id of removed) {
      const item = parsed.locations.get(id);
      if (item?.method !== 1) continue;
      for (const extent of item.extents) if (!kept.some(other => extent.offset < other.offset + other.length && other.offset < extent.offset + extent.length)) cleaned.fill(0, extent.absolute - idat.start, extent.absolute - idat.start + extent.length);
    }
    replacement.idat = cleaned;
  }
  const children = parsed.children.map(child => replacement[child.type] || input.subarray(child.start, child.end));
  if (!parsed.children.some(child => child.type === "iref")) children.push(replacement.iref);
  // Leaving the old meta's size intact keeps all absolute image offsets valid,
  // including files whose media precedes or follows metadata. The active meta
  // is appended, with idat-relative offsets preserved inside its copied idat.
  const original = input.slice();
  for (const box of parsed.top) if (original[box.start] === 0 && original[box.start + 1] === 0 && original[box.start + 2] === 0 && original[box.start + 3] === 0) original.set(u32(box.end - box.start), box.start);
  original.set(str("free"), parsed.meta.start + 4);
  // Erase only unshared old Exif extents; never touch compressed image bytes.
  const keptExtents = keptLocations.flatMap(item => item.extents);
  for (const id of removed) for (const extent of parsed.locations.get(id)?.extents || []) {
    if (!keptExtents.some(other => extent.absolute < other.absolute + other.length && other.absolute < extent.absolute + extent.length)) original.fill(0, extent.absolute, extent.absolute + extent.length);
  }
  const output = join(original, atom("mdat", exif), full("meta", 0, 0, ...children));
  parseHeic(output);
  return output;
}

/** Make a genuine single-image HEIC from a WebCodecs HEVC key frame. Use
 * hevc: { format: 'hevc' }; Annex B streams and non-key frames are rejected. */
export function muxHeicStill({ sample, decoderConfig, width, height, assetIdentifier } = {}) {
  uuid(assetIdentifier);
  for (const [label, value] of [["width", width], ["height", height]]) if (!Number.isInteger(value) || value < 2 || value > 16384) throw new RangeError(`${label} must be an integer from 2 to 16384.`);
  const image = bytes(sample, "sample"), config = bytes(decoderConfig, "decoderConfig");
  validateHevcConfig(config);
  validateHevcSample(image);
  const ftyp = atom("ftyp", str("heic"), u32(0), str("mif1heic"));
  const bitDepth = (config[17] & 7) + 8;
  const iprp = atom("iprp", atom("ipco", atom("hvcC", config), full("ispe", 0, 0, u32(width), u32(height)), full("pixi", 0, 0, new Uint8Array([3, bitDepth, bitDepth, bitDepth])), atom("colr", str("nclx"), u16(1), u16(13), u16(1), new Uint8Array([0]))), full("ipma", 0, 0, u32(1), u16(1), new Uint8Array([4, 129, 130, 3, 4])));
  const meta = offset => full("meta", 0, 0, full("hdlr", 0, 0, u32(0), str("pict"), new Uint8Array(13)), full("pitm", 0, 0, u16(1)), locationBox([{ id: 1, method: 0, extents: [{ offset, length: image.length }] }]), full("iinf", 1, 0, u32(1), full("infe", 2, 0, u16(1), u16(0), str("hvc1"), str("Primary\0"))), iprp);
  const metadata = meta(ftyp.length + meta(0).length + 8);
  return pairLivePhotoHeic(join(ftyp, metadata, atom("mdat", image)), assetIdentifier);
}
