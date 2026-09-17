const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const auth = require('./auth');
const telegram = require('./telegram-vault');
const vaultDb = require('./vault-db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 1. Security Headers ───────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Configure FFmpeg path (support for Render and cloud hosts)
try {
  const ffmpeg = require('@ffmpeg-installer/ffmpeg');
  if (ffmpeg && ffmpeg.path) {
    const ffmpegDir = path.dirname(ffmpeg.path);
    const delimiter = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${ffmpegDir}${delimiter}${process.env.PATH}`;
  }
} catch (e) {}

// Resolve yt-dlp binary (local bin/ or system PATH)
const localYtdlp = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_BIN = fs.existsSync(localYtdlp) ? localYtdlp : 'yt-dlp';

// Temporary directory for downloading before uploading to Telegram vault
const TMP_DOWNLOAD_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TMP_DOWNLOAD_DIR)) {
  fs.mkdirSync(TMP_DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 2. Healthcheck for Keep-Alive (cron-job.org) ───────────────────────────
// Stays public so cron-job.org keeps Render awake 24/7 without authentication
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'Kitsunify 🦊',
    uptime: Math.floor(process.uptime()),
    vaultSongs: vaultDb.getSongs().length,
    timestamp: Date.now()
  });
});

// ─── 3. Authentication Endpoints ───────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const result = auth.authenticateUser(username, password, clientIp);

  if (result.error) {
    return res.status(result.status || 401).json({ error: result.error });
  }

  res.json(result);
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', auth.requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const result = auth.changePassword(req.user.username, oldPassword, newPassword);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ success: true, message: 'Contraseña actualizada correctamente' });
});

// ─── 4. Active Downloads & SSE Progress ────────────────────────────────────
const activeDownloads = new Map();
const sseClients = new Set();

app.get('/api/downloads/progress', auth.requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);

  activeDownloads.forEach((dl, id) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', id, ...dl })}\n\n`);
  });

  req.on('close', () => sseClients.delete(res));
});

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(msg));
}

// ─── 5. YouTube Search (Protected + Sanitized) ─────────────────────────────
app.get('/api/search', auth.requireAuth, (req, res) => {
  const rawQuery = req.query.q;
  if (!rawQuery || typeof rawQuery !== 'string') {
    return res.json({ results: [] });
  }

  // Sanitize: max 100 chars, strip dangerous shell/control characters
  const query = rawQuery.trim().substring(0, 100).replace(/[;&|`$><\\]/g, '');
  if (query.length === 0) {
    return res.json({ results: [] });
  }

  const results = [];
  const ytdlp = spawn(YTDLP_BIN, [
    `ytsearch15:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--extractor-args', 'youtube:player_client=android,web',
    '--no-warnings',
    '--ignore-errors'
  ]);

  ytdlp.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const info = JSON.parse(line);
        results.push({
          id: info.id,
          title: info.title || 'Sin título',
          channel: info.channel || info.uploader || 'Desconocido',
          duration: info.duration || 0,
          thumbnail: info.thumbnails
            ? info.thumbnails[info.thumbnails.length - 1]?.url
            : `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
          url: info.url || `https://www.youtube.com/watch?v=${info.id}`,
          views: info.view_count || 0
        });
      } catch (e) {}
    }
  });

  ytdlp.on('close', () => {
    res.json({ results });
  });

  setTimeout(() => {
    try { ytdlp.kill(); } catch (e) {}
    if (!res.headersSent) {
      res.json({ results });
    }
  }, 30000);
});

