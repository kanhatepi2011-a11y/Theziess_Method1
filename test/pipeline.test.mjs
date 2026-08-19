import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

describe("production browser patch execution path", () => {
    it("routes the website through the worker and universal core", () => {
        const app = read("app.js");
        const client = read("src/mp4-patcher-client.mjs");
        const worker = read("src/mp4-patcher-worker.mjs");

        expect(app).toContain('from "./src/mp4-patcher-client.mjs"');
        expect(app).toContain("patchAudioInflationInWorker(inputBuffer, { onProgress })");
        expect(client).toContain('new URL("./mp4-patcher-worker.mjs", import.meta.url)');
        expect(worker).toContain('from "./mp4-audio-inflate.mjs"');
        expect(worker).toContain("patchAudioInflationMp4(buffer");
    });

    it("does not keep the removed v2 production patchers wired in", () => {
        const app = read("app.js");
        const worker = read("src/mp4-patcher-worker.mjs");
        expect(app).not.toContain("audio-inflation-v2.6");
        expect(worker).not.toContain("co64 not supported");
    });

    it("only reaches 100 percent after core validation reports Done", () => {
        const core = read("src/mp4-audio-inflate.mjs");
        const app = read("app.js");
        expect(core.indexOf('emitProgress(opts, 88, "Validating output...")')).toBeGreaterThan(-1);
        expect(core.indexOf('emitProgress(opts, 100, "Done")')).toBeGreaterThan(
            core.indexOf('emitProgress(opts, 88, "Validating output...")'),
        );
        expect(app).toContain("if (successCount === pendingItems.length) setProgress(100)");
    });
});
