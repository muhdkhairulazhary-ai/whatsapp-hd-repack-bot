import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { config } from './config.js';
import { HIGH_RES_TRANSCODE_HEADROOM, mediaMemoryLimit, memorySnapshot, timeStage } from './runtime-diagnostics.js';

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

const H264_PROFILES = new Set(['Baseline', 'Constrained Baseline', 'Main', 'High']);

function rotation(video) {
  return video.side_data_list?.find(data => Number.isFinite(data.rotation))?.rotation ?? 0;
}

function standardRotation(video) {
  const matrix = video.side_data_list?.find(data => data.displaymatrix)?.displaymatrix;
  if (!matrix) return rotation(video) === 0;
  const values = matrix.trim().split('\n').flatMap(line => line.split(':')[1]?.trim().split(/\s+/).map(Number) ?? []);
  const [a, b, x, c, d, y, u, v, w] = values;
  return values.length === 9 && x === 0 && y === 0 && u === 0 && v === 0 && w === 1073741824 &&
    ((b === 0 && c === 0 && a === d && Math.abs(a) === 65536) ||
     (a === 0 && d === 0 && b === -c && Math.abs(b) === 65536));
}

function compatibleVideo(video) {
  return video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && H264_PROFILES.has(video.profile) &&
    video.width % 2 === 0 && video.height % 2 === 0 && standardRotation(video) &&
    (!video.field_order || ['progressive', 'unknown'].includes(video.field_order));
}

function compatibleAudio(audio) {
  return audio?.codec_name === 'aac' && audio.profile === 'LC' && [1, 2].includes(audio.channels);
}

function buildStatusArgs(inputPath, outputPath, { duration, video, audio }, fallback = false) {
  const copyVideo = !fallback && compatibleVideo(video);
  const copyAudio = !fallback && compatibleAudio(audio);
  const hevc = video.codec_name === 'hevc';
  const keepMatrix = !fallback && standardRotation(video);
  const oddSize = video.width % 2 || video.height % 2;
  return {
    videoMode: copyVideo ? 'copy' : 'encode',
    audioMode: copyAudio ? 'copy' : audio ? 'encode' : 'silence',
    args: [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-filter_threads', '1', '-threads', '1', '-protocol_whitelist', 'file', '-f', 'mov',
      ...(keepMatrix ? ['-noautorotate'] : []), '-i', inputPath,
      ...(!audio ? ['-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=44100:cl=stereo'] : []),
      '-map', '0:V:0', '-map', audio ? '0:a:0' : '1:a:0',
      ...(copyVideo ? ['-c:v', 'copy'] : [
        '-c:v', 'libx264', '-preset', hevc ? 'ultrafast' : 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        ...(oddSize ? ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'] : []),
        '-fps_mode:v', 'passthrough', '-enc_time_base:v', '-1',
        '-threads:v', '1', '-x264-params', hevc ? 'rc-lookahead=0:sync-lookahead=0' : 'rc-lookahead=8:sync-lookahead=0'
      ]),
      ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '44100', '-threads:a', '1']),
      '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', outputPath
    ]
  };
}

function ffmpegProgress(stream, onProgress, intervalMs) {
  const started = Date.now();
  let pending = '';
  const values = {};
  stream.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop().slice(-256);
    for (const line of lines) {
      const match = /^(frame|out_time_us|total_size|speed)=(\d+(?:\.\d+)?)(?:x)?\s*$/.exec(line);
      if (match) values[match[1]] = Number(match[2]);
    }
  });
  return setInterval(() => onProgress({
    stage: 'ffmpeg', elapsedMs: Date.now() - started,
    frames: values.frame, outputTimeMs: values.out_time_us === undefined ? undefined : values.out_time_us / 1000,
    outputBytes: values.total_size, speed: values.speed
  }), intervalMs);
}

function abortSource(signal) {
  return signal.reason === 'shutdown' || signal.reason === 'job_deadline' ? signal.reason : 'cancelled';
}

