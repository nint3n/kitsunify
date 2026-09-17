const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8977623287:AAEbH9ZrwLYm9D9mM6AK3Uioy3rbhz1Jxq8';
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1004327082740';

/**
 * Make an API call to Telegram Bot API
 */
function apiCall(method, postData = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/${method}`,
      method: postData ? 'POST' : 'GET',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          reject(new Error(`Error parseando respuesta de Telegram: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (postData) {
      if (Buffer.isBuffer(postData) || typeof postData === 'string') {
        req.write(postData);
      } else if (postData.pipe) {
        postData.pipe(req);
        return;
      }
    }
    req.end();
  });
}

/**
 * Upload an audio file to the private Telegram channel
 */
function uploadAudio(filePath, title, artist, duration = 0) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const filename = path.basename(filePath);

    const stats = fs.statSync(filePath);
    const fileStream = fs.createReadStream(filePath);

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
      `${CHANNEL_ID}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="title"\r\n\r\n` +
      `${title}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="performer"\r\n\r\n` +
      `${artist}\r\n` +
      (duration ? `--${boundary}\r\nContent-Disposition: form-data; name="duration"\r\n\r\n${Math.round(duration)}\r\n` : '') +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${encodeURIComponent(filename)}"\r\n` +
      `Content-Type: audio/mpeg\r\n\r\n`
    );

    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = header.length + stats.size + footer.length;

    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/sendAudio`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': contentLength
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            const audio = json.result.audio;
            resolve({
              fileId: audio.file_id,
              uniqueId: audio.file_unique_id,
              messageId: json.result.message_id,
              title: audio.title || title,
              artist: audio.performer || artist,
              duration: audio.duration || duration,
              size: audio.file_size || stats.size,
              date: json.result.date
            });
          } else {
            reject(new Error(json.description || 'Error al subir a Telegram'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);

    req.write(header);
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => {
      req.write(footer);
      req.end();
    });
  });
}

/**
 * Get direct download/streaming URL for a fileId
 */
async function getStreamUrl(fileId) {
  const res = await apiCall(`getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    throw new Error(res.description || 'Archivo no encontrado en Telegram');
  }
  return `https://api.telegram.org/file/bot${TOKEN}/${res.result.file_path}`;
}

/**
 * Stream an audio file from Telegram to an HTTP response (with Range support)
 */
async function streamAudio(fileId, req, res) {
  try {
    const fileUrl = await getStreamUrl(fileId);

    const parsed = new URL(fileUrl);
    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const tReq = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers
    }, (tRes) => {
      // Forward status and headers
      res.writeHead(tRes.statusCode, tRes.headers);
      tRes.pipe(res);
    });

    tReq.on('error', (err) => {
      console.error('Error al hacer proxy de audio desde Telegram:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error transmitiendo audio' });
      }
    });

    tReq.end();
  } catch (err) {
    console.error('Error obteniendo stream de Telegram:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

/**
 * Delete a message from the private channel
 */
async function deleteAudio(messageId) {
  return await apiCall(`deleteMessage?chat_id=${CHANNEL_ID}&message_id=${messageId}`);
}

module.exports = {
  TOKEN,
  CHANNEL_ID,
  apiCall,
  uploadAudio,
  getStreamUrl,
  streamAudio,
  deleteAudio
};
