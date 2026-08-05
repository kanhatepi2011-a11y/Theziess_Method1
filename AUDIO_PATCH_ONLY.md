# Audio patch-only build

The processing pipeline now performs exactly one operation: the browser Web Worker port of the Audio-inflation MP4 patcher.

Removed from the active pipeline:
- FFmpeg / WebAssembly transcoding
- 60 FPS interpolation
- resolution scaling
- bitrate conversion
- container normalization
- TikTok FPS artifact validation during patching
- legacy video sample-table inflation

The patcher keeps its random 8–12x multiplier when no explicit multiplier is supplied.
