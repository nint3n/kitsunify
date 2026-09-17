/* ═══════════════════════════════════════════════════════════════
   Kitsunify ULTRA — Client Application with Security & Vault
   ═══════════════════════════════════════════════════════════════ */

// ─── DOM Elements ────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const searchInput = $('#searchInput');
const searchBtn = $('#searchBtn');
const searchResults = $('#searchResults');
const searchLoading = $('#searchLoading');
const searchEmpty = $('#searchEmpty');
const downloadsList = $('#downloadsList');
const downloadsEmpty = $('#downloadsEmpty');
const downloadBadge = $('#downloadBadge');
const libraryList = $('#libraryList');
const libraryEmpty = $('#libraryEmpty');
const libraryStats = $('#libraryStats');
const previewOverlay = $('#previewOverlay');
const previewIframe = $('#previewIframe');
const previewTitle = $('#previewTitle');
const previewChannel = $('#previewChannel');
const previewSaveBtn = $('#previewSaveBtn');
const previewClose = $('#previewClose');
const nowPlaying = $('#nowPlaying');
const audioPlayer = $('#audioPlayer');
const toast = $('#toast');

// Auth DOM
const authOverlay = $('#authOverlay');
const authForm = $('#authForm');
const authUsername = $('#authUsername');
const authPassword = $('#authPassword');
const authError = $('#authError');
const headerUserControls = $('#headerUserControls');
const userRoleBadge = $('#userRoleBadge');
const btnLogout = $('#btnLogout');

// ─── State ───────────────────────────────────────────────────────
let authToken = localStorage.getItem('kitsunify_token') || null;
let currentUser = null;
let currentPreview = null;
let downloads = new Map();
let isSearching = false;
let currentlyPlaying = null;
let eventSource = null;

// ─── Cloud Server API Endpoint ──────────────────────────────────
// When running inside the Android APK, requests must point to the Render cloud.
// When running in a web browser on Render or local dev (localhost:3000), relative path is used.
const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
                    window.location.protocol === 'capacitor:' ||
                    (window.location.hostname === 'localhost' && !window.location.port);

const API_BASE = isNativeApp ? (localStorage.getItem('kitsunify_server_url') || 'https://kitsunify.onrender.com') : '';

// ─── Inactivity Auto-Logout Security (15 min) ──────────────────
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
let lastActivityTime = Date.now();

function recordUserActivity() {
  lastActivityTime = Date.now();
  try {
    localStorage.setItem('kitsunify_last_active', lastActivityTime.toString());
  } catch (e) {}
}

// Activity event listeners
['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
  window.addEventListener(evt, recordUserActivity, { passive: true });
});

// Periodic heartbeat: check every 15 seconds
setInterval(() => {
  if (!authToken) return;

  // Music playback protection: if user is actively listening, do not disconnect!
  if (audioPlayer && !audioPlayer.paused && audioPlayer.currentTime > 0) {
    recordUserActivity();
    return;
  }

  const elapsed = Date.now() - lastActivityTime;
  if (elapsed >= INACTIVITY_TIMEOUT_MS) {
    console.warn(`[Seguridad] Sesión cerrada por inactividad (${Math.round(elapsed / 60000)} min sin actividad)`);
    logout('inactivity');
  }
}, 15000);

// App visibility change (returning to tab or unlocking mobile screen)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authToken) {
    const savedLastActive = parseInt(localStorage.getItem('kitsunify_last_active') || '0', 10);
    const elapsed = Date.now() - (savedLastActive || lastActivityTime);

    if (audioPlayer && !audioPlayer.paused && audioPlayer.currentTime > 0) {
      recordUserActivity();
      return;
    }

    if (savedLastActive && elapsed >= INACTIVITY_TIMEOUT_MS) {
      console.warn('[Seguridad] Sesión cerrada al regresar tras inactividad');
      logout('inactivity');
    } else {
      recordUserActivity();
    }
  }
});

