// Audio-inflation MP4 patcher — v2.3 (browser/Web Worker port)
// Core v2.3 behavior: inflate audio sample tables while leaving mdhd/mvhd
// duration fields unchanged so the output keeps the original movie duration.
// Browser compatibility from the existing site is preserved (Uint8Array, co64,
// padding/vendor-byte recovery, and transferable ArrayBuffer output).

// Parse only the ISO-BMFF containers required by the patcher. Metadata boxes
// such as udta/meta/ilst may contain vendor-specific payloads that are not a
// regular sequence of child boxes and must remain opaque.
const CONTAINERS = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf",
]);

const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function readU32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function writeU32(bytes, offset, value) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, false);
}

function readU64(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = view.getBigUint64(offset, false);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("MP4 chunk offset exceeds JavaScript safe integer range");
    }
    return Number(value);
}

function writeU64(bytes, offset, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Invalid 64-bit MP4 chunk offset");
    }
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .setBigUint64(offset, BigInt(value), false);
}

function readType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function writeType(bytes, offset, type) {
    for (let i = 0; i < 4; i++) bytes[offset + i] = type.charCodeAt(i) & 0xff;
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
        out.set(part, cursor);
        cursor += part.byteLength;
    }
    return out;
}

function makeBox(type, payload) {
    const out = new Uint8Array(8 + payload.byteLength);
    writeU32(out, 0, out.byteLength);
    writeType(out, 4, type);
    out.set(payload, 8);
    return out;
}

