import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { config } from './config.js';

export class VideoError extends Error {
  constructor(stage, reason, message, details = {}) {
    super(message);
    this.stage = stage;
    this.reason = reason;
    this.details = details;
  }
}

export function buildFfmpegArgs(inputPath, outputPath, { statusVideo = false, hasAudio = true } = {}) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...(statusVideo ? ['-filter_threads', '1', '-threads', '1', '-protocol_whitelist', 'file', '-f', 'mov'] : []),
    '-i', inputPath,
    ...(statusVideo && !hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'] : []),
    '-map', statusVideo ? '0:V:0' : '0:v:0', '-map', statusVideo && !hasAudio ? '1:a:0' : '0:a:0?',
    '-vf', `scale=w='min(${config.videoMaxWidth},iw)':h='min(${config.videoMaxWidth},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', String(config.videoCrf),
    '-maxrate', config.videoMaxrate, '-bufsize', '3600k',
    '-pix_fmt', 'yuv420p',
    ...(statusVideo ? ['-fpsmax', '30', '-x264-params', 'rc-lookahead=10', '-map_metadata', '-1'] : []),
    '-c:a', 'aac', '-b:a', config.videoAudioBitrate, '-ac', '2', '-ar', '44100',
    ...(statusVideo && !hasAudio ? ['-shortest'] : []),
    '-movflags', '+faststart',
    ...(statusVideo ? ['-threads:v', '2', '-threads:a', '1'] : ['-threads', '2']),
    outputPath
  ];
}

function runTool(command, args, { stage, timeoutMs, captureOutput = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let memoryFailure = false;
    let diskFull = false;
    let unsupportedCodec = false;
    let timedOut = false;
    let spawnError;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(0, 32768); });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4096);
      memoryFailure ||= /cannot allocate memory|out of memory|failed to allocate|allocation failed/i.test(stderr);
      diskFull ||= /no space left on device/i.test(stderr);
      unsupportedCodec ||= /decoder .*not found|unknown decoder|unsupported codec/i.test(stderr);
    });
    child.once('error', error => { spawnError = error; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const details = { exitCode, signal };
      if (timedOut) {
        reject(new VideoError(stage, 'timeout', `${command} timed out.`, details));
      } else if (memoryFailure || spawnError?.code === 'ENOMEM') {
        reject(new VideoError(stage, 'memory_exhausted', `${command} ran out of memory.`, details));
      } else if (diskFull || spawnError?.code === 'ENOSPC') {
        reject(new VideoError(stage, 'disk_full', 'Temporary storage is full.', details));
      } else if (spawnError) {
        reject(new VideoError(stage, 'tool_start_failed', `${command} could not start.`, details));
      } else if (signal) {
        reject(new VideoError(stage, 'tool_terminated', `${command} was terminated.`, details));
      } else if (exitCode !== 0) {
        const reason = stage === 'validation' || unsupportedCodec ? 'unsupported_video' : 'encode_failed';
        reject(new VideoError(stage, reason, `${command} failed with exit code ${exitCode}.`, details));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function probeVideo(inputPath, statusVideo) {
  const entries = statusVideo
    ? 'format=duration:format_tags=major_brand:stream=codec_type:stream_disposition=attached_pic'
    : 'format=duration';
  const output = await runTool('ffprobe', [
    '-v', 'error', ...(statusVideo ? ['-protocol_whitelist', 'file', '-f', 'mov'] : []),
    '-show_entries', entries, '-of', 'json', inputPath
  ], { stage: 'validation', timeoutMs: 15_000, captureOutput: true });
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw new VideoError('validation', 'unsupported_video', 'Could not read video metadata.');
  }
  const duration = Number(metadata.format?.duration);
  const streams = metadata.streams || [];
  const brand = metadata.format?.tags?.major_brand || '';
  if (!Number.isFinite(duration) || duration <= 0 || (statusVideo &&
      (/^(3g|mj2)/i.test(brand) || !streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)))) {
    throw new VideoError('validation', 'unsupported_video', 'Unsupported or damaged video.');
  }
  return { duration, hasAudio: streams.some(stream => stream.codec_type === 'audio') };
}

export async function repackVideo(inputPath, outputPath, { statusVideo = false } = {}) {
  const { duration, hasAudio } = await probeVideo(inputPath, statusVideo);
  const maxSeconds = statusVideo ? Math.min(config.maxVideoSeconds, 60) : config.maxVideoSeconds;
  if (duration > maxSeconds) {
    throw new VideoError('validation', 'duration_limit', `This video is longer than the ${maxSeconds}-second limit.`, {
      durationSeconds: duration, limitSeconds: maxSeconds
    });
  }

  await runTool('ffmpeg', buildFfmpegArgs(inputPath, outputPath, { statusVideo, hasAudio }), {
    stage: 'ffmpeg', timeoutMs: config.ffmpegTimeoutMs
  });

  const output = await stat(outputPath);
  if (!output.size) throw new VideoError('ffmpeg', 'empty_output', 'FFmpeg produced an empty output file.');
  if (output.size > config.maxOutputBytes) {
    throw new VideoError('ffmpeg', 'output_limit', 'Processed video is still too large to send.', {
      outputBytes: output.size, limitBytes: config.maxOutputBytes
    });
  }
  return output.size;
}
