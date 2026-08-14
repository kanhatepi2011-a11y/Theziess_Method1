/**
 * Audio-inflation MP4 patcher — v2.3 (browser/Web Worker port)
 *
 * Ported from the user's Node/CommonJS v2.3 patcher so it can run inside the
 * existing Vite/Web Worker pipeline without fs/require/process.
 *
 * Behavior kept from v2.3:
 * - Output movie/media duration is left unchanged (mdhd/mvhd are not patched).
 * - Audio sample tables stsz/stsc/stco/stts are inflated.
 * - Existing video ctts/stss are kept; missing ones are synthesized.
 * - Audio edts is removed while rebuilding the audio track.
 * - co64 is intentionally rejected, matching the supplied v2.3 script.
 */

const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const CONTAINERS = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts",
    "dinf", "udta", "meta", "ilst", "moof", "traf",
]);

function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError("Expected ArrayBuffer or Uint8Array");
}

function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU32(bytes, offset) {
    return viewOf(bytes).getUint32(offset, false);
}

function writeU32(bytes, offset, value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`32-bit MP4 value out of range: ${value}`);
    }
    viewOf(bytes).setUint32(offset, value, false);
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
    for (let i = 0; i < 4; i++) bytes[offset + i] = type.charCodeAt(i) & 0xff;
}

function readBox(bytes, offset, end) {
    if (offset + 8 > end) throw new Error(`Truncated box header @${offset}`);

    let size = readU32(bytes, offset);
    const type = readType(bytes, offset + 4);
    let headerSize = 8;

    if (size === 1) {
        if (offset + 16 > end) throw new Error(`Truncated large box header @${offset}`);
        const hi = readU32(bytes, offset + 8);
        const lo = readU32(bytes, offset + 12);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
    } else if (size === 0) {
        size = end - offset;
    }

    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) {
        throw new Error(`Bad box size for '${type}' @${offset}: ${size}`);
    }

    return {
        type,
        offset,
        size,
        headerSize,
        contentStart: offset + headerSize,
        end: offset + size,
        prefixStart: offset + headerSize,
        prefixEnd: offset + headerSize,
        children: [],
    };
}

function parseBoxes(bytes, start = 0, end = bytes.byteLength) {
    const boxes = [];
    let offset = start;

    while (offset + 8 <= end) {
        const box = readBox(bytes, offset, end);
        if (CONTAINERS.has(box.type)) {
            const childStart = box.type === "meta" ? box.contentStart + 4 : box.contentStart;
            box.prefixStart = box.contentStart;
            box.prefixEnd = childStart;
            box.children = parseBoxes(bytes, childStart, box.end);
        }
        boxes.push(box);
        offset = box.end;
    }

    return boxes;
}

function findChild(box, type) {
    return box.children.find((child) => child.type === type) || null;
}

function findDesc(box, path) {
    let current = box;
    for (const type of path) {
        current = findChild(current, type);
        if (!current) return null;
    }
    return current;
}

function concatBytes(parts) {
    const normalized = parts.map((part) => asBytes(part));
    const total = normalized.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of normalized) {
        out.set(part, cursor);
        cursor += part.byteLength;
    }
    return out;
}

function makeBox(type, payloadInput) {
    const payload = asBytes(payloadInput);
    const size = 8 + payload.byteLength;
    if (size > 0xffffffff) throw new Error(`Box '${type}' exceeds 32-bit size limit`);
    const out = new Uint8Array(size);
    writeU32(out, 0, size);
    writeType(out, 4, type);
    out.set(payload, 8);
    return out;
}

function parseStsz(box, bytes) {
    const defaultSize = readU32(bytes, box.contentStart + 4);
    const count = readU32(bytes, box.contentStart + 8);

    if (defaultSize !== 0) return Array(count).fill(defaultSize);

    const required = box.contentStart + 12 + count * 4;
    if (required > box.end) throw new Error("Invalid stsz table");

    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = readU32(bytes, box.contentStart + 12 + i * 4);
    }
    return out;
}

