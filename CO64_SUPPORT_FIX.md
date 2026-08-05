# co64 Support Fix

The browser audio-inflation patcher now supports both MP4 chunk-offset table formats:

- `stco` — 32-bit chunk offsets
- `co64` — 64-bit chunk offsets

Changes:

- Reads and writes 64-bit offsets with `BigInt`/`DataView`.
- Preserves `co64` when the source uses it.
- Automatically promotes `stco` to `co64` when rebuilt offsets exceed 32-bit range.
- Updates chunk offsets for every track after rebuilding `moov` and `mdat`.
- Keeps the existing padding-tolerant parser.

The patcher still requires a regular, non-encrypted MP4/MOV containing both video and audio sample tables. Fragmented or damaged files may require remuxing.