export function runTool(command, args, { stage, timeoutMs, captureOutput = false, signal, env = process.env, onProgress, progressIntervalMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const stopSource = abortSource(signal);
      reject(new VideoError(stage, stopSource === 'job_deadline' ? 'timeout' : stopSource,
        'Media processing was stopped.', { stopSource }));
      return;
    }
    const oomBefore = stage === 'ffmpeg' ? memorySnapshot().oomKills : undefined;
    const child = spawn(command, args, {
      env, stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe', onProgress ? 'pipe' : 'ignore']
    });
    const progress = onProgress && ffmpegProgress(child.stdio[3], onProgress, progressIntervalMs);
    let stdout = '';
    let stderr = '';
    let memoryFailure = false;
    let diskFull = false;
    let unsupportedCodec = false;
    let stopSource;
    let spawnError;
    const stop = source => {
      if (stopSource) return;
      stopSource = source;
      child.kill('SIGKILL');
    };
    const abort = () => stop(abortSource(signal));
    const timer = setTimeout(() => stop(stage === 'ffmpeg' ? 'ffmpeg_deadline' : 'tool_deadline'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });

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
      clearInterval(progress);
      signal?.removeEventListener('abort', abort);
      const details = { exitCode, signal: exitSignal };
      if (stopSource) {
        reject(new VideoError(stage, ['shutdown', 'cancelled'].includes(stopSource) ? stopSource : 'timeout',
          `${command} was stopped.`, { ...details, stopSource }));
      } else if (memoryFailure || spawnError?.code === 'ENOMEM') {
        reject(new VideoError(stage, 'memory_exhausted', `${command} ran out of memory.`, details));
      } else if (diskFull || spawnError?.code === 'ENOSPC') {
        reject(new VideoError(stage, 'disk_full', 'Temporary storage is full.', details));
      } else if (spawnError) {
        reject(new VideoError(stage, 'tool_start_failed', `${command} could not start.`, details));
      } else if (exitSignal) {
        const oomKillObserved = exitSignal === 'SIGKILL' && oomBefore !== undefined && memorySnapshot().oomKills > oomBefore;
        const reason = ['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE'].includes(exitSignal) ? 'tool_crashed' : 'tool_terminated';
        reject(new VideoError(stage, reason, `${command} was terminated.`, { ...details, oomKillObserved }));
      } else if (exitCode !== 0) {
        const reason = stage === 'image' ? 'image_conversion_failed'
          : stage === 'verification' ? 'output_invalid'
          : stage === 'validation' || unsupportedCodec ? 'unsupported_video' : 'encode_failed';
        reject(new VideoError(stage, reason, `${command} failed with exit code ${exitCode}.`, details));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function probeVideo(inputPath, statusVideo, signal, stage = 'validation') {
  const entries = statusVideo
    ? 'format=duration,bit_rate:format_tags=major_brand:stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,bit_rate,channels,start_time,duration,field_order,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation,displaymatrix'
    : 'format=duration';
  const output = await runTool('ffprobe', [
    '-v', 'error', ...(statusVideo ? ['-threads', '1', '-protocol_whitelist', 'file', '-f', 'mov'] : []),
    '-show_entries', entries, '-of', 'json', inputPath
  ], { stage, timeoutMs: 15_000, captureOutput: true, signal });
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw new VideoError(stage, stage === 'verification' ? 'output_invalid' : 'unsupported_video', 'Could not read video metadata.');
  }
  const duration = Number(metadata.format?.duration);
  const streams = metadata.streams || [];
  const brand = metadata.format?.tags?.major_brand || '';
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!Number.isFinite(duration) || duration <= 0 || (statusVideo &&
      (/^(3g|mj2)/i.test(brand) || !video?.width || !video?.height))) {
    throw new VideoError(stage, stage === 'verification' ? 'output_invalid' : 'unsupported_video', 'Unsupported or damaged video.');
  }
  return { duration, video, audio, brand, bitRate: Number(metadata.format?.bit_rate) || null };
}

function mediaMetrics({ duration, video, audio, bitRate }, bytes) {
  const fps = [video.avg_frame_rate, video.r_frame_rate].find(rate =>
    typeof rate === 'string' && /^[1-9][0-9]*\/[1-9][0-9]*$/.test(rate)
  ) ?? null;
  const sideways = Math.abs(rotation(video) % 180) === 90;
  return {
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps, bytes, durationSeconds: duration, bitrateBps: bitRate,
    videoBitrateBps: Number(video.bit_rate) || null,
    videoCodec: video.codec_name, audioCodec: audio?.codec_name ?? null
  };
}