function parseStco(box, bytes) {
    const count = readU32(bytes, box.contentStart + 4);
    const required = box.contentStart + 8 + count * 4;
    if (required > box.end) throw new Error("Invalid stco table");

    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = readU32(bytes, box.contentStart + 8 + i * 4);
    }
    return out;
}

function parseStsc(box, bytes) {
    const count = readU32(bytes, box.contentStart + 4);
    const required = box.contentStart + 8 + count * 12;
    if (required > box.end) throw new Error("Invalid stsc table");

    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        const offset = box.contentStart + 8 + i * 12;
        out[i] = [
            readU32(bytes, offset),
            readU32(bytes, offset + 4),
            readU32(bytes, offset + 8),
        ];
    }
    return out;
}

function buildCtts(realCount, frameDuration) {
    const groupCount = ri(6, 10);
    const perGroup = Math.floor(realCount / groupCount);
    const entries = [];
    let remaining = realCount;

    for (let group = 0; group < groupCount; group++) {
        const count = group === groupCount - 1 ? remaining : perGroup;
        remaining -= count;
        entries.push([count, ri(0, 2) * frameDuration]);
    }

    const payload = new Uint8Array(8 + entries.length * 8);
    writeU32(payload, 4, entries.length);
    entries.forEach(([count, offset], index) => {
        writeU32(payload, 8 + index * 8, count);
        writeU32(payload, 12 + index * 8, offset);
    });
    return makeBox("ctts", payload);
}

function buildStss(realCount, fps) {
    const step = Math.max(1, Math.min(realCount, ri(fps, fps * 2)));
    const keys = [];
    for (let i = 1; i <= realCount; i += step) keys.push(i);

    const payload = new Uint8Array(8 + keys.length * 4);
    writeU32(payload, 4, keys.length);
    keys.forEach((key, index) => writeU32(payload, 8 + index * 4, key));
    return makeBox("stss", payload);
}

