import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { runTool, VideoError } from './ffmpeg.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const MAX_PIXELS = 50_000_000;

export async function detectImageFormat(input) {
  const file = await open(input, 'r');
  try {
    const bytes = Buffer.alloc(512);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'PNG';
    if (bytesRead >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'JPEG';
    if (bytesRead >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
      const end = Math.min(bytes.readUInt32BE(0), bytesRead);
      const brands = [bytes.toString('ascii', 8, 12)];
      for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
      if (!brands.some(brand => ['avif', 'avis'].includes(brand)) && brands.some(brand => HEIF_BRANDS.has(brand))) return 'HEIC';
    }
    return null;
  } finally {
    await file.close();
  }
}

const limits = [
  '-limit', 'thread', '1', '-limit', 'memory', '48MiB', '-limit', 'map', '64MiB',
  '-limit', 'disk', '512MiB', '-limit', 'width', '12000', '-limit', 'height', '12000'
];

export async function processImage(input, directory, format, signal) {
  if (!format) throw new VideoError('image', 'unsupported_image', 'Unsupported image format.');
  const args = { stage: 'image', timeoutMs: 60_000, signal,
    env: { ...process.env, MAGICK_TEMPORARY_PATH: directory, OMP_NUM_THREADS: '1' } };
  const source = `${format}:${input}[0]`;

  async function dimensions(file) {
    const value = await runTool('identify', [...limits, '-ping', '-format', '%w %h', file], {
      ...args, timeoutMs: 15_000, captureOutput: true
    });
    const [width, height] = value.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new VideoError('image', 'unsupported_image', 'Invalid image dimensions.');
    }
    return { width, height };
  }

  const size = await dimensions(source);
  if (size.width * size.height > MAX_PIXELS) {
    throw new VideoError('image', 'image_pixel_limit', 'Image exceeds the pixel limit.');
  }
  const png = format === 'PNG';
  const output = path.join(directory, png ? 'output.png' : 'output.jpg');
  await runTool('convert', [
    ...limits, '-regard-warnings', source, '-auto-orient', '-strip',
    ...(png ? [] : ['-sampling-factor', '4:4:4', '-quality', '96']), output
  ], args);

  return {
    path: output, mimetype: png ? 'image/png' : 'image/jpeg',
    metrics: {
      input: { ...size, bytes: (await stat(input)).size },
      output: { ...await dimensions(output), bytes: (await stat(output)).size }
    }
  };
}
