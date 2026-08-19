#!/usr/bin/env node
/**
 * Audio-inflation MP4 patcher v2.6 CLI.
 * Uses the same implementation as the website/Web Worker so both outputs stay
 * identical and duration fields are written at valid MP4 offsets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { patchAudioInflationMp4 } from "../src/mp4-audio-inflate.mjs";

function usage(exitCode = 1) {
    console.error(`Usage: node ${basename(process.argv[1])} [options] <input.mp4> [output.mp4]
  --factor N     (default 8)
  --base-size N  (default 80)
  --seed N
  --verbose
`);
    process.exit(exitCode);
}

function readInteger(args, index, name, { min, max }) {
    const raw = args[index + 1];
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
}

const args = process.argv.slice(2);
const options = { verbose: false };
const files = [];

try {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") usage(0);
        if (arg === "--verbose") options.verbose = true;
        else if (arg === "--factor") {
            options.factor = readInteger(args, i, "factor", {
                min: 1,
                max: 100,
            });
            i++;
        } else if (arg === "--base-size") {
            options.baseSize = readInteger(args, i, "base-size", {
                min: 1,
                max: 65535,
            });
            i++;
        } else if (arg === "--seed") {
            options.seed = readInteger(args, i, "seed", { min: 0, max: 255 });
            i++;
        } else if (arg.startsWith("-")) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            files.push(arg);
        }
    }
} catch (error) {
    console.error(`[!] ${error.message}`);
    usage(1);
}

if (files.length < 1 || files.length > 2) usage(1);

const [inputPath, requestedOutputPath] = files;
if (!existsSync(inputPath)) {
    console.error(`[!] File not found: ${inputPath}`);
    process.exit(1);
}

const input = readFileSync(inputPath);
const outputPath =
    requestedOutputPath ||
    (/\.mp4$/i.test(inputPath)
        ? inputPath.replace(/\.mp4$/i, "_v26.mp4")
        : `${inputPath}_v26.mp4`);

console.log(
    `[*] Read ${inputPath} (${(input.length / 1024 / 1024).toFixed(2)} MB)`,
);
console.log("[*] Patching v2.6 ...");

try {
    const result = patchAudioInflationMp4(input, options);
    writeFileSync(outputPath, result.newBytes);
    console.log(
        `[+] Done -> ${outputPath} (${(
            result.newBytes.length /
            1024 /
            1024
        ).toFixed(2)} MB)`,
    );
} catch (error) {
    console.error(
        `[!] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
}
