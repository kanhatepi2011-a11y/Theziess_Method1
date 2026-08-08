# Real FPS Hosting Integration

The website now uses the Telegram bot hosting server to analyze the actual TikTok video with `yt-dlp + ffprobe`.

## Flow

1. Browser POSTs TikTok URL to `/api/tiktok/check` on Vercel.
2. Vercel starts a job on `http://panel.peachygang.app:3008/api/check-video/start`.
3. Browser polls the same Vercel endpoint every 2 seconds.
4. Vercel polls PEACHY `/api/check-video/status`.
5. When complete, the UI displays the real ffprobe FPS.

The browser never calls the HTTP PEACHY port directly, avoiding HTTPS mixed-content problems.

## Vercel environment variables

```env
TIKTOK_CHECKER_API_URL=http://panel.peachygang.app:3008
TIKTOK_CHECKER_API_KEY=<same secret as FPS_API_KEY on PEACHY>
TIKTOK_CHECKER_PROXY_TIMEOUT_MS=8000
```

## Important

FPS is never estimated from bitrate. If real FPS cannot be verified, the UI displays `Unavailable` instead of inventing a value.
