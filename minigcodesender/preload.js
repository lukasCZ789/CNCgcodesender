// preload.js
// Runs in isolated context; exposes a safe API to the renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File dialog / G-code loading
  openGcodeFile: () => ipcRenderer.invoke('dialog:openFile'),

  // Serial connection
  connectSerial: (config) => ipcRenderer.invoke('serial:connect', config),
  disconnectSerial: () => ipcRenderer.invoke('serial:disconnect'),

  // G-code queue control
  sendGcodeQueue: (payload) => ipcRenderer.invoke('gcode:queue', payload),
  pauseGcode: () => ipcRenderer.invoke('gcode:pause'),
  resumeGcode: () => ipcRenderer.invoke('gcode:resume'),
  stopGcode: () => ipcRenderer.invoke('gcode:stop'),

  // Jogging
  sendJog: (payload) => ipcRenderer.invoke('gcode:jog', payload),

  // Camera pop-out window
  openCameraWindow: (payload) => ipcRenderer.invoke('camera:open', payload),

  // Event subscriptions
  onSerialStatus: (callback) => {
    ipcRenderer.on('serial:status', (_event, data) => callback(data));
  },
  onSerialData: (callback) => {
    ipcRenderer.on('serial:data', (_event, data) => callback(data));
  },
  onMachinePosition: (callback) => {
    ipcRenderer.on('machine:position', (_event, pos) => callback(pos));
  },
  onGcodeSentLine: (callback) => {
    ipcRenderer.on('gcode:sentLine', (_event, info) => callback(info));
  },
  onGcodeQueueStarted: (callback) => {
    ipcRenderer.on('gcode:queueStarted', (_event, info) => callback(info));
  },
  onGcodeQueueComplete: (callback) => {
    ipcRenderer.on('gcode:queueComplete', () => callback());
  },
});