function verifyStatusVideo(input, output, preserveMatrix) {
  const actual = mediaMetrics(output, 0);
  const expected = mediaMetrics(input, 0);
  const startOffset = source => Number(source.audio?.start_time) - Number(source.video.start_time);
  const relativeOffset = Math.abs(startOffset(input) - startOffset(output));
  const videoDuration = source => Number(source.video.duration);
  const durationError = Math.abs(videoDuration(input) - videoDuration(output));
  const audioDurationError = Math.abs(Number(input.audio?.duration) - Number(output.audio?.duration));
  const fps = value => {
    const [top, bottom] = value?.split('/').map(Number) ?? [];
    return top / bottom;
  };
  const inputFps = fps(expected.fps);
  const outputFps = fps(actual.fps);
  const tolerance = Math.max(0.1, 1 / (inputFps || 25));
  const aspect = ({ video }) => video.sample_aspect_ratio === 'N/A' || !video.sample_aspect_ratio ? '1:1' : video.sample_aspect_ratio;
  const sideways = Math.abs((rotation(input.video) - rotation(output.video)) % 180) === 90;
  const expectedSar = sideways ? aspect(input).split(':').reverse().join(':') : aspect(input);
  const normalizeRotation = angle => (angle % 360 + 360) % 360;
  const outputRotation = normalizeRotation(rotation(output.video));
  if (!/^(isom|mp4)/.test(output.brand) || !compatibleVideo(output.video) || !compatibleAudio(output.audio) ||
      actual.width !== expected.width + expected.width % 2 || actual.height !== expected.height + expected.height % 2 ||
      outputRotation !== (preserveMatrix ? normalizeRotation(rotation(input.video)) : 0) ||
      aspect(output) !== expectedSar ||
      (Number.isFinite(relativeOffset) && relativeOffset > tolerance) ||
      (Number.isFinite(durationError) && durationError > tolerance) ||
      (Number.isFinite(audioDurationError) && audioDurationError > tolerance) ||
      (Number.isFinite(inputFps) && Number.isFinite(outputFps) && Math.abs(inputFps - outputFps) > inputFps * 0.02)) {
    throw new VideoError('verification', 'output_invalid', 'MP4 output failed compatibility checks.');
  }
}

export async function repackVideo(inputPath, outputPath, {
  statusVideo = false, signal, onProgress, onStage, inputBytes, readMemory = memorySnapshot
} = {}) {
  const input = await timeStage('ffprobe', onStage, () => probeVideo(inputPath, statusVideo, signal));
  const maxSeconds = statusVideo ? Math.min(config.maxVideoSeconds, 60) : config.maxVideoSeconds;
  if (input.duration > maxSeconds) {
    throw new VideoError('validation', 'duration_limit', `This video is longer than the ${maxSeconds}-second limit.`, {
      durationSeconds: input.duration, limitSeconds: maxSeconds
    });
  }

  async function convert(args) {
    const ffmpegArgs = onProgress ? ['-progress', 'pipe:3', '-stats_period', '15', '-nostats', ...args] : args;
    await timeStage('ffmpeg', onStage, () =>
      runTool('ffmpeg', ffmpegArgs, { stage: 'ffmpeg', timeoutMs: config.ffmpegTimeoutMs, signal, onProgress }));
  }

  if (statusVideo) {
    async function produce(fallback) {
      const { args, videoMode, audioMode } = buildStatusArgs(inputPath, outputPath, input, fallback);
      // The single-threaded UHD HEVC benchmark alone reached 583 MiB.
      // Check immediately before encoding, including after a failed remux.
      if (videoMode === 'encode' && input.video.width * input.video.height > 1920 * 1080) {
        const memory = readMemory();
        const limit = mediaMemoryLimit(memory);
        const used = Math.max(memory.cgroupBytes ?? 0, memory.rssBytes ?? 0);
        const available = Math.max(0, limit - used);
        if (available < HIGH_RES_TRANSCODE_HEADROOM) {
          throw new VideoError('validation', 'video_memory_budget', 'High-resolution transcode exceeds safe memory budget.', {
            width: input.video.width, height: input.video.height, memoryLimitBytes: limit,
            availableBytes: available, requiredBytes: HIGH_RES_TRANSCODE_HEADROOM
          });
        }
      }
      await convert(args);
      return timeStage('verification', onStage, async () => {
        const output = await stat(outputPath);
        if (!output.size) throw new VideoError('verification', 'output_invalid', 'Empty output.');
        const metadata = await probeVideo(outputPath, true, signal, 'verification');
        verifyStatusVideo(input, metadata, !fallback && standardRotation(input.video));
        return {
          videoMode, audioMode,
          input: mediaMetrics(input, inputBytes ?? (await stat(inputPath)).size),
          output: mediaMetrics(metadata, output.size)
        };
      });
    }
    try {
      return await produce(false);
    } catch (error) {
      // Retry only when a copied track or preserved rotation could be at fault.
      const videoCopy = compatibleVideo(input.video);
      const canRepair = error.reason === 'encode_failed' ? videoCopy :
        error.reason === 'output_invalid' && (videoCopy || compatibleAudio(input.audio) || rotation(input.video));
      if (signal?.aborted || !canRepair) throw error;
      return produce(true);
    }
  }
  await convert(buildFfmpegArgs(inputPath, outputPath));
  const output = await stat(outputPath);
  if (!output.size) throw new VideoError('ffmpeg', 'empty_output', 'FFmpeg produced an empty output file.');
  if (output.size > config.maxOutputBytes) {
    throw new VideoError('ffmpeg', 'output_limit', 'Processed video is still too large to send.', {
      outputBytes: output.size, limitBytes: config.maxOutputBytes
    });
  }
  return output.size;
}
