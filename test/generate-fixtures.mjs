import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(dir, "fixtures");
const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function u32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function boxTree(bytes, start = 0, end = bytes.length, parent = null) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
        let size = u32(bytes, offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        let header = 8;
        if (size === 1) {
            size = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset + 8, false));
            header = 16;
        } else if (size === 0) {
            size = end - offset;
        }
        if (size < header || offset + size > end) throw new Error(`Malformed ${type} at ${offset}`);
        const box = { type, offset, end: offset + size, size, header, parent, children: [] };
        if (containers.has(type)) box.children = boxTree(bytes, offset + header, box.end, box);
        boxes.push(box);
        offset = box.end;
    }
    return boxes;
}

function flatten(boxes, out = []) {
    for (const box of boxes) { out.push(box); flatten(box.children, out); }
    return out;
}

function makeBox(type, payload) {
    const out = new Uint8Array(8 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
}

function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

function convertAllStcoToCo64(inputPath, outputPath) {
    const bytes = new Uint8Array(readFileSync(inputPath));
    const top = boxTree(bytes);
    const moov = top.find((box) => box.type === "moov");
    const mdat = top.find((box) => box.type === "mdat");
    if (!moov || !mdat || moov.offset > mdat.offset) throw new Error("fixture generator expects fast-start moov before mdat");
    const all = flatten([moov]);
    const stcos = all.filter((box) => box.type === "stco");
    if (!stcos.length) throw new Error("no stco tables found");
    const growth = stcos.reduce((sum, box) => sum + u32(bytes, box.offset + box.header + 4) * 4, 0);

    const rebuild = (box) => {
        if (box.type === "stco") {
            const count = u32(bytes, box.offset + box.header + 4);
            const payload = new Uint8Array(8 + count * 8);
            const view = new DataView(payload.buffer);
            payload.set(bytes.subarray(box.offset + box.header, box.offset + box.header + 4), 0); // version/flags
            view.setUint32(4, count, false);
            for (let i = 0; i < count; i++) {
                const old = u32(bytes, box.offset + box.header + 8 + i * 4);
                view.setBigUint64(8 + i * 8, BigInt(old + growth), false);
            }
            return makeBox("co64", payload);
        }
        if (!box.children.length) return bytes.slice(box.offset, box.end);
        const parts = [];
        let cursor = box.offset + box.header;
        for (const child of box.children) {
            if (cursor < child.offset) parts.push(bytes.slice(cursor, child.offset));
            parts.push(rebuild(child));
            cursor = child.end;
        }
        if (cursor < box.end) parts.push(bytes.slice(cursor, box.end));
        return makeBox(box.type, concat(parts));
    };

    const newMoov = rebuild(moov);
    const result = concat([
        bytes.slice(0, moov.offset),
        newMoov,
        bytes.slice(moov.end),
    ]);
    writeFileSync(outputPath, result);
    return stcos.length;
}

const count = convertAllStcoToCo64(
    join(fixturesDir, "h264_faststart.mp4"),
    join(fixturesDir, "h264_co64.mp4"),
);
console.log(`wrote h264_co64.mp4 (${count} table(s))`);
