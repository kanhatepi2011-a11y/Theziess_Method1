# NoBlur — Post TikTok Videos Without the Blur

NoBlur is a browser-based video-processing application for THEZIESS METHOD. MP4 and MOV processing stays local on the device. The optional official TikTok Inbox/Draft feature sends a separate clean artifact directly from the browser to TikTok only after explicit user consent; THEZIESS METHOD does not proxy or permanently store the video bytes.

![Preview](preview.webp)

---

## Technical Architecture

NoBlur runs two pipelines depending on the Interpolation toggle.

### Non-Interpolation Path (Frame Density Inflation)

The primary path for bypassing TikTok recompression. Inflates the MP4 sample table using pure binary manipulation — no FFmpeg re-encode, preserving 100% video quality with 10-100x faster processing.

1. **Container Normalization:** Reorders the MP4 so `moov` atom precedes `mdat` (fast-start) and rewrites `ftyp` brand to `isom` for compatibility.
2. **Frame Density Inflation:** Multiplies the sample table by 10x. Real frames are kept; codec-aware dummy samples are appended with `stts`/`stsz`/`stco`/`stsc` patched and padding written at EOF. Supports VFR, 64-bit chunk offsets (co64), and per-codec dummy sizes (avc1/avc3: 8B, hvc1/hev1: 16B, vp09/av01: 4B). TikTok reads the inflated frame count as high-density content and skips heavy recompression.

### Interpolation Path (60fps VFI + Inflation Pipeline)

When the Interpolation toggle is enabled, FFmpeg.wasm is lazy-loaded to run motion-compensated frame interpolation (`minterpolate`) to 60fps at the selected output resolution (1080p or 2K). Audio is copied without re-encoding (`-c:a copy`) for faster processing. The interpolated video then passes through the same frame density inflation pipeline. The FFmpeg instance is terminated after each video to prevent stale WASM state.

---

## Key Features

- **Pure Container Inflation:** No FFmpeg re-encode in the main path — preserves 100% video quality, 10-100x faster than transcoding.
- **TikTok Compression Bypass:** Codec-aware frame density inflation (10x default) makes videos pass TikTok's quality-preservation threshold. Works at both 1080p and 2K.
- **Codec-Aware Inflation:** Per-codec dummy sample sizes (avc1/avc3: 8B, hvc1/hev1: 16B, vp09/av01: 4B), VFR support, and co64 for 64-bit chunk offsets.
- **Single-Pass Pipeline:** Container normalization followed by sample-table inflation in one operation.
- **Selectable Output Resolution:** 1080p or 2K (1440p) when interpolation is enabled. VFI processes at 1080p then upscales to 2K.
- **Local Processing:** FFmpeg.wasm and MP4 processing run in the browser. Optional TikTok posting uploads the clean artifact directly to TikTok, not to THEZIESS METHOD servers.
- **Multi-Format & Codec Input:** MP4 and MOV with H.264, HEVC/H.265, and others.
- **Bulk Processing Queue:** Drag/drop or select multiple videos; processed sequentially.
- **Screen Wake Lock:** Keeps display active during processing; re-acquires on visibility change.
- **TikTok Studio Shortcut:** One-click redirect to TikTok Studio with mobile desktop-mode guidance.
- **Codec Detection Refactored:** Shared codec helpers in `mp4-boxes.mjs` eliminated duplication across modules.
- **Binary Pipeline Tests:** Round-trip tests with real video fixtures (H.264, HEVC, co64, MOV, mdat-first) cover normalize + inflate + playable output.
- **Fast-Start Container Fix:** Recalculates chunk offsets (`stco`/`co64`) on every structural shift.
- **Neo-Brutalist Dark UI:** Flat offset shadows, solid dark panels, neon accents, responsive mobile layout.
- **Local History:** IndexedDB with output-buffer thumbnails.

---

## File Structure

