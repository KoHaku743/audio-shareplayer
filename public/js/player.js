// player.js – Room player page logic
// Handles: Socket.io room sync, HLS.js / native video, audio-only mode,
//          play/pause/seek controls, drift correction, chat, QR code.

// ── Globals ──────────────────────────────────────────────────────────────
const socket = window.io ? window.io() : null;

let roomId     = null;
let isMaster   = false;
let myMode     = 'video';   // 'video' | 'audio'
let roomSource = null;

/** The active HTMLVideoElement for the current mode */
let videoEl = null;
let hlsInstance = null;

// Sync state
let isSeeking     = false;
let lastSyncTime  = 0;
const DRIFT_THRESHOLD = 2.5; // seconds

// ── DOM refs ──────────────────────────────────────────────────────────────
const roomPage       = document.getElementById('room-page');
const videoWrap      = document.getElementById('video-wrap');
const audioWrap      = document.getElementById('audio-wrap');
const mainVideoEl    = document.getElementById('main-video');
const audioVideoEl   = document.getElementById('audio-video');
const videoOverlay   = document.getElementById('video-overlay');
const overlayText    = document.getElementById('overlay-text');
const playPauseBtn   = document.getElementById('play-pause-btn');
const bigPlayBtn     = document.getElementById('big-play-btn');
const seekBar        = document.getElementById('seek-bar');
const currentTimeEl  = document.getElementById('current-time-el');
const durationEl     = document.getElementById('duration-el');
const volSlider      = document.getElementById('vol-slider');
const muteBtn        = document.getElementById('mute-btn');
const memberCountEl  = document.getElementById('member-count-badge');
const roomIdText     = document.getElementById('room-id-text');
const modeBadge      = document.getElementById('mode-badge');
const masterBadge    = document.getElementById('master-badge');
const sourceName     = document.getElementById('source-name-el');
const syncBadge      = document.getElementById('sync-badge');
const slaveStatus    = document.getElementById('slave-status');
const audioViz       = document.getElementById('audio-viz');
const audioTitle     = document.getElementById('audio-track-title');
const audioSub       = document.getElementById('audio-track-sub');
const membersList    = document.getElementById('members-list');
const chatMessages   = document.getElementById('chat-messages');

// ── Utility ───────────────────────────────────────────────────────────────
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '--:--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function showToast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── HLS / Video loading ───────────────────────────────────────────────────
function loadSource(el, url) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

  const isHLS = url.includes('.m3u8') || url.includes('/hls/') || url.includes('playlist');

  if (isHLS && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(el);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      hideOverlay();
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        showToast(`Stream error: ${data.details}`, 'error');
        showOverlay('Stream error – check the URL');
      }
    });
  } else if (isHLS && el.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    el.src = url;
    hideOverlay();
  } else {
    el.src = url;
    hideOverlay();
  }
}

function showOverlay(msg) {
  overlayText.textContent = msg;
  videoOverlay.classList.remove('hidden');
}
function hideOverlay() {
  videoOverlay.classList.add('hidden');
}

// ── Controls ──────────────────────────────────────────────────────────────
function updatePlayPauseUI(playing) {
  const icon = playing ? '⏸' : '▶';
  if (playPauseBtn) playPauseBtn.textContent = icon;
  if (bigPlayBtn)  bigPlayBtn.textContent    = icon;
  if (audioViz) audioViz.classList.toggle('paused', !playing);
}

function updateSeekBar() {
  if (!videoEl || isSeeking) return;
  const dur = videoEl.duration;
  const cur = videoEl.currentTime;
  if (isFinite(dur) && dur > 0) {
    seekBar.value = (cur / dur) * 100;
    currentTimeEl.textContent = fmtTime(cur);
    durationEl.textContent    = fmtTime(dur);
  }
}

window.togglePlay = function () {
  if (!videoEl) return;
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
};

window.skip = function (seconds) {
  if (!videoEl) return;
  videoEl.currentTime = Math.max(0, videoEl.currentTime + seconds);
};

window.onSeekInput = function (val) {
  isSeeking = true;
  if (videoEl && isFinite(videoEl.duration)) {
    currentTimeEl.textContent = fmtTime((val / 100) * videoEl.duration);
  }
};

window.onSeekCommit = function (val) {
  isSeeking = false;
  if (!videoEl || !isFinite(videoEl.duration)) return;
  videoEl.currentTime = (val / 100) * videoEl.duration;
};

window.setVolume = function (val) {
  if (videoEl) {
    videoEl.volume = parseFloat(val);
    videoEl.muted = false;
  }
  muteBtn.textContent = val > 0 ? '🔊' : '🔇';
};

window.toggleMute = function () {
  if (!videoEl) return;
  videoEl.muted = !videoEl.muted;
  muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
};

