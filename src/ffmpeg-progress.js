function timestampUs(value) {
  const match = /^(\d{1,6}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return undefined;
  const [, hours, minutes, seconds, fraction = ''] = match;
  return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1e6 +
    Number(fraction.padEnd(6, '0'));
}

export function createFfmpegProgressReader() {
  let pending = '';
  let dropping = false;
  const values = {};
  const number = value => {
    const parsed = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    feed(chunk) {
      for (const c of chunk.toString()) {
        if (c !== '\n') {
          if (pending.length >= 256) dropping = true;
          if (!dropping) pending += c;
          continue;
        }
        if (!dropping) {
          const [key, raw] = pending.split('=', 2);
          const value = raw?.trim() ?? '';
          if (['frame', 'out_time_us', 'out_time_ms', 'total_size'].includes(key)) values[key] = number(value);
          else if (key === 'out_time') values[key] = timestampUs(value);
          else if (key === 'speed') values.speed = value.endsWith('x') ? number(value.slice(0, -1)) : undefined;
          else if (key === 'progress' && (value === 'continue' || value === 'end')) values.progress = value;
        }
        pending = '';
        dropping = false;
      }
    },
    snapshot() {
      // FFmpeg 5.1 and 7.1 report microseconds in both named fields.
      const us = values.out_time_us ?? values.out_time_ms ?? values.out_time;
      return {
        frames: values.frame, outputTimeMs: us === undefined ? undefined : us / 1000,
        outputBytes: values.total_size, speed: values.speed, progress: values.progress
      };
    }
  };
}
