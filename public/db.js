/* ═══════════════════════════════════════════════════════════════
   Kitsunify — Offline IndexedDB Audio Store
   ═══════════════════════════════════════════════════════════════ */

const DB_NAME = 'KitsunifyOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'offline_songs';

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Save a song for 100% offline playback
 */
async function saveOfflineSong(songData, audioBlob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const record = {
      id: songData.fileId || songData.id || songData.title,
      title: songData.title,
      artist: songData.artist,
      duration: songData.duration || 0,
      size: audioBlob.size,
      blob: audioBlob,
      savedAt: Date.now()
    };

    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all offline songs
 */
async function getOfflineSongs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Check if a specific song is saved offline
 */
async function isSongOffline(id) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => resolve(false);
  });
}

/**
 * Remove a song from offline cache
 */
async function removeOfflineSong(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
