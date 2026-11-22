import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

function readCgroup(file) {
  try {
    return readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function memorySnapshot() {
  const events = readCgroup('memory.events');
  const number = value => /^\d+$/.test(value ?? '') ? Number(value) : undefined;
  return {
    rssBytes: process.memoryUsage.rss(),
    cgroupBytes: number(readCgroup('memory.current')),
    cgroupLimitBytes: number(readCgroup('memory.max')),
    oomEvents: number(/^oom (\d+)$/m.exec(events ?? '')?.[1]),
    oomKills: number(/^oom_kill (\d+)$/m.exec(events ?? '')?.[1])
  };
}

export async function timeStage(stage, report, operation) {
  const started = performance.now();
  let outcome = 'failed';
  try {
    const result = await operation();
    outcome = 'ok';
    return result;
  } finally {
    report?.({ stage, outcome, elapsedMs: Math.round(performance.now() - started) });
  }
}

export function createShutdown({ server, media, connection, log, snapshot = memorySnapshot }) {
  let stopping;
  return signal => {
    if (stopping) return stopping;
    const started = performance.now();
    const before = snapshot();
    log.info({ signal, ...media.snapshot(), memory: before }, 'Service shutdown started');
    server.close();
    stopping = Promise.allSettled([media.stop(), connection.stop()]).then(results => {
      const after = snapshot();
      log.info({
        signal, elapsedMs: Math.round(performance.now() - started),
        cleanupFailed: results.some(result => result.status === 'rejected'),
        memory: after, oomKillCounterChanged: before.oomKills !== undefined && after.oomKills > before.oomKills
      }, 'Service shutdown finished');
    });
    return stopping;
  };
}
