import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { patchAudioInflationMp4 } from "../src/mp4-audio-inflate.mjs";
import { getBoxHeaderSize, parseBoxes } from "../src/mp4-boxes.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(testDir, "fixtures", "h264_faststart.mp4");

function typeAt(bytes, offset) {
    return String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    );
}

function children(bytes, view, box) {
    return parseBoxes(bytes, view, box.offset + getBoxHeaderSize(box), box.end);
}

function audioTables(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = top.find((box) => box.type === "moov");

    for (const trak of children(bytes, view, moov).filter(
        (box) => box.type === "trak",
    )) {
        const mdia = children(bytes, view, trak).find(
            (box) => box.type === "mdia",
        );
        if (!mdia) continue;
        const mdiaChildren = children(bytes, view, mdia);
        const hdlr = mdiaChildren.find((box) => box.type === "hdlr");
        if (!hdlr) continue;
        const hdlrPayload = hdlr.offset + getBoxHeaderSize(hdlr);
        if (typeAt(bytes, hdlrPayload + 8) !== "soun") continue;

        const mdhd = mdiaChildren.find((box) => box.type === "mdhd");
        const minf = mdiaChildren.find((box) => box.type === "minf");
        const stbl = children(bytes, view, minf).find(
            (box) => box.type === "stbl",
        );
        const stblChildren = children(bytes, view, stbl);
        const stsz = stblChildren.find((box) => box.type === "stsz");
        const stts = stblChildren.find((box) => box.type === "stts");
        const mdhdPayload = mdhd.offset + getBoxHeaderSize(mdhd);
        const stszPayload = stsz.offset + getBoxHeaderSize(stsz);
        const sttsPayload = stts.offset + getBoxHeaderSize(stts);
        const sttsEntries = view.getUint32(sttsPayload + 4, false);

        return {
            duration: view.getUint32(mdhdPayload + 16, false),
            sampleCount: view.getUint32(stszPayload + 8, false),
            timescale: view.getUint32(mdhdPayload + 12, false),
            finalDelta: view.getUint32(
                sttsPayload + 12 + (sttsEntries - 1) * 8,
                false,
            ),
        };
    }

    throw new Error("Audio track not found");
}

describe("audio inflation v2.6", () => {
    it("uses the supplied defaults and synchronizes the audio duration", () => {
        const input = new Uint8Array(readFileSync(fixturePath));
        const before = audioTables(input);
        const result = patchAudioInflationMp4(input, { seed: 7 });
        const after = audioTables(result.newBytes);
        const expectedDelta = Math.max(1, Math.floor(before.finalDelta / 10));

        expect(result.version).toBe("2.6");
        expect(result.factor).toBe(8);
        expect(result.baseSize).toBe(80);
        expect(result.fakeAudioCount).toBe(before.sampleCount * 8);
        expect(result.audioDelta).toBe(expectedDelta);
        expect(after.sampleCount).toBe(
            before.sampleCount + result.fakeAudioCount,
        );
        expect(after.duration).toBe(
            before.duration + result.fakeAudioCount * expectedDelta,
        );
    });

    it("produces an MP4 container that ffprobe can read", () => {
        const input = new Uint8Array(readFileSync(fixturePath));
        const result = patchAudioInflationMp4(input, { factor: 2, seed: 7 });
        const output = execFileSync(
            "ffprobe",
            [
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv",
                "-",
            ],
            { input: Buffer.from(result.newBytes), encoding: "utf8" },
        );

        expect(output).toContain("video");
        expect(output).toContain("audio");
    });
});
