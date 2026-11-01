import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { config } from './config.js';

export function buildFfmpegArgs(inputPath, outputPath) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=w='min(${config.videoMaxWidth},iw)':h='min(${config.videoMaxWidth},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', String(config.videoCrf),
    '-maxrate', config.videoMaxrate, '-bufsize', '3600k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', config.videoAudioBitrate, '-ac', '2', '-ar', '44100',
    '-movflags', '+faststart',
    '-threads', '2',
    outputPath
  ];
}

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', inputPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Video inspection timed out. Try a shorter video.'));
    }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.once('error', error => { clearTimeout(timer); reject(new Error(`FFprobe could not start: ${error.message}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      const duration = Number(stdout.trim());
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`Could not read video duration: ${stderr.slice(-500)}`));
      } else resolve(duration);
    });
  });
}

export async function repackVideo(inputPath, outputPath) {
  const duration = await probeDuration(inputPath);
  if (duration > config.maxVideoSeconds) {
    throw new Error(`This video is longer than the ${config.maxVideoSeconds}-second limit. Please send a shorter clip.`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', buildFfmpegArgs(inputPath, outputPath), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Video processing timed out. Try a shorter video.'));
    }, config.ffmpegTimeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    }

    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', error => finish(new Error(`FFmpeg could not start: ${error.message}`)));
    child.once('close', code => {
      if (code === 0) finish();
      else finish(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-1200)}`));
    });
  });

  const output = await stat(outputPath);
  if (!output.size) throw new Error('FFmpeg produced an empty output file.');
  if (output.size > config.maxOutputBytes) throw new Error('Processed video is still too large to send. Try a shorter or smaller source video.');
  return output.size;
}
