# Audio Inflation Web Worker Integration

## What changed

- Replaced the old video-track `inflateSampleTableVideo()` call in `app.js`.
- Added a browser-compatible port of the supplied audio-inflation MP4 patcher.
- Runs the binary patch in a module Web Worker, so the main UI thread remains responsive.
- Processing remains local on the user's device. Video bytes are not uploaded for patching.
- Existing optional VFI/60 FPS FFmpeg processing remains client-side and is only used when the interpolation option is enabled.

## New files

- `src/mp4-audio-inflate.mjs`
- `src/mp4-patcher-worker.mjs`
- `src/mp4-patcher-client.mjs`

## Compatibility

The audio patch requires a normal MP4 containing `ftyp`, `moov`, `mdat`, video, audio, and 32-bit `stco` chunk offsets. Files using `co64` must first be remuxed through the existing VFI/FFmpeg path or another MP4 remuxer.

## Verification performed

- JavaScript syntax checks passed.
- The patcher was executed against `test/fixtures/h264_faststart.mp4`.
- FFprobe successfully parsed both video and audio streams from the generated output.

Full Vite/Vitest execution could not be completed in the editing environment because its package mirror did not provide one locked transitive dependency (`yocto-queue`).