export function patchAudioInflationMp4(input, options = {}) {
    const bytes = asBytes(input);

    // Accept both the v2.3 CLI option names and the website's previous names.
    const requestedFactor = options.factor ?? options.multiplier;
    const factor = Number.isFinite(requestedFactor)
        ? Math.max(1, Math.floor(requestedFactor))
        : ri(8, 12);

    const requestedBaseSize = options.baseSize ?? options.baseAudioSize;
    const baseSize = Number.isFinite(requestedBaseSize)
        ? Math.max(1, Math.floor(requestedBaseSize))
        : ri(60, 100);

    const seed = Number.isFinite(options.seed)
        ? Math.max(0, Math.min(255, Math.floor(options.seed)))
        : ri(0, 255);

    const boxes = parseBoxes(bytes);
    const ftyp = boxes.find((box) => box.type === "ftyp");
    const moov = boxes.find((box) => box.type === "moov");
    const mdat = boxes.find((box) => box.type === "mdat");

    if (!ftyp || !moov || !mdat) {
        throw new Error("Missing required top-level boxes (ftyp / moov / mdat)");
    }

    let videoTrack = null;
    let audioTrack = null;
    for (const child of moov.children) {
        if (child.type !== "trak") continue;
        const hdlr = findDesc(child, ["mdia", "hdlr"]);
        if (!hdlr) continue;
        const handler = readType(bytes, hdlr.contentStart + 8);
        if (handler === "vide") videoTrack = child;
        else if (handler === "soun") audioTrack = child;
    }

    if (!videoTrack) throw new Error("No video track found");
    if (!audioTrack) throw new Error("No audio track found");

    const videoStbl = findDesc(videoTrack, ["mdia", "minf", "stbl"]);
    if (!videoStbl) throw new Error("Missing video stbl");
    if (findChild(videoStbl, "co64")) throw new Error("co64 not supported — remux first");

    const videoMdhd = findDesc(videoTrack, ["mdia", "mdhd"]);
    const videoStsz = findChild(videoStbl, "stsz");
    if (!videoMdhd || !videoStsz) throw new Error("Missing video mdhd/stsz");

    const videoTimescale = readU32(bytes, videoMdhd.contentStart + 12);
    const realVideoCount = parseStsz(videoStsz, bytes).length;

    const videoStts = findChild(videoStbl, "stts");
    let videoFrameDuration = Math.max(1, Math.floor(videoTimescale / 30));
    if (videoStts && readU32(bytes, videoStts.contentStart + 4) > 0) {
        videoFrameDuration = readU32(bytes, videoStts.contentStart + 12);
    }
    const videoFps = Math.max(1, Math.round(videoTimescale / videoFrameDuration));

    const audioStbl = findDesc(audioTrack, ["mdia", "minf", "stbl"]);
    if (!audioStbl) throw new Error("Missing audio stbl");
    if (findChild(audioStbl, "co64")) throw new Error("co64 not supported — remux first");

    const audioStsz = findChild(audioStbl, "stsz");
    const audioStco = findChild(audioStbl, "stco");
    const audioStsc = findChild(audioStbl, "stsc");
    const audioStts = findChild(audioStbl, "stts");
    const audioMdhd = findDesc(audioTrack, ["mdia", "mdhd"]);

    if (!audioStsz || !audioStco || !audioStsc || !audioMdhd) {
        throw new Error("Missing audio stsz/stco/stsc/mdhd");
    }

    const realAudioSizes = parseStsz(audioStsz, bytes);
    const realAudioOffsets = parseStco(audioStco, bytes);
    const realAudioRows = parseStsc(audioStsc, bytes);
    const realAudioCount = realAudioSizes.length;
    const fakeAudioCount = Math.floor(realAudioCount * factor);

    const fakeAudioSizes = Array.from(
        { length: fakeAudioCount },
        () => baseSize + ri(0, 60),
    );

    const fakeAudioChunks = fakeAudioSizes.map((size, i) => {
        const chunk = new Uint8Array(size);
        for (let j = 0; j < size; j++) {
            chunk[j] = ((seed + i * 23 + j * 41) ^ (i * 7 + j)) & 0xff;
        }
        return chunk;
    });
    const fakeAudioPayload = concatBytes(fakeAudioChunks);

    const fixed = new Map();

    // stsz
    {
        const allSizes = [...realAudioSizes, ...fakeAudioSizes];
        const payload = new Uint8Array(12 + allSizes.length * 4);
        writeU32(payload, 0, 0);
        writeU32(payload, 4, 0);
        writeU32(payload, 8, allSizes.length);
        allSizes.forEach((size, i) => writeU32(payload, 12 + i * 4, size));
        fixed.set(audioStsz, makeBox("stsz", payload));
    }

    // stsc
    {
        const rows = realAudioRows.map((row) => [...row]);
        if (rows.length === 0 || rows[rows.length - 1][1] !== 1) {
            rows.push([realAudioOffsets.length + 1, 1, 1]);
        }

        const payload = new Uint8Array(8 + rows.length * 12);
        writeU32(payload, 0, 0);
        writeU32(payload, 4, rows.length);
        rows.forEach((row, i) => {
            writeU32(payload, 8 + i * 12, row[0]);
            writeU32(payload, 12 + i * 12, row[1]);
            writeU32(payload, 16 + i * 12, row[2]);
        });
        fixed.set(audioStsc, makeBox("stsc", payload));
    }

    // stts is extended, but mdhd/mvhd durations are intentionally untouched.
    let audioDelta = 0;
    if (audioStts) {
        const entryCount = readU32(bytes, audioStts.contentStart + 4);
        if (entryCount > 0) {
            audioDelta = readU32(bytes, audioStts.contentStart + 12 + (entryCount - 1) * 8);
        }
    }

    if (audioDelta <= 0) {
        const audioTimescale = readU32(bytes, audioMdhd.contentStart + 12);
        audioDelta = Math.max(1, Math.round(audioTimescale / 43));
    }

    if (audioStts && fakeAudioCount > 0) {
        const entryCount = readU32(bytes, audioStts.contentStart + 4);
        const payload = new Uint8Array(8 + (entryCount + 1) * 8);
        payload.set(bytes.slice(audioStts.contentStart, audioStts.contentStart + 4), 0);
        writeU32(payload, 4, entryCount + 1);

        for (let i = 0; i < entryCount; i++) {
            writeU32(payload, 8 + i * 8, readU32(bytes, audioStts.contentStart + 8 + i * 8));
            writeU32(payload, 12 + i * 8, readU32(bytes, audioStts.contentStart + 12 + i * 8));
        }

        writeU32(payload, 8 + entryCount * 8, fakeAudioCount);
        writeU32(payload, 12 + entryCount * 8, audioDelta);
        fixed.set(audioStts, makeBox("stts", payload));
    }

    const existingCtts = findChild(videoStbl, "ctts");
    const existingStss = findChild(videoStbl, "stss");
    const newCtts = existingCtts ? null : buildCtts(realVideoCount, videoFrameDuration);
    const newStss = existingStss ? null : buildStss(realVideoCount, videoFps);

    function buildStcoReplacement(stcoBox, delta, fakeOffsets) {
        const original = parseStco(stcoBox, bytes);
        const isAudio = stcoBox === audioStco;
        const total = original.length + (isAudio ? fakeAudioCount : 0);
        const payload = new Uint8Array(8 + total * 4);
        writeU32(payload, 0, 0);
        writeU32(payload, 4, total);

        original.forEach((offset, i) => writeU32(payload, 8 + i * 4, offset + delta));
        if (isAudio && fakeOffsets) {
            fakeOffsets.forEach((offset, i) => {
                writeU32(payload, 8 + (original.length + i) * 4, offset);
            });
        }
        return makeBox("stco", payload);
    }

    const allStcos = [];
    for (const track of moov.children) {
        if (track.type !== "trak") continue;
        const stbl = findDesc(track, ["mdia", "minf", "stbl"]);
        if (!stbl) continue;
        const stco = findChild(stbl, "stco");
        if (stco) allStcos.push(stco);
    }

    function rebuild(box, replacements) {
        if (replacements.has(box)) return replacements.get(box);
        if (box.children.length === 0) return bytes.slice(box.offset, box.end);

        const parts = [bytes.slice(box.prefixStart, box.prefixEnd)];
        for (const child of box.children) {
            if (box === audioTrack && child.type === "edts") continue;
            parts.push(rebuild(child, replacements));
        }

        if (box === videoStbl) {
            if (newCtts) parts.push(newCtts);
            if (newStss) parts.push(newStss);
        }

        return makeBox(box.type, concatBytes(parts));
    }

    // Pass 1: measure rebuilt moov size.
    const passOne = new Map(fixed);
    for (const stco of allStcos) {
        passOne.set(stco, buildStcoReplacement(stco, 0, null));
    }
    const measuredMoov = rebuild(moov, passOne);

    const otherTop = boxes
        .filter((box) => !["ftyp", "moov", "mdat"].includes(box.type))
        .map((box) => bytes.slice(box.offset, box.end));
    const preservedTop = concatBytes(otherTop);

    const originalMdatPayload = bytes.slice(mdat.contentStart, mdat.end);
    const newMdatPayloadStart = ftyp.size + measuredMoov.byteLength + preservedTop.byteLength + 8;
    const delta = newMdatPayloadStart - mdat.contentStart;

    const fakeAudioOffsets = [];
    let cursor = newMdatPayloadStart + originalMdatPayload.byteLength;
    for (const size of fakeAudioSizes) {
        fakeAudioOffsets.push(cursor);
        cursor += size;
    }

    // Pass 2: write final chunk offsets.
    const finalReplacements = new Map(fixed);
    for (const stco of allStcos) {
        finalReplacements.set(stco, buildStcoReplacement(stco, delta, fakeAudioOffsets));
    }

    const output = concatBytes([
        bytes.slice(ftyp.offset, ftyp.end),
        rebuild(moov, finalReplacements),
        ...otherTop,
        makeBox("mdat", concatBytes([originalMdatPayload, fakeAudioPayload])),
    ]);

    return {
        newBuffer: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength),
        newBytes: output,
        multiplier: factor,
        factor,
        fakeAudioCount,
        seed,
    };
}
