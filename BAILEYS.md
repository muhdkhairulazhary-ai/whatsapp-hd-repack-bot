# Baileys deployment and iPhone pairing

The feature branch runs a WhatsApp Linked Devices companion using Baileys. The Cloud API instructions in the main README apply to the separate webhook service.

## Deploy on Render

1. Review and merge the fix PR into `feature/baileys-whatsapp-bot` in Safari. If you want a manual rollout and this branch has Auto-Deploy enabled, disable Auto-Deploy before merging.
2. In Render, open `whatsapp-hd-repack-bot-1`. Verify the service uses that feature branch, one instance, and `/health` as the health check path. The Docker image includes FFmpeg and FFprobe and defaults to `npm run start:baileys`. If the service already uses Docker, keep that runtime.
3. Verify that `BAILEYS_PHONE_NUMBER` contains the country code and number as digits, and that `PAIRING_ACCESS_TOKEN` is a long, private random secret. Rotate any previously exposed token. Keep `BAILEYS_AUTH_DIR` pointing to the existing session directory if it holds your linked session.
4. Choose **Manual Deploy → Deploy latest commit** when ready. Open the service HTTPS URL with `/health` appended. `ok: true` means the HTTP process is alive. `whatsappConnected: true` appears after WhatsApp login completes.

## Pair on the same iPhone

1. Create a private shortcut in Apple's **Shortcuts** app. Add a **URL** action with your Render HTTPS URL followed by `/pairing`.
2. Add **Get Contents of URL**, select **POST**, and under **Headers** add `Authorization` with value `Bearer YOUR_TOKEN`. Leave the body empty. Add **Show Result** to display the response. Keep this shortcut private because its configuration contains your token.
3. Run the shortcut. Run it again after a few seconds while the status is `connecting` or `waiting_for_whatsapp`. Read the `code` when the status is `pairing_code_ready`. The bot shows the code after WhatsApp acknowledges the registration request and returns a pairing reference. The same code stays available for up to 60 seconds, or until the phone responds or the socket closes.
4. In WhatsApp, open **Settings → Linked Devices → Link a Device → Link with phone number instead** and enter the code. The phone-number option may also appear in a WhatsApp notification. Reopen `/health` and look for `whatsappConnected: true`.
5. If you see `pairing_code_expired` or `connection_failed`, add `?refresh=1` to the shortcut URL and run it again. Refresh starts a new attempt once the previous one has stopped. If failures repeat, use the response's `reason` and numeric `statusCode` when troubleshooting. For a logged-out or invalid saved session, preserve the old directory and use a fresh private directory only when you intend to link again. For a replaced connection, check for another running instance using the same session.
6. Ask another WhatsApp user to send `PING` and a short MP4. The bot ignores messages sent by its own account.

A QR fallback normally requires displaying the QR on a second screen so the iPhone camera can scan it. Phone-number pairing works with a single device. This deployment keeps the QR challenge private and uses it internally to time the code request.

## Hosting and session persistence

Render Free web services spin down after 15 minutes without qualifying inbound traffic. The bot's outbound WhatsApp socket does not count as inbound traffic to Render. Spin-down and restarts disconnect the bot. Render's ephemeral filesystem can lose the session on a restart, redeploy or spin-down, and Free web services cannot attach persistent disks.

For an always-on connection with local session persistence, use a paid instance with a private persistent disk and set `BAILEYS_AUTH_DIR` to a directory under that disk's mount path. Pointing at a new empty directory requires linking again unless the complete session is migrated securely. Use a single process and a single instance for that auth directory. Exclude custom auth directories from Git and Docker build contexts, or keep them outside the checkout. The multi-file adapter is suitable for a single-instance bot, but a production database-backed auth adapter would need to persist both credentials and Signal keys. Deployments and network interruptions can still disconnect the socket. [Render Free limitations](https://render.com/docs/free) · [Persistent disks](https://render.com/docs/disks)

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
| `link_accepted` | The signed account identity was accepted. The socket must complete login before `/health` shows `whatsappConnected: true`. |

Report the last reason and numeric status code, with the approximate time of the attempt. Keep the pairing code, token, phone number, raw protocol data and credentials private. A notification processing warning during pairing is diagnostic context because Baileys uses that logger hook for all notifications.

## Video limits and troubleshooting

The Baileys bot accepts MP4 and MOV files up to **150 MB (150,000,000 bytes)** and **60 seconds**, including iPhone HEVC. For large clips or to preserve the source, send the video as a **document** in WhatsApp. The bot streams downloads to temporary storage, processes one video at a time, and uploads the MP4 from disk. WhatsApp can apply its own transfer limits before the bot receives a file.

`BAILEYS_MAX_INPUT_BYTES` defaults to 150,000,000 and can lower that limit. `MAX_VIDEO_SECONDS` can lower the Baileys duration limit. `MAX_INPUT_BYTES`, `MAX_OUTPUT_BYTES` and the `VIDEO_*` encoder settings apply to the separate Cloud API webhook.

FFprobe reads the source and output dimensions, frame rate, duration, codecs and bitrate. For compatible H.264/yuv420p video and AAC-LC audio, the bot remuxes the original streams into a fast-start MP4. If only one stream needs encoding, the compatible stream is copied. This preserves the original compressed media and generally keeps the output close to the input size, subject to container overhead and other tracks. Silent inputs get a silent AAC track.

When video needs encoding, FFmpeg uses H.264 CRF 18 with the `veryfast` preset, bounded decode/encode threads and lookahead, and source frame timestamps. It keeps the source resolution and aspect ratio, with no automatic downscaling or FPS cap. An odd encoded dimension may gain one padding pixel to support yuv420p. Re-encoding can change the size substantially, especially between different codecs. The bot applies neither a target bitrate nor padding bytes to match a file size.

`BAILEYS_MAX_OUTPUT_BYTES` defaults to 150,000,000. This is the bot's upload guard. If an output exceeds it, the bot replies in Malay and leaves the resolution and encoding strategy alone. Baileys 6.7.24 streams the encrypted file to WhatsApp's media hosts without setting a numerical Axios size limit. The hosts can still reject transfers and Baileys can report a generic upload failure after trying them. WhatsApp's advertised 2 GB file-sharing allowance is for file sharing and does not establish a limit for inline video uploads or WhatsApp Status. **WhatsApp may recompress clips posted to Status.** [Baileys uploader](https://github.com/WhiskeySockets/Baileys/blob/v6.7.24/src/Utils/messages-media.ts) · [WhatsApp file-sharing announcement](https://blog.whatsapp.com/reactions-2gb-file-sharing-512-groups)

If processing fails, check the Render log for `stage` and `reason`. Failures identify validation, storage, download, FFmpeg, upload or cleanup. Timeouts, explicit memory allocation failures, and unexpected child termination have separate reasons. A child terminated by SIGKILL may indicate memory pressure. If Render kills the entire process, check its service events and memory graph around the failure time. The app does not log filenames, WhatsApp identifiers, media URLs, raw FFmpeg output or credentials.
