import { patchAudioInflationMp4 } from "./mp4-audio-inflate.mjs";

self.onmessage = ({ data }) => {
    const { id, buffer, options } = data || {};
    try {
        const result = patchAudioInflationMp4(buffer, options);
        self.postMessage(
            {
                id,
                ok: true,
                buffer: result.newBuffer,
                multiplier: result.multiplier,
                fakeAudioCount: result.fakeAudioCount,
            },
            [result.newBuffer],
        );
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