window.toggleFullscreen = function () {
  if (!document.fullscreenElement) {
    (videoWrap || document.documentElement).requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
};

// ── Video event listeners ─────────────────────────────────────────────────
function attachVideoEvents(el) {
  el.addEventListener('play', () => {
    updatePlayPauseUI(true);
    if (isMaster) emitSyncState();
  });
  el.addEventListener('pause', () => {
    updatePlayPauseUI(false);
    if (isMaster) emitSyncState();
  });
  el.addEventListener('seeked', () => {
    if (isMaster) emitSyncState();
  });
  el.addEventListener('timeupdate', updateSeekBar);
  el.addEventListener('waiting', () => showOverlay('Buffering…'));
  el.addEventListener('canplay', hideOverlay);
  el.addEventListener('error', (e) => {
    const msg = el.error?.message || 'Unknown error';
    showOverlay(`Playback error: ${msg}`);
    showToast(`Playback error: ${msg}`, 'error');
  });
}

// ── Sync (master → socket → slave) ───────────────────────────────────────
function emitSyncState() {
  if (!socket || !isMaster || !videoEl) return;
  socket.emit('sync-state', {
    isPlaying: !videoEl.paused,
    currentTime: videoEl.currentTime
  });
}

function applySync(state) {
  if (!videoEl || isMaster) return;
  const { isPlaying, currentTime, updatedAt } = state;

  // Compensate for network latency by estimating elapsed time since updatedAt
  const elapsed = updatedAt ? (Date.now() - updatedAt) / 1000 : 0;
  const targetTime = currentTime + (isPlaying ? elapsed : 0);

  const drift = Math.abs(videoEl.currentTime - targetTime);
  if (drift > DRIFT_THRESHOLD) {
    videoEl.currentTime = targetTime;
    showSyncBadge('drifted');
  } else {
    showSyncBadge('synced');
  }

  if (isPlaying && videoEl.paused) {
    videoEl.play().catch(() => {});
  } else if (!isPlaying && !videoEl.paused) {
    videoEl.pause();
  }

  updatePlayPauseUI(isPlaying);
}

function showSyncBadge(type) {
  syncBadge.classList.remove('hidden', 'badge-synced', 'badge-drifted');
  syncBadge.classList.add(type === 'synced' ? 'badge-synced' : 'badge-drifted');
  syncBadge.textContent = type === 'synced' ? '✓ Synced' : '↺ Correcting';
  syncBadge.classList.remove('hidden');
  clearTimeout(syncBadge._timeout);
  syncBadge._timeout = setTimeout(() => syncBadge.classList.add('hidden'), 3000);
}

// Periodic sync request from slave (every 5 s)
setInterval(() => {
  if (socket && !isMaster) socket.emit('request-sync');
}, 5000);

// ── Room setup ────────────────────────────────────────────────────────────
function setupRoom(room, master, mode, source) {
  roomId     = room.id;
  isMaster   = master;
  myMode     = mode;
  roomSource = source || room.source;

  roomPage.classList.remove('hidden');

  // Room ID display
  roomIdText.textContent = room.id;

  // Source name
  const sname = roomSource?.name || roomSource?.url || '—';
  sourceName.textContent = sname;
  document.title = `${room.id} · audio-shareplayer`;

  // Mode badge
  if (myMode === 'audio') {
    modeBadge.textContent = '🎧 AUDIO';
    modeBadge.className = 'badge badge-audio';
    videoWrap.classList.add('hidden');
    audioWrap.classList.remove('hidden');
    videoEl = audioVideoEl;
    audioTitle.textContent = sname;
    audioSub.textContent   = roomSource?.torrentName || roomSource?.type?.toUpperCase() || '';
  } else {
    modeBadge.textContent = '🖥️ VIDEO';
    modeBadge.className = 'badge badge-video';
    videoEl = mainVideoEl;
  }

  // Master badge
  if (isMaster) {
    masterBadge.classList.remove('hidden');
    slaveStatus.classList.add('hidden');
  } else {
    masterBadge.classList.add('hidden');
    slaveStatus.classList.remove('hidden');
    slaveStatus.textContent = '⟳ Slave';
    slaveStatus.className = 'badge badge-audio';
  }

  // Attach video events
  attachVideoEvents(videoEl);

  // Load source
  if (roomSource?.url) {
    showOverlay('Loading stream…');
    loadSource(videoEl, roomSource.url);
  }

  // Members list update
  updateMembersList(room.memberCount || 1);

  // If joining an existing room, request current sync state
  if (!isMaster) {
    setTimeout(() => socket?.emit('request-sync'), 500);
  }
}

// ── Members ───────────────────────────────────────────────────────────────
function updateMembersList(count) {
  memberCountEl.textContent = `👤 ${count}`;
}

// ── Chat ──────────────────────────────────────────────────────────────────
window.sendChat = function () {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { text });
  input.value = '';
};