// ─── Authenticated Fetch Helper ──────────────────────────────────
async function authFetch(url, options = {}) {
  recordUserActivity();
  const fullUrl = url.startsWith('/') ? `${API_BASE}${url}` : url;
  const headers = options.headers || {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(fullUrl, { ...options, headers });

  if (res.status === 401) {
    logout();
    throw new Error('Sesión expirada o no autorizada');
  }

  return res;
}

// ─── Authentication Management ────────────────────────────────────
async function checkAuth() {
  if (!authToken) {
    showAuthModal();
    return;
  }

  // Check if session timed out while app was closed/minimized
  const savedLastActive = parseInt(localStorage.getItem('kitsunify_last_active') || '0', 10);
  if (savedLastActive && (Date.now() - savedLastActive >= INACTIVITY_TIMEOUT_MS)) {
    logout('inactivity');
    return;
  }
  recordUserActivity();

  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      hideAuthModal();
      setupUserUI();
      connectSSE();
      loadLibrary();
    } else {
      logout();
    }
  } catch (err) {
    // If offline, allow access to cached offline songs
    if (authToken) {
      console.warn('Servidor inaccesible, modo offline:', err);
      currentUser = { username: 'Modo Offline', role: 'listener' };
      hideAuthModal();
      setupUserUI();
      loadOfflineLibrary();
      showToast('📱 Modo Offline (sin conexión al servidor)', 'info');
    } else {
      showAuthModal();
    }
  }
}

function showAuthModal() {
  authOverlay.style.display = 'flex';
  headerUserControls.style.display = 'none';
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function hideAuthModal() {
  authOverlay.style.display = 'none';
  headerUserControls.style.display = 'flex';
  authError.style.display = 'none';
  authError.textContent = '';
}

function setupUserUI() {
  if (!currentUser) return;
  const isAdmin = currentUser.role === 'admin';
  userRoleBadge.textContent = isAdmin ? 'ADMIN 🛡️' : 'OYENTE 👤';
  userRoleBadge.style.borderColor = isAdmin ? 'rgba(255, 107, 53, 0.4)' : 'rgba(29, 185, 84, 0.4)';
  userRoleBadge.style.color = isAdmin ? '#ff8a00' : '#1ed760';
}

async function handleLogin() {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  authError.style.display = 'none';

  if (!username || !password) {
    authError.textContent = 'Por favor ingresa usuario y contraseña';
    authError.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      authError.textContent = data.error || 'Error al iniciar sesión';
      authError.style.display = 'block';
      return;
    }

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('kitsunify_token', authToken);
    recordUserActivity();

    hideAuthModal();
    setupUserUI();
    connectSSE();
    loadLibrary();
    showToast(`Bienvenido, ${currentUser.username}! 🦊`, 'success');
  } catch (err) {
    console.error('Error de login:', err);
    authError.textContent = 'No se pudo conectar al servidor en la nube. Revisa tu conexión a internet.';
    authError.style.display = 'block';
  }
}

function logout(reason = null) {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('kitsunify_token');
  localStorage.removeItem('kitsunify_last_active');
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.src = '';
  }
  nowPlaying.classList.remove('visible');
  showAuthModal();

  if (reason === 'inactivity') {
    authError.textContent = '🔒 Sesión cerrada automáticamente por inactividad (15 min).';
    authError.style.display = 'block';
    showToast('Sesión cerrada por inactividad', 'info');
  } else {
    showToast('Sesión cerrada', 'info');
  }
}

if (authForm) {
  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleLogin();
  });
}

if (btnLogout) {
  btnLogout.addEventListener('click', logout);
}