```text
NoBlur/
├── ffmpeg-core/          # Single-thread FFmpeg WASM
├── ffmpeg-core-mt/       # Multi-thread FFmpeg WASM (SAB)
├── ffmpeg-worker/        # FFmpeg.wasm class worker
├── scripts/
│   └── generate-changelog.mjs
├── src/
│   ├── mp4-boxes.mjs     # MP4 atom parser + codec helpers
│   ├── mp4-inflate.mjs   # Sample-table inflation logic
│   ├── mp4-normalize.mjs # Container normalization (moov→mdat, ftyp)
│   ├── changelog.mjs     # In-app changelog panel
│   ├── changelog-data.mjs
│   └── changelog.test.mjs
├── test/
│   ├── fixtures/         # Real MP4/MOV test vectors
│   ├── generate-fixtures.mjs
│   └── pipeline.test.mjs # Binary pipeline round-trip tests
├── index.html
├── style.css
├── app.js
├── db.js                 # IndexedDB wrapper
├── coi-serviceworker.js  # Cross-origin isolation for SAB
├── .nojekyll             # Disable GitHub Pages Jekyll
├── vite.config.js
├── package.json
├── biome.json
├── README.md
└── CHANGELOG.md
```

---

## Platform Notes

| Platform | Deployment | FFmpeg VFI |
|---|---|---|
| Vercel | `npm build`, server COEP headers | Multi-thread (SAB) |
| GitHub Pages | Deploy from branch, `.nojekyll`, COI service worker | Multi-thread (SAB) |
| Local (dev) | `vite`, dev-server COEP headers | Multi-thread (SAB) |

GitHub Pages serves files from the repo root directly (no Jekyll processing due to `.nojekyll`). Cross-origin isolation is provided by the COI service worker at `/coi-serviceworker.js`. If the service worker is still registering on first load, the page may not be immediately isolated — a page reload ensures it is active.

---

## Disclaimer

This utility rewrites MP4 container metadata for its local-download workflow. No video or audio data is re-encoded in the main non-interpolation path. The optional TikTok API flow deliberately uses a separate, truthful pre-inflation artifact and requires explicit consent before sending it directly to TikTok Inbox/Draft. Always keep backups of original files and upload only content you own or have permission to use.

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

## Real Telegram Login setup

This build uses Telegram OpenID Connect (Authorization Code + PKCE).

### 1. Choose one stable production domain

Example:

`https://theziess-method-test-qabd.vercel.app`

Avoid changing between Vercel preview domains because Telegram only accepts URLs that were registered beforehand.

### 2. Configure BotFather

1. Open `@BotFather`.
2. Select your bot → **Bot Settings** → **Web Login**.
3. Add both Allowed URLs (replace the example domain with your real production domain):
   - `https://theziess-method-test-qabd.vercel.app`
   - `https://theziess-method-test-qabd.vercel.app/api/auth/telegram/callback`
4. Copy the **Client ID** and **Client Secret** shown by BotFather.

### 3. Configure Vercel Environment Variables

Add these variables in **Vercel → Project Settings → Environment Variables**:

- `TELEGRAM_CLIENT_ID` — Client ID from BotFather Web Login
- `TELEGRAM_CLIENT_SECRET` — Client Secret from BotFather Web Login
- `TELEGRAM_REDIRECT_URI` — exact callback URL, for example `https://theziess-method-test-qabd.vercel.app/api/auth/telegram/callback`
- `SESSION_SECRET` — a random value of at least 24 characters
- `DATABASE_URL` — your PostgreSQL connection string

`TELEGRAM_BOT_TOKEN` is not used by this OIDC login flow. It is only needed if another backend feature sends Telegram bot messages.

### 4. Redeploy and test

After saving the environment variables, redeploy the project. Open the production domain, click **Login with Telegram**, then click **Continue with Telegram**.

The initiation endpoint is `/api/auth/telegram`. The callback endpoint registered with Telegram is `/api/auth/telegram/callback`.

## PostgreSQL database setup

This version permanently stores Telegram users, subscriptions, and KHQR demo payments in PostgreSQL.

1. Create a PostgreSQL database. Neon or Supabase works well with Vercel.
2. Add the PostgreSQL connection string as `DATABASE_URL` in Vercel → Project Settings → Environment Variables.
3. Keep `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_REDIRECT_URI`, and `SESSION_SECRET` configured.
4. Redeploy the project.
5. Open `/api/db-status` to confirm the database connection.

