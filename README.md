# 🎬 audio-shareplayer

A web app that lets you **stream video on your PC browser** while your **mobile phone plays the audio** — perfectly synchronized in real-time.

## Features

| Feature | Description |
|---|---|
| 🖥️ **Video on PC** | Full video + audio playback on desktop browser |
| 📱 **Audio on mobile** | Audio-only experience on phone, synced to PC |
| 🔄 **Real-time sync** | Play / pause / seek synced instantly via WebSocket |
| ⚡ **Torrent streaming** | Stream magnet links directly via WebTorrent |
| 🔑 **Real-Debrid** | Unrestrict premium links with your API key |
| 📡 **HLS / MP4 / WEBM** | Any browser-compatible stream URL |

## Quick start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Usage

1. **Create a room** on your PC — paste a stream URL, magnet link, or Real-Debrid link
2. The app generates a short **room code** (e.g. `A1B2C3D4`)
3. Open `http://<your-ip>:3000/?join=A1B2C3D4` on your phone (or scan the QR code)
4. Select **Audio only** mode on the phone
5. Press play on either device — playback stays in sync

## Sync mechanism

- The first device to create the room becomes the **Master** (controls playback)
- All other devices are **Slaves** that follow the master's play / pause / seek state
- A drift-correction algorithm re-syncs slaves if they fall more than 2.5 seconds behind

## Torrent streaming

POST `/api/torrent/add` with `{ "magnet": "magnet:?xt=..." }` — the server will start
downloading via WebTorrent and return an HTTP stream URL for the first video file found.

## Real-Debrid

POST `/api/realdebrid/unrestrict` with `{ "apiKey": "...", "link": "..." }` — the server proxies
the request to the Real-Debrid API and returns the direct download URL.  
Your API key is **never stored** on the server.

## Requirements

- Node.js ≥ 18
