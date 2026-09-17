const fs = require('fs');
const path = require('path');
const telegram = require('./telegram-vault');

const DB_FILE = path.join(__dirname, 'vault-db.json');

let cachedSongs = null;

function loadSongs() {
  if (cachedSongs) return cachedSongs;

  if (fs.existsSync(DB_FILE)) {
    try {
      cachedSongs = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return cachedSongs;
    } catch (e) {}
  }

  cachedSongs = [];
  return cachedSongs;
}

function saveSongs(songs) {
  cachedSongs = songs;
  fs.writeFileSync(DB_FILE, JSON.stringify(songs, null, 2));
}

/**
 * Add a newly uploaded Telegram song to the database
 */
function addSong(songData) {
  const songs = loadSongs();
  // Avoid duplicates by title + artist or fileId
  const existing = songs.findIndex(s => s.fileId === songData.fileId);
  if (existing >= 0) {
    songs[existing] = { ...songs[existing], ...songData };
  } else {
    songs.unshift(songData); // Newest first
  }
  saveSongs(songs);
  return songData;
}

/**
 * Delete a song from database and Telegram channel
 */
async function removeSong(fileId) {
  const songs = loadSongs();
  const index = songs.findIndex(s => s.fileId === fileId);
  if (index === 0 || index > 0) {
    const song = songs[index];
    if (song.messageId) {
      try {
        await telegram.deleteAudio(song.messageId);
      } catch (e) {
        console.warn('No se pudo borrar el mensaje en Telegram:', e.message);
      }
    }
    songs.splice(index, 1);
    saveSongs(songs);
    return true;
  }
  return false;
}

function getSongs() {
  return loadSongs();
}

module.exports = {
  loadSongs,
  saveSongs,
  addSong,
  removeSong,
  getSongs
};
