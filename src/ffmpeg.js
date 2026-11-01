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

export async function repackVideo(inputPath, outputPath) {
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
