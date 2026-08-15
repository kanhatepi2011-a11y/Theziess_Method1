// Audio-inflation MP4 patcher — v2.3 EXACT LOCAL PARITY PORT
// Browser/Web Worker implementation of the user-supplied Node.js v2.3 logic.
// The MP4 transformation intentionally mirrors the local script:
// - inflate audio stsz/stsc/stco/stts
// - do not change mdhd/mvhd duration fields
// - remove audio edts during rebuild
// - synthesize missing video ctts/stss
// - reject co64 exactly like the supplied local script
// - no FFmpeg, transcoding, resize, FPS conversion, or recompression

const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts',
  'dinf', 'udta', 'meta', 'ilst', 'moof', 'traf'
]);

function dv(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU32(bytes, offset) {
  return dv(bytes).getUint32(offset, false);
}

function writeU32(bytes, offset, value) {
  dv(bytes).setUint32(offset, Number(value) >>> 0, false);
}

function readType(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function writeType(bytes, offset, type) {
  for (let i = 0; i < 4; i++) {
    bytes[offset + i] = type.charCodeAt(i) & 0xff;
  }
}

function sliceBytes(bytes, start, end) {
  // Buffer.slice() in the local script returns a view, but the final Buffer.concat()
  // copies it. Uint8Array.slice() gives the same resulting bytes for this port.
  return bytes.slice(start, end);
}

function readBox(bytes, o, end) {
  if (o + 8 > end) throw new Error(`Truncated box header @${o}`);

  let size = readU32(bytes, o);
  const type = readType(bytes, o + 4);
  let hs = 8;

  if (size === 1) {
    const hi = readU32(bytes, o + 8);
    const lo = readU32(bytes, o + 12);
    size = hi * 0x100000000 + lo;
    hs = 16;
  } else if (size === 0) {
    size = end - o;
  }

  if (size < hs || o + size > end) {
    throw new Error(`Bad box size for '${type}' @${o}: ${size}`);
  }

  return {
    type,
    offset: o,
    size,
    hs,
    cStart: o + hs,
    end: o + size,
    pStart: o + hs,
    pEnd: o + hs,
    children: [],
  };
}

function parseBoxes(bytes, start = 0, end = null) {
  if (end === null) end = bytes.byteLength;
  const boxes = [];
  let o = start;

  while (o + 8 <= end) {
    const box = readBox(bytes, o, end);
    if (CONTAINERS.has(box.type)) {
      const cs = box.type === 'meta' ? box.cStart + 4 : box.cStart;
      box.pStart = box.cStart;
      box.pEnd = cs;
      box.children = parseBoxes(bytes, cs, box.end);
    }
    boxes.push(box);
    o = box.end;
  }

  return boxes;
}

function findChild(box, type) {
  return box.children.find((c) => c.type === type) || null;
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
  const size = 8 + payload.byteLength;
  const out = new Uint8Array(size);
  writeU32(out, 0, size);
  writeType(out, 4, type);
  out.set(payload, 8);
  return out;
}

function cat(parts) {
  const normalized = parts.map((p) =>
    p instanceof Uint8Array ? p : new Uint8Array(p),
  );
  const total = normalized.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const p of normalized) {
    out.set(p, cursor);
    cursor += p.byteLength;
  }
  return out;
}

function parseStsz(box, bytes) {
  const defSz = readU32(bytes, box.cStart + 4);
  const count = readU32(bytes, box.cStart + 8);
  if (defSz !== 0) return Array(count).fill(defSz);

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = readU32(bytes, box.cStart + 12 + i * 4);
  }
  return out;
}

function parseStco(box, bytes) {
  const count = readU32(bytes, box.cStart + 4);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = readU32(bytes, box.cStart + 8 + i * 4);
  }
  return out;
}

function parseStsc(box, bytes) {
  const count = readU32(bytes, box.cStart + 4);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = box.cStart + 8 + i * 12;
    out[i] = [
      readU32(bytes, o),
      readU32(bytes, o + 4),
      readU32(bytes, o + 8),
    ];
  }
  return out;
}

function buildCtts(realCount, frameDur) {
  const numGroups = ri(6, 10);
  const perGroup = Math.floor(realCount / numGroups);
  const entries = [];
  let rem = realCount;

  for (let g = 0; g < numGroups; g++) {
    const cnt = g === numGroups - 1 ? rem : perGroup;
    rem -= cnt;
    entries.push([cnt, ri(0, 2) * frameDur]);
  }

  const p = new Uint8Array(8 + entries.length * 8);
  writeU32(p, 4, entries.length);
  entries.forEach(([c, o], i) => {
    writeU32(p, 8 + i * 8, c);
    writeU32(p, 12 + i * 8, o);
  });
  return makeBox('ctts', p);
}

