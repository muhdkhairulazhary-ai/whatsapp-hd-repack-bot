import { performance } from 'node:perf_hooks';

const stages = {
  queued: '⏳ Menunggu giliran…',
  downloading: '📥 Memuat turun video…',
  processing: '⚙️ Sedang memproses video',
  copy: '⚙️ Sedang menyediakan video (Smart Copy)…',
  validating: '🔍 Mengesahkan video…',
  sending: '📤 Menghantar video…',
  completed: '✅ Video selesai dihantar',
  failed: '❌ Pemprosesan gagal'
};

export function createEncodingProgress(durationSeconds) {
  const duration = durationSeconds * 1000;
  let previousTime = 0;
  let previousElapsed = 0;
  let speed;
  return ({ outputTimeMs, elapsedMs, speed: reportedSpeed }) => {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(outputTimeMs) || outputTimeMs < 0) return {};
    const media = Math.min(duration, Math.max(previousTime, outputTimeMs));
    const elapsedDelta = elapsedMs - previousElapsed;
    const advance = media - previousTime;
    let etaSeconds;
    if (advance > 0 && elapsedDelta > 0) {
      const observed = advance / elapsedDelta;
      const sample = Number.isFinite(reportedSpeed) && reportedSpeed > 0
        ? (observed + reportedSpeed) / 2 : observed;
      if (previousTime > 0) {
        speed = speed === undefined ? sample : speed * 0.7 + sample * 0.3;
        const remaining = (duration - media) / speed / 1000;
        if (elapsedMs >= 5000 && media >= 500 && remaining > 0 && remaining <= 3600) etaSeconds = remaining;
      }
    }
    previousTime = media;
    previousElapsed = Math.max(previousElapsed, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    return { percent: Math.min(99, Math.floor(media / duration * 100)), etaSeconds };
  };
}

function durationText(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  return rounded >= 60 ? `${Math.floor(rounded / 60)}m ${rounded % 60}s` : `${rounded}s`;
}

function render(title, state, elapsed, retried) {
  const lines = [`🎬 ${title}`, '', stages[state.stage]];
  if (state.stage === 'queued') lines.splice(1, 0, '📁 Video diterima');
  if (state.stage === 'processing' && retried) lines.push('Percubaan semula');
  if (state.percent !== undefined) {
    const bar = Math.floor(state.percent / 10);
    lines.push(`${'█'.repeat(bar)}${'░'.repeat(10 - bar)} ${state.percent}%`);
  }
  if (state.stage === 'processing' || state.stage === 'downloading') {
    lines.push('', `⏱️ Masa berlalu: ${durationText(elapsed / 1000)}`);
  }
  if (state.stage === 'processing') {
    lines.push(state.etaSeconds === undefined ? '⏳ Mengira anggaran masa...' :
      `⏳ Anggaran baki pengekodan: ~${durationText(state.etaSeconds)}`);
  }
  if (state.stage === 'completed') lines.push('100%');
  if (state.detail) lines.push(state.detail);
  return lines.join('\n');
}

export function createVideoProgress({
  send, title, initialStage, onClose, onFailedEdit, now = () => performance.now(),
  schedule = setTimeout, cancel = clearTimeout, intervalMs = 12_000
}) {
  const started = now();
  let updatedAt = started;
  let current = { stage: initialStage };
  let lastSent = current;
  let timer;
  let key;
  let inFlight = true;
  let terminal = false;
  let paused = false;
  let disabled = false;
  let closed = false;
  let retried = false;
  let attempt;
  let estimate;

  function close() {
    if (closed) return;
    closed = true;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    onClose();
  }

  function flush() {
    if (closed || inFlight || (paused && !terminal)) return;
    if (disabled || !key) {
      if (terminal) {
        if (current.stage === 'failed') onFailedEdit(current.detail);
        close();
      }
      return;
    }
    const meaningful = current.stage !== lastSent.stage || current.attempt !== lastSent.attempt ||
      (current.percent !== undefined && (lastSent.percent === undefined || Math.abs(lastSent.percent - current.percent) >= 5)) ||
      (current.etaSeconds === undefined) !== (lastSent.etaSeconds === undefined);
    if (!meaningful) return;
    const wait = intervalMs - (now() - updatedAt);
    if (wait > 0) {
      if (timer === undefined) timer = schedule(() => { timer = undefined; flush(); }, wait);
      return;
    }
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    inFlight = true;
    lastSent = current;
    updatedAt = now();
    const finalEdit = terminal;
    const text = render(title, lastSent, now() - started, retried);
    Promise.resolve().then(() => {
      if (!closed && (!paused || finalEdit)) return send({ text, edit: key });
    }).catch(() => {
      disabled = true;
      if (!closed && finalEdit && current.stage === 'failed') onFailedEdit(current.detail);
    }).finally(() => {
      inFlight = false;
      if (finalEdit) close();
      else flush();
    });
  }

  Promise.resolve().then(() => {
    if (!closed) return send({ text: render(title, lastSent, 0, false) });
  }).then(message => {
    key = message?.key?.fromMe === true && message.key.id ? message.key : undefined;
  }).catch(() => { disabled = true; }).finally(() => {
    inFlight = false;
    flush();
  });

  return {
    update(stage, percent) {
      if (closed || terminal || paused) return;
      current = { stage, percent };
      flush();
    },
    startAttempt({ videoMode, durationSeconds, attempt: number }) {
      if (closed || terminal || paused) return;
      attempt = number;
      retried = number > 1;
      estimate = videoMode === 'encode' ? createEncodingProgress(durationSeconds) : undefined;
      current = { stage: estimate ? 'processing' : 'copy', attempt };
      flush();
    },
    sample(fields) {
      if (closed || terminal || paused || current.stage !== 'processing' || !estimate) return;
      current = { stage: 'processing', attempt, ...estimate(fields) };
      flush();
    },
    pause() {
      paused = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
    finish(stage, detail) {
      if (closed || terminal) return;
      terminal = true;
      current = { stage, detail };
      flush();
    },
    close
  };
}
