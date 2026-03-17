// main.js - Electron main process
// Handles window creation, IPC, serial connection, and G-code queue sending

const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { SerialPort } = require('serialport');

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** @type {BrowserWindow | null} */
let cameraWindow = null;

/** @type {SerialPort | null} */
let serialPort = null;

// G-code queue state
let gcodeQueue = [];
let currentLineIndex = 0;
let isSendingQueue = false;
let isPaused = false;

// Buffer for assembling complete serial lines
let serialLineBuffer = '';

// Last reported position (from GRBL status streaming)
/** @type {{ x: number, y: number, z: number, source: 'MPos' | 'WPos' } | null} */
let lastReportedPosition = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openCameraWindow({ deviceId, zoom }) {
  const displays = screen.getAllDisplays();
  const targetDisplay = displays.length > 1 ? displays[1] : screen.getPrimaryDisplay();
  const bounds = targetDisplay.bounds;

  const safeZoom = Number.isFinite(Number(zoom)) ? Math.max(1, Math.min(6, Number(zoom))) : 1;
  const qs = new URLSearchParams({
    deviceId: deviceId ? String(deviceId) : '',
    zoom: safeZoom.toFixed(3),
  }).toString();

  if (cameraWindow && !cameraWindow.isDestroyed()) {
    try {
      cameraWindow.setBounds(bounds);
      cameraWindow.show();
      cameraWindow.focus();
      cameraWindow.loadFile(path.join(__dirname, 'camera.html'), { search: `?${qs}` });
      cameraWindow.setFullScreen(false);
      cameraWindow.maximize();
      return;
    } catch {
      // fall through to recreate
    }
  }

  cameraWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  cameraWindow.on('closed', () => {
    cameraWindow = null;
  });

  cameraWindow.loadFile(path.join(__dirname, 'camera.html'), { search: `?${qs}` });
  cameraWindow.setFullScreen(false);
  cameraWindow.maximize();
}

// Helper to safely send events to renderer
function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Reset G-code queue state
function resetQueue() {
  gcodeQueue = [];
  currentLineIndex = 0;
  isSendingQueue = false;
  isPaused = false;
}

// Send next line from the G-code queue when GRBL is ready
function sendNextQueuedLine() {
  if (!isSendingQueue || isPaused) {
    return;
  }

  if (!serialPort || !serialPort.isOpen) {
    sendToRenderer('serial:status', {
      connected: false,
      error: 'Serial port is not open. Stopping queue.',
    });
    resetQueue();
    return;
  }

  if (currentLineIndex >= gcodeQueue.length) {
    // Finished
    sendToRenderer('gcode:queueComplete', {});
    resetQueue();
    return;
  }

  let line = gcodeQueue[currentLineIndex] || '';
  line = line.trim();

  // Skip empty/comment-only lines
  if (!line || line.startsWith(';') || line.startsWith('(')) {
    currentLineIndex += 1;
    sendNextQueuedLine();
    return;
  }

  // Actually write to serial
  serialPort.write(line + '\n', (err) => {
    if (err) {
      sendToRenderer('serial:status', {
        connected: !!(serialPort && serialPort.isOpen),
        error: `Error writing to serial: ${err.message}`,
      });
      resetQueue();
      return;
    }

    // Report the line we just sent
    sendToRenderer('gcode:sentLine', {
      index: currentLineIndex,
      line,
    });

    // Only advance index here; next call will be triggered by GRBL "ok"/"error"
    currentLineIndex += 1;
  });
}

// Parse GRBL status line for machine position, e.g.:
// <Idle|MPos:0.000,0.000,0.000|FS:0,0>
function parseAndSendMachinePosition(line) {
  const mpos = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
  const wpos = mpos ? null : line.match(/WPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
  const m = mpos || wpos;
  if (!m) return;

  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);

  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
    lastReportedPosition = { x, y, z, source: mpos ? 'MPos' : 'WPos' };
    sendToRenderer('machine:position', { x, y, z });
  }
}

function attachSerialEventHandlers() {
  if (!serialPort) return;

  serialPort.on('open', () => {
    sendToRenderer('serial:status', {
      connected: true,
      port: serialPort.path,
      message: 'Serial port opened.',
    });
  });

  serialPort.on('error', (err) => {
    sendToRenderer('serial:status', {
      connected: !!(serialPort && serialPort.isOpen),
      error: `Serial error: ${err.message}`,
    });
  });

  serialPort.on('close', () => {
    sendToRenderer('serial:status', {
      connected: false,
      message: 'Serial port closed.',
    });
    resetQueue();
  });

  serialPort.on('data', (data) => {
    const text = data.toString('utf8');
    serialLineBuffer += text;

    let newlineIndex;
    while ((newlineIndex = serialLineBuffer.indexOf('\n')) !== -1) {
      const rawLine = serialLineBuffer.slice(0, newlineIndex);
      serialLineBuffer = serialLineBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (!line) continue;

      // Forward everything to renderer terminal
      sendToRenderer('serial:data', { line });

      // Parse machine position if present
      parseAndSendMachinePosition(line);

      // Advance queue on "ok" or "error"
      if (isSendingQueue && !isPaused) {
        if (/^ok\b/i.test(line) || /^error\b/i.test(line)) {
          sendNextQueuedLine();
        }
      }
    }
  });
}

// IPC: open G-code file dialog and read content
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open G-code file',
    filters: [
      { name: 'G-code Files', extensions: ['gcode', 'nc', 'tap', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return { canceled: false, filePath, content };
  } catch (err) {
    return {
      canceled: false,
      filePath,
      error: err.message || String(err),
    };
  }
});