function buildStss(realCount, fps) {
  const step = Math.max(1, Math.min(realCount, ri(fps, fps * 2)));
  const keys = [];
  for (let i = 1; i <= realCount; i += step) keys.push(i);

  const p = new Uint8Array(8 + keys.length * 4);
  writeU32(p, 4, keys.length);
  keys.forEach((k, i) => writeU32(p, 8 + i * 4, k));
  return makeBox('stss', p);
}

export function patchAudioInflationMp4(input, opts = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // Keep the supplied v2.3 option semantics exactly (no clamping/normalization).
  const factor = opts.factor ?? ri(8, 12);
  const baseSize = opts.baseSize ?? ri(60, 100);
  const seed = opts.seed ?? ri(0, 255);
  const verbose = !!opts.verbose;

  const boxes = parseBoxes(bytes);
  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const moov = boxes.find((b) => b.type === 'moov');
  const mdat = boxes.find((b) => b.type === 'mdat');

  if (!ftyp || !moov || !mdat) {
    throw new Error('Missing required top-level boxes (ftyp / moov / mdat)');
  }

  let vTrak = null;
  let aTrak = null;

  for (const c of moov.children) {
    if (c.type !== 'trak') continue;
    const hdlr = findDesc(c, ['mdia', 'hdlr']);
    if (!hdlr) continue;
    const handler = readType(bytes, hdlr.cStart + 8);
    if (handler === 'vide') vTrak = c;
    else if (handler === 'soun') aTrak = c;
  }

  if (!vTrak) throw new Error('No video track found');
  if (!aTrak) throw new Error('No audio track found');

  const vStbl = findDesc(vTrak, ['mdia', 'minf', 'stbl']);
  if (!vStbl) throw new Error('Missing video stbl');
  if (findChild(vStbl, 'co64')) {
    throw new Error('co64 not supported — remux first');
  }

  const vMdhd = findDesc(vTrak, ['mdia', 'mdhd']);
  const vStsz = findChild(vStbl, 'stsz');
  if (!vMdhd || !vStsz) throw new Error('Missing video mdhd/stsz');

  const vTimescale = readU32(bytes, vMdhd.cStart + 12);
  const realVCount = parseStsz(vStsz, bytes).length;

  const vStts = findChild(vStbl, 'stts');
  let vFrameDur = Math.max(1, Math.floor(vTimescale / 30));
  if (vStts && readU32(bytes, vStts.cStart + 4) > 0) {
    vFrameDur = readU32(bytes, vStts.cStart + 12);
  }

  const vFps = Math.max(1, Math.round(vTimescale / vFrameDur));

  const aStbl = findDesc(aTrak, ['mdia', 'minf', 'stbl']);
  if (!aStbl) throw new Error('Missing audio stbl');
  if (findChild(aStbl, 'co64')) {
    throw new Error('co64 not supported — remux first');
  }

  const aStsz = findChild(aStbl, 'stsz');
  const aStco = findChild(aStbl, 'stco');
  const aStsc = findChild(aStbl, 'stsc');
  const aStts = findChild(aStbl, 'stts');
  const aMdhd = findDesc(aTrak, ['mdia', 'mdhd']);

  if (!aStsz || !aStco || !aStsc || !aMdhd) {
    throw new Error('Missing audio stsz/stco/stsc/mdhd');
  }

  const realASizes = parseStsz(aStsz, bytes);
  const realAOffsets = parseStco(aStco, bytes);
  const realARows = parseStsc(aStsc, bytes);
  const realACount = realASizes.length;
  const fakeACount = Math.floor(realACount * factor);

  if (verbose) {
    console.log(
      `[*] Audio samples: ${realACount} → ${realACount + fakeACount} (×${factor})`,
    );
  }

  const fakeASizes = Array.from(
    { length: fakeACount },
    () => baseSize + ri(0, 60),
  );

  const fakeAChunks = fakeASizes.map((sz, i) => {
    const chunk = new Uint8Array(sz);
    for (let j = 0; j < sz; j++) {
      chunk[j] = ((seed + i * 23 + j * 41) ^ (i * 7 + j)) & 0xff;
    }
    return chunk;
  });

  const fakeAPayload = cat(fakeAChunks);
  const fixed = new Map();

  // stsz
  {
    const all = [...realASizes, ...fakeASizes];
    const p = new Uint8Array(12 + all.length * 4);
    writeU32(p, 0, 0);
    writeU32(p, 4, 0);
    writeU32(p, 8, all.length);
    all.forEach((sz, i) => writeU32(p, 12 + i * 4, sz));
    fixed.set(aStsz, makeBox('stsz', p));
  }

  // stsc
  {
    const rows = realARows.map((r) => [...r]);
    if (rows.length === 0 || rows[rows.length - 1][1] !== 1) {
      rows.push([realAOffsets.length + 1, 1, 1]);
    }

    const p = new Uint8Array(8 + rows.length * 12);
    writeU32(p, 0, 0);
    writeU32(p, 4, rows.length);
    rows.forEach((r, i) => {
      writeU32(p, 8 + i * 12, r[0]);
      writeU32(p, 12 + i * 12, r[1]);
      writeU32(p, 16 + i * 12, r[2]);
    });
    fixed.set(aStsc, makeBox('stsc', p));
  }

  // stts (extend sample count, but do NOT touch mdhd duration)
  let aDelta = 0;
  if (aStts) {
    const entryCount = readU32(bytes, aStts.cStart + 4);
    if (entryCount > 0) {
      aDelta = readU32(
        bytes,
        aStts.cStart + 12 + (entryCount - 1) * 8,
      );
    }
  }

  if (aDelta <= 0) {
    const aTimescale = readU32(bytes, aMdhd.cStart + 12);
    aDelta = Math.max(1, Math.round(aTimescale / 43));
  }

  if (aStts && fakeACount > 0) {
    const entryCount = readU32(bytes, aStts.cStart + 4);
    const p = new Uint8Array(8 + (entryCount + 1) * 8);
    p.set(sliceBytes(bytes, aStts.cStart, aStts.cStart + 4), 0);
    writeU32(p, 4, entryCount + 1);

    for (let i = 0; i < entryCount; i++) {
      writeU32(
        p,
        8 + i * 8,
        readU32(bytes, aStts.cStart + 8 + i * 8),
      );
      writeU32(
        p,
        12 + i * 8,
        readU32(bytes, aStts.cStart + 12 + i * 8),
      );
    }

    writeU32(p, 8 + entryCount * 8, fakeACount);
    writeU32(p, 12 + entryCount * 8, aDelta);
    fixed.set(aStts, makeBox('stts', p));
  }

  // IMPORTANT: exactly like the local script, mdhd and mvhd are untouched.

  const existingCtts = findChild(vStbl, 'ctts');
  const existingStss = findChild(vStbl, 'stss');
  const newCtts = existingCtts ? null : buildCtts(realVCount, vFrameDur);
  const newStss = existingStss ? null : buildStss(realVCount, vFps);

  function buildStcoRep(stcoBox, delta, fakeOffsets) {
    const orig = parseStco(stcoBox, bytes);
    const isAudio = stcoBox === aStco;
    const total = orig.length + (isAudio ? fakeACount : 0);
    const p = new Uint8Array(8 + total * 4);
    writeU32(p, 0, 0);
    writeU32(p, 4, total);

    orig.forEach((off, i) => writeU32(p, 8 + i * 4, off + delta));

    if (isAudio && fakeOffsets) {
      fakeOffsets.forEach((off, i) => {
        writeU32(p, 8 + (orig.length + i) * 4, off);
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
      return sliceBytes(bytes, box.offset, box.end);
    }

    const parts = [sliceBytes(bytes, box.pStart, box.pEnd)];
    for (const c of box.children) {
      // Exact local v2.3 behavior: remove audio edit list container.
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
  for (const s of allStcos) {
    rep1.set(s, buildStcoRep(s, 0, null));
  }
  const moov1 = rebuild(moov, rep1);

  const otherTop = boxes
    .filter((b) => !['ftyp', 'moov', 'mdat'].includes(b.type))
    .map((b) => sliceBytes(bytes, b.offset, b.end));

  const oMdatPayload = sliceBytes(bytes, mdat.cStart, mdat.end);
  const nStart = ftyp.size + moov1.byteLength + cat(otherTop).byteLength + 8;
  const delta = nStart - mdat.cStart;

  const fakeAOffsets = [];
  let cursor = nStart + oMdatPayload.byteLength;
  for (const sz of fakeASizes) {
    fakeAOffsets.push(cursor);
    cursor += sz;
  }

  // Pass 2
  const repFinal = new Map(fixed);
  for (const s of allStcos) {
    repFinal.set(s, buildStcoRep(s, delta, fakeAOffsets));
  }

  const output = cat([
    sliceBytes(bytes, ftyp.offset, ftyp.end),
    rebuild(moov, repFinal),
    ...otherTop,
    makeBox('mdat', cat([oMdatPayload, fakeAPayload])),
  ]);

  return {
    newBuffer: output.buffer.slice(
      output.byteOffset,
      output.byteOffset + output.byteLength,
    ),
    newBytes: output,
    multiplier: factor,
    factor,
    baseSize,
    seed,
    fakeAudioCount: fakeACount,
    version: '2.3',
    parser: 'exact-local-v2.3',
    co64: {
      inputTables: 0,
      outputTables: 0,
      supported: false,
    },
  };
}