// ─── 6. Download & Save to Telegram Vault (Admin Only) ─────────────────────
app.post('/api/download', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { url, title, id, artist, duration, thumbnail } = req.body;

  // Strict YouTube URL validation
  const ytRegex = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]{11}/;
  if (!url || !ytRegex.test(url)) {
    return res.status(400).json({ error: 'URL de YouTube inválida o no permitida' });
  }

  const downloadId = id || Date.now().toString();

  if (activeDownloads.has(downloadId) && activeDownloads.get(downloadId).status === 'downloading') {
    return res.json({ id: downloadId, status: 'already_downloading' });
  }

  activeDownloads.set(downloadId, {
    title: title || 'Descargando...',
    progress: 0,
    status: 'starting',
    speed: '',
    eta: ''
  });

  broadcastSSE({ type: 'progress', id: downloadId, ...activeDownloads.get(downloadId) });

  const tempOutputFile = path.join(TMP_DOWNLOAD_DIR, `${downloadId}.mp3`);

  const ytdlp = spawn(YTDLP_BIN, [
    url,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--embed-metadata',
    '--parse-metadata', 'uploader:%(artist)s',
    '--output', path.join(TMP_DOWNLOAD_DIR, `${downloadId}.%(ext)s`),
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=android,web',
    '--newline',
    '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--no-warnings'
  ]);

  ytdlp.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.startsWith('download:')) {
        const parts = line.replace('download:', '').split('|');
        const percent = parseFloat(parts[0]) || 0;
        const speed = parts[1] || '';
        const eta = parts[2] || '';

        const dl = activeDownloads.get(downloadId);
        if (dl) {
          dl.progress = percent;
          dl.speed = speed.trim();
          dl.eta = eta.trim();
          dl.status = 'downloading';
          broadcastSSE({ type: 'progress', id: downloadId, ...dl });
        }
      }
    }
  });

  ytdlp.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('Destination') || text.includes('Post-process')) {
      const dl = activeDownloads.get(downloadId);
      if (dl) {
        dl.status = 'converting';
        dl.progress = 100;
        broadcastSSE({ type: 'progress', id: downloadId, ...dl });
      }
    }
  });

  ytdlp.on('close', async (code) => {
    const dl = activeDownloads.get(downloadId);
    if (!dl) return;

    if (code !== 0) {
      dl.status = 'error';
      broadcastSSE({ type: 'progress', id: downloadId, ...dl });
      setTimeout(() => activeDownloads.delete(downloadId), 10000);
      return;
    }

    // Now upload the finished MP3 to Telegram Vault!
    try {
      dl.status = 'uploading';
      dl.speed = 'Bóveda Telegram';
      broadcastSSE({ type: 'progress', id: downloadId, ...dl });

      // Find the created file in TMP_DOWNLOAD_DIR matching downloadId
      const files = fs.readdirSync(TMP_DOWNLOAD_DIR).filter(f => f.startsWith(downloadId));
      if (files.length === 0) {
        throw new Error('Archivo procesado no encontrado');
      }

      const audioFilePath = path.join(TMP_DOWNLOAD_DIR, files[0]);

      console.log(`[Telegram Vault] Subiendo audio a la bóveda privada: "${title}"...`);
      const uploaded = await telegram.uploadAudio(audioFilePath, title, artist || 'Desconocido', duration || 0);

      console.log(`[Telegram Vault] ✅ Audio subido con éxito! FileId: ${uploaded.fileId}`);

      // Save metadata in vault database
      vaultDb.addSong({
        fileId: uploaded.fileId,
        messageId: uploaded.messageId,
        title: uploaded.title,
        artist: uploaded.artist,
        duration: uploaded.duration,
        size: uploaded.size,
        date: uploaded.date,
        thumbnail: thumbnail || '',
        path: `/api/stream/vault/${uploaded.fileId}`
      });

      // Cleanup local temp file immediately (0 MB on server!)
      try { fs.unlinkSync(audioFilePath); } catch (e) {}

      dl.status = 'completed';
      dl.progress = 100;
      dl.speed = 'Guardado en Bóveda ✅';
      broadcastSSE({ type: 'progress', id: downloadId, ...dl });

    } catch (uploadErr) {
      console.error('[Telegram Vault] ❌ Error subiendo a Telegram:', uploadErr.message);
      dl.status = 'error';
      broadcastSSE({ type: 'progress', id: downloadId, ...dl });
    }

    setTimeout(() => activeDownloads.delete(downloadId), 10000);
  });

  res.json({ id: downloadId, status: 'started' });
});

// ─── 7. Library: List Songs in Telegram Vault ─────────────────────────────
app.get('/api/library', auth.requireAuth, (req, res) => {
  const songs = vaultDb.getSongs();
  res.json({ songs, total: songs.length });
});

// ─── 8. Secure Streaming Proxy from Telegram Vault ────────────────────────
// The client NEVER sees the Telegram Bot Token!
app.get('/api/stream/vault/:fileId', auth.requireAuth, async (req, res) => {
  await telegram.streamAudio(req.params.fileId, req, res);
});

// ─── 9. Delete Song from Telegram Vault (Admin Only) ───────────────────────
app.delete('/api/delete/vault/:fileId', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const success = await vaultDb.removeSong(req.params.fileId);
    if (success) {
      res.json({ success: true, message: 'Canción eliminada de tu bóveda privada' });
    } else {
      res.status(404).json({ error: 'Canción no encontrada' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 10. Start Server ──────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║                                              ║');
  console.log('  ║   🦊  Kitsunify ULTRA v2.0 (Telegram Vault) ║');
  console.log('  ║                                              ║');
  console.log(`  ║   🌐  http://localhost:${PORT}                  ║`);
  console.log('  ║   🔒  Seguridad: Bcrypt + JWT + Anti-Brute   ║');
  console.log('  ║   ☁️   Bóveda: Telegram Cloud Ilimitada      ║');
  console.log('  ║                                              ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
