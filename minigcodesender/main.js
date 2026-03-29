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

/** Poslední cesta z IPC connect (záloha, když serialPort.path v open je prázdná) */
let lastSerialConnectPath = null;

// G-code queue state
let gcodeQueue = [];
let currentLineIndex = 0;
let isSendingQueue = false;
let isPaused = false;
/** Lines to send before next queued line (e.g. Z-lift after resume + jog) */
let pendingInjectLines = [];
/** Z lift (mm) from last Start — reused on Resume */
let lastQueueZLiftMm = 0;

/** @type {ReturnType<typeof setInterval> | null} */
let grblStatusPollTimer = null;

// Buffer for assembling complete serial lines
let serialLineBuffer = '';

// Last reported work position (from GRBL status streaming)
/** @type {{ x: number, y: number, z: number, source: 'WPos' | 'derived' } | null} */
let lastReportedPosition = null;

/** Cached WCO from status (WPos = MPos − WCO); used when WPos is omitted from report */
/** @type {{ x: number, y: number, z: number } | null} */
let lastWorkCoordOffset = null;

function clearGrblPositionCache() {
  lastReportedPosition = null;
  lastWorkCoordOffset = null;
}

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
  pendingInjectLines = [];
  lastQueueZLiftMm = 0;
}

function startGrblStatusPolling() {
  stopGrblStatusPolling();
  grblStatusPollTimer = setInterval(() => {
    if (!serialPort || !serialPort.isOpen) return;
    try {
      serialPort.write('?');
    } catch {
      // ignore
    }
  }, 200);
}

function stopGrblStatusPolling() {
  if (grblStatusPollTimer != null) {
    clearInterval(grblStatusPollTimer);
    grblStatusPollTimer = null;
  }
}

/**
 * Vyřízne jednu zprávu z bufferu (řádek, ok/error, nebo status <...>).
 * @returns {{ line: string | null, rest: string }}
 */
function pullNextGrblMessage(buf) {
  if (!buf.length) return { line: null, rest: buf };
  if (buf[0] === '<') {
    const gt = buf.indexOf('>');
    if (gt === -1) return { line: null, rest: buf };
    const line = buf.slice(0, gt + 1);
    let rest = buf.slice(gt + 1).replace(/^[\r\n]+/, '');
    return { line, rest };
  }
  const m = buf.match(/^([\s\S]*?)(\r\n|\n|\r)/);
  if (!m) return { line: null, rest: buf };
  return { line: m[1], rest: buf.slice(m[0].length) };
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

  const writeQueuedLine = (line, advanceIndexAfterSend) => {
    serialPort.write(line + '\n', (err) => {
      if (err) {
        sendToRenderer('serial:status', {
          connected: !!(serialPort && serialPort.isOpen),
          error: `Error writing to serial: ${err.message}`,
        });
        resetQueue();
        return;
      }

      sendToRenderer('gcode:sentLine', {
        index: advanceIndexAfterSend ? currentLineIndex : -1,
        line,
        fromQueue: true,
      });

      if (advanceIndexAfterSend) {
        currentLineIndex += 1;
      }
    });
  };

  // After Resume: Z-lift before continuing the program (safe after jog)
  while (pendingInjectLines.length > 0) {
    const raw = pendingInjectLines.shift();
    let inj = String(raw || '').trim();
    if (!inj || inj.startsWith(';') || inj.startsWith('(')) continue;
    writeQueuedLine(inj, false);
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

  writeQueuedLine(line, true);
}

// Parse GRBL status line for work position (vůči aktivnímu work offsetu, typicky G54).
// <Idle|MPos:1.000,2.000,0.000|WPos:0.000,0.000,0.000|WCO:1.000,2.000,0.000|FS:0,0>
// UI vždy dostane X/Y/Z jako WPos; pokud report WPos neobsahuje, dopočítáme MPos − WCO.
function parseAndSendMachinePosition(line) {
  const mposM = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
  const wposM = line.match(/WPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
  const wcoM = line.match(/WCO:([-\d.]+),([-\d.]+),([-\d.]+)/i);

  const read = (m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    z: Number(m[3]),
  });

  const mpos = mposM ? read(mposM) : null;
  const wpos = wposM ? read(wposM) : null;
  const wcoFromLine = wcoM ? read(wcoM) : null;

  const finite = (p) =>
    p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z);

  if (finite(wcoFromLine)) {
    lastWorkCoordOffset = wcoFromLine;
  }

  if (finite(mpos) && finite(wpos)) {
    lastWorkCoordOffset = {
      x: mpos.x - wpos.x,
      y: mpos.y - wpos.y,
      z: mpos.z - wpos.z,
    };
  }

  if (finite(wpos)) {
    lastReportedPosition = { ...wpos, source: 'WPos' };
    sendToRenderer('machine:position', {
      x: wpos.x,
      y: wpos.y,
      z: wpos.z,
    });
    return;
  }

  if (finite(mpos) && finite(lastWorkCoordOffset)) {
    const wx = mpos.x - lastWorkCoordOffset.x;
    const wy = mpos.y - lastWorkCoordOffset.y;
    const wz = mpos.z - lastWorkCoordOffset.z;
    lastReportedPosition = { x: wx, y: wy, z: wz, source: 'derived' };
    sendToRenderer('machine:position', {
      x: wx,
      y: wy,
      z: wz,
    });
  }
}

