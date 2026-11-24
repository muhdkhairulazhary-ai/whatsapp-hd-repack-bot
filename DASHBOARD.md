# Shelby+ Control Center

Control Center is a read-only owner dashboard on the Baileys server. It uses local HTML, CSS, JavaScript and icons. It observes the existing queue, media stages, FFprobe metadata and encoding progress. It shares the WhatsApp progress estimate, issues no media commands, and makes no additional FFprobe calls.

## Enable from an iPhone

These are manual steps for after you approve the change and choose to deploy it.

1. In Safari, open your Render service and find its public HTTPS service URL under **Settings**.
2. Generate two independent 32-byte random secrets in unpadded base64url. For example, in a trusted terminal app on your iPhone such as iSH with OpenSSL installed, run the following twice. Save the administrator token in your password manager.

   ```sh
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

3. In Render, open the service’s **Environment** tab. Add these variables. Keep the existing Redis and Baileys settings.

   | Variable | Value |
   | --- | --- |
   | `SHELBY_ADMIN_ENABLED` | `1` |
   | `SHELBY_ADMIN_ORIGIN` | `https://your-render-service.onrender.com`, with an optional trailing slash. Use only the HTTPS service URL |
   | `SHELBY_ADMIN_TOKEN` | First 43-character secret |
   | `SHELBY_ANALYTICS_KEY` | Second 43-character secret. Keep stable for consistent user IDs |
   | `BAILEYS_AUTH_REDIS_URL` | Existing HTTPS Upstash REST endpoint |
   | `BAILEYS_AUTH_REDIS_TOKEN` | Existing read/write Upstash REST token |

4. Save and deploy only when ready. Open `https://your-render-service.onrender.com/dashboard` in Safari and paste the administrator token into the sign-in form. The dashboard uses the exact configured origin.
5. To add it to the Home Screen, tap Safari’s Share button, then **Add to Home Screen**. The Home Screen app may require its own sign-in. There is no service worker or offline copy of private data.

Configuration is required even if the bot already connects to WhatsApp. When enabled with invalid settings, `/dashboard` returns a generic 503 and the startup log lists the first invalid variable by name. Values are never logged. Look for **Control Center startup** in Render Logs. A `ready` entry confirms that settings and assets loaded. Redis reachability is checked separately when analytics run. A deliberately disabled dashboard returns 404. A healthy `/health` alone cannot confirm dashboard startup. The Docker default command and `npm run start:baileys` both serve the dashboard. The separate `npm start` server does not serve it.

## Metrics and retention

- A job enters telemetry once accepted by the media queue. Jobs rejected before queueing and queued jobs discarded at shutdown are excluded. An active job reaches **success** after the WhatsApp send resolves or **failed** at a terminal processing or delivery error. A sudden process exit can prevent a terminal event from being recorded.
- Overview totals cover today and the preceding 29 UTC dates, for videos and images combined. Videos delivered counts successful video sends. Success rate is successful jobs divided by all recorded terminal jobs. Average time includes successful and failed terminal jobs and covers work from dequeue through delivery or failure, excluding queue wait and background cleanup.
- Smart Copy and HD Conversion count successful videos by the final video-stream method. Smart Copy can include audio-only conversion. Filters in Jobs select based on final video-stream method or terminal result. Job history holds up to 500 records from the last 30 days.
- Observed users are keyed HMAC pseudonyms for WhatsApp IDs that reached a terminal job. The 30-day rolling user index holds at most the most recently active 1,000 distinct pseudonyms. Today uses UTC, and the weekly user count covers the trailing seven days. Individual job counts use the retained 500-job history, so a retained user can show zero jobs. Key rotation creates new pseudonyms for subsequent jobs.
- The seven-day chart covers today and the previous six UTC dates. Collection begins with the first persisted terminal record. Dashboard job IDs are random, and records contain coarse metadata such as geometry, size, duration, timestamps and allowlisted failure categories.
- HTTP readiness is separate from the current WhatsApp connection. The last WhatsApp connection is local to the current process. The delivery timestamp comes from Redis. Redis status reflects the latest analytics operation against the shared endpoint. Node RSS and Node process CPU differ from container-wide measurements. The latter memory reading includes FFmpeg where Linux cgroup metrics are available.

## Redis cost and outage behavior

Analytics uses a `shelby:dashboard:{...}` namespace derived from the configured origin. WhatsApp credentials and lease keys use their existing separate namespace. The dashboard sends one Redis EVAL request per terminal job and at most one EVAL every 12 seconds per running instance while the owner is polling, or about five requests per minute. The read script performs up to 30 daily aggregate lookups and three summary/history lookups per refresh. Check your Upstash plan for how it meters Lua commands and response bandwidth. There are no Redis reads for idle, signed-out dashboards.

Redis daily hashes and dedup markers have a 31-day expiration. The Lua write is atomic and repeated submissions of the same terminal ID are ignored. A UTC day admits at most 4,096 terminal IDs. The job and user indexes enforce both age and count caps. A small metadata hash records the first and latest delivery timestamps. Changing the public origin creates a separate analytics namespace. Redis outages or saturated telemetry can leave gaps. Writes are best-effort, bounded to eight pending operations and do not delay delivery. A Redis outage leaves live system telemetry available. A cached historical snapshot is served only until its first record reaches the retention cutoff or the UTC reporting date changes. The shared indexes prune old entries on each write. During idle periods, entries may remain physically stored past the dashboard’s 30-day window until the next write or the index’s 31-day idle expiration.

## Security and operation

The token is submitted in a JSON POST body, compared against a fixed-length digest and never placed in the URL. Sign-in is globally throttled to five attempts per minute per process. The throttle ignores client-supplied forwarding headers. Render terminates HTTPS and cookies always require Secure, HttpOnly and SameSite=Strict. Sessions expire after eight hours or a restart, and logout requires the session CSRF token and exact HTTPS origin. Protected responses are `no-store`, with restrictive CSP, clickjacking protection and no third-party assets. The browser renders received text as text nodes.

Render Free may sleep and take time to wake. Keep the dashboard open only when monitoring. Its 12-second foreground polling backs off on errors and pauses when hidden. Treat displayed data as stale when connectivity is lost.

To disable it, remove `SHELBY_ADMIN_ENABLED` or set it to `0` in Render and apply the change when ready. For a code rollback, redeploy the previously approved image or commit. Leave the existing WhatsApp Redis settings in place. Dashboard data ages out under the retention rules, apart from the first/latest timestamps.
