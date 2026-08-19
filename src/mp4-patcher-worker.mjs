import { patchAudioInflationMp4 } from "./mp4-audio-inflate.mjs";

self.onmessage = ({ data }) => {
    const { id, buffer, options } = data || {};
    try {
        const result = patchAudioInflationMp4(buffer, {
            ...(options || {}),
            onProgress: ({ percent, stage }) => {
                self.postMessage({ id, progress: true, percent, stage });
            },
        });
        self.postMessage(
            {
                id,
                ok: true,
                buffer: result.newBuffer,
                multiplier: result.multiplier,
                factor: result.factor,
                baseSize: result.baseSize,
                seed: result.seed,
                version: result.version,
                fakeAudioCount: result.fakeAudioCount,
                audioDelta: result.audioDelta,
                addedAudioDuration: result.addedAudioDuration,
                audioTimescale: result.audioTimescale,
                co64: result.co64,
                parser: result.parser,
                method: result.method,
                videoCodec: result.videoCodec,
                trackOffsetTables: result.trackOffsetTables,
                stabilizationPasses: result.stabilizationPasses,
            },
            [result.newBuffer],
        );
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