function readBox(bytes, offset, end) {
    if (offset + 8 > end) throw new Error(`Truncated MP4 box at ${offset}`);
    let size = readU32(bytes, offset);
    const type = readType(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
        if (offset + 16 > end) throw new Error(`Truncated large MP4 box at ${offset}`);
        const hi = readU32(bytes, offset + 8);
        const lo = readU32(bytes, offset + 12);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
    } else if (size === 0) {
        size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) {
        throw new Error(`Invalid ${type} box at ${offset}`);
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

const RECOVERY_BOX_TYPES = new Set([
    "ftyp", "moov", "mdat", "free", "skip", "wide", "uuid",
    "mvhd", "trak", "tkhd", "edts", "elst", "mdia", "mdhd", "hdlr",
    "minf", "vmhd", "smhd", "hmhd", "dinf", "dref", "url ", "urn ",
    "stbl", "stsd", "stts", "ctts", "stsc", "stsz", "stz2", "stco",
    "co64", "stss", "sdtp", "sgpd", "sbgp", "subs", "padb",
    "udta", "meta", "ilst", "keys", "data", "name", "mean",
    "moof", "mfhd", "traf", "tfhd", "tfdt", "trun", "mfra", "tfra",
]);

function isLikelyBoxType(type) {
    // MP4 FourCC values are normally printable ASCII. This deliberately
    // rejects NUL padding and random binary data while allowing common types.
    return /^[\x20-\x7e]{4}$/.test(type);
}

function tryReadBox(bytes, offset, end) {
    try {
        const box = readBox(bytes, offset, end);
        return isLikelyBoxType(box.type) ? box : null;
    } catch (_) {
        return null;
    }
}

function findNextBox(bytes, offset, end) {
    // Some phone encoders place zero padding or proprietary bytes between
    // children in moov/trak. Search only for recognized ISO-BMFF box types to
    // avoid mistaking arbitrary payload bytes for a child box.
    const limit = Math.min(end - 8, offset + 1024 * 1024);
    const test = (cursor) => {
        const box = tryReadBox(bytes, cursor, end);
        return box && RECOVERY_BOX_TYPES.has(box.type) ? box : null;
    };

    // Box alignment is normally 4-byte aligned; prefer those candidates.
    for (let cursor = offset + 1; cursor <= limit; cursor++) {
        if ((cursor - offset) % 4 !== 0) continue;
        const box = test(cursor);
        if (box) return box;
    }
    for (let cursor = offset + 1; cursor <= limit; cursor++) {
        const box = test(cursor);
        if (box) return box;
    }
    return null;
}

function parseBoxes(bytes, start = 0, end = bytes.byteLength) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
        let box = tryReadBox(bytes, offset, end);
        if (!box) {
            box = findNextBox(bytes, offset, end);
            if (!box) break; // remaining bytes are padding/vendor payload
        }
        if (CONTAINERS.has(box.type)) {
            box.prefixEnd = box.contentStart;
            box.children = parseBoxes(bytes, box.contentStart, box.end);
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

function parseStsz(box, bytes) {
    const defaultSize = readU32(bytes, box.contentStart + 4);
    const count = readU32(bytes, box.contentStart + 8);
    if (defaultSize) return Array(count).fill(defaultSize);
    const required = box.contentStart + 12 + count * 4;
    if (required > box.end) throw new Error("Invalid stsz table");
    return Array.from({ length: count }, (_, i) => readU32(bytes, box.contentStart + 12 + i * 4));
}

function parseChunkOffsets(box, bytes) {
    const count = readU32(bytes, box.contentStart + 4);
    const entrySize = box.type === "co64" ? 8 : 4;
    if (box.contentStart + 8 + count * entrySize > box.end) {
        throw new Error(`Invalid ${box.type} table`);
    }
    return Array.from({ length: count }, (_, i) => {
        const offset = box.contentStart + 8 + i * entrySize;
        return box.type === "co64" ? readU64(bytes, offset) : readU32(bytes, offset);
    });
}

function parseStsc(box, bytes) {
    const count = readU32(bytes, box.contentStart + 4);
    if (box.contentStart + 8 + count * 12 > box.end) throw new Error("Invalid stsc table");
    return Array.from({ length: count }, (_, i) => {
        const offset = box.contentStart + 8 + i * 12;
        return [readU32(bytes, offset), readU32(bytes, offset + 4), readU32(bytes, offset + 8)];
    });
}

function buildCtts(realCount, frameDuration) {
    const groupCount = Math.min(realCount, ri(6, 10));
    const baseCount = Math.floor(realCount / groupCount);
    const entries = [];
    let remaining = realCount;
    for (let group = 0; group < groupCount; group++) {
        const count = group === groupCount - 1 ? remaining : baseCount;
        remaining -= count;
        entries.push([count, ri(0, 2) * frameDuration]);
    }
    const payload = new Uint8Array(8 + entries.length * 8);
    writeU32(payload, 4, entries.length);
    entries.forEach(([count, offset], i) => {
        writeU32(payload, 8 + i * 8, count);
        writeU32(payload, 12 + i * 8, offset);
    });
    return makeBox("ctts", payload);
}

function buildStss(realCount, fps) {
    const step = Math.max(1, Math.min(realCount, ri(fps, fps * 2)));
    const keys = [];
    for (let i = 1; i <= realCount; i += step) keys.push(i);
    const payload = new Uint8Array(8 + keys.length * 4);
    writeU32(payload, 4, keys.length);
    keys.forEach((key, i) => writeU32(payload, 8 + i * 4, key));
    return makeBox("stss", payload);
}

export function patchAudioInflationMp4(input, options = {}) {
    const inputBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    // v2.3 CLI names are factor/baseSize/seed. Keep multiplier/baseAudioSize
    // aliases so the existing site API remains backwards-compatible.
    const requestedFactor = Number.isFinite(options.factor) ? options.factor : options.multiplier;
    const multiplier = Number.isFinite(requestedFactor)
        ? Math.max(2, Math.min(20, Math.floor(requestedFactor)))
        : ri(8, 12);
    const requestedBaseSize = Number.isFinite(options.baseSize) ? options.baseSize : options.baseAudioSize;
    const baseAudioSize = Number.isFinite(requestedBaseSize)
        ? Math.max(16, Math.min(4096, Math.floor(requestedBaseSize)))
        : ri(60, 100);
    const payloadSeed = Number.isFinite(options.seed)
        ? Math.max(0, Math.min(255, Math.floor(options.seed)))
        : ri(0, 255);

    const boxes = parseBoxes(inputBytes);
    const ftyp = boxes.find((box) => box.type === "ftyp");
    const moov = boxes.find((box) => box.type === "moov");
    const mdat = boxes.find((box) => box.type === "mdat");
    if (!ftyp || !moov || !mdat) throw new Error("Missing ftyp, moov, or mdat box");

    let videoTrack = null;
    let audioTrack = null;
    for (const child of moov.children) {
        if (child.type !== "trak") continue;
        const hdlr = findDesc(child, ["mdia", "hdlr"]);
        if (!hdlr || hdlr.contentStart + 12 > hdlr.end) continue;
        const handler = readType(inputBytes, hdlr.contentStart + 8);
        if (handler === "vide" && !videoTrack) videoTrack = child;
        if (handler === "soun" && !audioTrack) audioTrack = child;
    }
    if (!videoTrack) throw new Error("No video track found");
    if (!audioTrack) throw new Error("No audio track found");

    const videoStbl = findDesc(videoTrack, ["mdia", "minf", "stbl"]);
    const videoMdhd = findDesc(videoTrack, ["mdia", "mdhd"]);
    const videoStsz = videoStbl && findChild(videoStbl, "stsz");
    if (!videoStbl || !videoMdhd || !videoStsz) throw new Error("Missing video sample tables");

    const videoTimescale = readU32(inputBytes, videoMdhd.contentStart + 12);
    const realVideoCount = parseStsz(videoStsz, inputBytes).length;
    const videoStts = findChild(videoStbl, "stts");
    const videoFrameDuration = videoStts && readU32(inputBytes, videoStts.contentStart + 4) > 0
        ? readU32(inputBytes, videoStts.contentStart + 12)
        : Math.max(1, Math.floor(videoTimescale / 30));
    const videoFps = Math.max(1, Math.round(videoTimescale / videoFrameDuration));

    const audioStbl = findDesc(audioTrack, ["mdia", "minf", "stbl"]);
    if (!audioStbl) throw new Error("Missing audio stbl");

    const audioStsz = findChild(audioStbl, "stsz");
    const audioStco = findChild(audioStbl, "stco") || findChild(audioStbl, "co64");
    const audioStsc = findChild(audioStbl, "stsc");
    const audioStts = findChild(audioStbl, "stts");
    const audioMdhd = findDesc(audioTrack, ["mdia", "mdhd"]);
    if (!audioStsz || !audioStco || !audioStsc) throw new Error("Missing audio stsz/stco/stsc");

    const realAudioSizes = parseStsz(audioStsz, inputBytes);
    const realAudioOffsets = parseChunkOffsets(audioStco, inputBytes);
    const realAudioRows = parseStsc(audioStsc, inputBytes);
    const fakeAudioCount = Math.floor(realAudioSizes.length * multiplier);
    if (fakeAudioCount <= 0) throw new Error("No audio samples found");

    const fakeAudioSizes = Array.from({ length: fakeAudioCount }, () => baseAudioSize + ri(0, 60));
    const fakeAudioChunks = [];
    const seed = payloadSeed;
    for (let i = 0; i < fakeAudioSizes.length; i++) {
        const chunk = new Uint8Array(fakeAudioSizes[i]);
        for (let j = 0; j < chunk.length; j++) {
            chunk[j] = ((seed + i * 23 + j * 41) ^ (i * 7 + j)) & 0xff;
        }
        fakeAudioChunks.push(chunk);
    }
    const fakeAudioPayload = concatBytes(fakeAudioChunks);

    const allAudioSizes = [...realAudioSizes, ...fakeAudioSizes];
    const audioStszPayload = new Uint8Array(12 + allAudioSizes.length * 4);
    writeU32(audioStszPayload, 8, allAudioSizes.length);
    allAudioSizes.forEach((size, i) => writeU32(audioStszPayload, 12 + i * 4, size));

    const audioRows = realAudioRows.map((row) => [...row]);
    if (!audioRows.length || audioRows[audioRows.length - 1][1] !== 1) {
        audioRows.push([realAudioOffsets.length + 1, 1, 1]);
    }
    const audioStscPayload = new Uint8Array(8 + audioRows.length * 12);
    writeU32(audioStscPayload, 4, audioRows.length);
    audioRows.forEach((row, i) => {
        writeU32(audioStscPayload, 8 + i * 12, row[0]);
        writeU32(audioStscPayload, 12 + i * 12, row[1]);
        writeU32(audioStscPayload, 16 + i * 12, row[2]);
    });

    const existingCtts = findChild(videoStbl, "ctts");
    const existingStss = findChild(videoStbl, "stss");
    const newCtts = existingCtts ? null : buildCtts(realVideoCount, videoFrameDuration);
    const newStss = existingStss ? null : buildStss(realVideoCount, videoFps);

    const fixed = new Map([
        [audioStsz, makeBox("stsz", audioStszPayload)],
        [audioStsc, makeBox("stsc", audioStscPayload)],
    ]);

    // v2.3: extend the audio stts sample count, but deliberately DO NOT
    // modify mdhd, tkhd, or mvhd duration fields. This preserves the movie's
    // original declared duration while keeping the inflated sample table.
    let audioDelta = 0;
    if (audioStts) {
        const entryCount = readU32(inputBytes, audioStts.contentStart + 4);
        if (entryCount > 0) {
            audioDelta = readU32(
                inputBytes,
                audioStts.contentStart + 12 + (entryCount - 1) * 8,
            );
        }
    }
    if (audioDelta <= 0 && audioMdhd) {
        const audioTimescale = readU32(inputBytes, audioMdhd.contentStart + 12);
        audioDelta = Math.max(1, Math.round(audioTimescale / 43));
    }

    if (audioStts && fakeAudioCount > 0 && audioDelta > 0) {
        const entryCount = readU32(inputBytes, audioStts.contentStart + 4);
        const payload = new Uint8Array(8 + (entryCount + 1) * 8);
        payload.set(inputBytes.slice(audioStts.contentStart, audioStts.contentStart + 4), 0);
        writeU32(payload, 4, entryCount + 1);
        payload.set(
            inputBytes.slice(audioStts.contentStart + 8, audioStts.contentStart + 8 + entryCount * 8),
            8,
        );
        writeU32(payload, 8 + entryCount * 8, fakeAudioCount);
        writeU32(payload, 12 + entryCount * 8, audioDelta);
        fixed.set(audioStts, makeBox("stts", payload));
    }


    const allChunkOffsetBoxes = [];
    for (const track of moov.children) {
        if (track.type !== "trak") continue;
        const stbl = findDesc(track, ["mdia", "minf", "stbl"]);
        const chunkOffsets = stbl && (findChild(stbl, "stco") || findChild(stbl, "co64"));
        if (chunkOffsets) allChunkOffsetBoxes.push(chunkOffsets);
    }

    function buildChunkOffsetReplacement(offsetBox, delta, fakeOffsets = null) {
        const original = parseChunkOffsets(offsetBox, inputBytes);
        const isAudio = offsetBox === audioStco;
        const total = original.length + (isAudio ? fakeAudioCount : 0);

        // Preserve co64 when present. For an stco input, automatically promote
        // to co64 if rebuilding would exceed the 32-bit offset range.
        const candidateOffsets = original.map((offset) => offset + delta);
        if (isAudio) candidateOffsets.push(...(fakeOffsets || Array(fakeAudioCount).fill(0)));
        const useCo64 = offsetBox.type === "co64" || candidateOffsets.some((offset) => offset > 0xffffffff);
        const entrySize = useCo64 ? 8 : 4;
        const payload = new Uint8Array(8 + total * entrySize);
        writeU32(payload, 4, total);

        candidateOffsets.forEach((offset, i) => {
            if (!Number.isSafeInteger(offset) || offset < 0) {
                throw new Error("Invalid rebuilt MP4 chunk offset");
            }
            if (useCo64) writeU64(payload, 8 + i * 8, offset);
            else writeU32(payload, 8 + i * 4, offset);
        });
        return makeBox(useCo64 ? "co64" : "stco", payload);
    }

    function rebuild(box, replacements) {
        if (replacements.has(box)) return replacements.get(box);
        if (!box.children.length) return inputBytes.slice(box.offset, box.end);

        // Preserve every unparsed byte between children. This is essential for
        // MP4s containing alignment padding, free space, or vendor metadata.
        const parts = [inputBytes.slice(box.prefixStart, box.prefixEnd)];
        let rawCursor = box.prefixEnd;
        for (const child of box.children) {
            if (child.offset > rawCursor) {
                parts.push(inputBytes.slice(rawCursor, child.offset));
            }
            // v2.3 duration-preservation fix: keep the original audio edit list.
            // AAC MP4s commonly use edts/elst to hide encoder priming; removing
            // it can make the visible duration longer by one AAC frame.
            parts.push(rebuild(child, replacements));
            rawCursor = child.end;
        }
        if (rawCursor < box.end) {
            parts.push(inputBytes.slice(rawCursor, box.end));
        }
        if (box === videoStbl) {
            if (newCtts) parts.push(newCtts);
            if (newStss) parts.push(newStss);
        }
        return makeBox(box.type, concatBytes(parts));
    }

    const passOne = new Map(fixed);
    for (const offsetBox of allChunkOffsetBoxes) {
        passOne.set(offsetBox, buildChunkOffsetReplacement(offsetBox, 0));
    }
    const measuredMoov = rebuild(moov, passOne);

    const preserved = concatBytes(
        boxes
            .filter((box) => !["ftyp", "moov", "mdat"].includes(box.type))
            .map((box) => inputBytes.slice(box.offset, box.end)),
    );
    const originalMdatPayload = inputBytes.slice(mdat.contentStart, mdat.end);
    const newMdatPayloadStart = ftyp.size + measuredMoov.byteLength + preserved.byteLength + 8;
    const offsetDelta = newMdatPayloadStart - mdat.contentStart;

    const fakeOffsets = [];
    let cursor = newMdatPayloadStart + originalMdatPayload.byteLength;
    for (const size of fakeAudioSizes) {
        fakeOffsets.push(cursor);
        cursor += size;
    }

    const finalReplacements = new Map(fixed);
    for (const offsetBox of allChunkOffsetBoxes) {
        finalReplacements.set(
            offsetBox,
            buildChunkOffsetReplacement(offsetBox, offsetDelta, fakeOffsets),
        );
    }

    const output = concatBytes([
        inputBytes.slice(ftyp.offset, ftyp.end),
        rebuild(moov, finalReplacements),
        preserved,
        makeBox("mdat", concatBytes([originalMdatPayload, fakeAudioPayload])),
    ]);

    return {
        newBuffer: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength),
        newBytes: output,
        multiplier,
        factor: multiplier,
        baseSize: baseAudioSize,
        seed,
        fakeAudioCount,
        version: "2.3",
    };
}