function appendChatMsg(msg, isMe) {
  const div = document.createElement('div');
  div.className = `chat-msg${isMe ? ' me' : ''}`;
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = `${msg.mode === 'video' ? '🖥️' : '🎧'} ${isMe ? 'You' : msg.mode}`;
  div.appendChild(sender);
  div.appendChild(document.createTextNode(msg.text));
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Sidebar tabs ──────────────────────────────────────────────────────────
window.switchSidebarTab = function (tab) {
  ['members', 'chat'].forEach(t => {
    document.getElementById(`sidebar-tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`sidebar-panel-${t}`).classList.toggle('hidden', t !== tab);
  });
};

// ── Share / QR modal ──────────────────────────────────────────────────────
window.openShareModal = function () {
  const url = `${window.location.origin}/?join=${roomId}`;
  document.getElementById('share-url').textContent = url;
  document.getElementById('share-modal').classList.remove('hidden');

  // Generate QR code
  const canvas = document.getElementById('qr-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (window.QRCode) {
    // QRCode.js renders to a div; use the canvas approach
    const tmp = document.createElement('div');
    tmp.style.display = 'none';
    document.body.appendChild(tmp);
    new QRCode(tmp, {
      text: url,
      width: 200,
      height: 200,
      colorDark: '#6c63ff',
      colorLight: '#1c1f2e',
      correctLevel: QRCode.CorrectLevel.H
    });
    const img = tmp.querySelector('img') || tmp.querySelector('canvas');
    if (img) {
      const draw = () => {
        ctx.drawImage(img, 0, 0, 200, 200);
        tmp.remove();
      };
      if (img.complete) draw();
      else img.onload = draw;
    } else {
      tmp.remove();
    }
  }
};

window.closeShareModal = function (e) {
  if (!e || e.target === document.getElementById('share-modal')) {
    document.getElementById('share-modal').classList.add('hidden');
  }
};

window.copyShareUrl = function () {
  const url = document.getElementById('share-url').textContent;
  navigator.clipboard?.writeText(url).then(() => showToast('Link copied!', 'success'));
};

window.copyRoomId = function () {
  navigator.clipboard?.writeText(roomId || '').then(() => showToast('Room code copied!', 'success'));
};

// ── Socket.io event handlers ──────────────────────────────────────────────
if (socket) {
  socket.on('room-joined', ({ room, isMaster: master }) => {
    const pending = JSON.parse(sessionStorage.getItem('pendingRoom') || '{}');
    setupRoom(room, master, pending.mode || 'video', pending.source || null);
    sessionStorage.removeItem('pendingRoom');
  });

  socket.on('sync-state', (state) => {
    applySync(state);
  });

  socket.on('master-changed', ({ masterId }) => {
    const wasMe = isMaster;
    isMaster = masterId === socket.id;
    if (!wasMe && isMaster) {
      masterBadge.classList.remove('hidden');
      slaveStatus.classList.add('hidden');
      showToast('You are now the master controller!', 'info');
    }
  });

  socket.on('member-joined', ({ memberCount }) => {
    updateMembersList(memberCount);
    showToast('A new member joined the room', 'info');
  });

  socket.on('member-left', ({ memberCount }) => {
    updateMembersList(memberCount);
  });

  socket.on('chat-message', (msg) => {
    appendChatMsg(msg, false);
    // Switch to chat tab if not active
    const chatPanel = document.getElementById('sidebar-panel-chat');
    if (chatPanel?.classList.contains('hidden')) {
      showToast(`💬 ${msg.text.slice(0, 40)}`, 'info');
    }
  });

  socket.on('error', ({ message }) => {
    showToast(message, 'error', 5000);
    // Redirect back to index after a short delay
    setTimeout(() => { window.location.href = '/'; }, 3000);
  });

  socket.on('connect_error', () => {
    showToast('Connection error – retrying…', 'error');
  });
}

// ── Bootstrap: connect to room from sessionStorage ────────────────────────
(function () {
  const pending = JSON.parse(sessionStorage.getItem('pendingRoom') || '{}');
  if (!pending.action) {
    // No pending room – redirect to index
    window.location.href = '/';
    return;
  }

  if (!socket) {
    document.body.innerHTML = '<p style="color:red;padding:2rem">Socket.io failed to load. Please refresh.</p>';
    return;
  }

  if (pending.action === 'create') {
    socket.emit('create-room', { source: pending.source, mode: pending.mode });
  } else if (pending.action === 'join') {
    socket.emit('join-room', { roomId: pending.roomId, mode: pending.mode });
  }
})();
