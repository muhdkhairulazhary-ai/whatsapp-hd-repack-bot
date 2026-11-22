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

export function buildFfmpegArgs(inputPath, outputPath) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=w='min(${config.videoMaxWidth},iw)':h='min(${config.videoMaxWidth},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(config.videoCrf),
    '-maxrate', config.videoMaxrate, '-bufsize', '3600k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', config.videoAudioBitrate, '-ac', '2', '-ar', '44100',
    '-movflags', '+faststart', '-threads', '2', outputPath
  ];
}

function buildStatusArgs(inputPath, outputPath, { duration, video, audio }) {
  const copyVideo = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' &&
    ['Baseline', 'Constrained Baseline', 'Main', 'High'].includes(video.profile);
  const largeFrame = video.width * video.height > 1920 * 1080;
  const copyAudio = audio?.codec_name === 'aac' && audio.profile === 'LC' && [1, 2].includes(audio.channels);
  return {
    videoMode: copyVideo ? 'copy' : 'encode',
    audioMode: copyAudio ? 'copy' : audio ? 'encode' : 'silence',
    args: [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-filter_threads', '1', '-threads', '1', '-protocol_whitelist', 'file', '-f', 'mov', '-i', inputPath,
      ...(!audio ? ['-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=44100:cl=stereo'] : []),
      '-map', '0:V:0', '-map', audio ? '0:a:0' : '1:a:0',
      ...(copyVideo ? ['-c:v', 'copy'] : [
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-fps_mode:v', 'passthrough', '-enc_time_base:v', '-1',
        '-threads:v', largeFrame ? '1' : '2',
        '-x264-params', largeFrame ? 'rc-lookahead=4:sync-lookahead=0' : 'rc-lookahead=10'
      ]),
      ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '44100', '-threads:a', '1']),
      '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', outputPath
    ]
  };
}

export function runTool(command, args, { stage, timeoutMs, captureOutput = false, signal, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new VideoError(stage, 'timeout', 'Media processing was stopped.'));
      return;
    }
    const child = spawn(command, args, { env, stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let memoryFailure = false;
    let diskFull = false;
    let unsupportedCodec = false;
    let timedOut = false;
    let spawnError;
    const stop = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(0, 32768); });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4096);
      memoryFailure ||= /cannot allocate memory|out of memory|failed to allocate|allocation failed/i.test(stderr);
      diskFull ||= /no space left on device/i.test(stderr);
      unsupportedCodec ||= /decoder .*not found|unknown decoder|unsupported codec/i.test(stderr);
    });
    child.once('error', error => { spawnError = error; });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      const details = { exitCode, signal: exitSignal };
      if (timedOut) {
        reject(new VideoError(stage, 'timeout', `${command} timed out.`, details));
      } else if (memoryFailure || spawnError?.code === 'ENOMEM') {
        reject(new VideoError(stage, 'memory_exhausted', `${command} ran out of memory.`, details));
      } else if (diskFull || spawnError?.code === 'ENOSPC') {
        reject(new VideoError(stage, 'disk_full', 'Temporary storage is full.', details));
      } else if (spawnError) {
        reject(new VideoError(stage, 'tool_start_failed', `${command} could not start.`, details));
      } else if (exitSignal) {
        reject(new VideoError(stage, 'tool_terminated', `${command} was terminated.`, details));
      } else if (exitCode !== 0) {
        const reason = stage === 'image' ? 'image_conversion_failed'
          : stage === 'validation' || unsupportedCodec ? 'unsupported_video' : 'encode_failed';
        reject(new VideoError(stage, reason, `${command} failed with exit code ${exitCode}.`, details));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function probeVideo(inputPath, statusVideo, signal) {
  const entries = statusVideo
    ? 'format=duration,bit_rate:format_tags=major_brand:stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,bit_rate,channels:stream_disposition=attached_pic:stream_side_data=rotation'
    : 'format=duration';
  const output = await runTool('ffprobe', [
    '-v', 'error', ...(statusVideo ? ['-protocol_whitelist', 'file', '-f', 'mov'] : []),
    '-show_entries', entries, '-of', 'json', inputPath
  ], { stage: 'validation', timeoutMs: 15_000, captureOutput: true, signal });
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw new VideoError('validation', 'unsupported_video', 'Could not read video metadata.');
  }
  const duration = Number(metadata.format?.duration);
  const streams = metadata.streams || [];
  const brand = metadata.format?.tags?.major_brand || '';
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!Number.isFinite(duration) || duration <= 0 || (statusVideo &&
      (/^(3g|mj2)/i.test(brand) || !video?.width || !video?.height))) {
    throw new VideoError('validation', 'unsupported_video', 'Unsupported or damaged video.');
  }
  return { duration, video, audio, bitRate: Number(metadata.format?.bit_rate) || null };
}

function mediaMetrics({ duration, video, audio, bitRate }, bytes) {
  const fps = [video.avg_frame_rate, video.r_frame_rate].find(rate =>
    typeof rate === 'string' && /^[1-9][0-9]*\/[1-9][0-9]*$/.test(rate)
  ) ?? null;
  const rotation = video.side_data_list?.find(data => Number.isFinite(data.rotation))?.rotation ?? 0;
  const sideways = Math.abs(rotation % 180) === 90;
  return {
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps, bytes, durationSeconds: duration, bitrateBps: bitRate,
    videoBitrateBps: Number(video.bit_rate) || null,
    videoCodec: video.codec_name, audioCodec: audio?.codec_name ?? null
  };
}

export async function repackVideo(inputPath, outputPath, { statusVideo = false, signal } = {}) {
  const input = await probeVideo(inputPath, statusVideo, signal);
  const maxSeconds = statusVideo ? Math.min(config.maxVideoSeconds, 60) : config.maxVideoSeconds;
  if (input.duration > maxSeconds) {
    throw new VideoError('validation', 'duration_limit', `This video is longer than the ${maxSeconds}-second limit.`, {
      durationSeconds: input.duration, limitSeconds: maxSeconds
    });
  }

  const { args, videoMode, audioMode } = statusVideo
    ? buildStatusArgs(inputPath, outputPath, input)
    : { args: buildFfmpegArgs(inputPath, outputPath) };
  await runTool('ffmpeg', args, { stage: 'ffmpeg', timeoutMs: config.ffmpegTimeoutMs, signal });

  const output = await stat(outputPath);
  if (!output.size) throw new VideoError('ffmpeg', 'empty_output', 'FFmpeg produced an empty output file.');
  if (statusVideo) {
    const metadata = await probeVideo(outputPath, true, signal);
    return {
      videoMode, audioMode,
      input: mediaMetrics(input, (await stat(inputPath)).size),
      output: mediaMetrics(metadata, output.size)
    };
  }
  if (output.size > config.maxOutputBytes) {
    throw new VideoError('ffmpeg', 'output_limit', 'Processed video is still too large to send.', {
      outputBytes: output.size, limitBytes: config.maxOutputBytes
    });
  }
  return output.size;
}
