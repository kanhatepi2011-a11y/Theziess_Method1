#!/usr/bin/env node
/**
 * Audio-inflation MP4 patcher — v2.3
 * - Duration of output = same as original video
 * - Only sample tables are inflated (stsz/stsc/stco/stts)
 * - mdhd and mvhd durations are NOT changed
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts',
  'dinf', 'udta', 'meta', 'ilst', 'moof', 'traf'
]);

function readBox(buf, o, end) {
  if (o + 8 > end) throw new Error(`Truncated box header @${o}`);
  let size = buf.readUInt32BE(o);
  const type = buf.toString('latin1', o + 4, o + 8);
  let hs = 8;
  if (size === 1) {
    const hi = buf.readUInt32BE(o + 8);
    const lo = buf.readUInt32BE(o + 12);
    size = hi * 0x100000000 + lo;
    hs = 16;
  } else if (size === 0) {
    size = end - o;
  }
  if (size < hs || o + size > end) {
    throw new Error(`Bad box size for '${type}' @${o}: ${size}`);
  }
  return {
    type, offset: o, size, hs,
    cStart: o + hs, end: o + size,
    pStart: o + hs, pEnd: o + hs,
    children: []
  };
}

function looksLikeBoxHeader(buf, offset, end) {
  if (offset + 8 > end) return false;

  let size = buf.readUInt32BE(offset);
  let hs = 8;

  if (size === 1) {
    if (offset + 16 > end) return false;
    const hi = buf.readUInt32BE(offset + 8);
    const lo = buf.readUInt32BE(offset + 12);
    size = hi * 0x100000000 + lo;
    hs = 16;
  } else if (size === 0) {
    size = end - offset;
  }

  if (!Number.isSafeInteger(size) || size < hs || offset + size > end) return false;

  for (let i = 0; i < 4; i++) {
    const c = buf[offset + 4 + i];
    if (c < 0x20 || c > 0x7e) return false;
  }

  return true;
}

function metaChildStart(buf, box) {
  const direct = box.cStart;
  const afterFullBoxHeader = box.cStart + 4;

  const directLooksValid = looksLikeBoxHeader(buf, direct, box.end);
  const skippedLooksValid = looksLikeBoxHeader(buf, afterFullBoxHeader, box.end);

  if (directLooksValid && !skippedLooksValid) return direct;
  if (skippedLooksValid && !directLooksValid) return afterFullBoxHeader;

  if (skippedLooksValid && afterFullBoxHeader <= box.end) {
    const version = buf[direct];
    const flags = (buf[direct + 1] << 16) | (buf[direct + 2] << 8) | buf[direct + 3];
    if (version <= 1 && flags <= 0x00ffffff) return afterFullBoxHeader;
  }

  return direct;
}

function parseBoxes(buf, start = 0, end = null) {
  if (end === null) end = buf.length;
  const boxes = [];
  let o = start;
  while (o + 8 <= end) {
    const box = readBox(buf, o, end);
    if (CONTAINERS.has(box.type)) {
      const cs = box.type === 'meta' ? metaChildStart(buf, box) : box.cStart;
      box.pStart = box.cStart;
      box.pEnd   = cs;
      box.children = parseBoxes(buf, cs, box.end);
    }
    boxes.push(box);
    o = box.end;
  }
  return boxes;
}

function findChild(box, type) {
  return box.children.find(c => c.type === type) || null;
}
function findDesc(box, path) {
  let cur = box;
  for (const t of path) {
    cur = findChild(cur, t);
    if (!cur) return null;
  }
  return cur;
}

function makeBox(type, payload) {
  const size = 8 + payload.length;
  const buf  = Buffer.allocUnsafe(size);
  buf.writeUInt32BE(size, 0);
  buf.write(type, 4, 4, 'latin1');
  payload.copy(buf, 8);
  return buf;
}

function cat(parts) {
  return Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
}

function parseStsz(box, buf) {
  const defSz = buf.readUInt32BE(box.cStart + 4);
  const count = buf.readUInt32BE(box.cStart + 8);
  if (defSz !== 0) return Array(count).fill(defSz);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readUInt32BE(box.cStart + 12 + i * 4);
  }
  return out;
}

function parseStco(box, buf) {
  const count = buf.readUInt32BE(box.cStart + 4);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readUInt32BE(box.cStart + 8 + i * 4);
  }
  return out;
}

function parseStsc(box, buf) {
  const count = buf.readUInt32BE(box.cStart + 4);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = box.cStart + 8 + i * 12;
    out[i] = [
      buf.readUInt32BE(o),
      buf.readUInt32BE(o + 4),
      buf.readUInt32BE(o + 8)
    ];
  }
  return out;
}

function buildCtts(realCount, frameDur) {
  const numGroups = ri(6, 10);
  const perGroup  = Math.floor(realCount / numGroups);
  const entries   = [];
  let rem = realCount;
  for (let g = 0; g < numGroups; g++) {
    const cnt = g === numGroups - 1 ? rem : perGroup;
    rem -= cnt;
    entries.push([cnt, ri(0, 2) * frameDur]);
  }
  const p = Buffer.alloc(8 + entries.length * 8);
  p.writeUInt32BE(entries.length, 4);
  entries.forEach(([c, o], i) => {
    p.writeUInt32BE(c, 8 + i * 8);
    p.writeUInt32BE(o, 12 + i * 8);
  });
  return makeBox('ctts', p);
}

function buildStss(realCount, fps) {
  const step = Math.max(1, Math.min(realCount, ri(fps, fps * 2)));
  const keys = [];
  for (let i = 1; i <= realCount; i += step) keys.push(i);
  const p = Buffer.alloc(8 + keys.length * 4);
  p.writeUInt32BE(keys.length, 4);
  keys.forEach((k, i) => p.writeUInt32BE(k, 8 + i * 4));
  return makeBox('stss', p);
}

function patch(buf, opts = {}) {
  const factor   = opts.factor  ?? ri(8, 12);
  const baseSize = opts.baseSize ?? ri(60, 100);
  const seed     = opts.seed    ?? ri(0, 255);
  const verbose  = !!opts.verbose;

  const boxes = parseBoxes(buf);
  const ftyp  = boxes.find(b => b.type === 'ftyp');
  const moov  = boxes.find(b => b.type === 'moov');
  const mdat  = boxes.find(b => b.type === 'mdat');
  if (!ftyp || !moov || !mdat) {
    throw new Error('Missing required top-level boxes (ftyp / moov / mdat)');
  }

  let vTrak = null, aTrak = null;
  for (const c of moov.children) {
    if (c.type !== 'trak') continue;
    const hdlr = findDesc(c, ['mdia', 'hdlr']);
    if (!hdlr) continue;
    const handler = buf.toString('latin1', hdlr.cStart + 8, hdlr.cStart + 12);
    if (handler === 'vide') vTrak = c;
    else if (handler === 'soun') aTrak = c;
  }
  if (!vTrak) throw new Error('No video track found');
  if (!aTrak) throw new Error('No audio track found');

  const vStbl = findDesc(vTrak, ['mdia', 'minf', 'stbl']);
  if (!vStbl) throw new Error('Missing video stbl');
  if (findChild(vStbl, 'co64')) throw new Error('co64 not supported — remux first');

  const vMdhd = findDesc(vTrak, ['mdia', 'mdhd']);
  const vStsz = findChild(vStbl, 'stsz');
  if (!vMdhd || !vStsz) throw new Error('Missing video mdhd/stsz');

  const vTimescale = buf.readUInt32BE(vMdhd.cStart + 12);
  const realVCount = parseStsz(vStsz, buf).length;

  const vStts = findChild(vStbl, 'stts');
  let vFrameDur = Math.max(1, Math.floor(vTimescale / 30));
  if (vStts && buf.readUInt32BE(vStts.cStart + 4) > 0) {
    vFrameDur = buf.readUInt32BE(vStts.cStart + 12);
  }
  const vFps = Math.max(1, Math.round(vTimescale / vFrameDur));

  const aStbl = findDesc(aTrak, ['mdia', 'minf', 'stbl']);
  if (!aStbl) throw new Error('Missing audio stbl');
  if (findChild(aStbl, 'co64')) throw new Error('co64 not supported — remux first');

  const aStsz = findChild(aStbl, 'stsz');
  const aStco = findChild(aStbl, 'stco');
  const aStsc = findChild(aStbl, 'stsc');
  const aStts = findChild(aStbl, 'stts');
  const aMdhd = findDesc(aTrak, ['mdia', 'mdhd']);
  if (!aStsz || !aStco || !aStsc || !aMdhd) {
    throw new Error('Missing audio stsz/stco/stsc/mdhd');
  }

  const realASizes   = parseStsz(aStsz, buf);
  const realAOffsets = parseStco(aStco, buf);
  const realARows    = parseStsc(aStsc, buf);
  const realACount   = realASizes.length;
  const fakeACount   = Math.floor(realACount * factor);

  if (verbose) {
    console.log(`[*] Audio samples: ${realACount} → ${realACount + fakeACount} (×${factor})`);
  }

  const fakeASizes = Array.from({ length: fakeACount }, () => baseSize + ri(0, 60));
  const fakeAChunks = fakeASizes.map((sz, i) => {
    const chunk = Buffer.allocUnsafe(sz);
    for (let j = 0; j < sz; j++) {
      chunk[j] = ((seed + i * 23 + j * 41) ^ (i * 7 + j)) & 0xff;
    }
    return chunk;
  });
  const fakeAPayload = Buffer.concat(fakeAChunks);

  const fixed = new Map();

  // stsz
  {
    const all = [...realASizes, ...fakeASizes];
    const p = Buffer.alloc(12 + all.length * 4);
    p.writeUInt32BE(0, 0);
    p.writeUInt32BE(0, 4);
    p.writeUInt32BE(all.length, 8);
    all.forEach((sz, i) => p.writeUInt32BE(sz, 12 + i * 4));
    fixed.set(aStsz, makeBox('stsz', p));
  }

  // stsc
  {
    const rows = realARows.map(r => [...r]);
    if (rows.length === 0 || rows[rows.length - 1][1] !== 1) {
      rows.push([realAOffsets.length + 1, 1, 1]);
    }
    const p = Buffer.alloc(8 + rows.length * 12);
    p.writeUInt32BE(0, 0);
    p.writeUInt32BE(rows.length, 4);
    rows.forEach((r, i) => {
      p.writeUInt32BE(r[0],  8 + i * 12);
      p.writeUInt32BE(r[1], 12 + i * 12);
      p.writeUInt32BE(r[2], 16 + i * 12);
    });
    fixed.set(aStsc, makeBox('stsc', p));
  }

  // stts (still extend the sample count, but we do NOT touch mdhd duration)
  let aDelta = 0;
  if (aStts) {
    const entryCount = buf.readUInt32BE(aStts.cStart + 4);
    if (entryCount > 0) {
      aDelta = buf.readUInt32BE(aStts.cStart + 12 + (entryCount - 1) * 8);
    }
  }
  if (aDelta <= 0) {
    const aTimescale = buf.readUInt32BE(aMdhd.cStart + 12);
    aDelta = Math.max(1, Math.round(aTimescale / 43));
  }

  if (aStts && fakeACount > 0) {
    const entryCount = buf.readUInt32BE(aStts.cStart + 4);
    const p = Buffer.alloc(8 + (entryCount + 1) * 8);
    buf.copy(p, 0, aStts.cStart, aStts.cStart + 4);
    p.writeUInt32BE(entryCount + 1, 4);
    for (let i = 0; i < entryCount; i++) {
      p.writeUInt32BE(buf.readUInt32BE(aStts.cStart +  8 + i * 8),  8 + i * 8);
      p.writeUInt32BE(buf.readUInt32BE(aStts.cStart + 12 + i * 8), 12 + i * 8);
    }
    p.writeUInt32BE(fakeACount,  8 + entryCount * 8);
    p.writeUInt32BE(aDelta,     12 + entryCount * 8);
    fixed.set(aStts, makeBox('stts', p));
  }

  // ===== IMPORTANT =====
  // We do NOT change mdhd duration or mvhd duration
  // → Output duration stays exactly the same as original video
  // =====================

  const existingCtts = findChild(vStbl, 'ctts');
  const existingStss = findChild(vStbl, 'stss');
  const newCtts = existingCtts ? null : buildCtts(realVCount, vFrameDur);
  const newStss = existingStss ? null : buildStss(realVCount, vFps);

  function buildStcoRep(stcoBox, delta, fakeOffsets) {
    const orig = parseStco(stcoBox, buf);
    const isAudio = stcoBox === aStco;
    const total = orig.length + (isAudio ? fakeACount : 0);
    const p = Buffer.alloc(8 + total * 4);
    p.writeUInt32BE(0, 0);
    p.writeUInt32BE(total, 4);
    orig.forEach((off, i) => p.writeUInt32BE(off + delta, 8 + i * 4));
    if (isAudio && fakeOffsets) {
      fakeOffsets.forEach((off, i) => {
        p.writeUInt32BE(off, 8 + (orig.length + i) * 4);
      });
    }
    return makeBox('stco', p);
  }

  const allStcos = [];
  for (const t of moov.children) {
    if (t.type !== 'trak') continue;
    const st = findDesc(t, ['mdia', 'minf', 'stbl']);
    if (st) {
      const sc = findChild(st, 'stco');
      if (sc) allStcos.push(sc);
    }
  }

  function rebuild(box, rep) {
    if (rep.has(box)) return rep.get(box);
    if (box.children.length === 0) {
      return buf.slice(box.offset, box.end);
    }
    const parts = [buf.slice(box.pStart, box.pEnd)];
    for (const c of box.children) {
      if (box === aTrak && c.type === 'edts') continue;
      parts.push(rebuild(c, rep));
    }
    if (box === vStbl) {
      if (newCtts) parts.push(newCtts);
      if (newStss) parts.push(newStss);
    }
    return makeBox(box.type, cat(parts));
  }

  // Pass 1
  const rep1 = new Map(fixed);
  for (const s of allStcos) rep1.set(s, buildStcoRep(s, 0, null));
  const moov1 = rebuild(moov, rep1);

  const otherTop = boxes
    .filter(b => !['ftyp', 'moov', 'mdat'].includes(b.type))
    .map(b => buf.slice(b.offset, b.end));

  const oMdatPayload = buf.slice(mdat.cStart, mdat.end);
  const nStart = ftyp.size + moov1.length + Buffer.concat(otherTop).length + 8;
  const delta  = nStart - mdat.cStart;

  const fakeAOffsets = [];
  let cursor = nStart + oMdatPayload.length;
  for (const sz of fakeASizes) {
    fakeAOffsets.push(cursor);
    cursor += sz;
  }

  // Pass 2
  const repFinal = new Map(fixed);
  for (const s of allStcos) {
    repFinal.set(s, buildStcoRep(s, delta, fakeAOffsets));
  }

  return cat([
    buf.slice(ftyp.offset, ftyp.end),
    rebuild(moov, repFinal),
    ...otherTop,
    makeBox('mdat', cat([oMdatPayload, fakeAPayload]))
  ]);
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function usage() {
  console.error(`Usage: node ${path.basename(process.argv[1])} [options] <input.mp4> [output.mp4]

Options:
  --factor N     Inflation multiplier (default: random 8-12)
  --seed N       PRNG seed for fake payload (default: random)
  --verbose      Extra logging
  -h, --help     Show this help
`);
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = { verbose: false };
const files = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') usage();
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '--factor') opts.factor = parseInt(args[++i], 10);
  else if (a === '--seed')   opts.seed   = parseInt(args[++i], 10);
  else if (a.startsWith('-')) {
    console.error(`Unknown option: ${a}`);
    usage();
  } else {
    files.push(a);
  }
}

if (files.length < 1) usage();
const [inputPath, outputPath] = files;

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const input = fs.readFileSync(inputPath);
console.log(`[*] Read     ${inputPath}  (${(input.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`[*] Patching …`);

let patched;
try {
  patched = patch(input, opts);
} catch (e) {
  console.error(`[!] ${e.message}`);
  process.exit(1);
}

const outPath = outputPath || inputPath.replace(/\.mp4$/i, '_patched.mp4');
fs.writeFileSync(outPath, patched);
console.log(`[+] Done → ${outPath}  (${(patched.length / 1024 / 1024).toFixed(2)} MB)`);