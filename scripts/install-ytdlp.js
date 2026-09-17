const fs = require('fs');
const path = require('path');
const https = require('https');

const binDir = path.join(__dirname, '..', 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const isWin = process.platform === 'win32';
const targetBinary = path.join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp');

// If running locally on Windows and system yt-dlp exists, no need to download 150MB exe
if (isWin && fs.existsSync(targetBinary)) {
  console.log('✅ yt-dlp ya está presente en bin/');
  process.exit(0);
}

// On Linux (Render), download latest standalone yt-dlp binary (~20MB)
const url = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

console.log(`⬇️ Descargando yt-dlp para ${process.platform}...`);

function downloadFile(sourceUrl, destPath) {
  https.get(sourceUrl, (res) => {
    // Handle redirects (301, 302, 307, 308)
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return downloadFile(res.headers.location, destPath);
    }

    if (res.statusCode !== 200) {
      console.error(`❌ Error descargando yt-dlp: HTTP ${res.statusCode}`);
      return;
    }

    const fileStream = fs.createWriteStream(destPath);
    res.pipe(fileStream);

    fileStream.on('finish', () => {
      fileStream.close(() => {
        try {
          fs.chmodSync(destPath, 0o755);
        } catch (e) {}
        console.log(`✅ yt-dlp instalado exitosamente en ${destPath}`);
      });
    });
  }).on('error', (err) => {
    console.error('❌ Error de conexión al descargar yt-dlp:', err.message);
  });
}

if (!isWin) {
  downloadFile(url, targetBinary);
} else {
  console.log('ℹ️ En Windows local se usa el yt-dlp del sistema.');
}
