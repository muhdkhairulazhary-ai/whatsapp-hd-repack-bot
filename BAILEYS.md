# Shelby+ HD Status Bot deployment and iPhone pairing

The feature branch runs a WhatsApp Linked Devices companion using Baileys. The Cloud API instructions in the main README apply to the separate webhook service.

## Deploy on Render

1. Review and merge the fix PR into `feature/baileys-whatsapp-bot` in Safari. If you want a manual rollout and this branch has Auto-Deploy enabled, disable Auto-Deploy before merging.
2. In Render, open `whatsapp-hd-repack-bot-1`. Verify the service uses that feature branch, one instance, and `/health` as the health check path. The Docker image includes FFmpeg, FFprobe and ImageMagick and defaults to `node src/baileys-server.js` so Node receives container signals directly. If the service already uses Docker, keep that runtime.
3. Verify that `BAILEYS_PHONE_NUMBER` contains the country code and number as digits, and that `PAIRING_ACCESS_TOKEN` is a long, private random secret. Rotate any previously exposed token. Keep `BAILEYS_AUTH_DIR` pointing to the existing session directory if it holds your linked session.
4. Choose **Manual Deploy → Deploy latest commit** when ready. Open the service HTTPS URL with `/health` appended. `{"status":"ok"}` means the HTTP process is alive. The authenticated `POST /pairing` reports `already_linked` after WhatsApp login completes.

## Pair on the same iPhone

1. Create a private shortcut in Apple's **Shortcuts** app. Add a **URL** action with your Render HTTPS URL followed by `/pairing`.
2. Add **Get Contents of URL**, select **POST**, and under **Headers** add `Authorization` with value `Bearer YOUR_TOKEN`. Leave the body empty. Add **Show Result** to display the response. Keep this shortcut private because its configuration contains your token.
3. Run the shortcut. Run it again after a few seconds while the status is `connecting` or `waiting_for_whatsapp`. Read the `code` when the status is `pairing_code_ready`. The bot shows the code after WhatsApp acknowledges the registration request and returns a pairing reference. The same code stays available for up to 60 seconds, or until the phone responds or the socket closes.
4. In WhatsApp, open **Settings → Linked Devices → Link a Device → Link with phone number instead** and enter the code. The phone-number option may also appear in a WhatsApp notification. Run the authenticated pairing shortcut again and look for `already_linked`.
5. If you see `pairing_code_expired` or `connection_failed`, add `?refresh=1` to the shortcut URL and run it again. Refresh starts a new attempt once the previous one has stopped. If failures repeat, use the response's `reason` and numeric `statusCode` when troubleshooting. For a logged-out or invalid saved session, preserve the old directory and use a fresh private directory only when you intend to link again. For a replaced connection, check for another running instance using the same session.
6. Ask another WhatsApp user to send `.ping` and a short MP4. The bot ignores messages sent by its own account.

A QR fallback normally requires displaying the QR on a second screen so the iPhone camera can scan it. Phone-number pairing works with a single device. This deployment keeps the QR challenge private and uses it internally to time the code request.

## Hosting and session persistence

Render Free web services spin down after 15 minutes without qualifying inbound traffic. The bot's outbound WhatsApp socket does not count as inbound traffic to Render. Spin-down and restarts disconnect the bot. Render's ephemeral filesystem can lose the session on a restart, redeploy or spin-down, and Free web services cannot attach persistent disks.

The default file adapter stores `creds.json` and the Signal key files under `BAILEYS_AUTH_DIR` (default `./baileys-auth`). Those files are local to the instance. For an always-on instance you can still mount a private paid disk. For auth persistence on Render Free, configure the external store below. In both cases use one bot instance.

### Encrypted auth on Render Free

1. Open the Upstash console, create a dedicated **Redis Free** database near the Render region, and open its REST credentials. Choose the free plan explicitly. Copy the read/write REST URL and token.
2. Generate a private 32-byte key as base64 in a trusted local terminal with `openssl rand -base64 32`. On an iPhone you can use a trusted local terminal such as iSH with OpenSSL installed. Save the key and token privately. The key is required to restore the session and must remain stable across deployments.
3. In Render's service environment, set the following values before your manual deployment. Preserve your existing phone number and pairing endpoint token.