function attachSerialEventHandlers() {
  if (!serialPort) return;

  serialPort.on('open', () => {
    serialLineBuffer = '';
    startGrblStatusPolling();
    const portPath =
      (serialPort && serialPort.path) || lastSerialConnectPath || '';
    sendToRenderer('serial:status', {
      connected: true,
      port: portPath,
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
    stopGrblStatusPolling();
    clearGrblPositionCache();
    sendToRenderer('serial:status', {
      connected: false,
      message: 'Serial port closed.',
    });
    resetQueue();
  });

  serialPort.on('data', (data) => {
    const text = data.toString('utf8');
    serialLineBuffer += text;

    while (true) {
      const { line: raw, rest } = pullNextGrblMessage(serialLineBuffer);
      if (!raw) {
        serialLineBuffer = rest;
        break;
      }
      serialLineBuffer = rest;

      const line = raw.trim();
      if (!line) continue;

      sendToRenderer('serial:data', { line });
      parseAndSendMachinePosition(line);

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
  stopGrblStatusPolling();
  clearGrblPositionCache();
  lastSerialConnectPath = path != null && String(path).trim() ? String(path).trim() : null;
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
  stopGrblStatusPolling();
  clearGrblPositionCache();
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

  const stripGcodeComments = (raw) => {
    let s = String(raw || '').replace(/\(.*?\)/g, '');
    const semi = s.indexOf(';');
    if (semi >= 0) s = s.slice(0, semi);
    return s.trim();
  };

  /** X/Y token (i G0X10 — mezi číslicí a X není \b v JS). */
  const hasAxis = (u, letter) =>
    new RegExp(`(?:^|[^A-Z])${letter}\\s*[-+]?\\d*\\.?\\d+|(?:^|[^A-Z])${letter}\\s*[-+]?\\.\\d+`, 'i').test(
      u,
    );

  /** První řádek, který mění X nebo Y (jako běžné CAM: G0X0Y0, X1 Y1, …). */
  const isFirstXyMotionLine = (raw) => {
    const s = stripGcodeComments(raw);
    if (!s) return false;
    const upper = s.toUpperCase();
    if (/\bG10\b/.test(upper)) return false;
    if (/\bT\d+\b/.test(upper) && !hasAxis(upper, 'X') && !hasAxis(upper, 'Y')) return false;
    return hasAxis(upper, 'X') || hasAxis(upper, 'Y');
  };

  /**
   * Jeden řádek G0/G1 s X/Y i Z → rozdělit, aby po relativním liftu nejel šikmo do materiálu.
   * Oblouky nerozdělujeme.
   */
  const splitLinearXyzLine = (raw) => {
    const cleaned = stripGcodeComments(raw);
    if (!cleaned) return null;
    const upper = cleaned.toUpperCase();
    if (/\bG2\b|\bG02\b|\bG3\b|\bG03\b/.test(upper)) return null;
    const hasX = hasAxis(upper, 'X');
    const hasY = hasAxis(upper, 'Y');
    const zMatch = cleaned.match(/(?:^|[^A-Z])Z\s*([-+]?\d*\.?\d+|\.\d+)/i);
    if (!(hasX || hasY) || !zMatch) return null;
    const xyLine = cleaned
      .replace(/(?:^|[^A-Z])Z\s*[-+]?\d*\.?\d+/i, '')
      .replace(/(?:^|[^A-Z])Z\s*\.\d+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!xyLine) return null;
    const fMatch = cleaned.match(/\bF\s*[-+]?\d*\.?\d+/i);
    const gLead = upper.match(/^(G00|G01|G0|G1)(?=[XYIJZFR.\d\s+-]|$)/i);
    let g = 'G1';
    if (gLead) {
      const t = gLead[1].toUpperCase();
      g = t.startsWith('G0') ? 'G0' : 'G1';
    }
    let zLine = `${g} Z${zMatch[1]}`;
    if (fMatch) zLine += ` ${fMatch[0]}`;
    return [xyLine, zLine];
  };

  /** @type {string[]} */
  const finalQueue = lines.slice();

  let zLiftApplied = false;
  if (zLiftMm > 0) {
    const idx = finalQueue.findIndex(isFirstXyMotionLine);
    if (idx >= 0) {
      const original = finalQueue[idx];
      const parts = splitLinearXyzLine(original);
      if (parts) {
        finalQueue.splice(idx, 1, parts[0], parts[1]);
      }
      const insertAt = finalQueue.findIndex(isFirstXyMotionLine);
      const liftBlock = ['G91', `G0 Z${zLiftMm.toFixed(3)}`, 'G90'];
      finalQueue.splice(insertAt >= 0 ? insertAt : 0, 0, ...liftBlock);
      zLiftApplied = true;
    } else {
      finalQueue.unshift('G91', `G0 Z${zLiftMm.toFixed(3)}`, 'G90');
      zLiftApplied = true;
    }
  }

  gcodeQueue = finalQueue;
  currentLineIndex = 0;
  isSendingQueue = true;
  isPaused = false;
  pendingInjectLines = [];
  lastQueueZLiftMm = zLiftMm;

  sendToRenderer('gcode:queueStarted', {
    total: gcodeQueue.length,
    zLiftPreambleApplied: zLiftApplied,
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

  const lift = Number(lastQueueZLiftMm);
  if (Number.isFinite(lift) && lift > 0) {
    pendingInjectLines.push('G91', `G0 Z${lift.toFixed(3)}`, 'G90');
  }

  sendNextQueuedLine();
  return { success: true };
});

// IPC: stop queue — soft reset GRBL vyčistí buffer; pak $X odemkne alarm (error:9 bez $X)
ipcMain.handle('gcode:stop', async () => {
  if (serialPort && serialPort.isOpen) {
    try {
      serialPort.write(Buffer.from([0x18]));
    } catch {
      try {
        serialPort.write('!\n');
      } catch {
        // ignore
      }
    }
  }
  resetQueue();
  sendToRenderer('gcode:aborted', {});
  if (serialPort && serialPort.isOpen) {
    setTimeout(() => {
      if (!serialPort || !serialPort.isOpen) return;
      try {
        serialPort.write('$X\n');
        sendToRenderer('gcode:sentLine', { line: '$X', fromQueue: false });
      } catch {
        // ignore
      }
    }, 200);
  }
  return { success: true };
});

// IPC: send one-off G-code lines (not queued)
ipcMain.handle('gcode:sendLines', async (_event, lines) => {
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: 'Serial port is not connected.' };
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return { success: false, error: 'No lines provided.' };
  }

  try {
    for (const raw of lines) {
      const line = String(raw || '').trim();
      if (!line) continue;
      serialPort.write(line + '\n');
      sendToRenderer('gcode:sentLine', { line, fromQueue: false });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
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
      sendToRenderer('gcode:sentLine', { line: cmd, fromQueue: false });
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