// ─── Tab Navigation ──────────────────────────────────────────────
$$('.tab-item').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab-item').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#${tab.dataset.tab}`).classList.add('active');

    const searchContainer = $('#searchContainer');
    if (tab.dataset.tab === 'tabSearch') {
      searchContainer.style.display = '';
    } else {
      searchContainer.style.display = 'none';
    }

    if (tab.dataset.tab === 'tabLibrary') {
      loadLibrary();
    }
  });
});

// ─── Search ──────────────────────────────────────────────────────
async function performSearch() {
  const query = searchInput.value.trim();
  if (!query || isSearching) return;

  isSearching = true;
  searchLoading.style.display = '';
  searchEmpty.style.display = 'none';
  searchResults.innerHTML = '';
  searchBtn.disabled = true;

  try {
    const res = await authFetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    searchLoading.style.display = 'none';
    searchBtn.disabled = false;
    isSearching = false;

    if (!data.results || data.results.length === 0) {
      searchEmpty.style.display = '';
      $('#searchEmptyTitle').textContent = 'Sin resultados';
      $('#searchEmptyDesc').textContent = `No encontramos nada para "${query}". Intenta con otro término.`;
      return;
    }

    renderSearchResults(data.results);
  } catch (err) {
    searchLoading.style.display = 'none';
    searchBtn.disabled = false;
    isSearching = false;
    showToast('Error en la búsqueda', 'error');
  }
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performSearch();
});
searchBtn.addEventListener('click', performSearch);

// ─── Render Search Results ───────────────────────────────────────
function renderSearchResults(results) {
  searchResults.innerHTML = results.map(item => {
    const duration = formatDuration(item.duration);
    const views = formatViews(item.views);
    const dl = downloads.get(item.id);
    const isDl = dl && (dl.status === 'downloading' || dl.status === 'starting' || dl.status === 'converting');
    const isDone = dl && dl.status === 'completed';

    return `
      <div class="song-card" id="card-${item.id}">
        <img
          class="song-thumb"
          src="${escapeAttr(item.thumbnail)}"
          alt="${escapeAttr(item.title)}"
          loading="lazy"
          onerror="this.src='data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><rect fill=\'%231a1a2e\' width=\'100\' height=\'100\'/><text y=\'.9em\' font-size=\'90\'>🎵</text></svg>'"
        >
        <div class="song-info" onclick="openPreview('${item.id}', '${escapeAttr(item.title)}', '${escapeAttr(item.channel)}', '${escapeAttr(item.url)}', '${escapeAttr(item.thumbnail)}', ${item.duration})">
          <div class="song-title">${escapeHtml(item.title)}</div>
          <div class="song-artist">${escapeHtml(item.channel)}</div>
          <div class="song-meta">
            ${duration ? `<span class="song-duration">⏱ ${duration}</span>` : ''}
            ${views ? `<span class="song-views">👁 ${views}</span>` : ''}
          </div>
        </div>
        <button
          class="play-btn"
          onclick="openPreview('${item.id}', '${escapeAttr(item.title)}', '${escapeAttr(item.channel)}', '${escapeAttr(item.url)}', '${escapeAttr(item.thumbnail)}', ${item.duration})"
          aria-label="Escuchar preview"
          title="Escuchar preview"
        >▶</button>
        <button
          class="save-btn ${isDl ? 'downloading' : ''} ${isDone ? 'completed' : ''}"
          id="saveBtn-${item.id}"
          onclick="startDownload('${item.id}', '${escapeAttr(item.url)}', '${escapeAttr(item.title)}', '${escapeAttr(item.channel)}', ${item.duration}, '${escapeAttr(item.thumbnail)}')"
          aria-label="Guardar en Bóveda"
          title="Guardar en Bóveda"
          ${isDl || isDone ? 'disabled' : ''}
        >${isDl ? '⏳' : isDone ? '✓' : '💾'}</button>
      </div>
    `;
  }).join('');
}

