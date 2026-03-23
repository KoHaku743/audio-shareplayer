import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import WebTorrent from 'webtorrent';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------
// Room shape:
// {
//   id: string,
//   source: { type: 'url'|'torrent'|'realdebrid', url: string, name: string },
//   playback: { isPlaying: bool, currentTime: number, updatedAt: number (ms) },
//   masterId: socketId | null,      ← the controlling peer
//   members: Map<socketId, { mode: 'video'|'audio', userAgent: string }>
// }
const rooms = new Map();

function createRoom(id) {
  return {
    id,
    source: null,
    playback: { isPlaying: false, currentTime: 0, updatedAt: Date.now() },
    masterId: null,
    members: new Map()
  };
}

function roomPublic(room) {
  return {
    id: room.id,
    source: room.source,
    playback: room.playback,
    masterId: room.masterId,
    memberCount: room.members.size
  };
}

// ---------------------------------------------------------------------------
// WebTorrent
// ---------------------------------------------------------------------------
const torrentClient = new WebTorrent();

// Map: infoHash -> torrent object
const activeTorrents = new Map();

// Clean up inactive torrents after 2 hours of inactivity
const TORRENT_TTL_MS = 2 * 60 * 60 * 1000;
function scheduleTorrentCleanup(torrent) {
  setTimeout(() => {
    if (activeTorrents.has(torrent.infoHash)) {
      torrentClient.remove(torrent.infoHash, {}, (err) => {
        if (err) console.warn(`Failed to remove torrent ${torrent.infoHash}:`, err.message);
        else console.log(`Torrent ${torrent.infoHash} removed after TTL`);
      });
      activeTorrents.delete(torrent.infoHash);
    }
  }, TORRENT_TTL_MS);
}

