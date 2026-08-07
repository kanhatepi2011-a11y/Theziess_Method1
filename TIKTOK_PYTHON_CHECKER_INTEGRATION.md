# TikTok Python Quality Checker integration

The website now supports two checker engines behind the existing `/api/tiktok/check` route.

## Default mode
No environment change is required. The existing JavaScript/serverless-friendly checker remains active.

## Exact Python mode
Set:

```env
TIKTOK_CHECKER_ENGINE=python
TIKTOK_CHECKER_PYTHON_BIN=python3
TIKTOK_CHECKER_TIMEOUT_MS=420000
TIKTOK_CHECKER_PYTHON_STRICT=false
```

Install runtime tools on the server:

```bash
python3 -m pip install -U "yt-dlp[default]"
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg
```

The Python engine downloads the TikTok video into a temporary directory, reads real video metadata with `ffprobe`, returns FPS/resolution/bitrates/codecs/pixel format/duration/file size/quality score, and automatically removes the temporary video.

`TIKTOK_CHECKER_PYTHON_STRICT=false` means the website automatically falls back to the existing checker if Python, yt-dlp, ffprobe, TikTok extraction, or the server runtime is unavailable.

## Vercel note
The built-in checker is the safe default for Vercel/serverless. Exact Python mode is intended for a VPS, Render/Railway-style persistent service, Termux server, or another host where Python, yt-dlp and ffmpeg/ffprobe are actually installed.
