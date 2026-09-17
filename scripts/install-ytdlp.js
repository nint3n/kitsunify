const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const binDir = path.join(__dirname, '..', 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const isWin = process.platform === 'win32';
const targetBinary = path.join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp');

async function main() {
  if (isWin && fs.existsSync(targetBinary)) {
    console.log('✅ yt-dlp ya está presente en bin/');
    return;
  }

  // On Linux (Render), download latest official yt-dlp
  const url = isWin
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  console.log(`⬇️ Descargando motor yt-dlp para ${process.platform}...`);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kitsunify/2.0)' },
      redirect: 'follow'
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} al descargar de GitHub`);
    }

    const fileStream = fs.createWriteStream(targetBinary);
    await new Promise((resolve, reject) => {
      Readable.fromWeb(res.body).pipe(fileStream);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    try {
      fs.chmodSync(targetBinary, 0o755);
    } catch (e) {}

    const sizeMb = (fs.statSync(targetBinary).size / (1024 * 1024)).toFixed(2);
    console.log(`✅ yt-dlp instalado exitosamente en ${targetBinary} (${sizeMb} MB)`);
  } catch (err) {
    console.error('❌ Error instalando yt-dlp:', err.message);
  }
}

main();