// POST /api/torrent/add  { magnet: string }
// Returns { streamUrl, files: [{ name, size, streamUrl }] }
app.post('/api/torrent/add', (req, res) => {
  const { magnet } = req.body || {};
  if (!magnet || typeof magnet !== 'string') {
    return res.status(400).json({ error: 'magnet field required' });
  }

  // Return existing torrent if already added
  const existing = torrentClient.get(magnet);
  if (existing) {
    activeTorrents.set(existing.infoHash, existing);
    const files = existing.files.map((f, i) => ({
      name: f.name,
      size: f.length,
      streamUrl: `/api/torrent/stream/${existing.infoHash}/${i}`
    }));
    return res.json({
      infoHash: existing.infoHash,
      name: existing.name,
      files,
      streamUrl: files[0]?.streamUrl || null
    });
  }

  torrentClient.add(magnet, (torrent) => {
    activeTorrents.set(torrent.infoHash, torrent);
    scheduleTorrentCleanup(torrent);

    const files = torrent.files.map((f, i) => ({
      name: f.name,
      size: f.length,
      streamUrl: `/api/torrent/stream/${torrent.infoHash}/${i}`
    }));

    res.json({
      infoHash: torrent.infoHash,
      name: torrent.name,
      files,
      streamUrl: files[0]?.streamUrl || null
    });
  });

  torrentClient.once('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });
});

// GET /api/torrent/stream/:infoHash/:fileIndex
// Streams the torrent file with range support
app.get('/api/torrent/stream/:infoHash/:fileIndex', (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = activeTorrents.get(infoHash) || torrentClient.get(infoHash);
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not found. Add it first via POST /api/torrent/add' });
  }

  const idx = parseInt(fileIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= torrent.files.length) {
    return res.status(400).json({ error: 'Invalid file index' });
  }

  const file = torrent.files[idx];
  const fileSize = file.length;
  const rangeHeader = req.headers.range;

  // Determine mime type from extension
  const ext = file.name.split('.').pop().toLowerCase();
  const mimeTypes = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
    mp3: 'audio/mpeg', aac: 'audio/aac', flac: 'audio/flac',
    ogg: 'audio/ogg', wav: 'audio/wav'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    file.createReadStream({ start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    file.createReadStream().pipe(res);
  }
});

// ---------------------------------------------------------------------------
// Real-Debrid proxy
// ---------------------------------------------------------------------------
const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

// POST /api/realdebrid/unrestrict  { apiKey: string, link: string }
// Returns { download, filename, filesize, mimeType, ... }
app.post('/api/realdebrid/unrestrict', async (req, res) => {
  const { apiKey, link } = req.body || {};
  if (!apiKey || !link) {
    return res.status(400).json({ error: 'apiKey and link fields required' });
  }

  // Reject non-http(s) links to prevent SSRF via the RD API
  let parsedLink;
  try {
    parsedLink = new URL(link);
  } catch {
    return res.status(400).json({ error: 'Invalid link URL' });
  }
  if (!['http:', 'https:'].includes(parsedLink.protocol)) {
    return res.status(400).json({ error: 'Only http/https links are supported' });
  }

  try {
    const params = new URLSearchParams({ link });
    const response = await axios.post(`${RD_BASE}/unrestrict/link`, params.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error || err.message;
    res.status(status).json({ error: message });
  }
});

// POST /api/realdebrid/check  { apiKey: string }
// Returns user info (to verify API key validity)
app.post('/api/realdebrid/check', async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
  try {
    const response = await axios.get(`${RD_BASE}/user`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000
    });
    res.json({ username: response.data.username, premium: response.data.premium > 0 });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Invalid API key or Real-Debrid unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Socket.io – room sync
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // ── create-room ──────────────────────────────────────────────────────────
  socket.on('create-room', ({ source, mode } = {}) => {
    if (!source?.url) {
      socket.emit('error', { message: 'source.url is required' });
      return;
    }
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    const room = createRoom(roomId);
    room.source = source;
    room.masterId = socket.id;
    room.members.set(socket.id, { mode: mode || 'video', userAgent: socket.handshake.headers['user-agent'] || '' });
    rooms.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('room-joined', { room: roomPublic(room), isMaster: true });
  });

  // ── join-room ─────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, mode } = {}) => {
    const id = (roomId || '').toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      socket.emit('error', { message: `Room "${id}" not found` });
      return;
    }

    room.members.set(socket.id, { mode: mode || 'audio', userAgent: socket.handshake.headers['user-agent'] || '' });
    if (!room.masterId) room.masterId = socket.id;

    socket.join(id);
    socket.data.roomId = id;

    const isMaster = room.masterId === socket.id;
    socket.emit('room-joined', { room: roomPublic(room), isMaster });

    // Notify others in the room
    socket.to(id).emit('member-joined', { memberCount: room.members.size, mode });
  });

  // ── sync-state (master -> all) ────────────────────────────────────────────
  socket.on('sync-state', ({ isPlaying, currentTime } = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.masterId !== socket.id) return;

    room.playback = { isPlaying, currentTime, updatedAt: Date.now() };
    socket.to(roomId).emit('sync-state', room.playback);
  });

  // ── request-sync (slave asks for current state) ───────────────────────────
  socket.on('request-sync', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit('sync-state', room.playback);
  });

  // ── transfer-master ───────────────────────────────────────────────────────
  socket.on('transfer-master', ({ targetSocketId } = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.masterId !== socket.id) return;
    if (!room.members.has(targetSocketId)) return;

    room.masterId = targetSocketId;
    io.to(roomId).emit('master-changed', { masterId: room.masterId });
  });

  // ── chat-message ──────────────────────────────────────────────────────────
  socket.on('chat-message', ({ text } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(socket.id);
    io.to(roomId).emit('chat-message', {
      id: uuidv4(),
      text: String(text || '').slice(0, 500),
      mode: member?.mode || 'unknown',
      ts: Date.now()
    });
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(socket.id);

    if (room.members.size === 0) {
      rooms.delete(roomId);
      return;
    }

    // If master left, assign first remaining member as new master
    if (room.masterId === socket.id) {
      room.masterId = room.members.keys().next().value;
      io.to(roomId).emit('master-changed', { masterId: room.masterId });
    }

    io.to(roomId).emit('member-left', { memberCount: room.members.size });
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎬  audio-shareplayer  listening on  http://localhost:${PORT}\n`);
});