// IPC: connect to a GRBL device
ipcMain.handle('serial:connect', async (_event, { path, baudRate }) => {
  // Close existing port first
  if (serialPort && serialPort.isOpen) {
    try {
      serialPort.close();
    } catch {
      // ignore
    }
  }

  serialPort = new SerialPort({
    path,
    baudRate: Number(baudRate) || 115200,
    autoOpen: true,
  });

  attachSerialEventHandlers();

  // Let the renderer know we are attempting connection
  sendToRenderer('serial:status', {
    connected: false,
    port: path,
    message: 'Opening serial port...',
  });

  return { success: true };
});

// IPC: disconnect from GRBL
ipcMain.handle('serial:disconnect', async () => {
  if (serialPort) {
    try {
      if (serialPort.isOpen) {
        serialPort.close();
      }
    } catch {
      // ignore closing errors
    }
    serialPort = null;
  }
  resetQueue();
  return { success: true };
});

// IPC: open camera pop-out window on second display (if available)
ipcMain.handle('camera:open', async (_event, payload) => {
  const deviceId = payload && typeof payload === 'object' ? payload.deviceId : '';
  const zoom = payload && typeof payload === 'object' ? payload.zoom : 1;
  try {
    openCameraWindow({ deviceId, zoom });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

// IPC: queue G-code lines and start sending
ipcMain.handle('gcode:queue', async (_event, payload) => {
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: 'Serial port is not connected.' };
  }

  /** @type {string[]} */
  let lines = [];
  /** @type {number} */
  let zLiftMm = 10;

  // Backwards compatible payload:
  // - old: lines[]
  // - new: { lines: string[], zLiftMm?: number }
  if (Array.isArray(payload)) {
    lines = payload;
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.lines)) {
      lines = payload.lines;
    }
    const maybeLift = Number(payload.zLiftMm);
    if (Number.isFinite(maybeLift) && maybeLift >= 0) {
      zLiftMm = maybeLift;
    }
  }

  if (!Array.isArray(lines) || !lines.length) {
    return { success: false, error: 'No G-code lines provided.' };
  }

  const isNearZero = (n) => Math.abs(Number(n) || 0) <= 0.0005;
  const shouldLiftZBeforeStart =
    !!lastReportedPosition &&
    isNearZero(lastReportedPosition.x) &&
    isNearZero(lastReportedPosition.y) &&
    isNearZero(lastReportedPosition.z) &&
    zLiftMm > 0;

  const preamble = shouldLiftZBeforeStart
    ? [
        'G91',     // relative mode
        `G0 Z${zLiftMm.toFixed(3)}`, // lift Z by configured amount
        'G90',     // back to absolute
      ]
    : [];

  gcodeQueue = preamble.concat(lines);
  currentLineIndex = 0;
  isSendingQueue = true;
  isPaused = false;

  sendToRenderer('gcode:queueStarted', {
    total: gcodeQueue.length,
    zLiftPreambleApplied: shouldLiftZBeforeStart,
  });

  // Kick off the first line; subsequent ones are driven by GRBL responses
  sendNextQueuedLine();

  return { success: true, total: gcodeQueue.length };
});

// IPC: pause queue
ipcMain.handle('gcode:pause', async () => {
  isPaused = true;
  return { success: true };
});

// IPC: resume queue
ipcMain.handle('gcode:resume', async () => {
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: 'Serial port is not connected.' };
  }
  if (!isSendingQueue) {
    return { success: false, error: 'No active queue.' };
  }
  if (!isPaused) {
    return { success: true };
  }

  isPaused = false;
  // Continue from current position
  sendNextQueuedLine();
  return { success: true };
});

// IPC: stop queue and optionally send a GRBL feed hold
ipcMain.handle('gcode:stop', async () => {
  if (serialPort && serialPort.isOpen) {
    // GRBL feed hold (optional; safe on GRBL)
    try {
      serialPort.write('!\n');
    } catch {
      // ignore
    }
  }
  resetQueue();
  return { success: true };
});

// IPC: simple jog controls (X/Y/Z, relative)
ipcMain.handle('gcode:jog', async (_event, { axis, direction, step }) => {
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: 'Serial port is not connected.' };
  }

  const uppercaseAxis = String(axis || '').toUpperCase();
  if (!['X', 'Y', 'Z'].includes(uppercaseAxis)) {
    return { success: false, error: 'Invalid axis for jog.' };
  }

  const dir = direction === '-' ? -1 : 1;
  const distance = Number(step) || 1.0;
  const amount = dir * distance;

  // Use simple relative move (G91/G90). For more advanced setups, $J= jog could be used.
  const cmds = [
    'G91', // relative mode
    `G0 ${uppercaseAxis}${amount.toFixed(3)}`, // rapid move
    'G90', // back to absolute
  ];

  try {
    for (const cmd of cmds) {
      serialPort.write(cmd + '\n');
      sendToRenderer('gcode:sentLine', { line: cmd });
    }
  } catch (err) {
    return {
      success: false,
      error: `Failed to send jog command: ${err.message}`,
    };
  }

  return { success: true };
});

// App lifecycle
app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Basic global error handling so serial disconnects don't crash the app
process.on('uncaughtException', (err) => {
  sendToRenderer('serial:status', {
    connected: !!(serialPort && serialPort.isOpen),
    error: `Uncaught exception: ${err.message}`,
  });
});

