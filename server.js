const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: os.tmpdir() });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/export', upload.single('video'), async (req, res) => {
  const inputPath = req.file?.path;

  if (!inputPath) {
    return res.status(400).json({ error: 'No video file uploaded' });
  }

  let cuts;
  try {
    cuts = JSON.parse(req.body.cuts);
    if (!Array.isArray(cuts) || cuts.length === 0) throw new Error();
  } catch {
    fs.unlinkSync(inputPath);
    return res.status(400).json({ error: 'Invalid cuts parameter. Expected JSON array of {start, end}' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const segmentPaths = [];

  try {
    for (let i = 0; i < cuts.length; i++) {
      const { start, end } = cuts[i];
      const duration = end - start;
      const segPath = path.join(tmpDir, 'seg_' + i + '.mp4');
      segmentPaths.push(segPath);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(start)
          .setDuration(duration)
          .outputOptions([
            '-c:v libx264',
            '-preset fast',
            '-crf 18',
            '-c:a aac',
            '-b:a 192k',
            '-ar 44100',
            '-movflags +faststart',
            '-avoid_negative_ts make_zero',
            '-fflags +genpts'
          ])
          .output(segPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    }

    if (segmentPaths.length === 1) {
      res.setHeader('Content-Disposition', 'attachment; filename="exported.mp4"');
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(segmentPaths[0]);
      stream.pipe(res);
      stream.on('end', () => cleanup(inputPath, tmpDir));
      stream.on('error', () => cleanup(inputPath, tmpDir));
      return;
    }

    const concatListPath = path.join(tmpDir, 'concat.txt');
    const concatContent = segmentPaths.map(p => "file '" + p + "'").join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    const outputPath = path.join(tmpDir, 'output.mp4');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions([
          '-c:v libx264',
          '-preset fast',
          '-crf 18',
          '-c:a aac',
          '-b:a 192k',
          '-ar 44100',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    res.setHeader('Content-Disposition', 'attachment; filename="exported.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => cleanup(inputPath, tmpDir));
    stream.on('error', () => cleanup(inputPath, tmpDir));

  } catch (err) {
    console.error('FFmpeg error:', err);
    cleanup(inputPath, tmpDir);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Video processing failed', details: err.message });
    }
  }
});

function cleanup(inputPath, tmpDir) {
  try { fs.unlinkSync(inputPath); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