// ─── Preview Modal ───────────────────────────────────────────────
function openPreview(id, title, channel, url, thumbnail, duration) {
  currentPreview = { id, title, channel, url, thumbnail, duration };

  previewTitle.textContent = title;
  previewChannel.textContent = channel;
  previewIframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;

  const dl = downloads.get(id);
  if (dl && dl.status === 'completed') {
    previewSaveBtn.disabled = true;
    previewSaveBtn.textContent = '✓ Guardada en Bóveda';
  } else if (dl && (dl.status === 'downloading' || dl.status === 'starting')) {
    previewSaveBtn.disabled = true;
    previewSaveBtn.textContent = '⏳ Guardando...';
  } else {
    previewSaveBtn.disabled = false;
    previewSaveBtn.textContent = '💾 Guardar en Bóveda';
  }

  previewOverlay.classList.add('visible');
}

function closePreview() {
  previewOverlay.classList.remove('visible');
  previewIframe.src = '';
  currentPreview = null;
}

previewClose.addEventListener('click', closePreview);
previewOverlay.addEventListener('click', (e) => {
  if (e.target === previewOverlay) closePreview();
});

previewSaveBtn.addEventListener('click', () => {
  if (!currentPreview) return;
  startDownload(
    currentPreview.id,
    currentPreview.url,
    currentPreview.title,
    currentPreview.channel,
    currentPreview.duration,
    currentPreview.thumbnail
  );
  previewSaveBtn.disabled = true;
  previewSaveBtn.textContent = '⏳ Guardando...';
});

// ─── Downloads & Telegram Cloud Vault ─────────────────────────────
async function startDownload(id, url, title, artist, duration, thumbnail) {
  if (currentUser && currentUser.role !== 'admin') {
    showToast('Solo el administrador puede guardar en la nube', 'error');
    return;
  }

  downloads.set(id, {
    title,
    artist,
    progress: 0,
    status: 'starting',
    speed: '',
    eta: ''
  });

  updateDownloadUI();
  updateSaveBtnState(id, 'downloading');
  showToast(`Guardando: ${title.substring(0, 30)}...`, 'info');

  try {
    const res = await authFetch('/api/download', {
      method: 'POST',
      body: { url, title, id, artist, duration, thumbnail }
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Error al iniciar descarga');
    }
  } catch (err) {
    downloads.set(id, { title, progress: 0, status: 'error', speed: '', eta: '' });
    updateDownloadUI();
    updateSaveBtnState(id, 'error');
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─── SSE Progress Listener ───────────────────────────────────────
function connectSSE() {
  if (eventSource || !authToken) return;

  eventSource = new EventSource(`${API_BASE}/api/downloads/progress?token=${encodeURIComponent(authToken)}`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'progress' && data.id) {
        downloads.set(data.id, {
          title: data.title,
          progress: data.progress || 0,
          status: data.status,
          speed: data.speed || '',
          eta: data.eta || '',
          error: data.error || ''
        });

        updateDownloadUI();
        updateSaveBtnState(data.id, data.status);

        if (data.status === 'completed') {
          showToast(`✅ ${data.title} guardada en tu Bóveda Telegram!`, 'success');
          if (currentPreview && currentPreview.id === data.id) {
            previewSaveBtn.disabled = true;
            previewSaveBtn.textContent = '✓ Guardada';
          }
          loadLibrary();
        }
      }
    } catch (e) {}
  };

  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    setTimeout(connectSSE, 4000);
  };
}

