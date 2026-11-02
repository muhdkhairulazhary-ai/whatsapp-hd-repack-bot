
import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const router = Router();
const MAX_UPLOAD = 100 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!['video/mp4', 'video/quicktime',
           'video/webm', 'video/x-m4v'].includes(file.mimetype)) {
      return cb(new Error('Format video tidak disokong.'));
    }
    cb(null, true);
  }
});

function runFFmpeg(input, output, quality) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=1080:-2:force_original_aspect_ratio=decrease',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', quality === 'small' ? '29' : '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-threads', '2',
      output
    ];

    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let errorText = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 180000);

    child.stderr.on('data', chunk => {
      errorText = (errorText + chunk.toString()).slice(-1000);
    });

    child.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(
        'FFmpeg gagal: ' + errorText.slice(-300)
      ));
    });
  });
}

router.post('/api/convert', upload.single('video'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'Sila pilih video.'
      });
    }

    const quality = req.body.quality === 'small'
      ? 'small' : 'hd';

    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'statushd-')
    );

    const input = path.join(
      dir, crypto.randomUUID() + '.input'
    );
    const output = path.join(
      dir, crypto.randomUUID() + '.mp4'
    );

    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(input, req.file.buffer);

      await runFFmpeg(input, output, quality);

      const result = await stat(output);
      if (!result.size) {
        throw new Error('Video output kosong.');
      }

      res.download(output, 'statushd-converted.mp4',
        async () => {
          await rm(dir, { recursive: true, force: true });
        }
      );
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (!res.headersSent) {
        res.status(500).json({
          error: err.message
        });
      }
    }
  }
);

export default router;
