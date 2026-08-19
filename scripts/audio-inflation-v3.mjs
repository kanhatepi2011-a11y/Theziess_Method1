#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { patchAudioInflationMp4, VERSION } from "../src/mp4-audio-inflate.mjs";

function usage(code = 0) {
    const exe = path.basename(process.argv[1] || "audio-inflation-v3.mjs");
    (code ? console.error : console.log)(`Usage: node ${exe} [--factor N] [--verbose] <input.mp4|mov> [output.mp4|mov]`);
    process.exit(code);
}
const args = process.argv.slice(2), opts = {}, files = [];
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") usage(0);
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--factor") opts.factor = Number(args[++i]);
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else files.push(arg);
}
if (files.length < 1 || files.length > 2) usage(1);
const inputPath = files[0];
const ext = path.extname(inputPath) || ".mp4";
const outputPath = files[1] || `${inputPath.slice(0, inputPath.length - ext.length)}_patched${ext}`;
if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
const input = fs.readFileSync(inputPath);
console.log(`[*] Theziess Universal browser-core v${VERSION}`);
const result = patchAudioInflationMp4(input, { ...opts, onProgress: ({ percent, stage }) => { if (opts.verbose) console.log(`[*] ${percent}% ${stage}`); } });
fs.writeFileSync(outputPath, Buffer.from(result.newBuffer));
console.log(`[+] Done -> ${outputPath}`);
console.log(`[+] Method: ${result.method}`);
console.log(`[+] co64: ${result.co64.inputTables} -> ${result.co64.outputTables}`);
