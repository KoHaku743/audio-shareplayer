// main.js – Landing page logic (Create / Join room)

// ── Tabs ─────────────────────────────────────────────────────────────────
let mainTab = 'create';
let sourceTab = 'url';
let createMode = 'video';
let joinMode = 'audio';

window.switchMainTab = function (tab) {
  mainTab = tab;
  document.getElementById('tab-create').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join').classList.toggle('active', tab === 'join');
  document.getElementById('panel-create').classList.toggle('hidden', tab !== 'create');
  document.getElementById('panel-join').classList.toggle('hidden', tab !== 'join');
};

window.switchSourceTab = function (tab) {
  sourceTab = tab;
  ['url', 'torrent', 'rd'].forEach(t => {
    document.getElementById(`src-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`source-${t === 'rd' ? 'rd' : t}-panel`).classList.toggle('hidden', t !== tab);
  });
};

window.selectMode = function (mode, context) {
  if (context === 'create') createMode = mode;
  else joinMode = mode;

  const container = document.getElementById(`${context}-mode-select`);
  container.querySelectorAll('.mode-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.mode === mode);
  });
};

// ── Real-Debrid key check ────────────────────────────────────────────────
window.checkRdKey = async function () {
  const key = document.getElementById('rd-key-input').value.trim();
  const statusEl = document.getElementById('rd-key-status');
  if (!key) { statusEl.textContent = 'Please enter an API key.'; return; }
  statusEl.textContent = 'Checking…';
  try {
    const res = await fetch('/api/realdebrid/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key })
    });
    const data = await res.json();
    if (res.ok) {
      statusEl.style.color = 'var(--success)';
      statusEl.textContent = `✓ Logged in as ${data.username}${data.premium ? ' (Premium)' : ''}`;
    } else {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = `✗ ${data.error}`;
    }
  } catch {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Network error – is the server running?';
  }
};

// ── Create room ──────────────────────────────────────────────────────────
window.createRoom = async function () {
  const errEl = document.getElementById('create-error');
  errEl.textContent = '';

  let source = null;

  if (sourceTab === 'url') {
    const url = document.getElementById('url-input').value.trim();
    if (!url) { errEl.textContent = 'Please enter a stream URL.'; return; }
    source = { type: 'url', url, name: url };

  } else if (sourceTab === 'torrent') {
    const magnet = document.getElementById('magnet-input').value.trim();
    if (!magnet) { errEl.textContent = 'Please enter a magnet link.'; return; }

    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Adding torrent…';

    try {
      const res = await fetch('/api/torrent/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Torrent error.'; btn.disabled = false; btn.textContent = 'Create Room & Start'; return; }

      // Let user pick which file if there are multiple video files
      const videoFiles = data.files.filter(f => /\.(mp4|mkv|avi|webm|mov|m4v)$/i.test(f.name));
      const chosen = videoFiles.length > 0 ? videoFiles[0] : data.files[0];
      source = { type: 'torrent', url: chosen.streamUrl, name: chosen.name, torrentName: data.name };
    } catch {
      errEl.textContent = 'Network error.';
      btn.disabled = false;
      btn.textContent = 'Create Room & Start';
      return;
    }
    document.getElementById('create-btn').disabled = false;
    document.getElementById('create-btn').textContent = 'Create Room & Start';

  } else if (sourceTab === 'rd') {
    const apiKey = document.getElementById('rd-key-input').value.trim();
    const link   = document.getElementById('rd-link-input').value.trim();
    if (!apiKey) { errEl.textContent = 'Please enter your Real-Debrid API key.'; return; }
    if (!link)   { errEl.textContent = 'Please enter a restricted link.'; return; }

    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Unrestricting link…';

    try {
      const res = await fetch('/api/realdebrid/unrestrict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, link })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Real-Debrid error.'; btn.disabled = false; btn.textContent = 'Create Room & Start'; return; }
      source = { type: 'realdebrid', url: data.download, name: data.filename || link };
    } catch {
      errEl.textContent = 'Network error.';
      btn.disabled = false;
      btn.textContent = 'Create Room & Start';
      return;
    }
    document.getElementById('create-btn').disabled = false;
    document.getElementById('create-btn').textContent = 'Create Room & Start';
  }

  if (!source) return;

  // Persist source in sessionStorage so the room page can read it
  sessionStorage.setItem('pendingRoom', JSON.stringify({ action: 'create', source, mode: createMode }));
  window.location.href = '/room.html';
};

// ── Join room ────────────────────────────────────────────────────────────
window.joinRoom = function () {
  const code  = document.getElementById('join-code-input').value.trim().toUpperCase();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';
  if (!code) { errEl.textContent = 'Please enter a room code.'; return; }
  sessionStorage.setItem('pendingRoom', JSON.stringify({ action: 'join', roomId: code, mode: joinMode }));
  window.location.href = '/room.html';
};

// ── Pre-fill from URL params ─────────────────────────────────────────────
(function () {
  const params = new URLSearchParams(window.location.search);
  const join = params.get('join');
  if (join) {
    switchMainTab('join');
    const el = document.getElementById('join-code-input');
    if (el) el.value = join.toUpperCase();
  }
})();

// ── Show initial tab ─────────────────────────────────────────────────────
switchSourceTab('url');
