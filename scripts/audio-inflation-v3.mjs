#!/usr/bin/env node
/**
 * Theziess Universal MP4/MOV Audio-Inflation Patcher — v3.0.0
 *
 * Goals:
 *   - Generic ISO BMFF/MP4 parser for non-fragmented files.
 *   - Audio sample-count inflation without video transcoding.
 *   - Preserve original movie/track/media durations and edit lists.
 *   - stco + co64, automatic stco -> co64 promotion, BigInt offsets.
 *   - Multiple mdat boxes, moov before/after mdat, top-level order preserved.
 *   - Preserve unmodified/unknown boxes byte-for-byte.
 *   - Add/replace iTunes-style ©cmt + ©nam = "theziessmethod.site".
 *   - Stream media payloads so large (>4 GiB) files do not need to fit in RAM.
 *
 * CLI:
 *   node patch.js input.mp4 output.mp4
 *   node patch.js --factor 8 --verbose input.mov output.mov
 *
 * No external dependencies. No FFmpeg. No video/audio re-encoding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3.0.0';
const METHOD = 'theziessmethod.site';
const UINT32_MAX = 0xFFFFFFFFn;
const UINT64_MAX = 0xFFFFFFFFFFFFFFFFn;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const COPY_CHUNK = 8 * 1024 * 1024;
const DEFAULT_FACTOR = 8;
const DEFAULT_FAKE_SIZE = 8;
const MAX_STABILIZATION_PASSES = 32;

// We recurse only into structural containers whose payload is defined as a
// direct child-box stream. Metadata containers are parsed separately with
// layout validation because real devices use more than one meta layout.
const STRUCTURAL_CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex',
]);

class Mp4Error extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'Mp4Error';
    this.details = details;
  }
}

function hex(n) {
  return `0x${BigInt(n).toString(16)}`;
}

function safeNumber(v, label = 'value') {
  const b = BigInt(v);
  if (b < 0n || b > MAX_SAFE_BIG) {
    throw new Mp4Error(`${label} exceeds JavaScript safe integer range: ${b}`);
  }
  return Number(b);
}

function ensureBufferLength(sizeBig, label) {
  const size = safeNumber(sizeBig, label);
  // Buffer.alloc will also enforce the runtime-specific hard limit. This
  // pre-check gives a clearer message for enormous sample tables/moov boxes.
  if (size < 0) throw new Mp4Error(`Invalid ${label}: ${size}`);
  return size;
}

function readExact(fd, positionBig, length, label = 'file data') {
  const position = safeNumber(positionBig, `${label} offset`);
  const out = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, out, done, length - done, position + done);
    if (n <= 0) {
      throw new Mp4Error(`Unexpected EOF while reading ${label} at ${positionBig + BigInt(done)}`);
    }
    done += n;
  }
  return out;
}

function readU64BE(buf, offset) {
  const hi = BigInt(buf.readUInt32BE(offset));
  const lo = BigInt(buf.readUInt32BE(offset + 4));
  return (hi << 32n) | lo;
}

function writeU64BE(buf, offset, value) {
  const v = BigInt(value);
  if (v < 0n || v > UINT64_MAX) throw new Mp4Error(`64-bit integer out of range: ${v}`);
  buf.writeUInt32BE(Number((v >> 32n) & UINT32_MAX), offset);
  buf.writeUInt32BE(Number(v & UINT32_MAX), offset + 4);
}

function typeFrom(buf, offset) {
  return buf.toString('latin1', offset, offset + 4);
}

function rawType(type) {
  if (Buffer.isBuffer(type)) {
    if (type.length !== 4) throw new Mp4Error('Box type buffer must be exactly 4 bytes');
    return type;
  }
  const out = Buffer.allocUnsafe(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i) & 0xFF;
  return out;
}

function printableType(type) {
  return [...Buffer.from(type, 'latin1')]
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
    .join('');
}

function boxParseError(kind, boxType, absoluteOffset, parentType, declaredSize, available) {
  const t = printableType(boxType || '????');
  return new Mp4Error(
    `${kind}: atom='${t}' offset=${absoluteOffset} parent='${parentType}' ` +
      `declaredSize=${declaredSize} available=${available}`,
  );
}

function readFileBoxHeader(fd, offset, scopeEnd, parentType = 'file') {
  if (offset < 0n || scopeEnd < offset) throw new Mp4Error('Invalid parser scope');
  const available = scopeEnd - offset;
  if (available < 8n) {
    throw boxParseError('Truncated MP4 box header', '????', offset, parentType, 'unknown', available);
  }

  const first = readExact(fd, offset, 8, 'MP4 box header');
  const rawSize = first.readUInt32BE(0);
  const type = typeFrom(first, 4);
  let headerSize = 8n;
  let declaredSize;
  let sizeWasZero = false;
  let usedLargeSize = false;

  if (rawSize === 1) {
    if (available < 16n) {
      throw boxParseError('Truncated extended MP4 box header', type, offset, parentType, 'largesize', available);
    }
    const ext = readExact(fd, offset + 8n, 8, 'MP4 largesize');
    declaredSize = readU64BE(ext, 0);
    headerSize = 16n;
    usedLargeSize = true;
  } else if (rawSize === 0) {
    declaredSize = available;
    sizeWasZero = true;
  } else {
    declaredSize = BigInt(rawSize);
  }

  if (declaredSize < headerSize || declaredSize > available) {
    throw boxParseError('Malformed MP4 box', type, offset, parentType, declaredSize, available);
  }

  return {
    type,
    start: offset,
    size: declaredSize,
    end: offset + declaredSize,
    headerSize,
    contentStart: offset + headerSize,
    payloadSize: declaredSize - headerSize,
    sizeWasZero,
    usedLargeSize,
    rawSize,
  };
}

function parseTopLevel(fd, fileSize) {
  const boxes = [];
  let offset = 0n;
  while (offset < fileSize) {
    if (fileSize - offset < 8n) {
      throw new Mp4Error(`Trailing ${fileSize - offset} byte(s) after final top-level atom at offset ${offset}`);
    }
    const box = readFileBoxHeader(fd, offset, fileSize, 'file');
    boxes.push(box);
    offset = box.end;
    if (box.sizeWasZero) break;
  }
  if (offset !== fileSize) {
    throw new Mp4Error(`Top-level MP4 parse ended at ${offset}, file size is ${fileSize}`);
  }
  return boxes;
}

function readBufferBox(buf, offset, end, parentType, absBase = 0n) {
  const available = end - offset;
  const abs = absBase + BigInt(offset);
  if (available < 8) {
    throw boxParseError('Truncated MP4 child header', '????', abs, parentType, 'unknown', BigInt(available));
  }

  const rawSize = buf.readUInt32BE(offset);
  const type = typeFrom(buf, offset + 4);
  let headerSize = 8;
  let sizeBig;
  let sizeWasZero = false;
  let usedLargeSize = false;

  if (rawSize === 1) {
    if (available < 16) {
      throw boxParseError('Truncated extended child header', type, abs, parentType, 'largesize', BigInt(available));
    }
    sizeBig = readU64BE(buf, offset + 8);
    headerSize = 16;
    usedLargeSize = true;
  } else if (rawSize === 0) {
    sizeBig = BigInt(available);
    sizeWasZero = true;
  } else {
    sizeBig = BigInt(rawSize);
  }

  if (sizeBig < BigInt(headerSize) || sizeBig > BigInt(available)) {
    throw boxParseError('Malformed MP4 child box', type, abs, parentType, sizeBig, BigInt(available));
  }
  const size = safeNumber(sizeBig, `box '${printableType(type)}' size`);

  return {
    type,
    offset,
    absOffset: abs,
    size,
    sizeBig,
    end: offset + size,
    headerSize,
    contentStart: offset + headerSize,
    sizeWasZero,
    usedLargeSize,
    rawSize,
    parentType,
    children: [],
  };
}

function parseBoxStream(buf, start, end, parentType, absBase = 0n, strict = true) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) {
      if (!strict) return null;
      throw boxParseError(
        'Trailing bytes in MP4 container',
        '????',
        absBase + BigInt(offset),
        parentType,
        'unknown',
        BigInt(end - offset),
      );
    }
    let box;
    try {
      box = readBufferBox(buf, offset, end, parentType, absBase);
    } catch (e) {
      if (!strict) return null;
      throw e;
    }
    boxes.push(box);
    offset = box.end;
    if (box.sizeWasZero) break;
  }
  if (offset !== end) {
    if (!strict) return null;
    throw new Mp4Error(`Child-box stream for '${parentType}' did not consume its complete payload`);
  }
  return boxes;
}

function parseStructuralTree(buf, root, absBase) {
  function descend(box) {
    if (!STRUCTURAL_CONTAINERS.has(box.type)) return;
    box.children = parseBoxStream(buf, box.contentStart, box.end, box.type, absBase, true);
    for (const child of box.children) descend(child);
  }
  descend(root);
  return root;
}

function findChild(box, type) {
  return box?.children?.find((c) => c.type === type) || null;
}

function findChildren(box, type) {
  return box?.children?.filter((c) => c.type === type) || [];
}

function findDesc(box, pathTypes) {
  let cur = box;
  for (const t of pathTypes) {
    cur = findChild(cur, t);
    if (!cur) return null;
  }
  return cur;
}

function boxPayloadSlice(buf, box) {
  return buf.subarray(box.contentStart, box.end);
}

function boxRawSlice(buf, box) {
  return buf.subarray(box.offset, box.end);
}

function makeBox(type, payload, options = {}) {
  const typeBytes = rawType(type);
  const payloadLength = BigInt(payload.length);
  const preserveExtended = !!options.preserveExtended;
  const forceSizeZero = !!options.forceSizeZero;

  if (forceSizeZero) {
    const out = Buffer.allocUnsafe(8 + payload.length);
    out.writeUInt32BE(0, 0);
    typeBytes.copy(out, 4);
    payload.copy(out, 8);
    return out;
  }

  const normalSize = 8n + payloadLength;
  const useExtended = preserveExtended || normalSize > UINT32_MAX;
  if (!useExtended) {
    const out = Buffer.allocUnsafe(Number(normalSize));
    out.writeUInt32BE(Number(normalSize), 0);
    typeBytes.copy(out, 4);
    payload.copy(out, 8);
    return out;
  }

  const extendedSize = 16n + payloadLength;
  const len = ensureBufferLength(extendedSize, `box '${printableType(typeBytes.toString('latin1'))}'`);
  const out = Buffer.allocUnsafe(len);
  out.writeUInt32BE(1, 0);
  typeBytes.copy(out, 4);
  writeU64BE(out, 8, extendedSize);
  payload.copy(out, 16);
  return out;
}

function makeBoxLike(box, payload) {
  return makeBox(box.type, payload, { preserveExtended: box.usedLargeSize });
}

function assertRange(box, relativeOffset, bytesNeeded, label) {
  const start = box.contentStart + relativeOffset;
  const end = start + bytesNeeded;
  if (start < box.contentStart || end > box.end) {
    throw new Mp4Error(`${label}: atom='${printableType(box.type)}' offset=${box.absOffset} requires ${bytesNeeded} byte(s), available=${box.end - start}`);
  }
  return start;
}

function checkedTableBytes(count, entrySize, baseBytes, box, label) {
  const countBig = BigInt(count);
  const need = BigInt(baseBytes) + countBig * BigInt(entrySize);
  const available = BigInt(box.end - box.contentStart);
  if (need > available) {
    throw new Mp4Error(`${label}: atom='${box.type}' offset=${box.absOffset} entryCount=${countBig} entrySize=${entrySize} required=${need} available=${available}`);
  }
  return safeNumber(need, `${label} table byte count`);
}

function parseStco(box, buf) {
  assertRange(box, 0, 8, 'Invalid stco table header');
  const count = buf.readUInt32BE(box.contentStart + 4);
  checkedTableBytes(count, 4, 8, box, 'Invalid stco table');
  const offsets = new Array(count);
  let p = box.contentStart + 8;
  for (let i = 0; i < count; i++, p += 4) offsets[i] = BigInt(buf.readUInt32BE(p));
  return { versionFlags: Buffer.from(buf.subarray(box.contentStart, box.contentStart + 4)), offsets };
}

function parseCo64(box, buf) {
  assertRange(box, 0, 8, 'Invalid co64 table header');
  const count = buf.readUInt32BE(box.contentStart + 4);
  checkedTableBytes(count, 8, 8, box, 'Invalid co64 table');
  const offsets = new Array(count);
  let p = box.contentStart + 8;
  for (let i = 0; i < count; i++, p += 8) offsets[i] = readU64BE(buf, p);
  return { versionFlags: Buffer.from(buf.subarray(box.contentStart, box.contentStart + 4)), offsets };
}

function buildStco(offsets, versionFlags = Buffer.alloc(4)) {
  if (offsets.length > 0xFFFFFFFF) throw new Mp4Error('stco entry count exceeds uint32');
  for (const off of offsets) {
    if (off < 0n || off > UINT32_MAX) throw new Mp4Error(`stco offset out of 32-bit range: ${off}`);
  }
  const payloadLen = 8n + BigInt(offsets.length) * 4n;
  const p = Buffer.allocUnsafe(ensureBufferLength(payloadLen, 'stco payload'));
  versionFlags.copy(p, 0, 0, 4);
  p.writeUInt32BE(offsets.length, 4);
  for (let i = 0; i < offsets.length; i++) p.writeUInt32BE(Number(offsets[i]), 8 + i * 4);
  return makeBox('stco', p);
}

function buildCo64(offsets, versionFlags = Buffer.alloc(4)) {
  if (offsets.length > 0xFFFFFFFF) throw new Mp4Error('co64 entry count exceeds uint32');
  const payloadLen = 8n + BigInt(offsets.length) * 8n;
  const p = Buffer.allocUnsafe(ensureBufferLength(payloadLen, 'co64 payload'));
  versionFlags.copy(p, 0, 0, 4);
  p.writeUInt32BE(offsets.length, 4);
  for (let i = 0; i < offsets.length; i++) writeU64BE(p, 8 + i * 8, offsets[i]);
  return makeBox('co64', p);
}

function parseStsz(box, buf) {
  assertRange(box, 0, 12, 'Invalid stsz table header');
  const versionFlags = Buffer.from(buf.subarray(box.contentStart, box.contentStart + 4));
  const defaultSize = buf.readUInt32BE(box.contentStart + 4);
  const sampleCount = buf.readUInt32BE(box.contentStart + 8);
  if (defaultSize !== 0) {
    return { sourceType: 'stsz', versionFlags, sampleCount, defaultSize, sizes: null };
  }
  checkedTableBytes(sampleCount, 4, 12, box, 'Invalid stsz table');
  const sizes = new Array(sampleCount);
  let p = box.contentStart + 12;
  for (let i = 0; i < sampleCount; i++, p += 4) sizes[i] = buf.readUInt32BE(p);
  return { sourceType: 'stsz', versionFlags, sampleCount, defaultSize: 0, sizes };
}

function parseStz2(box, buf) {
  // FullBox + reserved(24) + field_size(8) + sample_count(32) + packed entries
  assertRange(box, 0, 12, 'Invalid stz2 table header');
  const versionFlags = Buffer.from(buf.subarray(box.contentStart, box.contentStart + 4));
  const fieldSize = buf[box.contentStart + 7];
  const sampleCount = buf.readUInt32BE(box.contentStart + 8);
  if (![4, 8, 16].includes(fieldSize)) throw new Mp4Error(`Invalid stz2 field_size=${fieldSize} at ${box.absOffset}`);
  const packedBytes = fieldSize === 4 ? Math.ceil(sampleCount / 2) : sampleCount * (fieldSize / 8);
  checkedTableBytes(packedBytes, 1, 12, box, 'Invalid stz2 table');
  const sizes = new Array(sampleCount);
  let p = box.contentStart + 12;
  if (fieldSize === 4) {
    for (let i = 0; i < sampleCount; i++) {
      const byte = buf[p + (i >> 1)];
      sizes[i] = (i & 1) === 0 ? (byte >> 4) & 0x0F : byte & 0x0F;
    }
  } else if (fieldSize === 8) {
    for (let i = 0; i < sampleCount; i++) sizes[i] = buf[p + i];
  } else {
    for (let i = 0; i < sampleCount; i++) sizes[i] = buf.readUInt16BE(p + i * 2);
  }
  return { sourceType: 'stz2', versionFlags, sampleCount, defaultSize: 0, sizes, fieldSize };
}

function getSampleSize(sampleInfo, index) {
  return sampleInfo.defaultSize !== 0 ? sampleInfo.defaultSize : sampleInfo.sizes[index];
}

function buildInflatedStsz(sampleInfo, fakeCount, fakeSize) {
  const finalCountBig = BigInt(sampleInfo.sampleCount) + BigInt(fakeCount);
  if (finalCountBig > UINT32_MAX) throw new Mp4Error(`Invalid stsz table: final sample_count ${finalCountBig} exceeds uint32`);
  const finalCount = Number(finalCountBig);

  // Fake samples differ from most real default-size tables, so always emit
  // explicit sizes. This also safely promotes stz2 to ordinary stsz.
  const payloadLen = 12n + BigInt(finalCount) * 4n;
  const p = Buffer.allocUnsafe(ensureBufferLength(payloadLen, 'inflated stsz payload'));
  sampleInfo.versionFlags.copy(p, 0, 0, 4);
  p.writeUInt32BE(0, 4);
  p.writeUInt32BE(finalCount, 8);
  let out = 12;
  for (let i = 0; i < sampleInfo.sampleCount; i++, out += 4) {
    p.writeUInt32BE(getSampleSize(sampleInfo, i), out);
  }
  for (let i = 0; i < fakeCount; i++, out += 4) p.writeUInt32BE(fakeSize, out);
  return makeBox('stsz', p);
}

function parseStsc(box, buf) {
  assertRange(box, 0, 8, 'Invalid stsc table header');
  const versionFlags = Buffer.from(buf.subarray(box.contentStart, box.contentStart + 4));
  const count = buf.readUInt32BE(box.contentStart + 4);
  checkedTableBytes(count, 12, 8, box, 'Invalid stsc table');
  const rows = new Array(count);
  let p = box.contentStart + 8;
  for (let i = 0; i < count; i++, p += 12) {
    rows[i] = {
      firstChunk: buf.readUInt32BE(p),
      samplesPerChunk: buf.readUInt32BE(p + 4),
      sampleDescriptionIndex: buf.readUInt32BE(p + 8),
    };
  }
  return { versionFlags, rows };
}

function validateStsc(rows, chunkCount, sampleCount, label = 'stsc') {
  if (chunkCount === 0 && sampleCount === 0) return { mappedSamples: 0n, lastDescriptionIndex: 1 };
  if (rows.length === 0) throw new Mp4Error(`Invalid ${label} mapping: no entries for ${chunkCount} chunks`);
  if (rows[0].firstChunk !== 1) throw new Mp4Error(`Invalid ${label} mapping: first entry must start at chunk 1`);

  let mapped = 0n;
  let lastDesc = 1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const next = i + 1 < rows.length ? rows[i + 1].firstChunk : chunkCount + 1;
    if (r.firstChunk < 1 || r.samplesPerChunk < 1 || r.sampleDescriptionIndex < 1) {
      throw new Mp4Error(`Invalid ${label} entry ${i}: firstChunk=${r.firstChunk}, samplesPerChunk=${r.samplesPerChunk}, description=${r.sampleDescriptionIndex}`);
    }
    if (i > 0 && r.firstChunk <= rows[i - 1].firstChunk) throw new Mp4Error(`Invalid ${label}: first_chunk values are not strictly increasing`);
    if (r.firstChunk > chunkCount || next > chunkCount + 1 || next <= r.firstChunk) {
      throw new Mp4Error(`Invalid ${label}: chunk run ${r.firstChunk}..${next - 1} outside chunk_count=${chunkCount}`);
    }
    mapped += BigInt(next - r.firstChunk) * BigInt(r.samplesPerChunk);
    lastDesc = r.sampleDescriptionIndex;
  }
  if (mapped !== BigInt(sampleCount)) {
    throw new Mp4Error(`Invalid ${label} mapping: maps ${mapped} samples but sample table contains ${sampleCount}`);
  }
  return { mappedSamples: mapped, lastDescriptionIndex: lastDesc };
}

function buildInflatedStsc(stscInfo, oldChunkCount, fakeCount) {
  if (fakeCount === 0) {
    const p = Buffer.allocUnsafe(8 + stscInfo.rows.length * 12);
    stscInfo.versionFlags.copy(p, 0, 0, 4);
    p.writeUInt32BE(stscInfo.rows.length, 4);
    stscInfo.rows.forEach((r, i) => {
      const o = 8 + i * 12;
      p.writeUInt32BE(r.firstChunk, o);
      p.writeUInt32BE(r.samplesPerChunk, o + 4);
      p.writeUInt32BE(r.sampleDescriptionIndex, o + 8);
    });
    return makeBox('stsc', p);
  }

  if (BigInt(oldChunkCount) + BigInt(fakeCount) > UINT32_MAX) {
    throw new Mp4Error('Inflated audio chunk count exceeds uint32');
  }
  const rows = stscInfo.rows.map((r) => ({ ...r }));
  const last = rows[rows.length - 1];
  const desc = last?.sampleDescriptionIndex || 1;
  if (!last || last.samplesPerChunk !== 1 || last.sampleDescriptionIndex !== desc) {
    rows.push({ firstChunk: oldChunkCount + 1, samplesPerChunk: 1, sampleDescriptionIndex: desc });
  } else {
    // Existing last run already maps one sample per chunk; extending the chunk
    // table automatically extends that run to the new fake chunks.
  }

  const p = Buffer.allocUnsafe(8 + rows.length * 12);
  stscInfo.versionFlags.copy(p, 0, 0, 4);
  p.writeUInt32BE(rows.length, 4);
  rows.forEach((r, i) => {
    const o = 8 + i * 12;
    p.writeUInt32BE(r.firstChunk, o);
    p.writeUInt32BE(r.samplesPerChunk, o + 4);
    p.writeUInt32BE(r.sampleDescriptionIndex, o + 8);
  });
  return makeBox('stsc', p);
}

function parseStts(box, buf) {
  assertRange(box, 0, 8, 'Invalid stts table header');
  const versionFlags = Buffer.from(buf.subarray(box.contentStart, box.contentStart + 4));
  const count = buf.readUInt32BE(box.contentStart + 4);
  checkedTableBytes(count, 8, 8, box, 'Invalid stts table');
  const rows = new Array(count);
  let p = box.contentStart + 8;
  let totalSamples = 0n;
  let totalDuration = 0n;
  for (let i = 0; i < count; i++, p += 8) {
    const sampleCount = buf.readUInt32BE(p);
    const sampleDelta = buf.readUInt32BE(p + 4);
    if (sampleCount === 0) throw new Mp4Error(`Invalid stts entry ${i}: sample_count=0`);
    rows[i] = { sampleCount, sampleDelta };
    totalSamples += BigInt(sampleCount);
    totalDuration += BigInt(sampleCount) * BigInt(sampleDelta);
  }
  return { versionFlags, rows, totalSamples, totalDuration };
}

function buildInflatedStts(sttsInfo, fakeCount) {
  if (fakeCount === 0) return null;
  const rows = sttsInfo.rows.map((r) => ({ ...r }));
  // Zero delta is intentional for this method: the extra sample-table entries
  // exist without extending the declared/intended media timeline.
  if (rows.length && rows[rows.length - 1].sampleDelta === 0) {
    const merged = BigInt(rows[rows.length - 1].sampleCount) + BigInt(fakeCount);
    if (merged > UINT32_MAX) throw new Mp4Error('stts zero-delta run exceeds uint32 sample_count');
    rows[rows.length - 1].sampleCount = Number(merged);
  } else {
    rows.push({ sampleCount: fakeCount, sampleDelta: 0 });
  }
  const p = Buffer.allocUnsafe(8 + rows.length * 8);
  sttsInfo.versionFlags.copy(p, 0, 0, 4);
  p.writeUInt32BE(rows.length, 4);
  rows.forEach((r, i) => {
    p.writeUInt32BE(r.sampleCount, 8 + i * 8);
    p.writeUInt32BE(r.sampleDelta, 12 + i * 8);
  });
  return makeBox('stts', p);
}

function handlerType(mdia, moovBuf) {
  const hdlr = findChild(mdia, 'hdlr');
  if (!hdlr) return null;
  // hdlr is a FullBox: version/flags (4), pre_defined (4), handler_type (4)
  if (hdlr.contentStart + 12 > hdlr.end) return null;
  return typeFrom(moovBuf, hdlr.contentStart + 8);
}

function detectCodec(stbl, moovBuf) {
  const stsd = findChild(stbl, 'stsd');
  if (!stsd || stsd.contentStart + 16 > stsd.end) return 'unknown';
  const entryCount = moovBuf.readUInt32BE(stsd.contentStart + 4);
  if (entryCount < 1) return 'unknown';
  const entry = stsd.contentStart + 8;
  if (entry + 8 > stsd.end) return 'unknown';
  return typeFrom(moovBuf, entry + 4);
}

function codecLabel(fourcc) {
  const map = {
    avc1: 'H.264/AVC', avc3: 'H.264/AVC',
    hvc1: 'HEVC', hev1: 'HEVC', dvhe: 'Dolby Vision/HEVC', dvh1: 'Dolby Vision/HEVC',
    mp4v: 'MPEG-4 Visual', vp09: 'VP9', av01: 'AV1',
  };
  return map[fourcc] || fourcc || 'unknown';
}

function buildDataAtom(text) {
  const str = Buffer.from(text, 'utf8');
  const p = Buffer.allocUnsafe(8 + str.length);
  p.writeUInt32BE(1, 0); // type indicator = UTF-8
  p.writeUInt32BE(0, 4); // locale
  str.copy(p, 8);
  return makeBox('data', p);
}

function buildIlstTextTag(typeBytes, text) {
  return makeBox(typeBytes, buildDataAtom(text));
}

const CMT_TYPE = Buffer.from([0xA9, 0x63, 0x6D, 0x74]); // ©cmt
const NAM_TYPE = Buffer.from([0xA9, 0x6E, 0x61, 0x6D]); // ©nam

function buildMetadataHdlr() {
  const name = Buffer.from('appl\0', 'latin1');
  const p = Buffer.alloc(24 + name.length, 0);
  p.writeUInt32BE(0, 0); // FullBox version/flags
  p.writeUInt32BE(0, 4); // pre_defined
  Buffer.from('mdir', 'latin1').copy(p, 8);
  // reserved[3] = zero at 12..23
  name.copy(p, 24);
  return makeBox('hdlr', p);
}

function buildFreshIlst() {
  return makeBox('ilst', Buffer.concat([
    buildIlstTextTag(NAM_TYPE, METHOD),
    buildIlstTextTag(CMT_TYPE, METHOD),
  ]));
}

function buildFreshMeta() {
  const fullBox = Buffer.alloc(4, 0);
  return makeBox('meta', Buffer.concat([fullBox, buildMetadataHdlr(), buildFreshIlst()]));
}

function buildFreshUdta() {
  return makeBox('udta', buildFreshMeta());
}

function detectMetaLayout(moovBuf, metaBox, moovAbsBase) {
  // Standard ISO/MP4 meta is a FullBox: version+flags then child atoms.
  if (metaBox.contentStart + 4 <= metaBox.end) {
    const standard = parseBoxStream(
      moovBuf,
      metaBox.contentStart + 4,
      metaBox.end,
      'meta',
      moovAbsBase,
      false,
    );
    if (standard) return { prefix: Buffer.from(moovBuf.subarray(metaBox.contentStart, metaBox.contentStart + 4)), children: standard, standard: true };
  }

  // Some QuickTime/vendor files use meta-like payloads where children begin
  // immediately. Accept only when the entire payload validates as boxes.
  const direct = parseBoxStream(moovBuf, metaBox.contentStart, metaBox.end, 'meta', moovAbsBase, false);
  if (direct) return { prefix: Buffer.alloc(0), children: direct, standard: false };
  return null;
}

function stripAndSetIlst(moovBuf, ilstBox, moovAbsBase, addMethod) {
  const children = parseBoxStream(moovBuf, ilstBox.contentStart, ilstBox.end, 'ilst', moovAbsBase, false);
  if (!children) return null;
  const parts = [];
  let hasName = false;
  for (const c of children) {
    const raw = moovBuf.subarray(c.offset + 4, c.offset + 8);
    const isCmt = raw.equals(CMT_TYPE);
    const isNam = raw.equals(NAM_TYPE);
    // ©cmt is the requested Method field, so replace existing comments rather
    // than duplicating them. ©nam is optional: preserve an existing title
    // exactly and add the Method title only when the file has no ©nam.
    if (isCmt) continue;
    if (isNam) hasName = true;
    parts.push(Buffer.from(boxRawSlice(moovBuf, c)));
  }
  if (addMethod) {
    if (!hasName) parts.push(buildIlstTextTag(NAM_TYPE, METHOD));
    parts.push(buildIlstTextTag(CMT_TYPE, METHOD));
  }
  return makeBoxLike(ilstBox, Buffer.concat(parts));
}

function rebuildMetaWithMethod(moovBuf, metaBox, moovAbsBase, addMethod) {
  const layout = detectMetaLayout(moovBuf, metaBox, moovAbsBase);
  if (!layout) return null;

  // Avoid injecting ©-style items into mdta/key-index metadata unless it
  // already carries an © item. If it only uses 'keys', preserve it and let a
  // fresh iTunes-style meta be added elsewhere.
  const hasKeys = layout.children.some((c) => c.type === 'keys');
  const ilst = layout.children.find((c) => c.type === 'ilst');
  let ilstHasCopyrightTag = false;
  if (ilst) {
    const ilstChildren = parseBoxStream(moovBuf, ilst.contentStart, ilst.end, 'ilst', moovAbsBase, false);
    if (ilstChildren) {
      ilstHasCopyrightTag = ilstChildren.some((c) => {
        const raw = moovBuf.subarray(c.offset + 4, c.offset + 8);
        return raw.equals(CMT_TYPE) || raw.equals(NAM_TYPE);
      });
    }
  }

  if (hasKeys && !ilstHasCopyrightTag) {
    return { buffer: Buffer.from(boxRawSlice(moovBuf, metaBox)), acceptedForMethod: false };
  }

  const parts = [layout.prefix];
  let sawIlst = false;
  for (const child of layout.children) {
    if (child.type === 'ilst') {
      sawIlst = true;
      const rebuilt = stripAndSetIlst(moovBuf, child, moovAbsBase, addMethod);
      if (!rebuilt) return null;
      parts.push(rebuilt);
    } else {
      parts.push(Buffer.from(boxRawSlice(moovBuf, child)));
    }
  }
  if (addMethod && !sawIlst) parts.push(buildFreshIlst());
  return { buffer: makeBoxLike(metaBox, Buffer.concat(parts)), acceptedForMethod: true };
}

function rebuildUdtaMetadata(moovBuf, udtaBox, moovAbsBase, state) {
  const children = parseBoxStream(moovBuf, udtaBox.contentStart, udtaBox.end, 'udta', moovAbsBase, false);
  if (!children) return null;
  const parts = [];
  let hadAcceptedMeta = false;

  for (const child of children) {
    if (child.type !== 'meta') {
      parts.push(Buffer.from(boxRawSlice(moovBuf, child)));
      continue;
    }
    const shouldAdd = !state.methodPlaced;
    const rebuilt = rebuildMetaWithMethod(moovBuf, child, moovAbsBase, shouldAdd);
    if (!rebuilt) {
      parts.push(Buffer.from(boxRawSlice(moovBuf, child)));
      continue;
    }
    hadAcceptedMeta ||= rebuilt.acceptedForMethod;
    if (rebuilt.acceptedForMethod && shouldAdd) state.methodPlaced = true;
    parts.push(rebuilt.buffer);
  }

  if (!state.methodPlaced && !hadAcceptedMeta) {
    parts.push(buildFreshMeta());
    state.methodPlaced = true;
  } else if (!state.methodPlaced && hadAcceptedMeta) {
    // This can only happen if an accepted meta was rebuilt without method;
    // keep deterministic behavior by adding a dedicated standard meta.
    parts.push(buildFreshMeta());
    state.methodPlaced = true;
  }

  return makeBoxLike(udtaBox, Buffer.concat(parts));
}

function buildMetadataReplacements(moovBuf, moov, moovAbsBase) {
  const replacements = new Map();
  const udtas = findChildren(moov, 'udta');
  const state = { methodPlaced: false };

  // First pass: rebuild parseable udta boxes. Existing ©cmt/©nam are removed
  // from every parseable compatible meta, and the method is inserted once.
  for (const udta of udtas) {
    const rebuilt = rebuildUdtaMetadata(moovBuf, udta, moovAbsBase, state);
    if (rebuilt) replacements.set(udta, rebuilt);
  }

  // If every existing udta is opaque/vendor-specific, preserve it untouched
  // and append a new standard udta sibling instead of deleting vendor data.
  const appendFreshUdta = !state.methodPlaced;
  return { replacements, appendFreshUdta };
}

function rebuildTree(buf, box, replacements, options = {}) {
  if (replacements.has(box)) return replacements.get(box);
  if (!box.children || box.children.length === 0) return Buffer.from(boxRawSlice(buf, box));

  const parts = [];
  let cursor = box.contentStart;
  for (const child of box.children) {
    if (cursor < child.offset) parts.push(Buffer.from(buf.subarray(cursor, child.offset)));
    parts.push(rebuildTree(buf, child, replacements, options));
    cursor = child.end;
  }
  if (cursor < box.end) parts.push(Buffer.from(buf.subarray(cursor, box.end)));
  if (box.type === 'moov' && options.appendFreshUdta) parts.push(buildFreshUdta());
  return makeBoxLike(box, Buffer.concat(parts));
}

function trackEnabled(trak, moovBuf) {
  const tkhd = findChild(trak, 'tkhd');
  if (!tkhd || tkhd.contentStart + 4 > tkhd.end) return true;
  const versionAndFlags = moovBuf.readUInt32BE(tkhd.contentStart);
  return (versionAndFlags & 0x000001) !== 0;
}

function collectTracks(moov, moovBuf) {
  const tracks = [];
  for (const trak of findChildren(moov, 'trak')) {
    const mdia = findChild(trak, 'mdia');
    if (!mdia) continue;
    const handler = handlerType(mdia, moovBuf);
    const minf = findChild(mdia, 'minf');
    const stbl = minf ? findChild(minf, 'stbl') : null;
    tracks.push({
      trak,
      mdia,
      handler,
      minf,
      stbl,
      codec: stbl ? detectCodec(stbl, moovBuf) : 'unknown',
      enabled: trackEnabled(trak, moovBuf),
    });
  }
  return tracks;
}

function getOffsetBoxesForTrack(track) {
  if (!track.stbl) return [];
  return track.stbl.children.filter((c) => c.type === 'stco' || c.type === 'co64');
}

function parseOffsetTable(box, moovBuf) {
  return box.type === 'co64' ? parseCo64(box, moovBuf) : parseStco(box, moovBuf);
}

function validateAudioChunkByteRanges(sampleInfo, stscInfo, offsetInfo, mdats) {
  let rowIndex = 0;
  let sampleIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= offsetInfo.offsets.length; chunkIndex++) {
    while (rowIndex + 1 < stscInfo.rows.length && stscInfo.rows[rowIndex + 1].firstChunk <= chunkIndex) rowIndex++;
    const row = stscInfo.rows[rowIndex];
    if (!row) throw new Mp4Error(`Invalid audio stsc mapping at chunk ${chunkIndex}`);
    let chunkBytes = 0n;
    for (let j = 0; j < row.samplesPerChunk; j++) {
      if (sampleIndex >= sampleInfo.sampleCount) throw new Mp4Error(`Invalid audio stsc mapping: chunk ${chunkIndex} references sample beyond stsz/stz2`);
      chunkBytes += BigInt(getSampleSize(sampleInfo, sampleIndex++));
    }
    const off = offsetInfo.offsets[chunkIndex - 1];
    const mdat = locateMdatForOffset(off, mdats);
    if (!mdat) throw new Mp4Error(`Chunk offset outside mdat: audio chunk=${chunkIndex} offset=${off}`);
    if (off + chunkBytes > mdat.end) {
      throw new Mp4Error(`Audio chunk exceeds mdat payload: chunk=${chunkIndex} offset=${off} bytes=${chunkBytes} mdatEnd=${mdat.end}`);
    }
  }
  if (sampleIndex !== sampleInfo.sampleCount) {
    throw new Mp4Error(`Invalid audio stsc mapping: consumed ${sampleIndex} samples, expected ${sampleInfo.sampleCount}`);
  }
}

function getSelectedAudioCandidate(track, moovBuf, mdats) {
  if (track.handler !== 'soun' || !track.stbl) return null;
  const stsz = findChild(track.stbl, 'stsz');
  const stz2 = findChild(track.stbl, 'stz2');
  const stsc = findChild(track.stbl, 'stsc');
  const stts = findChild(track.stbl, 'stts');
  const offsets = getOffsetBoxesForTrack(track);
  if ((!stsz && !stz2) || (stsz && stz2) || !stsc || !stts || offsets.length !== 1) return null;

  try {
    const sampleInfo = stsz ? parseStsz(stsz, moovBuf) : parseStz2(stz2, moovBuf);
    const offsetInfo = parseOffsetTable(offsets[0], moovBuf);
    const stscInfo = parseStsc(stsc, moovBuf);
    const sttsInfo = parseStts(stts, moovBuf);
    if (sampleInfo.sampleCount === 0 || offsetInfo.offsets.length === 0) return null;
    validateStsc(stscInfo.rows, offsetInfo.offsets.length, sampleInfo.sampleCount, 'audio stsc');
    if (sttsInfo.totalSamples !== BigInt(sampleInfo.sampleCount)) {
      throw new Mp4Error(`Invalid audio stts table: maps ${sttsInfo.totalSamples} samples but stsz/stz2 contains ${sampleInfo.sampleCount}`);
    }
    validateAudioChunkByteRanges(sampleInfo, stscInfo, offsetInfo, mdats);
    return { track, sizeBox: stsz || stz2, stsc, stts, offsetBox: offsets[0], sampleInfo, offsetInfo, stscInfo, sttsInfo };
  } catch (error) {
    return { error };
  }
}

function locateMdatForOffset(offset, mdats) {
  for (const mdat of mdats) {
    if (offset >= mdat.contentStart && offset < mdat.end) return mdat;
  }
  return null;
}

function chooseAudioAndTargetMdat(tracks, moovBuf, mdats) {
  const candidates = [];
  const audioErrors = [];
  for (const t of tracks) {
    const c = getSelectedAudioCandidate(t, moovBuf, mdats);
    if (!c) continue;
    if (c.error) { audioErrors.push(c.error); continue; }
    let lastOffset = -1n;
    let lastMdat = null;
    for (const off of c.offsetInfo.offsets) {
      const mdat = locateMdatForOffset(off, mdats);
      if (off > lastOffset) { lastOffset = off; lastMdat = mdat; }
    }
    if (!lastMdat) continue;
    candidates.push({ ...c, targetMdat: lastMdat });
  }
  if (!candidates.length) {
    if (audioErrors.length) throw audioErrors[0];
    throw new Mp4Error('No usable audio track');
  }
  // Prefer an enabled track, then the largest continuous sample table. This
  // avoids blindly assuming track order while leaving secondary tracks intact.
  candidates.sort((a, b) => Number(b.track.enabled) - Number(a.track.enabled) || b.sampleInfo.sampleCount - a.sampleInfo.sampleCount);
  return candidates[0];
}

function collectAllOffsetTables(tracks, moovBuf, selectedAudio) {
  const tables = [];
  for (const track of tracks) {
    for (const box of getOffsetBoxesForTrack(track)) {
      const parsed = parseOffsetTable(box, moovBuf);
      tables.push({
        box,
        track,
        originalType: box.type,
        versionFlags: parsed.versionFlags,
        originalOffsets: parsed.offsets,
        isSelectedAudio: box === selectedAudio.offsetBox,
      });
    }
  }
  return tables;
}

function originalMdatPayloadSize(mdat) {
  return mdat.end - mdat.contentStart;
}

function chooseMdatHeader(targetMdat, newPayloadSize) {
  if (targetMdat.sizeWasZero) {
    return { headerSize: 8n, totalSize: 8n + newPayloadSize, sizeZero: true, extended: false };
  }
  const normal = 8n + newPayloadSize;
  const extended = targetMdat.usedLargeSize || normal > UINT32_MAX;
  const headerSize = extended ? 16n : 8n;
  const totalSize = headerSize + newPayloadSize;
  if (totalSize > UINT64_MAX) throw new Mp4Error('Target mdat exceeds 64-bit MP4 box size');
  return { headerSize, totalSize, sizeZero: false, extended };
}

function calculateLayout(topBoxes, moovTop, moovLength, targetMdat, fakePayloadSize) {
  const layout = new Map();
  let cursor = 0n;
  for (const box of topBoxes) {
    let size = box.size;
    let headerSize = box.headerSize;
    let sizeZero = box.sizeWasZero;
    let extended = box.usedLargeSize;

    if (box === moovTop) {
      size = BigInt(moovLength);
      headerSize = size > UINT32_MAX || moovTop.usedLargeSize ? 16n : 8n;
      // moovLength already includes whichever header rebuildTree emitted.
      // Recover actual header by reading its first size field later; the total
      // size here is authoritative.
      sizeZero = false;
      extended = headerSize === 16n;
    } else if (box === targetMdat) {
      const payload = originalMdatPayloadSize(box) + fakePayloadSize;
      const hdr = chooseMdatHeader(box, payload);
      size = hdr.totalSize;
      headerSize = hdr.headerSize;
      sizeZero = hdr.sizeZero;
      extended = hdr.extended;
    }

    const rec = {
      box,
      oldStart: box.start,
      oldEnd: box.end,
      newStart: cursor,
      newEnd: cursor + size,
      newSize: size,
      newHeaderSize: headerSize,
      newContentStart: cursor + headerSize,
      sizeZero,
      extended,
    };
    layout.set(box, rec);
    cursor += size;
  }
  return { layout, outputSize: cursor };
}

function buildRelocationMap(mdats, layout) {
  return mdats.map((mdat) => {
    const rec = layout.get(mdat);
    return {
      mdat,
      oldStart: mdat.contentStart,
      oldEnd: mdat.end,
      newStart: rec.newContentStart,
      newEndOriginal: rec.newContentStart + originalMdatPayloadSize(mdat),
    };
  });
}

function translateOffset(oldOffset, relocationMap) {
  for (const r of relocationMap) {
    if (oldOffset >= r.oldStart && oldOffset < r.oldEnd) {
      return r.newStart + (oldOffset - r.oldStart);
    }
  }
  throw new Mp4Error(`Chunk offset outside mdat: ${oldOffset}`);
}

function fakeOffsetsFor(targetMdat, layout, fakeCount, fakeSize) {
  const rec = layout.get(targetMdat);
  const start = rec.newContentStart + originalMdatPayloadSize(targetMdat);
  const out = new Array(fakeCount);
  for (let i = 0; i < fakeCount; i++) out[i] = start + BigInt(i) * BigInt(fakeSize);
  return out;
}

function buildOffsetReplacement(table, mappedOffsets, forceCo64) {
  const useCo64 = table.originalType === 'co64' || forceCo64 || mappedOffsets.some((o) => o > UINT32_MAX);
  return useCo64 ? buildCo64(mappedOffsets, table.versionFlags) : buildStco(mappedOffsets, table.versionFlags);
}

function makeZeroOffsetReplacement(table, fakeCount, forceCo64) {
  const count = table.originalOffsets.length + (table.isSelectedAudio ? fakeCount : 0);
  const zeros = new Array(count).fill(0n);
  return buildOffsetReplacement(table, zeros, forceCo64);
}

function makeMdatHeader(rec) {
  if (rec.sizeZero) {
    const h = Buffer.allocUnsafe(8);
    h.writeUInt32BE(0, 0);
    h.write('mdat', 4, 4, 'latin1');
    return h;
  }
  if (rec.extended) {
    const h = Buffer.allocUnsafe(16);
    h.writeUInt32BE(1, 0);
    h.write('mdat', 4, 4, 'latin1');
    writeU64BE(h, 8, rec.newSize);
    return h;
  }
  if (rec.newSize > UINT32_MAX) throw new Mp4Error('Internal error: 32-bit mdat header overflow');
  const h = Buffer.allocUnsafe(8);
  h.writeUInt32BE(Number(rec.newSize), 0);
  h.write('mdat', 4, 4, 'latin1');
  return h;
}

function inspectFinalAudioTables(selectedAudio, fakeCount, replacements, offsetReplacementInfo) {
  const finalSampleCount = BigInt(selectedAudio.sampleInfo.sampleCount) + BigInt(fakeCount);
  const finalChunkCount = BigInt(selectedAudio.offsetInfo.offsets.length) + BigInt(fakeCount);
  if (finalSampleCount > UINT32_MAX || finalChunkCount > UINT32_MAX) throw new Mp4Error('Final audio table count overflow');

  const finalStscRows = selectedAudio.stscInfo.rows.map((r) => ({ ...r }));
  if (fakeCount > 0) {
    const last = finalStscRows[finalStscRows.length - 1];
    if (!last || last.samplesPerChunk !== 1) {
      finalStscRows.push({
        firstChunk: selectedAudio.offsetInfo.offsets.length + 1,
        samplesPerChunk: 1,
        sampleDescriptionIndex: last?.sampleDescriptionIndex || 1,
      });
    }
  }
  validateStsc(finalStscRows, Number(finalChunkCount), Number(finalSampleCount), 'final audio stsc');

  const finalSttsSamples = selectedAudio.sttsInfo.totalSamples + BigInt(fakeCount);
  if (finalSttsSamples !== finalSampleCount) {
    throw new Mp4Error(`Final stts sample count mismatch: stts=${finalSttsSamples}, stsz=${finalSampleCount}`);
  }
  if (!replacements.has(selectedAudio.sizeBox) || !replacements.has(selectedAudio.stsc) || !replacements.has(selectedAudio.stts)) {
    throw new Mp4Error('Final audio sample-table replacements are incomplete');
  }
  if (!offsetReplacementInfo) throw new Mp4Error('Final audio chunk-offset replacement is missing');
}

function verifyFinalChunkOffsets(offsetTables, mappedByTable, relocationMap, targetMdat, layout, fakeCount, fakeSize) {
  const finalMediaRanges = relocationMap.map((r) => ({ start: r.newStart, end: r.newEndOriginal, mdat: r.mdat }));
  const targetRec = layout.get(targetMdat);
  if (fakeCount > 0) {
    finalMediaRanges.push({
      start: targetRec.newContentStart + originalMdatPayloadSize(targetMdat),
      end: targetRec.newContentStart + originalMdatPayloadSize(targetMdat) + BigInt(fakeCount) * BigInt(fakeSize),
      mdat: targetMdat,
      fake: true,
    });
  }

  for (const table of offsetTables) {
    const offsets = mappedByTable.get(table);
    if (!offsets) throw new Mp4Error('Internal error: missing mapped chunk offsets');
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i];
      const ok = finalMediaRanges.some((r) => off >= r.start && off < r.end);
      if (!ok) {
        throw new Mp4Error(`Generated ${table.originalType} chunk offset outside final mdat: table@${table.box.absOffset} entry=${i} offset=${off}`);
      }
    }
  }
}

function buildUniversalPatchPlan(inputPath, opts = {}) {
  const factor = opts.factor ?? DEFAULT_FACTOR;
  const fakeSize = opts.fakeSize ?? DEFAULT_FAKE_SIZE;
  const verbose = !!opts.verbose;

  if (!Number.isInteger(factor) || factor < 1 || factor > 1000) throw new Mp4Error('--factor must be an integer from 1 to 1000');
  if (!Number.isInteger(fakeSize) || fakeSize < 1 || fakeSize > 1024) throw new Mp4Error('--fake-size must be an integer from 1 to 1024');

  const fd = fs.openSync(inputPath, 'r');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const fileSize = stat.size;
    if (fileSize < 8n) throw new Mp4Error('Input is too small to be an MP4/MOV file');
    if (fileSize > MAX_SAFE_BIG) throw new Mp4Error(`Input file is too large for Node random-access APIs: ${fileSize}`);

    const topBoxes = parseTopLevel(fd, fileSize);
    const moovs = topBoxes.filter((b) => b.type === 'moov');
    const mdats = topBoxes.filter((b) => b.type === 'mdat');
    if (topBoxes.some((b) => b.type === 'moof')) throw new Mp4Error('Unsupported fragmented MP4 structure (moof/traf/trun)');
    if (moovs.length !== 1) throw new Mp4Error(`Expected exactly one moov box, found ${moovs.length}`);
    if (!mdats.length) throw new Mp4Error('No mdat box found');

    const moovTop = moovs[0];
    const moovSize = ensureBufferLength(moovTop.size, 'moov box');
    const moovBuf = readExact(fd, moovTop.start, moovSize, 'moov box');
    const moovRoot = readBufferBox(moovBuf, 0, moovBuf.length, 'file', moovTop.start);
    if (moovRoot.type !== 'moov' || moovRoot.end !== moovBuf.length) throw new Mp4Error('Internal moov parse mismatch');
    parseStructuralTree(moovBuf, moovRoot, moovTop.start);
    if (findChild(moovRoot, 'mvex')) throw new Mp4Error('Unsupported fragmented MP4 structure (mvex)');

    const tracks = collectTracks(moovRoot, moovBuf);
    const videoTracks = tracks.filter((t) => t.handler === 'vide');
    if (!videoTracks.length) throw new Mp4Error('No video track');
    const selectedAudio = chooseAudioAndTargetMdat(tracks, moovBuf, mdats);

    const realCount = selectedAudio.sampleInfo.sampleCount;
    const fakeCountBig = BigInt(realCount) * BigInt(factor);
    const finalCountBig = BigInt(realCount) + fakeCountBig;
    if (fakeCountBig > UINT32_MAX || finalCountBig > UINT32_MAX) {
      throw new Mp4Error(`Invalid stsz table: ${realCount} real samples with factor ${factor} exceeds uint32 sample_count`);
    }
    const fakeCount = Number(fakeCountBig);
    const fakePayloadSize = BigInt(fakeCount) * BigInt(fakeSize);

    const offsetTables = collectAllOffsetTables(tracks, moovBuf, selectedAudio);
    if (!offsetTables.length) throw new Mp4Error('No stco/co64 chunk-offset tables found');

    // Validate every original chunk offset before any mutation.
    for (const table of offsetTables) {
      for (let i = 0; i < table.originalOffsets.length; i++) {
        if (!locateMdatForOffset(table.originalOffsets[i], mdats)) {
          throw new Mp4Error(`Chunk offset outside mdat: table='${table.originalType}' atomOffset=${table.box.absOffset} entry=${i} value=${table.originalOffsets[i]}`);
        }
      }
    }

    const baseReplacements = new Map();
    baseReplacements.set(selectedAudio.sizeBox, buildInflatedStsz(selectedAudio.sampleInfo, fakeCount, fakeSize));
    baseReplacements.set(selectedAudio.stsc, buildInflatedStsc(selectedAudio.stscInfo, selectedAudio.offsetInfo.offsets.length, fakeCount));
    const sttsRep = buildInflatedStts(selectedAudio.sttsInfo, fakeCount);
    if (sttsRep) baseReplacements.set(selectedAudio.stts, sttsRep);

    const metadata = buildMetadataReplacements(moovBuf, moovRoot, moovTop.start);
    for (const [k, v] of metadata.replacements) baseReplacements.set(k, v);

    const forceCo64 = new Set(offsetTables.filter((t) => t.originalType === 'co64'));
    let finalMoov = null;
    let finalLayout = null;
    let finalRelocation = null;
    let mappedByTable = null;
    let finalReplacements = null;
    let stabilized = false;
    let lastSignature = null;
    let passes = 0;

    for (let pass = 1; pass <= Math.min(MAX_STABILIZATION_PASSES, offsetTables.length + 8); pass++) {
      passes = pass;
      // Measurement build: table counts/types are final, values are placeholders.
      const measureReplacements = new Map(baseReplacements);
      for (const table of offsetTables) {
        measureReplacements.set(table.box, makeZeroOffsetReplacement(table, fakeCount, forceCo64.has(table)));
      }
      const measuredMoov = rebuildTree(moovBuf, moovRoot, measureReplacements, { appendFreshUdta: metadata.appendFreshUdta });
      const layoutResult = calculateLayout(topBoxes, moovTop, measuredMoov.length, selectedAudio.targetMdat, fakePayloadSize);
      const relocationMap = buildRelocationMap(mdats, layoutResult.layout);
      const fakeOffsets = fakeOffsetsFor(selectedAudio.targetMdat, layoutResult.layout, fakeCount, fakeSize);

      const translated = new Map();
      let promoted = false;
      for (const table of offsetTables) {
        const offsets = table.originalOffsets.map((old) => translateOffset(old, relocationMap));
        if (table.isSelectedAudio) offsets.push(...fakeOffsets);
        translated.set(table, offsets);
        if (table.originalType === 'stco' && !forceCo64.has(table) && offsets.some((o) => o > UINT32_MAX)) {
          forceCo64.add(table);
          promoted = true;
        }
      }
      if (promoted) continue;

      const reps = new Map(baseReplacements);
      for (const table of offsetTables) {
        reps.set(table.box, buildOffsetReplacement(table, translated.get(table), forceCo64.has(table)));
      }
      const actualMoov = rebuildTree(moovBuf, moovRoot, reps, { appendFreshUdta: metadata.appendFreshUdta });
      const actualLayoutResult = calculateLayout(topBoxes, moovTop, actualMoov.length, selectedAudio.targetMdat, fakePayloadSize);
      const signature = `${actualMoov.length}|${actualLayoutResult.outputSize}|${[...forceCo64].length}|${actualLayoutResult.layout.get(selectedAudio.targetMdat).newHeaderSize}`;

      // If the actual rebuild changed layout relative to the measured build,
      // loop again with the observed dimensions. Usually one stable pass is
      // sufficient after all stco promotions are known.
      if (actualMoov.length !== measuredMoov.length || (lastSignature !== null && signature !== lastSignature)) {
        lastSignature = signature;
        continue;
      }

      const actualRelocation = buildRelocationMap(mdats, actualLayoutResult.layout);
      const actualFakeOffsets = fakeOffsetsFor(selectedAudio.targetMdat, actualLayoutResult.layout, fakeCount, fakeSize);
      const actualMapped = new Map();
      let needsPromotion = false;
      for (const table of offsetTables) {
        const offsets = table.originalOffsets.map((old) => translateOffset(old, actualRelocation));
        if (table.isSelectedAudio) offsets.push(...actualFakeOffsets);
        actualMapped.set(table, offsets);
        if (table.originalType === 'stco' && !forceCo64.has(table) && offsets.some((o) => o > UINT32_MAX)) {
          forceCo64.add(table);
          needsPromotion = true;
        }
      }
      if (needsPromotion) continue;

      // Rebuild once more with the exact final translated offsets.
      const exactReps = new Map(baseReplacements);
      for (const table of offsetTables) {
        exactReps.set(table.box, buildOffsetReplacement(table, actualMapped.get(table), forceCo64.has(table)));
      }
      const exactMoov = rebuildTree(moovBuf, moovRoot, exactReps, { appendFreshUdta: metadata.appendFreshUdta });
      const exactLayout = calculateLayout(topBoxes, moovTop, exactMoov.length, selectedAudio.targetMdat, fakePayloadSize);
      if (exactMoov.length !== actualMoov.length || exactLayout.outputSize !== actualLayoutResult.outputSize) {
        lastSignature = `${exactMoov.length}|${exactLayout.outputSize}|${forceCo64.size}`;
        continue;
      }

      finalMoov = exactMoov;
      finalLayout = exactLayout;
      finalRelocation = buildRelocationMap(mdats, finalLayout.layout);
      mappedByTable = actualMapped;
      finalReplacements = exactReps;
      stabilized = true;
      break;
    }

    if (!stabilized) throw new Mp4Error('Unable to stabilize MP4 layout');

    const selectedTablePlan = offsetTables.find((t) => t.isSelectedAudio);
    inspectFinalAudioTables(selectedAudio, fakeCount, finalReplacements, selectedTablePlan);
    verifyFinalChunkOffsets(offsetTables, mappedByTable, finalRelocation, selectedAudio.targetMdat, finalLayout.layout, fakeCount, fakeSize);

    // Final output offsets must be inside the final file and inside intended
    // media ranges. The media-range check above is stronger; this is a final
    // absolute bounds guard.
    for (const offsets of mappedByTable.values()) {
      for (const off of offsets) {
        if (off < 0n || off >= finalLayout.outputSize) throw new Mp4Error(`Generated chunk offset outside final file: ${off}`);
      }
    }

    const inputCo64 = offsetTables.filter((t) => t.originalType === 'co64').length;
    const outputCo64 = offsetTables.filter((t) => t.originalType === 'co64' || forceCo64.has(t)).length;
    const videoCodec = videoTracks[0].codec;

    if (verbose) {
      console.log(`[*] Container parsed successfully`);
      console.log(`[*] Video codec: ${codecLabel(videoCodec)}`);
      console.log(`[*] Top-level mdats: ${mdats.length}`);
      console.log(`[*] Chunk offset tables: ${offsetTables.length} (${inputCo64} co64 input)`);
      console.log(`[*] Audio samples: ${realCount} -> ${realCount + fakeCount}`);
      console.log(`[*] Updating ${offsetTables.length} track offset table(s)`);
      console.log(`[*] Layout stabilization passes: ${passes}`);
      if (outputCo64 > inputCo64) console.log(`[*] Promoted ${outputCo64 - inputCo64} stco table(s) -> co64`);
      console.log(`[*] Embedding Method: ${METHOD}`);
      console.log(`[*] Preserving original duration and edit lists`);
      console.log(`[*] Final layout validated`);
    }

    return {
      version: VERSION,
      method: METHOD,
      fileSize,
      topBoxes,
      moovTop,
      mdats,
      targetMdat: selectedAudio.targetMdat,
      finalMoov,
      finalLayout,
      fakeCount,
      fakeSize,
      fakePayloadSize,
      factor,
      tracks,
      videoCodec,
      realAudioSamples: realCount,
      offsetTableCount: offsetTables.length,
      inputCo64,
      outputCo64,
      passes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function copyRange(inFd, outFd, start, length) {
  let pos = start;
  let remaining = length;
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  while (remaining > 0n) {
    const wanted = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
    const inputPos = safeNumber(pos, 'copy source offset');
    const n = fs.readSync(inFd, buffer, 0, wanted, inputPos);
    if (n <= 0) throw new Mp4Error(`Unexpected EOF while copying media at ${pos}`);
    let written = 0;
    while (written < n) written += fs.writeSync(outFd, buffer, written, n - written, null);
    pos += BigInt(n);
    remaining -= BigInt(n);
  }
}

function writeZeros(outFd, length) {
  const zero = Buffer.alloc(Math.min(COPY_CHUNK, 1024 * 1024), 0);
  let remaining = length;
  while (remaining > 0n) {
    const n = Number(remaining > BigInt(zero.length) ? BigInt(zero.length) : remaining);
    let written = 0;
    while (written < n) written += fs.writeSync(outFd, zero, written, n - written, null);
    remaining -= BigInt(n);
  }
}

function patchFile(inputPath, outputPath, opts = {}) {
  const absIn = path.resolve(inputPath);
  const absOut = path.resolve(outputPath);
  const samePath = absIn === absOut;
  const tempPath = samePath ? `${absOut}.theziess-tmp-${process.pid}` : absOut;
  const plan = buildUniversalPatchPlan(absIn, opts);

  const inFd = fs.openSync(absIn, 'r');
  let outFd;
  try {
    outFd = fs.openSync(tempPath, 'w');
    for (const box of plan.topBoxes) {
      if (box === plan.moovTop) {
        let written = 0;
        while (written < plan.finalMoov.length) {
          written += fs.writeSync(outFd, plan.finalMoov, written, plan.finalMoov.length - written, null);
        }
        continue;
      }

      if (box === plan.targetMdat) {
        const rec = plan.finalLayout.layout.get(box);
        const header = makeMdatHeader(rec);
        fs.writeSync(outFd, header, 0, header.length, null);
        copyRange(inFd, outFd, box.contentStart, originalMdatPayloadSize(box));
        writeZeros(outFd, plan.fakePayloadSize);
        continue;
      }

      copyRange(inFd, outFd, box.start, box.size);
    }
    fs.fsyncSync(outFd);
  } catch (e) {
    try { if (outFd !== undefined) fs.closeSync(outFd); } catch {}
    outFd = undefined;
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    throw e;
  } finally {
    fs.closeSync(inFd);
    if (outFd !== undefined) fs.closeSync(outFd);
  }

  const finalStat = fs.statSync(tempPath, { bigint: true });
  if (finalStat.size !== plan.finalLayout.outputSize) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw new Mp4Error(`Final file size mismatch: wrote ${finalStat.size}, planned ${plan.finalLayout.outputSize}`);
  }

  if (samePath) fs.renameSync(tempPath, absOut);
  return { ...plan, outputPath: absOut, outputSize: finalStat.size };
}

function usage(exitCode = 0) {
  const exe = path.basename(process.argv[1] || 'patch.js');
  const msg = `Usage: node ${exe} [options] <input.mp4|mov> [output.mp4|mov]\n\n` +
    `Options:\n` +
    `  --factor N       Fake samples to append per real sample (default ${DEFAULT_FACTOR})\n` +
    `  --fake-size N    Zero-filled bytes per fake sample (default ${DEFAULT_FAKE_SIZE})\n` +
    `  --base-size N    Compatibility alias; accepted but does not change the safe 8-byte default\n` +
    `  --seed N         Compatibility option; accepted, fake payload is always zero-filled\n` +
    `  --verbose        Print parser/layout details\n` +
    `  -h, --help       Show this help\n`;
  (exitCode ? console.error : console.log)(msg);
  process.exit(exitCode);
}

function defaultOutput(input) {
  const ext = path.extname(input);
  const base = ext ? input.slice(0, -ext.length) : input;
  return `${base}_patched${ext || '.mp4'}`;
}

function parseCli(argv) {
  const opts = { factor: DEFAULT_FACTOR, fakeSize: DEFAULT_FAKE_SIZE, verbose: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--factor') {
      if (i + 1 >= argv.length) throw new Mp4Error('--factor requires a value');
      opts.factor = Number(argv[++i]);
    } else if (a === '--fake-size') {
      if (i + 1 >= argv.length) throw new Mp4Error('--fake-size requires a value');
      opts.fakeSize = Number(argv[++i]);
    } else if (a === '--base-size') {
      if (i + 1 >= argv.length) throw new Mp4Error('--base-size requires a value');
      opts.baseSize = Number(argv[++i]);
    } else if (a === '--seed') {
      if (i + 1 >= argv.length) throw new Mp4Error('--seed requires a value');
      opts.seed = Number(argv[++i]);
    } else if (a.startsWith('-')) {
      throw new Mp4Error(`Unknown option: ${a}`);
    } else files.push(a);
  }
  if (files.length < 1 || files.length > 2) usage(1);
  return { input: files[0], output: files[1] || defaultOutput(files[0]), opts };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const { input, output, opts } = parseCli(process.argv.slice(2));
    if (!fs.existsSync(input)) throw new Mp4Error(`Input file not found: ${input}`);
    const inStat = fs.statSync(input, { bigint: true });
    console.log(`[*] Input: ${input} (${(Number(inStat.size > MAX_SAFE_BIG ? MAX_SAFE_BIG : inStat.size) / 1024 / 1024).toFixed(2)} MB${inStat.size > MAX_SAFE_BIG ? '+' : ''})`);
    console.log(`[*] Patcher: Theziess Universal v${VERSION}`);
    const result = patchFile(input, output, opts);
    console.log(`[+] Done -> ${result.outputPath}`);
    console.log(`[+] Audio samples: ${result.realAudioSamples} -> ${result.realAudioSamples + result.fakeCount}`);
    console.log(`[+] Method metadata: ${result.method}`);
    console.log(`[+] Chunk tables: ${result.offsetTableCount}; co64 ${result.inputCo64} -> ${result.outputCo64}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[!] ${message}`);
    if (e?.details) console.error(e.details);
    process.exitCode = 1;
  }
}

export {
  VERSION,
  METHOD,
  Mp4Error,
  patchFile,
  buildUniversalPatchPlan,
  parseStco,
  parseCo64,
  buildStco,
  buildCo64,
};
