
import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const router = Router();
const MAX_UPLOAD = 100 * 1024 * 1024;
const TEMP_ROOT = path.join(os.tmpdir(), 'statushd-uploads');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, TEMP_ROOT);
    },
    filename: (_req, _file, cb) => {
      cb(null, crypto.randomUUID() + '.video');
    }
  }),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/x-m4v'
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format video tidak disokong.'));
    }
    cb(null, true);
  }
});

await mkdir(TEMP_ROOT, { recursive: true });

function runFFmpeg(input, output, quality) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-threads', '1',
      '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf',
      "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads:v', '1',
      '-crf', quality === 'small' ? '29' : '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      output
    ];

    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let errorText = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 180000);

    child.stderr.on('data', chunk => {
      errorText = (errorText + chunk.toString()).slice(-2000);
    });

    child.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          timedOut
            ? 'Conversion mengambil masa terlalu lama.'
            : 'FFmpeg gagal: ' + errorText.slice(-500)
        ));
      }
    });
  });
}

router.post('/api/convert', (req, res) => {
  upload.single('video')(req, res, async error => {
    if (error) {
      return res.status(400).json({
        error: error.code === 'LIMIT_FILE_SIZE'
          ? 'Video melebihi 100 MB.'
          : error.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Sila pilih video.'
      });
    }

    const input = req.file.path;
    const output = path.join(
      TEMP_ROOT, crypto.randomUUID() + '.mp4'
    );

    const cleanup = async () => {
      await Promise.allSettled([
        rm(input, { force: true }),
        rm(output, { force: true })
      ]);
    };

    try {
      const quality = req.body.quality === 'small'
        ? 'small' : 'hd';

      await runFFmpeg(input, output, quality);

      const result = await stat(output);
      if (!result.size) {
        throw new Error('Video output kosong.');
      }

      res.download(output, 'statushd-converted.mp4',
        async err => {
          if (err) console.error('Download:', err.message);
          await cleanup();
        }
      );
    } catch (err) {
      console.error('Conversion:', err);
      await cleanup();

      if (!res.headersSent) {
        res.status(500).json({
          error: err.message
        });
      }
    }
  });
});

export default router;
