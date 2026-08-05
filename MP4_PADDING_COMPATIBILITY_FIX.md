# MP4 padding compatibility fix

The audio-only patcher now:

- Parses only the ISO-BMFF containers needed for the audio patch.
- Keeps `udta`, `meta`, `ilst`, fragmented metadata, and vendor payloads opaque.
- Skips NUL/alignment padding between valid child boxes.
- Searches only for recognized MP4 FourCC box types during recovery.
- Preserves every byte before, between, and after parsed children when rebuilding.

This fixes errors such as:

```
Invalid \0\0\0\0 box at 156
```

The pipeline still performs only the audio-inflation patch. It does not use FFmpeg,
transcoding, resizing, interpolation, bitrate conversion, or FPS conversion.

Supported scope: ordinary non-fragmented MP4/MOV files containing one video track,
one audio track, `stco`, `stsc`, `stsz`, and normal sample tables. Files using `co64`,
fragmented `moof/traf` media, missing audio, encrypted tracks, or damaged sample tables
cannot be safely patched by this algorithm without remuxing or a separate implementation.
