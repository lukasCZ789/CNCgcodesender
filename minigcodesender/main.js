// main.js - Electron main process
// Handles window creation, IPC, serial connection, and G-code queue sending

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { SerialPort } = require('serialport');

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** @type {SerialPort | null} */
let serialPort = null;

// G-code queue state
let gcodeQueue = [];
let currentLineIndex = 0;
let isSendingQueue = false;
let isPaused = false;

// Buffer for assembling complete serial lines
let serialLineBuffer = '';

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
  const m = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/i) ||
            line.match(/WPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
  if (!m) return;

  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);

  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
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

// IPC: queue G-code lines and start sending
ipcMain.handle('gcode:queue', async (_event, lines) => {
  if (!serialPort || !serialPort.isOpen) {
    return { success: false, error: 'Serial port is not connected.' };
  }

  if (!Array.isArray(lines) || !lines.length) {
    return { success: false, error: 'No G-code lines provided.' };
  }

  gcodeQueue = lines;
  currentLineIndex = 0;
  isSendingQueue = true;
  isPaused = false;

  sendToRenderer('gcode:queueStarted', {
    total: gcodeQueue.length,
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

