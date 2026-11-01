import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function number(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}; expected a number from ${min} to ${max}`);
  }
  return value;
}

export const config = {
  port: number('PORT', 3000, 1, 65535),
  whatsappToken: process.env.WHATSAPP_TOKEN?.trim() ?? '',
  phoneNumberId: process.env.PHONE_NUMBER_ID?.trim() ?? '',
  graphApiVersion: process.env.GRAPH_API_VERSION?.trim() || 'v23.0',
  appSecret: process.env.APP_SECRET?.trim() ?? '',
  verifyToken: process.env.VERIFY_TOKEN?.trim() ?? '',
  logLevel: process.env.LOG_LEVEL || 'info',
  maxInputBytes: number('MAX_INPUT_BYTES', 16 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  maxOutputBytes: number('MAX_OUTPUT_BYTES', 16 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  maxVideoSeconds: number('MAX_VIDEO_SECONDS', 300, 1, 3600),
  ffmpegTimeoutMs: number('FFMPEG_TIMEOUT_MS', 180000, 1000, 600000),
  videoMaxWidth: number('VIDEO_MAX_WIDTH', 1280, 320, 3840),
  videoCrf: number('VIDEO_CRF', 28, 18, 35),
  videoMaxrate: process.env.VIDEO_MAXRATE || '1800k',
  videoAudioBitrate: process.env.VIDEO_AUDIO_BITRATE || '96k'
};

export function assertConfigured() {
  for (const key of ['whatsappToken', 'phoneNumberId', 'appSecret', 'verifyToken']) {
    if (!config[key]) throw new Error(`Server configuration incomplete: ${key}`);
  }
}
