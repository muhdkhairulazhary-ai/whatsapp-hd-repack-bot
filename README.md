# WhatsApp HD Repack Bot

A Node.js WhatsApp Business Cloud API webhook that receives a video, securely downloads it from Meta, repacks it with FFmpeg, then sends the MP4 back to the same sender.

**Output:** MP4 container · H.264 video · AAC audio · yuv420p · aspect ratio preserved.

This project uses the official Meta WhatsApp Cloud API only. It does not automate WhatsApp Web, access private sessions, or publish WhatsApp Status updates.

## Features

- WhatsApp Cloud API webhook (GET verification and POST signature validation).
- Secure media download from Meta over HTTPS with host validation and an input-size cap.
- FFmpeg conversion to H.264/AAC MP4, yuv420p, fast-start metadata and aspect-ratio-preserving scale.
- CRF and bitrate caps to reduce file size while retaining practical quality.
- Sends the processed video back to the original sender.
- HELP, PING and STATUS commands.
- Per-job temporary directory, restrictive file permissions and cleanup in a `finally` block.
- Docker image includes FFmpeg; suitable for a Render Web Service.

## Requirements

- A Meta developer account and a WhatsApp Business Platform / Cloud API app.
- A WhatsApp-enabled Meta phone number and a recipient phone for testing.
- GitHub repository and a Render account.
- Node.js 20+ and FFmpeg 5+ for local development, or Docker.

## Deploy from an iPhone (Safari)

You can do the setup from Safari; no computer is required for the normal GitHub + Render deployment.

### 1. Prepare Meta WhatsApp Cloud API

1. Open [Meta for Developers](https://developers.facebook.com/) and sign in.
2. Create an app, add the **WhatsApp** product, and open **WhatsApp > API Setup**.
3. Copy the **Phone number ID** and an access token. For production, create/use a long-lived System User token with the minimum required WhatsApp permissions. Do not paste the token into GitHub, source code, screenshots, or chat.
4. In the app's basic settings, copy the **App Secret**.
5. Add your own phone number as a test recipient if Meta's test setup requires it.

### 2. Deploy on Render

1. Open [Render](https://render.com/) in Safari and sign in with GitHub.
2. Choose **New + > Web Service**, then connect `muhdkhairulazhary-ai/whatsapp-hd-repack-bot`.
3. Choose the Docker runtime if Render offers the runtime selector; otherwise choose **Docker** as the environment.
4. Use the default branch `main`. Render detects the included `Dockerfile`.
5. Create the service. Wait for the first deployment and copy its public HTTPS URL, for example `https://your-service.onrender.com`.

### 3. Add environment variables in Render

In the service dashboard, open **Environment** and add these values. Use the actual secrets from Meta; never commit them.

| Key | Value |
| --- | --- |
| `WHATSAPP_TOKEN` | Meta WhatsApp access token |
| `PHONE_NUMBER_ID` | Phone number ID from WhatsApp API Setup |
| `GRAPH_API_VERSION` | A Graph API version currently supported by your Meta app (default in this project: `v23.0`) |
| `APP_SECRET` | Meta app secret |
| `VERIFY_TOKEN` | A long random string you create; this is not your Meta access token |
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Render may inject its own PORT; the app respects it) |

Optional limits (defaults shown): `MAX_INPUT_BYTES=16777216`, `MAX_OUTPUT_BYTES=16777216`, `MAX_VIDEO_SECONDS=300`, `FFMPEG_TIMEOUT_MS=180000`, `VIDEO_MAX_WIDTH=1280`, `VIDEO_CRF=28`, `VIDEO_MAXRATE=1800k`, `VIDEO_AUDIO_BITRATE=96k`.

After saving environment variables, trigger a redeploy if Render does not do it automatically.

### 4. Configure the Meta webhook

1. In Meta for Developers, open your app's **WhatsApp > Configuration** (or Webhooks setup).
2. Set the callback URL to `https://YOUR-SERVICE.onrender.com/webhook`.
3. Enter the exact `VERIFY_TOKEN` you added in Render.
4. Verify and save the callback.
5. Subscribe the WhatsApp webhook to the **messages** field.
6. Send a message to the WhatsApp test/business number.

Health check: open `https://YOUR-SERVICE.onrender.com/health`. It should return JSON with `"ok":true`.

### 5. Try the bot

Send these messages from a WhatsApp recipient number allowed by your Meta setup:

- `HELP` — command guide.
- `PING` — quick response test.
- `STATUS` — service status.
- Send a video — bot returns a repacked MP4.

Meta's customer-service window and template rules apply. A reply to an incoming user message is normally within the 24-hour customer service window.

## Local setup

1. Clone the repository.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in the required values.
4. Ensure FFmpeg is installed and available as `ffmpeg` in PATH.
5. Run `npm start`.
6. Expose the local server using a trusted HTTPS tunnel, then configure the tunnel's `/webhook` URL in Meta.

Never commit `.env`.

## Commands

| Message | Behaviour |
| --- | --- |
| HELP / MENU | Shows instructions |
| PING | Confirms the bot responds |
| STATUS | Reports the service as online |
| Video message | Downloads, repacks and replies with the MP4 |

## Processing and limits

- Input is capped at 16 MiB by default; output is capped at 16 MiB by default. Change the environment values only after checking the current WhatsApp Cloud API media limits for your account and message type.
- The bot accepts common video MIME types (MP4, MOV, 3GP, AVI and WebM); actual FFmpeg decoder support depends on the container image's FFmpeg build.
- Output is scaled down only when necessary, never upscaled, and the original aspect ratio is retained. Even dimensions are used for yuv420p compatibility.
- CRF 28 with a 1,800 kbit/s video max rate and 96 kbit/s AAC audio are sensible size-conscious defaults, not a guarantee of a particular quality or output size.
- Jobs run in the web process. Render free instances may sleep, restart, or have limited CPU/RAM and request-processing capacity; long videos can time out or be interrupted. Keep videos short and small. For reliable production workloads, use a paid always-on service and a durable job queue/worker.
- Temporary files are written under the operating system temp directory and removed after each job. Render's local filesystem is ephemeral; do not use it as permanent storage.

## Security

- Verifies Meta's `X-Hub-Signature-256` HMAC-SHA256 header against the exact raw request body using `APP_SECRET`.
- Uses HTTPS Meta media URLs and an allowlist of Meta media host domains.
- Uses generated filenames, private temporary directories and file mode `0600`.
- Does not log access tokens or media URLs.
- Keep all credentials in Render environment variables or a local untracked `.env` file. Rotate any token that has been accidentally exposed.
- The webhook responds quickly and processes messages asynchronously. For high-volume deployments, add a durable queue and webhook deduplication.

## Tests

Run:

```sh
npm test
```

The tests cover webhook signature validation, allowed media URL hosts and command parsing. They do not make live calls to Meta or test a deployed Render service.

## Troubleshooting

- **Webhook verification fails:** callback must end in `/webhook`; the Meta verify token must exactly match `VERIFY_TOKEN`.
- **Webhook returns 401:** check `APP_SECRET`; do not use the WhatsApp access token in this field.
- **Media download fails:** check token permissions, token expiry, media ID, and that the WhatsApp app is subscribed to `messages`.
- **Could not process video:** try a shorter MP4. Check Render logs for FFmpeg errors; do not share logs containing secrets.
- **Video too large:** lower `VIDEO_MAX_WIDTH`, increase `VIDEO_CRF` (for example 30–32), or use a shorter source clip.
- **Bot stops responding:** a free Render instance may be waking from sleep or may have restarted. Check the service health endpoint and Render logs.

## License

MIT