// ─── Update Download UI ──────────────────────────────────────────
function updateDownloadUI() {
  let activeCount = 0;

  downloads.forEach((dl) => {
    if (dl.status === 'completed' || dl.status === 'error') return;
    activeCount++;
  });

  if (downloads.size > 0) {
    let allHtml = '';
    downloads.forEach((dl) => {
      const statusClass = dl.status === 'completed' ? 'completed' : (dl.status === 'error' ? 'error' : '');
      let statusText = '';
      switch (dl.status) {
        case 'starting': statusText = 'Descargando audio...'; break;
        case 'downloading': statusText = `${dl.progress.toFixed(0)}% · ${dl.speed}`; break;
        case 'converting': statusText = 'Convirtiendo a MP3...'; break;
        case 'uploading': statusText = 'Subiendo a tu Bóveda Telegram ☁️...'; break;
        case 'completed': statusText = '✅ En tu Bóveda Privada'; break;
        case 'error': statusText = dl.error ? `❌ ${escapeHtml(dl.error)}` : '❌ Error al procesar'; break;
      }

      allHtml += `
        <div class="song-card">
          <div style="width:52px;height:52px;border-radius:12px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">
            ${dl.status === 'completed' ? '✅' : dl.status === 'error' ? '❌' : '☁️'}
          </div>
          <div class="song-info">
            <div class="song-title">${escapeHtml(dl.title)}</div>
            <div class="song-artist ${statusClass}">${statusText}</div>
            ${dl.status !== 'completed' && dl.status !== 'error' ? `
              <div class="progress-bar-wrap" style="margin-top:6px">
                <div class="progress-bar-fill ${dl.status === 'converting' || dl.status === 'uploading' ? 'converting' : ''}" style="width: ${dl.progress || 100}%"></div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    });
    downloadsList.innerHTML = allHtml;
    downloadsEmpty.style.display = 'none';
  } else {
    downloadsList.innerHTML = '';
    downloadsEmpty.style.display = '';
  }

  if (activeCount > 0) {
    downloadBadge.textContent = activeCount;
    downloadBadge.classList.add('visible');
  } else {
    downloadBadge.classList.remove('visible');
  }
}

function updateSaveBtnState(id, status) {
  const btn = $(`#saveBtn-${id}`);
  if (!btn) return;

  btn.className = 'save-btn';
  switch (status) {
    case 'downloading':
    case 'starting':
    case 'converting':
    case 'uploading':
      btn.classList.add('downloading');
      btn.innerHTML = '⏳';
      btn.disabled = true;
      break;
    case 'completed':
      btn.classList.add('completed');
      btn.innerHTML = '✓';
      btn.disabled = true;
      break;
    case 'error':
      btn.classList.add('error');
      btn.innerHTML = '⚠';
      btn.disabled = false;
      break;
  }
}

// ─── Library: Telegram Vault + Offline Store ─────────────────────
async function loadLibrary() {
  // If offline or network unavailable, load from phone's local database
  if (!navigator.onLine) {
    return loadOfflineLibrary();
  }

  try {
    const res = await authFetch('/api/library');
    const data = await res.json();

    if (!data.songs || data.songs.length === 0) {
      return loadOfflineLibrary();
    }

    libraryEmpty.style.display = 'none';
    libraryStats.style.display = '';

    const totalSize = data.songs.reduce((sum, s) => sum + (s.size || 0), 0);
    $('#statSongs').textContent = data.total;
    $('#statSize').textContent = formatBytes(totalSize);

    const isAdmin = currentUser && currentUser.role === 'admin';

    // Check offline status for each song
    const songCards = await Promise.all(data.songs.map(async song => {
      const isOffline = typeof isSongOffline === 'function' ? await isSongOffline(song.fileId) : false;

      return `
        <div class="song-card" id="lib-${song.fileId || song.filename}">
          <div style="width:52px;height:52px;border-radius:12px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">
            ${isOffline ? '📱' : '☁️'}
          </div>
          <div class="song-info" onclick="playLibrarySong('${escapeAttr(song.path)}', '${escapeAttr(song.title)}', '${escapeAttr(song.artist)}', '${song.fileId}')">
            <div class="song-title">${escapeHtml(song.title)}</div>
            <div class="song-artist">${escapeHtml(song.artist)}</div>
            <div class="song-meta">
              <span class="song-size">📦 ${formatBytes(song.size)}</span>
              <span class="song-views" style="color:${isOffline ? '#1ed760' : 'var(--accent-green)'}">
                ${isOffline ? '📱 Sin Internet OK' : '☁️ Bóveda Nube'}
              </span>
            </div>
          </div>
          <button
            class="save-btn ${isOffline ? 'completed' : ''}"
            style="font-size: 13px; width: 34px; height: 34px; margin-right: 4px;"
            title="${isOffline ? 'Disponible sin internet (Toca para quitar)' : 'Guardar para escuchar sin internet'}"
            onclick="toggleOfflineMode('${song.fileId}', '${escapeAttr(song.path)}', '${escapeAttr(song.title)}', '${escapeAttr(song.artist)}', ${song.duration || 0})"
          >${isOffline ? '📱' : '📥'}</button>
          <button class="play-btn ${currentlyPlaying === song.path ? 'playing' : ''}" onclick="playLibrarySong('${escapeAttr(song.path)}', '${escapeAttr(song.title)}', '${escapeAttr(song.artist)}', '${song.fileId}')" aria-label="Reproducir">
            ${currentlyPlaying === song.path ? '⏸' : '▶'}
          </button>
          ${isAdmin ? `
            <button class="delete-btn" onclick="deleteSong('${escapeAttr(song.fileId)}')" aria-label="Eliminar de la bóveda">🗑</button>
          ` : ''}
        </div>
      `;
    }));

    libraryList.innerHTML = songCards.join('');
  } catch (err) {
    loadOfflineLibrary();
  }
}