| Variable | Value |
| --- | --- |
| `BAILEYS_AUTH_REDIS_URL` | Upstash HTTPS REST URL, with no path or embedded secrets |
| `BAILEYS_AUTH_REDIS_TOKEN` | Upstash read/write REST token |
| `BAILEYS_AUTH_ENCRYPTION_KEY` | Stable base64 encoding of exactly 32 random bytes |
| `BAILEYS_AUTH_SESSION_ID` | `shelby` by default. Keep it stable on routine deployments. |
| `BAILEYS_AUTH_DIR` | Existing local path. Used when no remote store is configured or for optional migration. |
| `BAILEYS_AUTH_MIGRATE_LOCAL` | Leave unset for a fresh external store, or set to `1` to import an available local snapshot into an empty external session. |
| `BAILEYS_PHONE_NUMBER` | Existing international number, digits only |
| `PAIRING_ACCESS_TOKEN` | Existing private bearer token for `POST /pairing` |
| `FFMPEG_TIMEOUT_MS` | `600000` (10 minutes, also the new default) |
| `BOT_MEDIA_JOB_TIMEOUT_MS` | `900000` (15 minutes, also the new default) |

Update any old explicit timeout values in Render when deploying. The FFmpeg clock starts at encoder launch and the overall job clock starts when a worker takes the job. Queue wait counts against neither. A long download leaves less time on the overall deadline. FFmpeg logs numeric progress every 15 seconds during long jobs, including elapsed time, frames, media time, output bytes and speed when available. `stopSource` distinguishes the FFmpeg timer, active job timer and shutdown. Crash signals are logged separately. Explicit allocation failures report `memory_exhausted`. An unexpected SIGKILL with a cgroup OOM counter change is evidence of memory pressure, but the counter can include other processes. If Render terminates the whole container, check Render's service events and memory metrics.

### Migrate an existing linked device

- If you have a secure, complete local snapshot, stop writes to that snapshot and make all Baileys auth files available in a private directory at startup. Set `BAILEYS_AUTH_DIR` to that directory and enable `BAILEYS_AUTH_MIGRATE_LOCAL=1` for the import. The import parses and encrypts all records, then commits them together only when the target Redis session is empty. It leaves the local files intact. Verify the authenticated `POST /pairing` shows `already_linked`, then remove the migration flag before a later deployment. The Redis session takes precedence once populated.
- Render Free has no persistent disk and may provide no safe way to access a live instance's full auth directory. If that snapshot is unavailable, leave migration disabled, deploy with the Redis settings, and use the existing authenticated phone-number pairing flow once. The new linked device will save its state in Redis. Keep private files and keys out of GitHub, build contexts, URLs and chat.
- After a controlled restart, verify the authenticated `POST /pairing` reports `already_linked` without requesting a code. A Redis outage, wrong key, or corrupt snapshot stops recovery without creating a replacement session. Check the store or restore the correct key first. After a genuine revocation and when you intend to link again, use a new `BAILEYS_AUTH_SESSION_ID` and leave migration disabled. This preserves the old encrypted snapshot.

