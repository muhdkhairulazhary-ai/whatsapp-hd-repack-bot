// CI-only. Playwright and its browser engines are installed outside this repository.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium, webkit } = await import(pathToFileURL(resolve(process.argv[2])));
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const dir = new URL('../public/dashboard/', import.meta.url);
const now = Date.UTC(2026, 10, 24, 11);
const job = (id, extra) => ({ id, kind: 'video', method: 'encode', inputBytes: 39600000, outputBytes: 27891000,
  width: 1920, height: 1080, fps: 60, durationMs: 133000, finishedAt: now - 90000, result: 'success', ...extra });
const rows = [job('31c2d929', {}), job('d77d6a2a', { method: 'copy', durationMs: 4100, fps: 30 }),
  job('a2945e07', { result: 'failed', error: 'video_memory_budget', width: 3840, height: 2160, outputBytes: null })];
const pageOf = items => ({ items, page: 1, pageSize: 20, total: items.length });
const days = [16, 26, 21, 18, 29, 31, 12].map((total, i) => ({
  total, success: total - i % 3, failed: i % 3, date: new Date(now - (6 - i) * 86400000).toISOString().slice(0, 10)
}));
const fixture = {
  csrf: 'fixture', updatedAt: now, collectedAt: now, redis: 'available', dropped: 0,
  queue: { activeJobs: 1, queuedJobs: 1 },
  system: { whatsapp: 'connected', redis: 'available', uptimeSeconds: 28391, rssBytes: 89000000,
    containerBytes: 172000000, containerLimitBytes: 536870912, cpuPercent: 2.2, version: 'c308b11',
    lastWhatsAppAt: now - 28391000, lastDeliveryAt: now - 90000 },
  overview: { startedAt: now - 863999000, videos: 132, total: 153, failed: 11, success: 142, copy: 92, encode: 40,
    uniqueUsers: 24, activeToday: 7, activeWeek: 19, averageMs: 105155, days },
  active: [job('942ea736', { stage: 'processing', percent: 68, etaSeconds: 74, durationMs: 143000, attempt: 2 }),
    job('4f7ca780', { stage: 'queued', width: null, height: null, fps: null, durationMs: 7000, method: 'unknown' })],
  history: pageOf(rows),
  users: pageOf([{ id: '25b1f24234a0', jobs: 9, lastActive: now - 145000 },
    { id: '45bc5327d0fc', jobs: 4, lastActive: now - 330000 }])
};
let empty = false;
let slow = false;
const types = { 'app.js': 'text/javascript', 'style.css': 'text/css', 'icon.svg': 'image/svg+xml',
  'apple-touch-icon.png': 'image/png', 'manifest.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/api/admin/state') {
    if (slow) await new Promise(done => setTimeout(done, 400));
    const filter = url.searchParams.get('filter');
    const data = empty ? { ...fixture, active: [], overview: { startedAt: null }, history: pageOf([]), users: pageOf([]) } :
      { ...fixture, history: pageOf(filter === 'failed' ? rows.filter(row => row.result === filter) : rows) };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  } else if (url.pathname === '/api/admin/login') {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{}');
  } else if (url.pathname === '/login' || url.pathname === '/dashboard') {
    const file = url.pathname === '/login' ? 'login.html' : 'index.html';
    const html = await readFile(new URL(file, dir), 'utf8');
    const marker = '<p class="notice">Fixture data · preview only</p>';
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(html.replace(file === 'index.html' ? '<div class="hero">' : '<form id="login"',
      file === 'index.html' ? marker + '<div class="hero">' : marker + '<form id="login"'));
  } else {
    const name = url.pathname.split('/').at(-1);
    if (!Object.hasOwn(types, name)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': types[name] }).end(await readFile(new URL(name, dir)));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const withinViewport = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base + '/login');
      await withinViewport();
      await page.screenshot({ path: join(output, `${engine.name()}-login.png`), fullPage: true });
      await page.getByLabel('Administrator access token').fill('invalid-test-token');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByText('Sign-in failed.', { exact: false }).waitFor();
      for (const [width, height] of [[390, 844], [402, 874], [768, 1024], [1365, 900], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await page.goto(base + '/dashboard');
        await page.getByText('Processing activity · 7 UTC days').waitFor();
        await withinViewport();
        if (width === 390 || width === 1365) await page.screenshot({
          path: join(output, `${engine.name()}-overview-${width}.png`), fullPage: true });
        for (const [nav, content] of [['Jobs', 'Recent jobs'], ['Users', 'Observed users'], ['System', 'Container memory']]) {
          await page.getByRole('button', { name: nav, exact: true }).click();
          await page.getByText(content, { exact: true }).waitFor();
          await withinViewport();
          if (width === 390) await page.screenshot({ path: join(output, `${engine.name()}-${nav.toLowerCase()}.png`), fullPage: true });
        }
      }
      await page.getByRole('button', { name: 'Jobs', exact: true }).click();
      await page.getByLabel('Filter job history').selectOption('failed');
      await page.getByText('#31c2d929', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText('video memory budget').count(), 1);
      await context.setOffline(true);
      await page.getByText('Offline. Showing data', { exact: false }).waitFor();
      await context.setOffline(false);
      await page.getByText('Offline. Showing data', { exact: false }).waitFor({ state: 'hidden' });

      empty = true;
      slow = true;
      await page.goto(base + '/dashboard');
      await page.getByText('No jobs recorded yet.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Users', exact: true }).click();
      await page.getByRole('button', { name: 'Jobs', exact: true }).click();
      await page.getByText('No active or queued jobs.').waitFor();
      await page.getByText('No jobs match this view.').waitFor();
      empty = false;
      slow = false;
      console.log(`${engine.name()} fixture UX passed`);
    } finally { await browser.close(); }
  }
} finally {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
