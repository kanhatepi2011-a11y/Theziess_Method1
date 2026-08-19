import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { METHOD, VERSION, patchAudioInflationMp4 } from "../src/mp4-audio-inflate.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");

function fixture(name) {
    return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

function ffprobe(buffer, entries = "format=duration:format_tags=comment,title") {
    return execFileSync(
        "ffprobe",
        ["-v", "error", "-show_entries", entries, "-of", "default=nw=1", "-"],
        { input: Buffer.from(buffer), encoding: "utf8" },
    );
}

function decodeOk(buffer) {
    execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "null", "-"], {
        input: Buffer.from(buffer),
        stdio: ["pipe", "ignore", "pipe"],
    });
}

describe("universal audio inflation v3.1", () => {
    const cases = [
        "h264_faststart.mp4",
        "h264_mdat_first.mp4",
        "h264_faststart.mov",
        "hevc_faststart.mp4",
        "h264_co64.mp4",
        "multi_mdat.mp4",
        "size0_mdat.mp4",
        "extended_moov.mp4",
        "stz2_audio.mp4",
    ];

    for (const name of cases) {
        it(`patches ${name} without extending the timeline`, () => {
            const result = patchAudioInflationMp4(fixture(name), { factor: 2 });
            const probe = ffprobe(result.newBytes);

            expect(result.version).toBe(VERSION);
            expect(result.method).toBe(METHOD);
            expect(result.audioDelta).toBe(0);
            expect(result.addedAudioDuration).toBe(0);
            expect(result.fakeAudioCount).toBeGreaterThan(0);
            expect(result.trackOffsetTables).toBeGreaterThan(0);
            expect(probe).toContain("duration=2.000000");
            expect(probe).toContain(`TAG:comment=${METHOD}`);
            expect(() => decodeOk(result.newBytes)).not.toThrow();
        });
    }

    it("keeps source co64 tables as co64", () => {
        const result = patchAudioInflationMp4(fixture("h264_co64.mp4"), { factor: 2 });
        expect(result.co64.inputTables).toBeGreaterThan(0);
        expect(result.co64.outputTables).toBe(result.co64.inputTables);
    });

    it("preserves unrelated metadata while replacing the method comment", () => {
        const result = patchAudioInflationMp4(fixture("existing_metadata.mp4"), { factor: 2 });
        const probe = ffprobe(result.newBytes);
        expect(probe).toContain("TAG:title=Original Camera Title");
        expect(probe).toContain(`TAG:comment=${METHOD}`);
    });

    it("reports production progress through final validation", () => {
        const progress = [];
        patchAudioInflationMp4(fixture("h264_faststart.mp4"), {
            factor: 2,
            onProgress: (entry) => progress.push(entry),
        });
        expect(progress[0]).toMatchObject({ percent: 8, stage: "Reading video..." });
        expect(progress.some((entry) => entry.stage === "Updating offsets...")).toBe(true);
        expect(progress.some((entry) => entry.stage === "Validating output...")).toBe(true);
        expect(progress.at(-1)).toMatchObject({ percent: 100, stage: "Done" });
    });
});