The adapter encrypts credentials and Signal values with AES-256-GCM before transmission and obscures Signal record names. Writes are atomic batches guarded by a renewable 45-second lease. Storage recovery uses bounded exponential retries through 32 seconds to cover deployment overlap and lease expiry. A storage error never falls back to a new local account. Upstash lists 250 MB storage, 10 GB monthly bandwidth and 500,000 monthly commands for Free. Continuous lease renewal at 15-second intervals uses about 173,000 commands per 30 days before auth writes. A session snapshot must fit the provider's REST response and import request limits. The free tier, provider availability and WhatsApp's linked-device rules still apply. The store preserves auth across Render spin-down, but the bot cannot receive messages while the Render process is asleep. [Upstash pricing](https://upstash.com/pricing/redis) · [Upstash REST API](https://upstash.com/docs/redis/features/restapi) · [Render Free](https://render.com/docs/free)

## Diagnose a code rejected by the phone

The bot uses the protocol version bundled with Baileys 6.7.24. A registration acknowledgement confirms that WhatsApp registered the attempt. A matching phone notification, a finish acknowledgement and a signed response must still arrive before the account can link.

| Reason | What the bot observed |
| --- | --- |
| `pairing_hello_rejected` | WhatsApp rejected the registration IQ. The endpoint includes the protocol status code when provided. |
| `pairing_hello_unconfirmed`, `pairing_hello_unexpected_reply`, or `pairing_hello_reference_missing` | The bot received no usable registration acknowledgement and withheld the code. |
| `pairing_phone_notification_missing` | The code window expired before the phone notification arrived. |
| `pairing_phone_reference_mismatch` | The phone notification's reference did not match the active request. |
| `pairing_finish_unconfirmed` | The matching phone notification arrived, but the finish acknowledgement did not. |
| `pairing_signed_response_missing` or `pairing_signed_response_failed` | The signed response was missing or received without establishing a signed account identity. |
| `link_accepted` | The signed account identity was accepted. The socket must complete login before the authenticated `POST /pairing` shows `already_linked`. |

Report the last reason and numeric status code, with the approximate time of the attempt. Keep the pairing code, token, phone number, raw protocol data and credentials private. A notification processing warning during pairing is diagnostic context because Baileys uses that logger hook for all notifications.

## Video limits and troubleshooting

The Baileys bot accepts MP4 and MOV files up to **150 MB (150,000,000 bytes)** and **60 seconds**, including iPhone HEVC. For large clips or to preserve the source, send the video as a **document** in WhatsApp. The bot streams downloads to temporary storage, processes one video at a time, and uploads the MP4 from disk. WhatsApp can apply its own transfer limits before the bot receives a file.

`BAILEYS_MAX_INPUT_BYTES` defaults to 150,000,000 and can lower that limit. `MAX_VIDEO_SECONDS` can lower the Baileys duration limit. `MAX_INPUT_BYTES`, `MAX_OUTPUT_BYTES` and the `VIDEO_*` encoder settings apply to the separate Cloud API webhook.

FFprobe reads the source and output dimensions, frame rate, duration, codecs and bitrate. For compatible H.264/yuv420p video and AAC-LC audio, the bot remuxes the original streams into a fast-start MP4. If only one stream needs encoding, the compatible stream is copied. This preserves the original compressed media and generally keeps the output close to the input size, subject to container overhead and other tracks. Silent inputs get a silent AAC track.

When video needs encoding, FFmpeg uses H.264 CRF 18 with the `ultrafast` preset for HEVC and `veryfast` for other inputs, one video decode thread, one video encode thread, and bounded lookahead, and source frame timestamps. It keeps the source resolution and aspect ratio, with no automatic downscaling or FPS cap. An odd encoded dimension may gain one padding pixel to support yuv420p. Re-encoding can change the size substantially, especially between different codecs. The bot applies neither a target bitrate nor padding bytes to match a file size.

`BAILEYS_MAX_OUTPUT_BYTES` defaults to 150,000,000. This is the bot's upload guard. If an output exceeds it, the bot replies in Malay and leaves the resolution and encoding strategy alone. Baileys 6.7.24 streams the encrypted file to WhatsApp's media hosts without setting a numerical Axios size limit. The hosts can still reject transfers and Baileys can report a generic upload failure after trying them. WhatsApp's advertised 2 GB file-sharing allowance is for file sharing and does not establish a limit for inline video uploads or WhatsApp Status. **WhatsApp may recompress clips posted to Status.** [Baileys uploader](https://github.com/WhiskeySockets/Baileys/blob/v6.7.24/src/Utils/messages-media.ts) · [WhatsApp file-sharing announcement](https://blog.whatsapp.com/reactions-2gb-file-sharing-512-groups)

If processing fails, check the Render log for `stage` and `reason`. Failures identify validation, storage, download, FFmpeg, upload or cleanup. Timeouts, explicit memory allocation failures, and unexpected child termination have separate reasons. A child terminated by SIGKILL may indicate memory pressure. If Render kills the entire process, check its service events and memory graph around the failure time. The app does not log filenames, WhatsApp identifiers, media URLs, raw FFmpeg output or credentials.

## Shelby+ V2 configuration

Keep the existing `BAILEYS_AUTH_DIR`, `BAILEYS_PHONE_NUMBER` and `PAIRING_ACCESS_TOKEN`. A linked session uses its saved credentials. The phone and token are used when pairing is needed. Render supplies `PORT`. The bot's display name is separate from its existing Linked Devices identity.

| Optional variable | Default |
| --- | --- |
| `BOT_NAME` | Shelby+ |
| `BOT_FULL_NAME` | Shelby+ HD Status Bot |
| `BOT_TAGLINE` | Your Status. Your Quality. |
| `BOT_PREFIX` | `.` |
| `BOT_ACCOUNTS_DIR` | `./shelby-accounts` |
| `BOT_MEDIA_CONCURRENCY` | 1 active job, configurable from 1 to 4 |
| `BOT_MEDIA_QUEUE_SIZE` | 4 waiting jobs, configurable from 0 to 32 |
| `BOT_MEDIA_JOB_TIMEOUT_MS` | 900,000 per active job |
| `BAILEYS_MAX_INPUT_BYTES`, `BAILEYS_MAX_OUTPUT_BYTES` | 150,000,000 each |

Keep concurrency at 1 on Render Free. The job deadline cancels transfers and child processes where supported. Baileys' final relay still uses its own socket timeout. Duplicate suppression and the queue are in-memory. Jobs interrupted by a restart must be resent. Registered and unregistered users can convert media without credits or a daily quota. Once registered, `.status` shows the successful deliveries recorded for that WhatsApp JID. Changes in the JID presented by WhatsApp can result in a separate account record.

Accounts are stored as private JSON files and updated atomically on a single instance. No database is needed. For durability, keep `BAILEYS_AUTH_DIR` and `BOT_ACCOUNTS_DIR` in separate directories under a private persistent mount. On Render this requires paid compute and a disk. Render lists Starter compute at US$7/month and persistent disks at US$0.25 per GB/month. Check current charges and plan limits before changing instance type. Keep both directories private and out of Git, Docker build contexts and public backups. Migrate the whole existing authentication directory securely before changing its path. The optional Redis adapter above stores WhatsApp credentials and Signal keys. Account and usage records still use `BOT_ACCOUNTS_DIR` and can be lost on Render Free. [Render pricing](https://render.com/pricing) · [Disk setup](https://render.com/docs/disks)

A transient connection failure retries after 1, 2 and 4 seconds, then stops until recovery is requested or the process restarts. WhatsApp's post-link restart remains immediate. Logged-out and replaced sessions stop automatic retries and keep all existing credentials. Tests confirm a saved session can be reloaded through Baileys' file adapter after a simulated restart. Actual survival on Render depends on where that directory is mounted.

Images are validated by content and decoded with ImageMagick. The Docker build supports JPEG, PNG and HEIC. PNG output remains lossless, while JPEG and HEIC inputs produce high-quality JPEG. Orientation is applied before sending and metadata is stripped. The bot handles a single image up to 50 megapixels and may reject files that exceed decoder resource limits. A host without HEIC decoder support returns a Malay conversion error. Media is sent without captions. The bot skips the extra thumbnail decode to save memory, so previews can vary by WhatsApp client. WhatsApp controls chat colors and may recompress media when posting to Status. The separate browser converter uses the Shelby+ black, red and white theme.

### Manual iPhone check

1. After a manual deploy, open `/health` for HTTP liveness and check the authenticated `POST /pairing` for `already_linked`. Keep the existing session path.
2. From another WhatsApp account, send `.daftar Azhary`, repeat it, and check `.menu`, `.help` and `.status`.
3. Send an H.264/AAC 1080p MP4, an iPhone HEVC MOV, a rotated JPEG, a transparent PNG and a HEIC document. Check that replies have no captions. Confirm the counts in `.status`.
4. Send an oversized or unsupported file and check the Malay reply. Send several files together and check the wait and queue-full replies.
5. On a staging instance with persistent storage, restart the process and confirm the account counts and WhatsApp session return without re-linking.

### Diagnose a restart with an open socket and no replies

In Render logs, look for `auth_lease_acquired`, `stored_auth_available`, and `whatsapp_open` in that order. `auth_storage_busy` means the old process still owns the lease or its lease is waiting to expire. Recovery retries with backoff while keeping the encrypted state. A successful storage recovery still leaves the socket its own reconnect budget.

After WhatsApp opens, `offline_notifications_received` marks completion of the server's offline batch and `first_notify_dispatched` shows that the app received a message batch. If Baileys still has a buffered batch 30 seconds after open, the bot flushes it and logs `startup_event_buffer_flushed`. The bot accepts fresh offline deliveries from the current recovery window and ignores older history. If a fresh `.menu` still receives no reply, check for the message-receive or init-query warning and the numeric status code. These logs exclude message contents, identifiers and auth data.


### Video performance and shutdown

The video path checks both streams and display geometry before copying. A compatible rotation matrix is preserved without rotating every decoded frame. The output probe checks MP4 branding, H.264/AAC compatibility, dimensions, rotation, sample aspect ratio, frame rate, stream duration and the relative audio start time. A failed remux or failed compatibility check can trigger one encoding fallback. Deadline, memory and cancellation failures do not trigger another conversion. The output size guard still applies before upload.

Compare `Media stage timing` for `download`, `ffprobe`, `ffmpeg`, `verification` and `upload`. `Media job timing` reports total active time, excluding queue wait. No path, JID, filename or media URL is included. Download and upload times vary by WhatsApp host and network. An app `SIGTERM` records shutdown, job counts, and available cgroup memory counters, then cancels work, cleans temporary files and drains connection shutdown. A SIGTERM does not establish OOM. The reported 22:25 MYT termination had no corresponding visible Render event, and its source remains unknown.

#### One-core benchmark

Synthetic 60 fps MOV fixtures used FFmpeg `testsrc2`, HEVC Main 10 and AAC. The 1080×1920 fixture runs for five seconds and the 3840×2160 fixture for three seconds. The comparator was feature commit `e4f9475` versus this implementation. Processes ran on one pinned logical CPU with FFmpeg 7.1.5. The times below include local input/output probes, FFmpeg and Node startup, without WhatsApp transfers. Peak RSS is the largest process's RSS, not the total service memory. These were single runs on the development host, without Render's shared CPU quota or a 512 MiB memory cap.

| Input | Local time before → after | Wall-time reduction | Output resolution and FPS | MP4 size before → after | Peak RSS before → after | CPU seconds before → after |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Portrait HEVC | 9.951 → 6.281 s | 36.9% | 1080×1920 at 60 fps | 14.18 → 18.81 MB | 296 → 179 MiB | 9.93 → 6.27 |
| UHD HEVC | 26.276 → 17.346 s | 34.0% | 3840×2160 at 60 fps | 26.48 → 40.01 MB | 848 → 583 MiB | 26.26 → 17.33 |
| Compatible H.264/AAC | 0.509 → 0.443 s | Small single-run difference | 1080×1920 at 60 fps | 14.18 → 14.18 MB | 40 → 40 MiB | 0.51 → 0.44 |

Codec output was H.264/AAC in all cases. A separate encoder-only CRF 18 comparison used one decode and one encode thread for all three presets. SSIM is against the source converted to 8-bit 4:2:0 for measurement. Results are fixture-specific.

| Preset | Portrait time / size / SSIM | UHD time / size / SSIM |
| --- | --- | --- |
| ultrafast | 5.828 s / 18.81 MB / 0.99597 | 17.063 s / 40.01 MB / 0.99673 |
| superfast | 9.574 s / 14.18 MB / 0.99662 | 24.939 s / 26.48 MB / 0.99737 |
| veryfast | 13.115 s / 10.59 MB / 0.99614 | 31.858 s / 22.62 MB / 0.99714 |

`ultrafast` was selected for HEVC because it used less CPU time and memory on both fixtures at similar measured similarity. Its larger files can take longer to upload or hit the existing output cap. The UHD benchmark, run before the memory guard, exceeded Render Free's 512 MiB RAM by itself. Shelby+ now rejects video transcodes above 1920×1080 pixels (including portrait equivalents by pixel count) unless the cgroup reports at least 768 MiB of available headroom. The preflight runs again if a remux fails and would need re-encoding. Compatible UHD Smart Copy remains available, subject to output verification and the upload-size limit. The bot suggests sending a 1080p version when a transcode is refused. It does not silently resize the video.

Media worker concurrency is capped by the cgroup memory limit using a conservative estimate of 768 MiB per worker plus 128 MiB of service headroom. The 512 MiB instance runs one job even if configured for more. If the cgroup limit is unavailable or unlimited, the bot uses a conservative 512 MiB estimate. These are admission checks, not a guarantee against every OOM. Output bytes are checked before upload, and a file exactly at the cap is accepted. The original 39.6 MB MOV and live Render/WhatsApp transfers were unavailable in this benchmark. The under-two-minute production target remains unverified. [Render instance specifications](https://render.com/pricing)

### HEVC size control

HEVC-to-H.264 conversion keeps the ultrafast CRF 18 preset, with an x264 VBV ceiling based on source duration, dimensions, frame rate, bitrate, audio budget and the configured upload limit. The estimate reserves 5% of the limit plus container and VBV headroom. Compatible Smart Copy is unchanged. Size control does not resize, pad or change the frame rate of HEVC video. An odd HEVC dimension is refused because this output format requires even dimensions.

If an encode still exceeds the cap, the bot may make one lower-bitrate attempt within the remaining encoder and job deadlines and the same memory guard. If the estimate would fall below the quality floor, the bot asks for a shorter clip in Malay. The floor is a bitrate heuristic. Very noisy or high-motion footage can still show quality loss near the cap. The bot checks actual bytes before sending.

The CI benchmark runs three-second synthetic portrait 1080p30 and 1080p60 Main 10 MOV clips in Docker with one CPU, 512 MiB of memory and no swap allowance. It compares the same ultrafast encoder with and without the size plan, using a 3 MB cap to exercise the constraint. It reports wall time including probes, sampled peak cgroup memory and SSIM against the source converted to 8-bit yuv420p. The benchmark excludes WhatsApp transfers and does not contain the original production clip.

### Diagnose an early MOV encoder exit

FFprobe success means the container and metadata were readable. It does not prove that every selected track is decodable, that the pixel format can be converted, or that the encoder and MP4 muxer will accept the stream. The previous status command selected `0:V:0` and `0:a:0`, with single-thread decoding, the HEVC-derived VBV plan, H.264/yuv420p output, source frame timing, and AAC copy or conversion. If the first audio codec is unrecognized, the status path now selects a compatible AAC alternate when available, or a recognized audio alternate. It maps the exact probed stream indexes so timing checks use the same tracks as FFmpeg.

Synthetic HEVC Main 10 HLG with a first audio sample description marked as unknown reproduces a first-track decoder failure and succeeds using the AAC alternate, including its audio offset. This represents a possible iPhone spatial-audio layout. The fixture does not contain real Apple spatial audio or Dolby Vision enhancement data. HDR and Dolby Vision are logged as bounded diagnostic hints where available, and this change does not tone-map video.

For a failed production job, use the existing `Media processing failed` log and collect `reason`, `exitCode`, `signal`, `stderrCategories`, `stderrBytes`, and the allowlisted `input` fields. These are fixed labels, counts, and technical stream properties. The bot never emits raw FFmpeg stderr, paths, URLs, or arbitrary metadata. Decoder absence is separate from encoder or muxer failure. An advisory unsupported-codec line by itself does not establish why FFmpeg exited.

If the same failure persists, those diagnostics and the deployed FFmpeg version can narrow the cause. A reproducible source clip or complete FFmpeg stderr captured in a private environment may still be needed. Remove locations, credentials and other sensitive data before sharing any output.

### Live video progress

Recognized video messages and MP4/MOV documents get one Shelby+ progress message. On Baileys 6.7.24 the bot edits its own message using its returned key. It coalesces changes and sends edits at least 12 seconds apart, independently of media processing. Download progress uses the declared file length when available. Smart Copy, output validation and upload show a stage without a fabricated percentage.

FFmpeg uses its machine-readable progress on descriptor 3. Both `out_time_us` and the legacy `out_time_ms` contain microseconds on the tested FFmpeg versions. Encoding progress uses the probed duration, stays below 100%, and starts over on a permitted retry. Elapsed time is measured from acceptance. The remaining-time estimate covers encoding only, after enough advancing samples are available. Output validation and delivery take additional time. A paced edit can skip short stages, and the final edit may follow the media by up to one edit interval during normal operation.

A failed edit disables further progress attempts for that job. The bot still sends the video or its normal error reply. Pending edits are bounded and shutdown discards scheduled updates. An edit already sent to Baileys cannot be recalled. Files with ambiguous document metadata may receive only the standard acknowledgment. WhatsApp may decline or delay an edit. The regression verifies serialization with the installed Baileys library, without contacting a live WhatsApp account.
