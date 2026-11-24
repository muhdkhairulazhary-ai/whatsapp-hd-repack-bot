#!/usr/bin/env bash
# Exercise the unmodified image entrypoint without contacting WhatsApp or Redis.
set -euo pipefail
image=${1:?Docker image required}
mode=${2:-fixed}
container=
trap 'if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi' EXIT

check() {
  local enabled=$1 origin=$2 expected=$3 marker=${4:-}
  container=$(docker run -d --network none --memory=512m --memory-swap=512m \
    -e SHELBY_ADMIN_ENABLED="$enabled" -e SHELBY_ADMIN_ORIGIN="$origin" \
    -e SHELBY_ADMIN_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    -e SHELBY_ANALYTICS_KEY=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA \
    -e BAILEYS_AUTH_REDIS_URL=https://redis.example.invalid \
    -e BAILEYS_AUTH_REDIS_TOKEN=test-only \
    -e BAILEYS_AUTH_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE= \
    "$image")
  docker exec "$container" node --input-type=module -e '
    import assert from "node:assert/strict";
    import { setTimeout } from "node:timers/promises";
    const request = async path => fetch("http://127.0.0.1:3000" + path, { signal: AbortSignal.timeout(1000) });
    let health;
    for (let i = 0; i < 30 && !health; i++) {
      try { health = await request("/health"); } catch { await setTimeout(200); }
    }
    assert.equal(health?.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const response = await request("/dashboard");
    const expected = Number(process.argv[1]);
    assert.equal(response.status, expected);
    if (expected === 401) {
      assert.match(await response.text(), /Administrator access token/);
      for (const file of ["app.js", "style.css", "manifest.webmanifest", "icon.svg", "apple-touch-icon.png"]) {
        assert.equal((await request("/dashboard/" + file)).status, 200, file);
      }
      assert.equal((await request("/api/admin/state")).status, 401);
    } else {
      assert.equal((await request("/api/admin/state")).status, 404);
    }
    console.log("GET /dashboard:", expected);
  ' "$expected"
  if [[ -n "$marker" ]]; then
    docker logs "$container" 2>&1 | grep -F "$marker" >/dev/null
  fi
  docker rm -f "$container" >/dev/null
  container=
}

check 1 https://control.example.test 401
if [[ "$mode" = deployed ]]; then
  check 1 https://control.example.test/ 404 'Control Center disabled'
else
  check 1 https://control.example.test/ 401 'Control Center startup'
  check 1 https://control.example.test/dashboard 503 '"variable":"SHELBY_ADMIN_ORIGIN"'
fi
check 0 https://control.example.test 404