async function loadOfflineLibrary() {
  if (typeof getOfflineSongs !== 'function') return;

  const offlineSongs = await getOfflineSongs();
  if (offlineSongs.length === 0) {
    libraryEmpty.style.display = '';
    libraryStats.style.display = 'none';
    libraryList.innerHTML = '';
    return;
  }

  libraryEmpty.style.display = 'none';
  libraryStats.style.display = '';
  $('#statSongs').textContent = `${offlineSongs.length} (Offline)`;
  const totalSize = offlineSongs.reduce((sum, s) => sum + s.size, 0);
  $('#statSize').textContent = formatBytes(totalSize);

  libraryList.innerHTML = offlineSongs.map(song => `
    <div class="song-card" id="lib-${song.id}">
      <div style="width:52px;height:52px;border-radius:12px;background:rgba(29,185,84,0.15);border:1px solid rgba(29,185,84,0.3);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">
        📱
      </div>
      <div class="song-info" onclick="playOfflineSong('${song.id}', '${escapeAttr(song.title)}', '${escapeAttr(song.artist)}')">
        <div class="song-title">${escapeHtml(song.title)}</div>
        <div class="song-artist">${escapeHtml(song.artist)}</div>
        <div class="song-meta">
          <span class="song-size">📦 ${formatBytes(song.size)}</span>
          <span class="song-views" style="color:#1ed760">📱 Sin Internet</span>
        </div>
      </div>
      <button class="play-btn" onclick="playOfflineSong('${song.id}', '${escapeAttr(song.title)}', '${escapeAttr(song.artist)}')">
        ▶
      </button>
      <button class="delete-btn" onclick="removeOfflineOnly('${song.id}')" title="Quitar de este celular">✕</button>
    </div>
  `).join('');
}

async function toggleOfflineMode(fileId, streamPath, title, artist, duration) {
  if (typeof isSongOffline !== 'function') return;

  const isAlready = await isSongOffline(fileId);
  if (isAlready) {
    await removeOfflineSong(fileId);
    showToast('Quitada del celular (sigue en la nube)', 'info');
    loadLibrary();
    return;
  }

  showToast('Guardando en celular para escuchar sin internet...', 'info');
  try {
    const res = await authFetch(`${streamPath}?token=${encodeURIComponent(authToken)}`);
    const blob = await res.blob();
    await saveOfflineSong({ fileId, title, artist, duration }, blob);
    showToast(`📱 "${title}" lista para escuchar sin internet!`, 'success');
    loadLibrary();
  } catch (e) {
    showToast('Error al guardar para modo offline', 'error');
  }
}

