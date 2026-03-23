'use strict';
const { app, BrowserWindow, shell } = require('electron');
const net = require('net');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Poll until the Express server is accepting connections
function waitForServer(port, maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function tryConnect() {
      const socket = net.createConnection(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        attempts += 1;
        if (attempts >= maxAttempts) {
          reject(new Error(`Server did not start on port ${port} after ${maxAttempts} attempts`));
        } else {
          setTimeout(tryConnect, 300);
        }
      });
    }
    tryConnect();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: 'audio-shareplayer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadURL(`http://localhost:${PORT}`);

  // Open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // Keep same-origin navigation inside Electron, open others externally
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(async () => {
  // Dynamically import the ESM server so it starts listening
  await import('./server.js');

  // Wait until the server is ready before opening the window
  await waitForServer(PORT);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