The API automatically creates the `users`, `subscriptions`, and `payments` tables on first use. You can also run `database.sql` manually in your PostgreSQL SQL editor.

Never expose `DATABASE_URL`, the Telegram bot token, or the session secret in frontend code.

## Telegram Admin Bot

The Vercel backend includes a secure Telegram webhook that lets configured
administrators inspect website users from Telegram.

### Available commands

- `/admin` — open the button-based admin dashboard
- `/stats` — user, subscription, payment and compression totals
- `/users [page]` — registered users ordered by latest login
- `/user <telegram_id|@username>` — full user details
- `/subscriptions` — active PRO, PREMIUM and MAX plans
- `/trials` — active FREE 3-day trials
- `/payments` — recent payment records
- `/id` — show your own Telegram ID

The bot shows only information saved by this application: Telegram login
profile, registration and login times, subscription/trial history, payment
records and compression metadata. It cannot read private chats, contacts,
phone numbers, email addresses or Telegram last-seen status.

### Vercel environment variables

```env
TELEGRAM_BOT_TOKEN=123456789:BOTFATHER_TOKEN
TELEGRAM_ADMIN_IDS=YOUR_TELEGRAM_ID
TELEGRAM_WEBHOOK_SECRET=random_letters_numbers_underscore_or_hyphen
TELEGRAM_SETUP_KEY=a_long_random_setup_password
ADMIN_TIMEZONE=Asia/Phnom_Penh
```

After deploying, register the webhook once from PowerShell:

```powershell
$body = @{ setupKey = "YOUR_TELEGRAM_SETUP_KEY" } | ConvertTo-Json
Invoke-RestMethod `
  -Method POST `
  -Uri "https://YOUR-VERCEL-DOMAIN/api/telegram/setup" `
  -ContentType "application/json" `
  -Body $body
```

Then open the bot in Telegram and send `/admin`. If you do not know your
Telegram ID yet, send `/id`, add the returned number to
`TELEGRAM_ADMIN_IDS`, redeploy, and run the setup request again so the admin
command menu is installed for that chat.

Webhook requests are checked with Telegram's
`X-Telegram-Bot-Api-Secret-Token` header. Never commit the real bot token,
setup key, webhook secret, session secret or database URL to GitHub.

---

## Official TikTok Login Kit + Content Posting API

This repository includes a Sandbox-first integration that links TikTok to an
already authenticated Telegram user. It uses TikTok's official OAuth 2.0 and
Content Posting API only. It does not scrape TikTok, collect TikTok passwords,
use browser cookies, or expose TikTok tokens to the frontend.

### What the integration does

1. A Telegram-authenticated user connects their own TikTok account.
2. The backend requests only `user.info.basic` and `video.upload`.
3. The backend stores access and refresh tokens encrypted with AES-256-GCM.
4. The browser prepares a separate clean TikTok artifact before the existing
   local sample-table inflation step.
5. The user reviews the real resolution, duration and FPS, checks a consent
   checkbox, and explicitly starts the upload.
6. The backend creates an official TikTok Inbox upload session.
7. The browser sends the video bytes directly to TikTok's short-lived HTTPS
   upload URL in sequential chunks. Video bytes never pass through Vercel or
   PostgreSQL.
8. The backend polls the official status endpoint. On success the UI tells the
   user to open TikTok, review the Inbox/Draft notification, and finish posting.

The integration does **not** claim that an Inbox upload is already public.
Production access remains subject to TikTok review and approval.

### TikTok Developer Portal configuration

Create or open the app in TikTok for Developers and configure:

- **Platform:** Web
- **Products:** Login Kit and Content Posting API
- **Content Posting mode:** Upload API / Upload to TikTok
- **Redirect URI:**
  `https://theziessmethod.site/api/auth/tiktok/callback`
- **Requested scopes:** `user.info.basic`, `video.upload`
- **Terms URL:** `https://theziessmethod.site/terms`
- **Privacy URL:** `https://theziessmethod.site/privacy`