async function playOfflineSong(id, title, artist) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const req = tx.objectStore(STORE_NAME).get(id);

  req.onsuccess = () => {
    const song = req.result;
    if (!song || !song.blob) return;

    if (audioPlayer.src) {
      URL.revokeObjectURL(audioPlayer.src);
    }

    const blobUrl = URL.createObjectURL(song.blob);
    audioPlayer.src = blobUrl;
    audioPlayer.play().catch(() => {});

    nowPlaying.classList.add('visible');
    $('#npTitle').textContent = title;
    $('#npArtist').textContent = `${artist} · Modo Offline 📱`;
    $('#npPlayBtn').textContent = '⏸';
  };
}

async function removeOfflineOnly(id) {
  if (typeof removeOfflineSong === 'function') {
    await removeOfflineSong(id);
    showToast('Canción quitada de la memoria del celular', 'info');
    loadOfflineLibrary();
  }
}

// ─── Play Library Song (Cloud / Stream) ───────────────────────────
function playLibrarySong(streamPath, title, artist, fileId) {
  if (currentlyPlaying === streamPath) {
    if (audioPlayer.paused) {
      audioPlayer.play();
      $('#npPlayBtn').textContent = '⏸';
    } else {
      audioPlayer.pause();
      $('#npPlayBtn').textContent = '▶';
    }
    return;
  }

  currentlyPlaying = streamPath;
  // Authenticated stream URL
  const fullStreamUrl = streamPath.startsWith('/') ? `${API_BASE}${streamPath}` : streamPath;
  audioPlayer.src = `${fullStreamUrl}?token=${encodeURIComponent(authToken)}`;
  audioPlayer.play().catch(e => {
    showToast('Error al reproducir audio', 'error');
  });

  nowPlaying.classList.add('visible');
  $('#npTitle').textContent = title;
  $('#npArtist').textContent = artist;
  $('#npPlayBtn').textContent = '⏸';

  loadLibrary();
}

$('#npPlayBtn').addEventListener('click', () => {
  if (audioPlayer.paused) {
    audioPlayer.play();
    $('#npPlayBtn').textContent = '⏸';
  } else {
    audioPlayer.pause();
    $('#npPlayBtn').textContent = '▶';
  }
});

$('#npCloseBtn').addEventListener('click', () => {
  audioPlayer.pause();
  audioPlayer.src = '';
  currentlyPlaying = null;
  nowPlaying.classList.remove('visible');
  loadLibrary();
});

audioPlayer.addEventListener('ended', () => {
  $('#npPlayBtn').textContent = '▶';
  currentlyPlaying = null;
  loadLibrary();
});

// ─── Delete Song ─────────────────────────────────────────────────
async function deleteSong(fileId) {
  if (!confirm('¿Eliminar esta canción de tu Bóveda Privada?')) return;

  try {
    const res = await authFetch(`/api/delete/vault/${encodeURIComponent(fileId)}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      showToast('Canción eliminada de la bóveda', 'info');
      if (currentlyPlaying && currentlyPlaying.includes(fileId)) {
        audioPlayer.pause();
        audioPlayer.src = '';
        nowPlaying.classList.remove('visible');
      }
      loadLibrary();
    } else {
      const data = await res.json();
      showToast(data.error || 'Error al eliminar', 'error');
    }
  } catch (err) {
    showToast('Error al conectar con el servidor', 'error');
  }
}

// ─── Utilities ───────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(views) {
  if (!views) return '';
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(0)}K`;
  return views.toString();
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info') {
  toast.textContent = msg;
  toast.className = `toast visible ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('visible');
  }, 3500);
}

// ─── Initialize ──────────────────────────────────────────────────
checkAuth();