Do not add `user.info.profile`, `user.info.stats`, `video.list`, or
`video.publish` for this first release.

For Sandbox testing, add the TikTok accounts that will test the app as Sandbox
target users in the Developer Portal. A Sandbox app is not Production approval.

### Required environment variables

```env
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=https://theziessmethod.site/api/auth/tiktok/callback
TIKTOK_SCOPES=user.info.basic,video.upload
TIKTOK_TOKEN_ENCRYPTION_KEY=
TIKTOK_PUBLIC_URL=https://theziessmethod.site
```

Generate a strong 32-byte token-encryption key and keep it stable. Examples:

```bash
openssl rand -base64 32
```

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Never commit the client secret, encryption key, access token, refresh token,
authorization code, or database URL. Changing the encryption key makes existing
stored TikTok tokens unreadable, so connected users would need to reconnect.

### Database migration

The application creates these non-destructive versioned tables through
`server/routes/_db.js`; the same schema is included in `database.sql`:

- `theziess_tiktok_connections_v1` — Telegram user key, TikTok identity,
  granted scopes, encrypted tokens, token expiry and timestamps.
- `theziess_tiktok_uploads_v1` — owner, publish ID, filename, byte count,
  MIME type, normalized status, safe error reference and timestamps.

No video bytes are stored in PostgreSQL. Existing users, subscriptions,
payments, free trials and compression history are preserved.

### TikTok API routes

```text
GET  /api/auth/tiktok
GET  /api/auth/tiktok/callback
GET  /api/tiktok/account
POST /api/tiktok/disconnect
POST /api/tiktok/upload/init
POST /api/tiktok/upload/status
POST /api/tiktok/upload/cancel
```

`/api/tiktok/upload/init` accepts only filename, byte size and MIME type. It
returns a short-lived TikTok upload URL, publish ID and safe chunk plan. The
browser uploads the binary directly to TikTok. `/cancel` only marks the local
upload record cancelled because the official FILE_UPLOAD flow does not expose a
client-side credential or application endpoint for deleting an already issued
upload URL.

### Clean TikTok artifact and compatibility validation

The existing inflated local-download artifact is preserved. It is never sent
through the official TikTok upload flow. Before inflation the app creates a
separate `tiktokUploadBlob` containing real media timing and real frames only.
It validates:

- MP4/MOV/WebM MIME type;
- H.264, H.265, VP8 or VP9 when codec metadata is available;
- real FPS from MP4 timing tables between 23 and 60;
- both dimensions between 360 and 4096 pixels;
- duration greater than zero and no longer than 10 minutes;
- file size no larger than 4 GB.

The app does not infer upload FPS from bitrate, hashtags or inflated sample
counts and does not add a watermark or promotional overlay.

### Upload chunk behavior

- Files below 5 MB use one complete chunk.
- A one-chunk upload between 5 MB and 64 MB uses the complete file size.
- Multi-chunk uploads use sequential 32 MB chunks.
- A remainder below 5 MB is merged into the final chunk.
- No chunk exceeds TikTok's 64 MB normal-chunk limit.
- The browser sends accurate `Content-Type` and `Content-Range`; the browser
  generates `Content-Length` from each Blob because JavaScript cannot set that
  forbidden header manually.
- `AbortController` cancels the active browser transfer.

Only one active TikTok upload is allowed per user. Upload initialization is
rate-limited in PostgreSQL.

### Local development

1. Copy `.env.example` to the environment used by the Vercel development
   runtime and provide all Telegram, PostgreSQL and TikTok values.
2. The production redirect URI must exactly match the Developer Portal. For a
   separate local TikTok app, register its HTTPS development callback instead
   of silently changing the Production callback.
3. Install and run:

```bash
npm ci
npm run dev
```

Vite serves the frontend; Vercel Functions should be tested with the Vercel
local runtime when OAuth/API endpoints are required.

### Universal MP4/MOV audio-inflation v3.1.1

The production website and command-line utility share one universal patch core:

`app.js → src/mp4-patcher-client.mjs → src/mp4-patcher-worker.mjs → src/mp4-audio-inflate.mjs`

The browser worker supports `stco` and `co64` (with BigInt), automatic
`stco → co64` promotion, multiple `mdat` relocation, 32/64-bit box sizes,
`size=0` boxes, `stsz`/`stz2`, metadata preservation, and method metadata
`theziessmethod.site`. Original movie/track/media durations and `edts/elst` are
not extended or removed by the fake samples. Fragmented MP4 (`moof`/`mvex`) is
rejected cleanly instead of being processed with classic sample-table logic.
Version 3.1.1 also avoids zero-duration `stts` entries and preserves the audio
timeline tick-for-tick for better compatibility with mobile MP4 demuxers.

To process a local compatible MP4/MOV through the exact same production core:

```bash
npm run patch:audio -- --factor 8 --verbose input.mp4 output.mp4
```

If the output path is omitted, the CLI writes an `_patched` file beside the
input. The CLI is only a Node wrapper; the patch implementation itself remains
in `src/mp4-audio-inflate.mjs` so there is one production engine.

### Vercel deployment

1. Add all variables from `.env.example` in **Vercel → Project → Settings →
   Environment Variables** for the Production environment.
2. Confirm the production domain is `https://theziessmethod.site`.
3. Deploy the repository root. Do not deploy the accidental application copy
   inside `ffmpeg-core-mt/`.
4. Confirm these public URLs load directly and after refresh:
   - `https://theziessmethod.site/terms`
   - `https://theziessmethod.site/privacy`
5. Log in with Telegram, connect a Sandbox target TikTok account, process a
   compatible video, and perform the manual test below.

Authentication and TikTok API responses use `Cache-Control: private, no-store`.
COOP/COEP headers required by FFmpeg.wasm remain enabled.

### Manual Sandbox test and review-demo recording

Record one continuous demo that shows:

1. The Terms and Privacy pages on the production domain.
2. Telegram login succeeding.
3. The separate **Connect TikTok** action.
4. TikTok's official consent screen showing only the requested scopes.
5. The connected TikTok display name and avatar in THEZIESS METHOD.
6. Processing a normal H.264 MP4 and showing the clean artifact's real FPS.
7. The review modal, unchecked consent state, then explicit user consent.
8. Direct upload progress and cancellation/retry behavior.
9. Successful processing status and the instruction to open the TikTok app.
10. The TikTok Inbox/Draft notification and the user manually reviewing and
    completing the post in TikTok.
11. Disconnecting TikTok and confirming the account is no longer connected.

Use only content owned by the test account or content the tester has permission
to upload. Never include real secrets or tokens in the recording.

### Troubleshooting

**Redirect mismatch**

The callback in TikTok Developer Portal, `TIKTOK_REDIRECT_URI`, and the OAuth
request must be identical, including HTTPS, hostname, path and trailing slash
behavior. The configured callback is:

```text
https://theziessmethod.site/api/auth/tiktok/callback
```

**Permission or scope error**

Confirm Login Kit and Content Posting API are enabled and the Sandbox target
user approved both `user.info.basic` and `video.upload`. Disconnect and connect
again after changing scopes.

**Expired or unreadable token**

The backend refreshes access tokens before API calls. Reconnect if the refresh
token expired, was revoked, or the encryption key changed.

**Upload rejected before transfer**

Process the source again and verify the clean artifact is 23–60 real FPS, uses
supported dimensions/codec/MIME type, is within the allowed duration and is no
larger than 4 GB. Old IndexedDB history records that lack a clean TikTok Blob
cannot be uploaded.

**429 or processing delay**

Wait before retrying. The app applies bounded polling and shows a support
reference only when TikTok provides a safe `log_id`.

**Upload appears complete but is not public**

This integration sends the video to TikTok Inbox/Draft. Open the TikTok app,
review the notification and manually finish posting. It does not publish
silently.

### Verification commands

```bash
npm test
npm run lint
npm run build
```

TikTok network calls are mocked in automated tests. Real credentials are never
required by the test suite.
