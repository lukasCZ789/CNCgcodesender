'use strict';

// renderer.js - runs in the browser (renderer) process
// Handles UI, G-code parsing, 3D-ish canvas visualization, and IPC calls.

(() => {
  /** @type {HTMLCanvasElement | null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D | null} */
  let ctx = null;

  // Parsed toolpath segments and bounds for re-draws
  let toolpathSegments = [];
  let toolpathBounds = null;

  // Queue / UI state
  let queueState = 'idle'; // 'idle' | 'running' | 'paused'
  let queuedTotal = 0;
  let sentCount = 0;

  // Current G-code file
  let currentFileName = null;
  let currentGcodeLines = [];

  const SETTINGS = {
    lastComPortKey: 'settings.lastComPortPath',
    zLiftMmKey: 'settings.zLiftMm',
    defaultZLiftMm: 10,
    toolDiameterMmKey: 'settings.toolDiameterMm',
    defaultToolDiameterMm: 3.0,
    jogStepsKey: 'settings.jogSteps',
    defaultJogSteps: 1,
    /** mm sent to GRBL per one “krok” in the jog field */
    JOG_MM_PER_STEP: 1,
    cameraDeviceIdKey: 'settings.camera.deviceId',
    cameraZoomKey: 'settings.camera.zoom',
    defaultCameraZoom: 1,
  };

  const SIM_SPEED_MM_PER_SEC = 120;
  /** @type {number | null} */
  let simulationRaf = null;
  /** @type {{running:boolean, segmentIndex:number, segmentT:number, lastTs:number, completedLength:number, currentPoint:{x:number,y:number,z:number} | null}} */
  let simulationState = {
    running: false,
    segmentIndex: 0,
    segmentT: 0,
    lastTs: 0,
    completedLength: 0,
    currentPoint: null,
  };

  /** True while sending the loaded file queue — tool follows real GRBL stream */
  let liveCncToolSync = false;
  /** @type {{ x: number, y: number, z: number, abs: boolean, mode: 'G0' | 'G1' | 'G2' | 'G3' | null }} */
  let liveInterp = {
    x: 0,
    y: 0,
    z: 0,
    abs: true,
    mode: null,
  };
  /** @type {{ x: number, y: number, z: number }[]} */
  let liveCutPath = [];
  let liveCutPathStarted = false;

  // Canvas camera: world mm + pixels/mm, wheel zoom, 2D shora / 3D rotace
  /** Jedna událost kolečka: blíž 1 = jemnější zoom (dřív ~0.92 ≈ 8 % krok) */
  const VIEW_ZOOM_WHEEL_RATIO = 0.97;

  /** @type {'2d' | '3d'} */
  let viewMode = '2d';
  let camCenterX = 0;
  let camCenterY = 0;
  let camCenterZ = 0;
  let camPxPerMm = 4;
  let serialConnected = false;
  let lastWorkPosition = { x: 0, y: 0, z: 0 };

  // Interactive 3D view rotation (drag on canvas); v 2D stejný tah posouvá pohled
  let viewYaw = -Math.PI / 4;   // around Z axis
  let viewPitch = 0.65;         // around X axis
  let isDraggingView = false;
  let lastDragX = 0;
  let lastDragY = 0;

  function $(id) {
    return document.getElementById(id);
  }

  /** Windows: číslo 3 → COM3; jinak nechá cestu jak je */
  function normalizeSerialPath(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^com\d+$/i.test(s)) return s.toUpperCase();
    if (/^\d+$/.test(s)) return `COM${s}`;
    const winSfx = s.match(/(COM\d+)$/i);
    if (winSfx) return winSfx[1].toUpperCase();
    return s;
  }

  /** Jednotné uložení do localStorage (Windows → COMn) */
  function comPathForStorage(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/(COM\d+)$/i);
    if (m) return m[1].toUpperCase();
    return s;
  }

  /** Hodnota do pole: u COM jen číslo, jinak celá cesta (Linux / …) */
  function comPathForInputDisplay(stored) {
    const s = String(stored || '').trim();
    if (!s) return '';
    const m = /^COM(\d+)$/i.exec(s);
    if (m) return m[1];
    return s;
  }

  function readJogStepsFromUi() {
    const input = /** @type {HTMLInputElement | null} */ ($('jog-step-input'));
    const raw = input && input.value !== undefined ? String(input.value) : '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return SETTINGS.defaultJogSteps;
    return n;
  }

  function setJogStepsUi(value) {
    const input = /** @type {HTMLInputElement | null} */ ($('jog-step-input'));
    if (!input) return;
    const n = Number(value);
    const v = Number.isFinite(n) && n > 0 ? n : SETTINGS.defaultJogSteps;
    input.value = String(v);
  }

  function loadJogStepsIntoUi() {
    try {
      const raw = localStorage.getItem(SETTINGS.jogStepsKey);
      const n = Number(raw);
      setJogStepsUi(Number.isFinite(n) && n > 0 ? n : SETTINGS.defaultJogSteps);
    } catch {
      setJogStepsUi(SETTINGS.defaultJogSteps);
    }
  }

  function persistJogStepsFromUi() {
    try {
      localStorage.setItem(SETTINGS.jogStepsKey, String(readJogStepsFromUi()));
    } catch {
      // ignore
    }
  }

  function multiplyJogSteps(factor) {
    const v = readJogStepsFromUi();
    const next =
      factor >= 1 ? v * factor : Math.max(1e-9, v * factor);
    setJogStepsUi(next);
    persistJogStepsFromUi();
  }

  function readZLiftMmFromUi() {
    const input = /** @type {HTMLInputElement | null} */ ($('zlift-input'));
    const raw = input && input.value !== undefined ? String(input.value) : '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return SETTINGS.defaultZLiftMm;
    return n;
  }

  function setZLiftMmUi(value) {
    const input = /** @type {HTMLInputElement | null} */ ($('zlift-input'));
    if (!input) return;
    const n = Number(value);
    input.value = Number.isFinite(n) && n >= 0 ? String(n) : String(SETTINGS.defaultZLiftMm);
  }

  function loadSettingsIntoUi() {
    try {
      const raw = localStorage.getItem(SETTINGS.zLiftMmKey);
      if (raw == null || raw === '') {
        setZLiftMmUi(SETTINGS.defaultZLiftMm);
        return;
      }
      const n = Number(raw);
      setZLiftMmUi(Number.isFinite(n) && n >= 0 ? n : SETTINGS.defaultZLiftMm);
    } catch {
      setZLiftMmUi(SETTINGS.defaultZLiftMm);
    }
  }

  function persistZLiftMmFromUi() {
    const n = readZLiftMmFromUi();
    try {
      localStorage.setItem(SETTINGS.zLiftMmKey, String(n));
    } catch {
      // ignore storage errors
    }
  }

  function readToolDiameterFromUi() {
    const input = /** @type {HTMLInputElement | null} */ ($('tool-diameter-input'));
    const raw = input && input.value !== undefined ? String(input.value) : '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return SETTINGS.defaultToolDiameterMm;
    return n;
  }

  function loadToolDiameterIntoUi() {
    const input = /** @type {HTMLInputElement | null} */ ($('tool-diameter-input'));
    if (!input) return;
    try {
      const raw = localStorage.getItem(SETTINGS.toolDiameterMmKey);
      const n = Number(raw);
      input.value =
        Number.isFinite(n) && n > 0
          ? String(n)
          : String(SETTINGS.defaultToolDiameterMm);
    } catch {
      input.value = String(SETTINGS.defaultToolDiameterMm);
    }
  }

  function persistToolDiameterFromUi() {
    const n = readToolDiameterFromUi();
    try {
      localStorage.setItem(SETTINGS.toolDiameterMmKey, String(n));
    } catch {
      // ignore
    }
  }

  // --- Camera preview ------------------------------------------------------

  /** @type {MediaStream | null} */
  let cameraStream = null;

  function getCameraElements() {
    return {
      select: /** @type {HTMLSelectElement | null} */ ($('camera-select')),
      video: /** @type {HTMLVideoElement | null} */ ($('camera-video')),
      zoomInput: /** @type {HTMLInputElement | null} */ ($('camera-zoom-input')),
      popoutBtn: $('camera-popout-btn'),
      hint: $('camera-hint'),
    };
  }

  function setCameraHint(text) {
    const { hint } = getCameraElements();
    if (hint) hint.textContent = text;
  }

  function stopCameraStream() {
    if (!cameraStream) return;
    try {
      for (const track of cameraStream.getTracks()) {
        track.stop();
      }
    } catch {
      // ignore
    }
    cameraStream = null;
  }

  function readCameraZoomFromUi() {
    const { zoomInput } = getCameraElements();
    const raw = zoomInput && zoomInput.value !== undefined ? String(zoomInput.value) : '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return SETTINGS.defaultCameraZoom;
    return Math.min(6, n);
  }

  function applyCameraZoom() {
    const { video } = getCameraElements();
    if (!video) return;
    const zoom = readCameraZoomFromUi();
    video.style.transform = `scale(${zoom})`;
    try {
      localStorage.setItem(SETTINGS.cameraZoomKey, String(zoom));
    } catch {
      // ignore
    }
  }

  async function ensureCameraPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraHint('Camera API není dostupné v tomto prostředí.');
      return false;
    }
    // Trigger permission prompt once so labels appear in enumerateDevices().
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      for (const t of tmp.getTracks()) t.stop();
      return true;
    } catch (err) {
      setCameraHint(`Nepodařilo se získat přístup ke kameře: ${err.message || String(err)}`);
      return false;
    }
  }

  async function refreshCameraDeviceList() {
    const { select } = getCameraElements();
    if (!select) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');

    const prev = select.value;
    select.innerHTML = '';

    if (!cams.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No camera devices found';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    for (const cam of cams) {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera (${cam.deviceId.slice(0, 6)}...)`;
      select.appendChild(opt);
    }

    // Restore selection from storage if possible
    let wanted = '';
    try {
      wanted = localStorage.getItem(SETTINGS.cameraDeviceIdKey) || '';
    } catch {
      wanted = '';
    }

    const hasWanted = wanted && cams.some((c) => c.deviceId === wanted);
    if (hasWanted) {
      select.value = wanted;
    } else if (prev && cams.some((c) => c.deviceId === prev)) {
      select.value = prev;
    } else {
      select.selectedIndex = 0;
    }
  }

  async function startCameraPreview(deviceId) {
    const { video } = getCameraElements();
    if (!video) return;

    stopCameraStream();
    setCameraHint('Spouštím kameru...');

    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : { video: true, audio: false };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraStream = stream;
      video.srcObject = stream;
      await video.play().catch(() => {});
      applyCameraZoom();
      setCameraHint('Kamera běží.');
    } catch (err) {
      setCameraHint(`Kameru nelze spustit: ${err.message || String(err)}`);
    }
  }

  async function initCameraUi() {
    const { select, zoomInput, popoutBtn } = getCameraElements();
    if (!select || !zoomInput) return;

    // Load saved zoom
    try {
      const raw = localStorage.getItem(SETTINGS.cameraZoomKey);
      const n = Number(raw);
      zoomInput.value =
        Number.isFinite(n) && n >= 1 ? String(Math.min(6, n)) : String(SETTINGS.defaultCameraZoom);
    } catch {
      zoomInput.value = String(SETTINGS.defaultCameraZoom);
    }
    applyCameraZoom();

    zoomInput.addEventListener('input', applyCameraZoom);
    zoomInput.addEventListener('change', applyCameraZoom);

    const ok = await ensureCameraPermission();
    if (!ok) return;

    await refreshCameraDeviceList();

    select.addEventListener('change', async () => {
      const id = select.value || '';
      try {
        localStorage.setItem(SETTINGS.cameraDeviceIdKey, id);
      } catch {
        // ignore
      }
      await startCameraPreview(id);
    });

    // Auto-start with saved / first device
    const id = select.value || '';
    await startCameraPreview(id);

    if (popoutBtn && window.electronAPI && window.electronAPI.openCameraWindow) {
      popoutBtn.addEventListener('click', async () => {
        const deviceId = select.value || '';
        const zoom = readCameraZoomFromUi();
        try {
          await window.electronAPI.openCameraWindow({ deviceId, zoom });
        } catch (err) {
          setCameraHint(`Nepodařilo se otevřít fullscreen okno: ${err.message || String(err)}`);
        }
      });
    }

    // Keep list updated if devices change
    if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
      navigator.mediaDevices.ondevicechange = async () => {
        const current = select.value;
        await refreshCameraDeviceList();
        const next = select.value || '';
        if (next !== current) {
          await startCameraPreview(next);
        }
      };
    }
  }

  function persistLastComPort(portPath) {
    if (!portPath) return;
    const toStore = comPathForStorage(portPath);
    if (!toStore) return;
    try {
      localStorage.setItem(SETTINGS.lastComPortKey, toStore);
    } catch {
      // ignore
    }
  }

  function loadLastComPortIntoInput() {
    const input = /** @type {HTMLInputElement | null} */ ($('port-input'));
    if (!input) return;
    try {
      const raw = localStorage.getItem(SETTINGS.lastComPortKey);
      if (!raw) return;
      input.value = comPathForInputDisplay(raw);
    } catch {
      // ignore
    }
  }

  /** Méně šumu: status <?>, holá ok, běžné echo */
  function shouldLogSerialRecv(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (t.startsWith('<')) return false;
    if (/^ok\s*$/i.test(t)) return false;
    if (/^\[echo:/i.test(t)) return false;
    return true;
  }

  function appendTerminalLine(text, type) {
    const terminal = $('terminal');
    if (!terminal) return;
    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    line.textContent = text;
    terminal.appendChild(line);

    // Trim to last ~500 lines to avoid unbounded growth
    const maxLines = 500;
    while (terminal.childElementCount > maxLines) {
      terminal.removeChild(terminal.firstChild);
    }

    terminal.scrollTop = terminal.scrollHeight;
  }

  function updateConnectionUI({ connected, message, error, port }) {
    const statusDot = $('status-dot');
    const statusText = $('status-text');
    const headerStatus = $('header-status');
    const connectBtn = $('connect-btn');
    const disconnectBtn = $('disconnect-btn');

    if (!statusDot || !statusText || !headerStatus) return;

    statusDot.className = 'status-dot';
    let text = '';

    if (error) {
      serialConnected = false;
      statusDot.classList.add('error');
      text = `Error: ${error}`;
      appendTerminalLine(`[ERR] ${error}`, 'error');
    } else if (connected) {
      serialConnected = true;
      statusDot.classList.add('connected');
      text = `Connected${port ? ` (${port})` : ''}`;
      if (port) persistLastComPort(port);
    } else {
      serialConnected = false;
      text = message || 'Disconnected';
      updateMachinePosition({ x: 0, y: 0, z: 0 });
    }

    statusText.textContent = text;
    headerStatus.textContent = connected ? 'Connected' : 'Disconnected';

    if (connectBtn && disconnectBtn) {
      connectBtn.disabled = !!connected;
      disconnectBtn.disabled = !connected;
    }
  }

  function setQueueState(newState) {
    queueState = newState;
    const queueStatus = $('queue-status');
    const startBtn = $('start-btn');
    const pauseBtn = $('pause-btn');
    const stopBtn = $('stop-btn');

    if (queueStatus) {
      queueStatus.innerHTML =
        'State: ' +
        (newState === 'running'
          ? '<span class="state-running">Running</span>'
          : newState === 'paused'
          ? '<span class="state-paused">Paused</span>'
          : '<span class="state-idle">Idle</span>') +
        (queuedTotal
          ? ` · Sent <strong>${sentCount}</strong> / <strong>${queuedTotal}</strong>`
          : '');
    }

    if (startBtn && pauseBtn && stopBtn) {
      if (newState === 'idle') {
        startBtn.disabled = currentGcodeLines.length === 0;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
      } else if (newState === 'running') {
        startBtn.disabled = false;
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
      } else if (newState === 'paused') {
        startBtn.disabled = false; // used as Resume
        pauseBtn.disabled = true;
        stopBtn.disabled = false;
      }
    }
  }

  function updateMachinePosition(pos) {
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    lastWorkPosition = { x, y, z };

    const px = $('pos-x');
    const py = $('pos-y');
    const pz = $('pos-z');
    if (px) px.textContent = x.toFixed(3);
    if (py) py.textContent = y.toFixed(3);
    if (pz) pz.textContent = z.toFixed(3);
    drawToolpath();
  }

  async function sendLines(lines) {
    try {
      const res = await window.electronAPI.sendGcodeLines(lines);
      if (!res || res.success === false) {
        appendTerminalLine(
          `[ERR] Command failed: ${(res && res.error) || 'unknown error'}`,
          'error',
        );
        return false;
      }
      return true;
    } catch (err) {
      appendTerminalLine(
        `[ERR] Command failed: ${err.message || String(err)}`,
        'error',
      );
      return false;
    }
  }

  async function setWorkZero(axis) {
    // Set current position to 0 in G54 using G10 L20
    const cmd =
      axis === 'x'
        ? 'G10 L20 P1 X0'
        : axis === 'y'
        ? 'G10 L20 P1 Y0'
        : axis === 'z'
        ? 'G10 L20 P1 Z0'
        : 'G10 L20 P1 X0 Y0';

    const ok = await sendLines(['G90', 'G54', cmd]);
    if (ok) {
      appendTerminalLine(`[SYS] Nula ${axis.toUpperCase()}`, 'system');
    }
  }

  async function goToWorkZero(which) {
    const cmd =
      which === 'xy'
        ? 'G0 X0 Y0'
        : which === 'x'
        ? 'G0 X0'
        : which === 'y'
        ? 'G0 Y0'
        : 'G0 Z0';
    const ok = await sendLines(['G90', 'G54', cmd]);
    if (ok) appendTerminalLine(`[SYS] Jedu na ${which.toUpperCase()}0`, 'system');
  }

  function cleanRawGcodeLine(raw) {
    let line = String(raw || '').replace(/\(.*?\)/g, '');
    const semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    return line.trim();
  }

  function resetLiveToolForQueue() {
    liveInterp = { x: 0, y: 0, z: 0, abs: true, mode: null };
    liveCutPath = [];
    liveCutPathStarted = false;
    simulationState.running = false;
    simulationState.segmentIndex = 0;
    simulationState.segmentT = 0;
    if (toolpathSegments.length) {
      const p0 = toolpathSegments[0].from;
      liveInterp.x = p0.x;
      liveInterp.y = p0.y;
      liveInterp.z = p0.z;
      simulationState.currentPoint = { x: p0.x, y: p0.y, z: p0.z };
    } else {
      simulationState.currentPoint = { x: 0, y: 0, z: 0 };
    }
  }

  function endLiveCncToolSync() {
    liveCncToolSync = false;
  }

  function applyLiveToolLine(rawLine) {
    const line = cleanRawGcodeLine(rawLine);
    if (!line || line.startsWith('(')) return;

    const upper = line.toUpperCase();
    if (upper.startsWith('$')) return;
    if (/\bG10\b/.test(upper)) return;
    if (/\bG28\b/.test(upper) || /\bG30\b/.test(upper)) return;

    const ax = (letter) => {
      const m = upper.match(new RegExp(`${letter}\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
      return m ? Number(m[1]) : null;
    };

    if (/\bG90\b/.test(upper)) liveInterp.abs = true;
    if (/\bG91\b/.test(upper)) liveInterp.abs = false;

    if (/\bG0\b|\bG00\b/.test(upper)) liveInterp.mode = 'G0';
    else if (/\bG1\b|\bG01\b/.test(upper)) liveInterp.mode = 'G1';
    else if (/\bG2\b|\bG02\b/.test(upper)) liveInterp.mode = 'G2';
    else if (/\bG3\b|\bG03\b/.test(upper)) liveInterp.mode = 'G3';

    const nx = ax('X');
    const ny = ax('Y');
    const nz = ax('Z');
    const nI = ax('I');
    const nJ = ax('J');
    const nR = ax('R');

    const isArc =
      liveInterp.mode === 'G2' || liveInterp.mode === 'G3';
    const hasCoord =
      nx != null ||
      ny != null ||
      nz != null ||
      (isArc && (nI != null || nJ != null || nR != null));
    if (!hasCoord || !liveInterp.mode) return;

    const ox = liveInterp.x;
    const oy = liveInterp.y;
    const oz = liveInterp.z;
    let x = liveInterp.x;
    let y = liveInterp.y;
    let z = liveInterp.z;

    if (liveInterp.abs) {
      if (nx != null) x = nx;
      if (ny != null) y = ny;
      if (nz != null) z = nz;
    } else {
      if (nx != null) x += nx;
      if (ny != null) y += ny;
      if (nz != null) z += nz;
    }

    liveInterp.x = x;
    liveInterp.y = y;
    liveInterp.z = z;
    simulationState.currentPoint = { x, y, z };

    const isCutMotion = liveInterp.mode === 'G1' || isArc;
    if (isCutMotion) {
      if (!liveCutPathStarted) {
        liveCutPath.push({ x: ox, y: oy, z: oz });
        liveCutPathStarted = true;
      }
      liveCutPath.push({ x, y, z });
    }
  }

  // --- G-code parsing and 3D-ish projection drawing -----------------------

  function parseGcode(lines) {
    /** @type {{from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}, type:'rapid'|'linear'}[]} */
    const segments = [];

    // Visualization resolution (trade-off: detail vs perf)
    const ARC_MAX_SEGMENTS = 180;
    const ARC_MAX_STEP_MM = 1.0; // smaller => smoother

    let x = 0;
    let y = 0;
    let z = 0;
    let mode = null; // 'G0' | 'G1' | 'G2' | 'G3'
    let lastPoint = { x, y, z };

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const updateBounds = (p) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      maxZ = Math.max(maxZ, p.z);
    };

    const getNum = (upper, letter) => {
      const m = upper.match(new RegExp(`${letter}(-?\\d+(?:\\.\\d+)?)`));
      return m ? Number(m[1]) : null;
    };

    const addLine = (from, to, type) => {
      segments.push({ from: { ...from }, to: { ...to }, type });
      updateBounds(to);
    };

    const approxArcXY = (from, to, center, cw) => {
      const sx = from.x - center.x;
      const sy = from.y - center.y;
      const ex = to.x - center.x;
      const ey = to.y - center.y;

      const r0 = Math.hypot(sx, sy);
      const r1 = Math.hypot(ex, ey);
      const r = (r0 + r1) / 2;
      if (!Number.isFinite(r) || r <= 0) {
        addLine(from, to, 'linear');
        return;
      }

      let a0 = Math.atan2(sy, sx);
      let a1 = Math.atan2(ey, ex);
      let da = a1 - a0;
      if (cw) {
        if (da >= 0) da -= Math.PI * 2;
      } else {
        if (da <= 0) da += Math.PI * 2;
      }

      const arcLen = Math.abs(da) * r;
      const n = Math.max(
        6,
        Math.min(ARC_MAX_SEGMENTS, Math.ceil(arcLen / ARC_MAX_STEP_MM)),
      );

      let prev = { ...from };
      for (let i = 1; i <= n; i += 1) {
        const t = i / n;
        const a = a0 + da * t;
        const p = {
          x: center.x + Math.cos(a) * r,
          y: center.y + Math.sin(a) * r,
          z: from.z + (to.z - from.z) * t,
        };
        addLine(prev, p, 'linear');
        prev = p;
      }
    };

    for (let raw of lines) {
      let line = String(raw || '');
      line = line.replace(/\(.*?\)/g, '');
      const semi = line.indexOf(';');
      if (semi >= 0) line = line.slice(0, semi);
      line = line.trim();
      if (!line) continue;

      const upper = line.toUpperCase();

      // Modal motion
      if (/\bG0\b|\bG00\b/.test(upper)) mode = 'G0';
      else if (/\bG1\b|\bG01\b/.test(upper)) mode = 'G1';
      else if (/\bG2\b|\bG02\b/.test(upper)) mode = 'G2';
      else if (/\bG3\b|\bG03\b/.test(upper)) mode = 'G3';

      // Extract coordinates (absolute only; relative G91 not handled)
      const nx = getNum(upper, 'X');
      const ny = getNum(upper, 'Y');
      const nz = getNum(upper, 'Z');

      const hasCoord = nx != null || ny != null || nz != null;
      if (!mode || !hasCoord) continue;

      const start = { x, y, z };
      if (nx != null) x = nx;
      if (ny != null) y = ny;
      if (nz != null) z = nz;
      const end = { x, y, z };

      if (mode === 'G0') {
        addLine(start, end, 'rapid');
      } else if (mode === 'G1') {
        addLine(start, end, 'linear');
      } else if (mode === 'G2' || mode === 'G3') {
        // Approximate arcs in XY plane (I/J or R)
        const i = getNum(upper, 'I');
        const j = getNum(upper, 'J');
        const r = getNum(upper, 'R');

        if (i != null || j != null) {
          const cx = start.x + (i || 0);
          const cy = start.y + (j || 0);
          approxArcXY(start, end, { x: cx, y: cy }, mode === 'G2');
        } else if (r != null && Number.isFinite(r) && r !== 0) {
          // Compute center from radius (one of two solutions)
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const d = Math.hypot(dx, dy);
          if (d > 0 && d <= 2 * Math.abs(r)) {
            const mx = (start.x + end.x) / 2;
            const my = (start.y + end.y) / 2;
            const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
            const ux = -dy / d;
            const uy = dx / d;
            const c1 = { x: mx + ux * h, y: my + uy * h };
            const c2 = { x: mx - ux * h, y: my - uy * h };

            // Choose center that matches CW/CCW better
            const pick = (c) => {
              const a0 = Math.atan2(start.y - c.y, start.x - c.x);
              const a1 = Math.atan2(end.y - c.y, end.x - c.x);
              let da = a1 - a0;
              if (mode === 'G2') {
                if (da >= 0) da -= Math.PI * 2;
              } else {
                if (da <= 0) da += Math.PI * 2;
              }
              return da;
            };
            const da1 = pick(c1);
            const da2 = pick(c2);
            const center = Math.abs(da1) <= Math.abs(da2) ? c1 : c2;
            approxArcXY(start, end, center, mode === 'G2');
          } else {
            addLine(start, end, 'linear');
          }
        } else {
          addLine(start, end, 'linear');
        }
      }

      lastPoint = end;
      updateBounds(end);
    }

    if (!segments.length) return { segments: [], bounds: null };
    return { segments, bounds: { minX, minY, minZ, maxX, maxY, maxZ } };
  }

  function ensureCanvasContext() {
    if (!canvas) canvas = /** @type {HTMLCanvasElement} */ (
      document.getElementById('toolpathCanvas')
    );
    if (!canvas) return null;
    if (!ctx) ctx = canvas.getContext('2d');
    return ctx;
  }

  function resizeCanvas() {
    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctxLocal.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fitCameraToBounds(bounds) {
    ensureCanvasContext();
    if (!bounds || !canvas) return;
    const { minX, maxX, minY, maxY, minZ, maxZ } = bounds;
    camCenterX = (minX + maxX) / 2;
    camCenterY = (minY + maxY) / 2;
    camCenterZ = (minZ + maxZ) / 2;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const spanZ = maxZ - minZ || 1;
    const maxSpan = Math.max(spanX, spanY, spanZ);
    const w = canvas.clientWidth || 400;
    const h = canvas.clientHeight || 300;
    camPxPerMm = (Math.min(w, h) / maxSpan) * 0.82;
  }

  function niceStepMm(pxPerMm) {
    const targetPx = 44;
    const raw = targetPx / pxPerMm;
    if (!Number.isFinite(raw) || raw <= 0) return 10;
    const exp = Math.floor(Math.log10(raw));
    const pow10 = Math.pow(10, exp);
    const fr = raw / pow10;
    const m = fr <= 1 ? 1 : fr <= 2 ? 2 : fr <= 5 ? 5 : 10;
    return m * pow10;
  }

  function screenToWorld2d(screenX, screenY) {
    const w = canvas ? canvas.clientWidth || 0 : 0;
    const h = canvas ? canvas.clientHeight || 0 : 0;
    const ppm = camPxPerMm || 1;
    return {
      x: camCenterX + (screenX - w / 2) / ppm,
      y: camCenterY - (screenY - h / 2) / ppm,
    };
  }

  /** Projekce bodu mm → obrazovka; střed pohledu = camCenter*, měřítko = camPxPerMm */
  function createProjector() {
    const ctxLocal = ensureCanvasContext();
    const noopP = () => ({ x: 0, y: 0 });
    const noopR = (dx, dy, dz) => ({ x: dx, y: dy, z: dz });
    if (!canvas || !ctxLocal) {
      return { project: noopP, rotatePoint: noopR, scale: camPxPerMm };
    }

    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const cx = camCenterX;
    const cy = camCenterY;
    const cz = camCenterZ;
    const ppm = camPxPerMm;
    const centerScreenX = width / 2;
    const centerScreenY = height / 2;

    const cosYaw = Math.cos(viewYaw);
    const sinYaw = Math.sin(viewYaw);
    const cosPitch = Math.cos(viewPitch);
    const sinPitch = Math.sin(viewPitch);

    function rotatePoint3d(dx, dy, dz) {
      const x1 = dx * cosYaw - dy * sinYaw;
      const y1 = dx * sinYaw + dy * cosYaw;
      const z1 = dz;
      const x2 = x1;
      const y2 = y1 * cosPitch - z1 * sinPitch;
      const z2 = y1 * sinPitch + z1 * cosPitch;
      return { x: x2, y: y2, z: z2 };
    }

    function rotatePoint(dx, dy, dz) {
      if (viewMode === '2d') {
        return { x: dx, y: dy, z: dz };
      }
      return rotatePoint3d(dx, dy, dz);
    }

    const project = (point) => {
      const dx = point.x - cx;
      const dy = point.y - cy;
      const dz = point.z - cz;
      if (viewMode === '2d') {
        return {
          x: centerScreenX + dx * ppm,
          y: centerScreenY - dy * ppm,
        };
      }
      const rotated = rotatePoint3d(dx, dy, dz);
      return {
        x: centerScreenX + rotated.x * ppm,
        y: centerScreenY + rotated.y * ppm,
      };
    };

    return { project, rotatePoint, scale: ppm };
  }

  function clearCanvas() {
    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) return;
    ctxLocal.save();
    ctxLocal.setTransform(1, 0, 0, 1, 0, 0);
    ctxLocal.clearRect(0, 0, canvas.width, canvas.height);
    ctxLocal.restore();
  }

  /** Poloha vrtáku: offline sim > při live frontě přesně podle odeslaných příkazů > jinak WPos ze stroje */
  function getToolDisplayPoint() {
    if (simulationState.running && simulationState.currentPoint) {
      return { ...simulationState.currentPoint };
    }
    if (liveCncToolSync && simulationState.currentPoint) {
      return { ...simulationState.currentPoint };
    }
    if (serialConnected) {
      return { ...lastWorkPosition };
    }
    return null;
  }

  function drawToolCylinderAt(ctxLocal, point, project, rotatePoint, scale) {
    if (!point) return;
    const pBottom = project(point);
    const toolDiameterMm = readToolDiameterFromUi();
    const rimRadiusPx = Math.max(3, (toolDiameterMm * scale) / 2);
    const cylinderHeightMm = Math.max(toolDiameterMm * 6, 30);
    const toolTopPoint = {
      x: point.x,
      y: point.y,
      z: point.z + cylinderHeightMm,
    };
    const pTop = project(toolTopPoint);

    const local = rotatePoint(
      point.x - camCenterX,
      point.y - camCenterY,
      point.z - camCenterZ,
    );
    const localRim = rotatePoint(
      point.x + toolDiameterMm / 2 - camCenterX,
      point.y - camCenterY,
      point.z - camCenterZ,
    );
    const rimPx = Math.max(2, Math.abs(localRim.x - local.x) * scale);
    const ellipseRy =
      viewMode === '2d'
        ? rimPx
        : Math.max(2, rimPx * (0.35 + 0.35 * Math.abs(Math.sin(viewPitch))));

    const wall = 'rgba(234, 88, 12, 0.78)';
    const top = 'rgba(253, 186, 116, 0.96)';
    const bottom = 'rgba(180, 83, 9, 0.9)';
    const strokeTop = 'rgba(255, 247, 237, 0.92)';

    ctxLocal.save();

    ctxLocal.beginPath();
    ctxLocal.moveTo(pBottom.x - rimPx, pBottom.y);
    ctxLocal.lineTo(pTop.x - rimPx, pTop.y);
    ctxLocal.lineTo(pTop.x + rimPx, pTop.y);
    ctxLocal.lineTo(pBottom.x + rimPx, pBottom.y);
    ctxLocal.closePath();
    ctxLocal.fillStyle = wall;
    ctxLocal.fill();

    ctxLocal.beginPath();
    ctxLocal.ellipse(pTop.x, pTop.y, rimPx, ellipseRy, 0, 0, Math.PI * 2);
    ctxLocal.fillStyle = top;
    ctxLocal.fill();

    ctxLocal.beginPath();
    ctxLocal.ellipse(pBottom.x, pBottom.y, rimPx, ellipseRy, 0, 0, Math.PI * 2);
    ctxLocal.fillStyle = bottom;
    ctxLocal.fill();

    ctxLocal.strokeStyle = strokeTop;
    ctxLocal.lineWidth = 1.2;
    ctxLocal.beginPath();
    ctxLocal.ellipse(pTop.x, pTop.y, rimPx, ellipseRy, 0, 0, Math.PI * 2);
    ctxLocal.stroke();

    ctxLocal.restore();
  }

  function drawToolpath() {
    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) return;

    resizeCanvas();
    clearCanvas();

    const { project, rotatePoint, scale } = createProjector();
    drawInfiniteWorldGrid(ctxLocal, project);
    drawWorldAxes(ctxLocal, project);
    drawAxisRulerLabels(ctxLocal, project);

    if (toolpathSegments.length && toolpathBounds) {
      ctxLocal.lineWidth = 1;
      ctxLocal.lineCap = 'round';
      ctxLocal.lineJoin = 'round';

      for (let i = 0; i < toolpathSegments.length; i += 1) {
        const seg = toolpathSegments[i];
        const from = project(seg.from);
        const to = project(seg.to);

        ctxLocal.beginPath();
        ctxLocal.moveTo(from.x, from.y);
        ctxLocal.lineTo(to.x, to.y);
        ctxLocal.strokeStyle =
          seg.type === 'rapid'
            ? getComputedStyle(document.documentElement)
                .getPropertyValue('--rapid')
                .trim() || '#4299e1'
            : getComputedStyle(document.documentElement)
                .getPropertyValue('--linear')
                .trim() || '#48bb78';
        ctxLocal.stroke();

        if (!(liveCutPath.length >= 2)) {
          if (simulationState.running || simulationState.currentPoint) {
            const isCompleted = i < simulationState.segmentIndex;
            const isCurrent = i === simulationState.segmentIndex;
            if (seg.type === 'linear' && (isCompleted || isCurrent)) {
              const cutTo = isCurrent
                ? {
                    x: from.x + (to.x - from.x) * simulationState.segmentT,
                    y: from.y + (to.y - from.y) * simulationState.segmentT,
                  }
                : to;
              ctxLocal.beginPath();
              ctxLocal.moveTo(from.x, from.y);
              ctxLocal.lineTo(cutTo.x, cutTo.y);
              ctxLocal.strokeStyle = '#f6e05e';
              ctxLocal.lineWidth = 2;
              ctxLocal.stroke();
              ctxLocal.lineWidth = 1;
            }
          }
        }
      }

      if (liveCutPath.length >= 2) {
        ctxLocal.beginPath();
        const p0 = project(liveCutPath[0]);
        ctxLocal.moveTo(p0.x, p0.y);
        for (let k = 1; k < liveCutPath.length; k++) {
          const p = project(liveCutPath[k]);
          ctxLocal.lineTo(p.x, p.y);
        }
        ctxLocal.strokeStyle = '#f6e05e';
        ctxLocal.lineWidth = 2;
        ctxLocal.stroke();
        ctxLocal.lineWidth = 1;
      }
    }

    const toolPt = getToolDisplayPoint();
    if (toolPt) {
      drawToolCylinderAt(ctxLocal, toolPt, project, rotatePoint, scale);
    }
  }

  function segmentLength(seg) {
    const dx = seg.to.x - seg.from.x;
    const dy = seg.to.y - seg.from.y;
    const dz = seg.to.z - seg.from.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function getSegmentPoint(seg, t) {
    return {
      x: seg.from.x + (seg.to.x - seg.from.x) * t,
      y: seg.from.y + (seg.to.y - seg.from.y) * t,
      z: seg.from.z + (seg.to.z - seg.from.z) * t,
    };
  }

  function stopSimulation() {
    simulationState.running = false;
    simulationState.lastTs = 0;
    if (simulationRaf != null) {
      cancelAnimationFrame(simulationRaf);
      simulationRaf = null;
    }
  }

  function resetSimulation() {
    stopSimulation();
    simulationState.segmentIndex = 0;
    simulationState.segmentT = 0;
    simulationState.completedLength = 0;
    simulationState.currentPoint = toolpathSegments.length
      ? { ...toolpathSegments[0].from }
      : null;
    drawToolpath();
  }

  function stepSimulation(ts) {
    if (!simulationState.running) return;
    if (!toolpathSegments.length) {
      stopSimulation();
      return;
    }

    if (!simulationState.lastTs) {
      simulationState.lastTs = ts;
    }
    const dt = Math.max(0, (ts - simulationState.lastTs) / 1000);
    simulationState.lastTs = ts;
    let remaining = SIM_SPEED_MM_PER_SEC * dt;

    while (remaining > 0 && simulationState.segmentIndex < toolpathSegments.length) {
      const seg = toolpathSegments[simulationState.segmentIndex];
      const len = Math.max(0.000001, segmentLength(seg));
      const remainingOnSegment = len * (1 - simulationState.segmentT);

      if (remaining >= remainingOnSegment) {
        remaining -= remainingOnSegment;
        simulationState.segmentIndex += 1;
        simulationState.segmentT = 0;
        simulationState.completedLength += remainingOnSegment;
        if (simulationState.segmentIndex >= toolpathSegments.length) {
          simulationState.currentPoint = { ...seg.to };
          simulationState.running = false;
          break;
        }
      } else {
        const addT = remaining / len;
        simulationState.segmentT = Math.min(1, simulationState.segmentT + addT);
        simulationState.currentPoint = getSegmentPoint(seg, simulationState.segmentT);
        remaining = 0;
      }
    }

    if (simulationState.segmentIndex < toolpathSegments.length) {
      const seg = toolpathSegments[simulationState.segmentIndex];
      simulationState.currentPoint = getSegmentPoint(seg, simulationState.segmentT);
    }

    drawToolpath();

    if (simulationState.running) {
      simulationRaf = requestAnimationFrame(stepSimulation);
    } else {
      simulationRaf = null;
      appendTerminalLine('[SYS] Simulace hotová.', 'system');
    }
  }

  function startSimulation() {
    if (!toolpathSegments.length) {
      appendTerminalLine('[ERR] No toolpath to simulate. Load a G-code file first.', 'error');
      return;
    }
    liveCutPath = [];
    liveCutPathStarted = false;
    persistToolDiameterFromUi();
    resetSimulation();
    simulationState.running = true;
    simulationState.lastTs = 0;
    appendTerminalLine('[SYS] Simulace řezu.', 'system');
    simulationRaf = requestAnimationFrame(stepSimulation);
  }

  /** Rovina mřížky: pod nejnižším bodem toolpathu (stůl „pod“ dílem), bez souboru z = 0 */
  function getGridZPlane() {
    if (!toolpathBounds) return 0;
    const { minZ, maxZ } = toolpathBounds;
    const span = Math.max(maxZ - minZ, 1);
    const margin = Math.max(0.5, span * 0.04);
    return minZ - margin;
  }

  function getVisibleWorldXYBounds() {
    if (!canvas) {
      return { xMin: -100, xMax: 100, yMin: -100, yMax: 100 };
    }
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const ppm = camPxPerMm || 1;
    if (viewMode === '2d') {
      return {
        xMin: camCenterX - w / (2 * ppm),
        xMax: camCenterX + w / (2 * ppm),
        yMin: camCenterY - h / (2 * ppm),
        yMax: camCenterY + h / (2 * ppm),
      };
    }
    const reach = Math.hypot(w, h) / ppm;
    return {
      xMin: camCenterX - reach,
      xMax: camCenterX + reach,
      yMin: camCenterY - reach,
      yMax: camCenterY + reach,
    };
  }

  function formatAxisNumber(val, step) {
    if (Math.abs(val) < 1e-9) return '0';
    if (step >= 1) return String(Math.round(val));
    const dec = step >= 0.1 ? 1 : 2;
    return String(Number(val.toFixed(dec)));
  }

  /** Měřítko na osách: dílce + hodnoty (mm) jako na technickém výkrese */
  function drawAxisRulerLabels(ctxLocal, project) {
    if (!canvas) return;
    const { xMin, xMax, yMin, yMax } = getVisibleWorldXYBounds();
    const zPlane = getGridZPlane();

    let labelStep = niceStepMm(camPxPerMm);
    const span = Math.max(xMax - xMin, yMax - yMin);
    while (span / labelStep > 24) labelStep *= 2;
    while (span / labelStep < 5 && labelStep > 1e-4) labelStep *= 0.5;

    const O = project({ x: 0, y: 0, z: zPlane });
    const Px = project({ x: labelStep, y: 0, z: zPlane });
    const Py = project({ x: 0, y: labelStep, z: zPlane });
    const norm = (vx, vy) => {
      const l = Math.hypot(vx, vy) || 1;
      return { x: vx / l, y: vy / l };
    };
    const tx = norm(Px.x - O.x, Px.y - O.y);
    const ty = norm(Py.x - O.x, Py.y - O.y);
    let nx = norm(-tx.y, tx.x);
    if (nx.x * ty.x + nx.y * ty.y > 0) {
      nx = { x: -nx.x, y: -nx.y };
    }
    let ny = norm(-ty.y, ty.x);
    if (ny.x * tx.x + ny.y * tx.y > 0) {
      ny = { x: -ny.x, y: -ny.y };
    }

    const tickPx = 6;
    const labelPx = 12;
    ctxLocal.save();
    ctxLocal.lineCap = 'round';
    ctxLocal.font =
      '11px ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace';
    ctxLocal.textAlign = 'center';
    ctxLocal.textBaseline = 'middle';

    for (let gx = Math.floor(xMin / labelStep) * labelStep; gx <= xMax + 1e-6; gx += labelStep) {
      if (Math.abs(gx) < 1e-9) continue;
      const p = project({ x: gx, y: 0, z: zPlane });
      ctxLocal.strokeStyle = 'rgba(229, 62, 62, 0.82)';
      ctxLocal.lineWidth = 1;
      ctxLocal.beginPath();
      ctxLocal.moveTo(p.x - nx.x * tickPx, p.y - nx.y * tickPx);
      ctxLocal.lineTo(p.x + nx.x * tickPx, p.y + nx.y * tickPx);
      ctxLocal.stroke();
      ctxLocal.fillStyle = 'rgba(254, 178, 178, 0.98)';
      ctxLocal.fillText(
        formatAxisNumber(gx, labelStep),
        p.x + nx.x * labelPx,
        p.y + nx.y * labelPx,
      );
    }

    for (let gy = Math.floor(yMin / labelStep) * labelStep; gy <= yMax + 1e-6; gy += labelStep) {
      if (Math.abs(gy) < 1e-9) continue;
      const p = project({ x: 0, y: gy, z: zPlane });
      ctxLocal.strokeStyle = 'rgba(72, 187, 120, 0.82)';
      ctxLocal.beginPath();
      ctxLocal.moveTo(p.x - ny.x * tickPx, p.y - ny.y * tickPx);
      ctxLocal.lineTo(p.x + ny.x * tickPx, p.y + ny.y * tickPx);
      ctxLocal.stroke();
      ctxLocal.fillStyle = 'rgba(154, 230, 180, 0.98)';
      ctxLocal.fillText(
        formatAxisNumber(gy, labelStep),
        p.x + ny.x * labelPx,
        p.y + ny.y * labelPx,
      );
    }

    ctxLocal.fillStyle = 'rgba(226, 232, 240, 0.95)';
    ctxLocal.fillText('0', O.x - nx.x * (labelPx * 0.85) - ny.x * (labelPx * 0.35), O.y - nx.y * (labelPx * 0.85) - ny.y * (labelPx * 0.35));

    ctxLocal.restore();
  }

  function drawInfiniteWorldGrid(ctxLocal, project) {
    if (!canvas) return;
    const { xMin, xMax, yMin, yMax } = getVisibleWorldXYBounds();
    const zPlane = getGridZPlane();
    const step = niceStepMm(camPxPerMm);
    ctxLocal.save();
    ctxLocal.strokeStyle = 'rgba(148, 163, 184, 0.24)';
    ctxLocal.lineWidth = 1;
    for (let gx = Math.floor(xMin / step) * step; gx <= xMax + 1e-6; gx += step) {
      const a = project({ x: gx, y: yMin, z: zPlane });
      const b = project({ x: gx, y: yMax, z: zPlane });
      ctxLocal.beginPath();
      ctxLocal.moveTo(a.x, a.y);
      ctxLocal.lineTo(b.x, b.y);
      ctxLocal.stroke();
    }
    for (let gy = Math.floor(yMin / step) * step; gy <= yMax + 1e-6; gy += step) {
      const a = project({ x: xMin, y: gy, z: zPlane });
      const b = project({ x: xMax, y: gy, z: zPlane });
      ctxLocal.beginPath();
      ctxLocal.moveTo(a.x, a.y);
      ctxLocal.lineTo(b.x, b.y);
      ctxLocal.stroke();
    }
    ctxLocal.restore();
  }

  function drawWorldAxes(ctxLocal, project) {
    if (!canvas) return;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const zPlane = getGridZPlane();
    const L = Math.max(120, (Math.hypot(w, h) / camPxPerMm) * 0.55);
    const ox0 = project({ x: -L, y: 0, z: zPlane });
    const ox1 = project({ x: L, y: 0, z: zPlane });
    const oy0 = project({ x: 0, y: -L, z: zPlane });
    const oy1 = project({ x: 0, y: L, z: zPlane });
    ctxLocal.save();
    ctxLocal.lineCap = 'round';
    ctxLocal.lineWidth = 2;
    ctxLocal.strokeStyle = 'rgba(229, 62, 62, 0.88)';
    ctxLocal.beginPath();
    ctxLocal.moveTo(ox0.x, ox0.y);
    ctxLocal.lineTo(ox1.x, ox1.y);
    ctxLocal.stroke();
    ctxLocal.strokeStyle = 'rgba(72, 187, 120, 0.88)';
    ctxLocal.beginPath();
    ctxLocal.moveTo(oy0.x, oy0.y);
    ctxLocal.lineTo(oy1.x, oy1.y);
    ctxLocal.stroke();
    ctxLocal.fillStyle = 'rgba(226, 232, 240, 0.95)';
    ctxLocal.font = '10px system-ui,sans-serif';
    ctxLocal.textAlign = 'left';
    ctxLocal.fillText('X', ox1.x + 4, ox1.y + 3);
    ctxLocal.textAlign = 'left';
    ctxLocal.fillText('Y', oy1.x + 4, oy1.y + 3);
    ctxLocal.restore();
  }

  function loadAndVisualizeGcode(content, filePath) {
    currentGcodeLines = content.split(/\r?\n/);
    const parsed = parseGcode(currentGcodeLines);
    toolpathSegments = parsed.segments;
    toolpathBounds = parsed.bounds;
    if (toolpathBounds) {
      fitCameraToBounds(toolpathBounds);
    }

    sentCount = 0;
    queuedTotal = 0;
    setQueueState('idle');
    endLiveCncToolSync();
    liveCutPath = [];
    liveCutPathStarted = false;
    resetSimulation();

    drawToolpath();

    const fileNameEl = $('file-name');
    if (fileNameEl) {
      currentFileName = filePath || 'Untitled';
      const parts = String(filePath || '').split(/[\\/]/);
      fileNameEl.textContent = parts[parts.length - 1] || 'Unnamed';
    }

    if (currentGcodeLines.length) {
      const startBtn = $('start-btn');
      if (startBtn) startBtn.disabled = false;
    }

    appendTerminalLine(`[SYS] Soubor: ${currentGcodeLines.length} řádků`, 'system');
  }

  /**
   * Perform a single jog move for the given axis/direction.
   * Shared by both the on-screen JOG buttons and the keyboard shortcuts.
   */
  async function performJog(axis, direction) {
    const steps = readJogStepsFromUi();
    const stepMm = steps * SETTINGS.JOG_MM_PER_STEP;

    try {
      const res = await window.electronAPI.sendJog({
        axis,
        direction,
        step: stepMm,
      });
      if (!res || res.success === false) {
        appendTerminalLine(
          `[ERR] Jog failed: ${
            (res && res.error) || 'unknown error'
          }`,
          'error',
        );
        return;
      }
      appendTerminalLine(`[OUT] Jog ${axis}${direction} ${steps} kroků`, 'sent');
    } catch (err) {
      appendTerminalLine(
        `[ERR] Jog failed: ${err.message || String(err)}`,
        'error',
      );
    }
  }

  // --- UI wiring -----------------------------------------------------------

  function syncViewModeButtons() {
    const b2 = $('view-2d-btn');
    const b3 = $('view-3d-btn');
    if (b2) b2.classList.toggle('active', viewMode === '2d');
    if (b3) b3.classList.toggle('active', viewMode === '3d');
  }

  function wireUI() {
    canvas = /** @type {HTMLCanvasElement} */ (
      document.getElementById('toolpathCanvas')
    );
    if (canvas) {
      window.addEventListener('resize', drawToolpath);

      canvas.addEventListener('mousedown', (event) => {
        isDraggingView = true;
        lastDragX = event.clientX;
        lastDragY = event.clientY;
      });
      window.addEventListener('mouseup', () => {
        isDraggingView = false;
      });
      window.addEventListener('mousemove', (event) => {
        if (!isDraggingView) return;
        const dx = event.clientX - lastDragX;
        const dy = event.clientY - lastDragY;
        lastDragX = event.clientX;
        lastDragY = event.clientY;

        if (viewMode === '2d') {
          camCenterX -= dx / camPxPerMm;
          camCenterY += dy / camPxPerMm;
        } else {
          viewYaw += dx * 0.01;
          viewPitch += dy * 0.01;
          const tau = Math.PI * 2;
          viewYaw = ((viewYaw % tau) + tau) % tau;
        }
        drawToolpath();
      });

      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const zoomFactor =
            e.deltaY > 0 ? VIEW_ZOOM_WHEEL_RATIO : 1 / VIEW_ZOOM_WHEEL_RATIO;
          const next = Math.max(0.02, Math.min(500, camPxPerMm * zoomFactor));
          if (viewMode === '2d') {
            const before = screenToWorld2d(mx, my);
            camPxPerMm = next;
            const after = screenToWorld2d(mx, my);
            camCenterX += before.x - after.x;
            camCenterY += before.y - after.y;
          } else {
            camPxPerMm = next;
          }
          drawToolpath();
        },
        { passive: false },
      );

      const btn2d = $('view-2d-btn');
      const btn3d = $('view-3d-btn');
      if (btn2d) {
        btn2d.addEventListener('click', () => {
          viewMode = '2d';
          syncViewModeButtons();
          drawToolpath();
        });
      }
      if (btn3d) {
        btn3d.addEventListener('click', () => {
          viewMode = '3d';
          syncViewModeButtons();
          drawToolpath();
        });
      }
    }
    syncViewModeButtons();

    const openFileBtn = $('open-file-btn');
    const startBtn = $('start-btn');
    const pauseBtn = $('pause-btn');
    const stopBtn = $('stop-btn');
    const connectBtn = $('connect-btn');
    const disconnectBtn = $('disconnect-btn');
    const toolDiameterInput = /** @type {HTMLInputElement | null} */ ($('tool-diameter-input'));
    const simulateBtn = $('simulate-btn');
    const zliftInput = /** @type {HTMLInputElement | null} */ ($('zlift-input'));

    // Load persisted settings
    loadSettingsIntoUi();
    loadToolDiameterIntoUi();
    loadJogStepsIntoUi();
    loadLastComPortIntoInput();

    const jogStepInput = /** @type {HTMLInputElement | null} */ ($('jog-step-input'));
    if (jogStepInput) {
      jogStepInput.addEventListener('change', persistJogStepsFromUi);
      jogStepInput.addEventListener('blur', persistJogStepsFromUi);
      jogStepInput.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        if (e.key === 'ArrowUp') multiplyJogSteps(2);
        else multiplyJogSteps(0.5);
      });
    }
    if (zliftInput) {
      zliftInput.addEventListener('change', persistZLiftMmFromUi);
      zliftInput.addEventListener('blur', persistZLiftMmFromUi);
    }
    if (toolDiameterInput) {
      toolDiameterInput.addEventListener('change', () => {
        persistToolDiameterFromUi();
        drawToolpath();
      });
      toolDiameterInput.addEventListener('blur', () => {
        persistToolDiameterFromUi();
        drawToolpath();
      });
    }
    if (simulateBtn) {
      simulateBtn.addEventListener('click', () => {
        startSimulation();
      });
    }

    if (openFileBtn) {
      openFileBtn.addEventListener('click', async () => {
        try {
          const result = await window.electronAPI.openGcodeFile();
          if (!result || result.canceled) return;
          if (result.error) {
            appendTerminalLine(
              `[ERR] Failed to read file: ${result.error}`,
              'error',
            );
            return;
          }
          loadAndVisualizeGcode(result.content || '', result.filePath);
        } catch (err) {
          appendTerminalLine(
            `[ERR] Failed to open file: ${err.message || String(err)}`,
            'error',
          );
        }
      });
    }

    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        if (!currentGcodeLines.length) return;

        try {
          if (queueState === 'paused') {
            // Resume
            const res = await window.electronAPI.resumeGcode();
            if (!res || res.success === false) {
              appendTerminalLine(
                `[ERR] Resume failed: ${
                  (res && res.error) || 'unknown error'
                }`,
                'error',
              );
              return;
            }
            setQueueState('running');
            appendTerminalLine('[SYS] Pokračuji.', 'system');
          } else if (queueState === 'idle') {
            // Start from beginning
            sentCount = 0;
            stopSimulation();
            liveCncToolSync = true;
            resetLiveToolForQueue();
            drawToolpath();
            const zLiftMm = readZLiftMmFromUi();
            persistZLiftMmFromUi();
            const res = await window.electronAPI.sendGcodeQueue({
              lines: currentGcodeLines,
              zLiftMm,
            });
            if (!res || res.success === false) {
              endLiveCncToolSync();
              resetSimulation();
              drawToolpath();
              appendTerminalLine(
                `[ERR] Queue start failed: ${
                  (res && res.error) || 'unknown error'
                }`,
                'error',
              );
              return;
            }
            queuedTotal = res.total || currentGcodeLines.length;
            setQueueState('running');
            appendTerminalLine('[SYS] Start programu.', 'system');
          }
        } catch (err) {
          appendTerminalLine(
            `[ERR] Start/resume failed: ${err.message || String(err)}`,
            'error',
          );
        }
      });
    }

    if (pauseBtn) {
      pauseBtn.addEventListener('click', async () => {
        if (queueState !== 'running') return;
        try {
          const res = await window.electronAPI.pauseGcode();
          if (!res || res.success === false) {
            appendTerminalLine(
              `[ERR] Pause failed: ${
                (res && res.error) || 'unknown error'
              }`,
              'error',
            );
            return;
          }
          setQueueState('paused');
          appendTerminalLine('[SYS] Pauza.', 'system');
        } catch (err) {
          appendTerminalLine(
            `[ERR] Pause failed: ${err.message || String(err)}`,
            'error',
          );
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        try {
          const res = await window.electronAPI.stopGcode();
          if (!res || res.success === false) {
            appendTerminalLine(
              `[ERR] Stop failed: ${
                (res && res.error) || 'unknown error'
              }`,
              'error',
            );
            return;
          }
        } catch (err) {
          appendTerminalLine(
            `[ERR] Stop failed: ${err.message || String(err)}`,
            'error',
          );
        }
      });
    }

    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        const portInput = $('port-input');
        const baudInput = $('baud-input');
        const portRaw = portInput ? portInput.value.trim() : '';
        const port = normalizeSerialPath(portRaw);
        const baudRate = baudInput ? Number(baudInput.value) || 115200 : 115200;

        if (!port) {
          appendTerminalLine(
            '[ERR] Zadej číslo portu (např. 3) nebo celý název (COM3).',
            'error',
          );
          return;
        }

        try {
          await window.electronAPI.connectSerial({ path: port, baudRate });
          appendTerminalLine(`[SYS] Připojuji ${port}…`, 'system');
        } catch (err) {
          appendTerminalLine(
            `[ERR] Failed to connect: ${err.message || String(err)}`,
            'error',
          );
        }
      });
    }

    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        try {
          await window.electronAPI.disconnectSerial();
          endLiveCncToolSync();
          drawToolpath();
          appendTerminalLine('[SYS] Odpojeno.', 'system');
        } catch (err) {
          appendTerminalLine(
            `[ERR] Failed to disconnect: ${err.message || String(err)}`,
            'error',
          );
        }
      });
    }

    // Jog controls (buttons)
    document
      .querySelectorAll('[data-jog]')
      .forEach((btn /** @type {HTMLElement} */) => {
        btn.addEventListener('click', () => {
          const spec = btn.getAttribute('data-jog') || '';
          const axis = spec.charAt(0);
          const direction = spec.charAt(1) === '-' ? '-' : '+';
          // Use the shared jog helper so buttons and keyboard behave identically
          void performJog(axis, direction);
        });
      });

    // Keyboard jog controls: map arrow keys and PageUp/PageDown to jog moves
    // so that keyboard input behaves exactly like clicking the JOG buttons.
    window.addEventListener('keydown', (event) => {
      // Don't steal keys when the user is typing in an input/textarea/editor
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return;
      }

      // Ignore if another handler already consumed this, or if modifiers are held
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return;
      }

      /** @type {{axis: string; direction: '+' | '-'} | null} */
      let jog = null;

      switch (event.key) {
        case 'ArrowUp':
          jog = { axis: 'Y', direction: '+' }; // Y+
          break;
        case 'ArrowDown':
          jog = { axis: 'Y', direction: '-' }; // Y-
          break;
        case 'ArrowRight':
          jog = { axis: 'X', direction: '+' }; // X+
          break;
        case 'ArrowLeft':
          jog = { axis: 'X', direction: '-' }; // X-
          break;
        case 'PageUp':
          jog = { axis: 'Z', direction: '+' }; // Z+
          break;
        case 'PageDown':
          jog = { axis: 'Z', direction: '-' }; // Z-
          break;
        default:
          break;
      }

      if (!jog) return;

      // Prevent default browser scrolling for these navigation keys
      event.preventDefault();

      // Use the same jog path as the on-screen buttons
      void performJog(jog.axis, jog.direction);
    });

    // Home / zero buttons
    const homeXBtn = $('home-x-btn');
    const homeYBtn = $('home-y-btn');
    const homeZBtn = $('home-z-btn');
    const xy0Btn = $('jog-xy0-btn');
    const z0Btn = $('jog-z0-btn');

    if (homeXBtn) {
      homeXBtn.addEventListener('click', () => void setWorkZero('x'));
    }
    if (homeYBtn) {
      homeYBtn.addEventListener('click', () => void setWorkZero('y'));
    }
    if (homeZBtn) {
      homeZBtn.addEventListener('click', () => void setWorkZero('z'));
    }
    if (xy0Btn) {
      xy0Btn.addEventListener('click', () => void goToWorkZero('xy'));
    }
    if (z0Btn) {
      z0Btn.addEventListener('click', () => void goToWorkZero('z'));
    }
  }

  // --- IPC event listeners from main process -------------------------------

  function wireIpc() {
    const api = window.electronAPI;
    if (!api) return;

    api.onSerialStatus((status) => {
      updateConnectionUI(status || {});
    });

    api.onSerialData((data) => {
      if (!data || !data.line) return;
      if (!shouldLogSerialRecv(data.line)) return;
      appendTerminalLine(`< ${data.line}`, 'recv');
    });

    api.onMachinePosition((pos) => {
      if (!pos) return;
      updateMachinePosition(pos);
    });

    api.onGcodeSentLine((info) => {
      if (!info || !info.line) return;
      // Počítadlo jen řádky z běžící fronty programu (ne jog / $X / G10)
      if (info.fromQueue === true) {
        sentCount += 1;
      }
      // Terminál: nepsat tisíce řádků z programu; krátké systémové ($X) ano
      const ln = String(info.line);
      if (info.fromQueue !== true && /^\$/i.test(ln.trim())) {
        appendTerminalLine(`> ${ln}`, 'sent');
      }
      if (liveCncToolSync && info.fromQueue === true) {
        applyLiveToolLine(info.line);
        drawToolpath();
      }
      setQueueState(queueState); // refresh counters
    });

    api.onGcodeQueueStarted((info) => {
      stopSimulation();
      sentCount = 0;
      queuedTotal = (info && info.total) || currentGcodeLines.length;
      setQueueState('running');
    });

    api.onGcodeQueueComplete(() => {
      endLiveCncToolSync();
      sentCount = 0;
      queuedTotal = 0;
      setQueueState('idle');
      drawToolpath();
      appendTerminalLine('[SYS] Hotovo.', 'system');
    });

    if (api.onGcodeAborted) {
      api.onGcodeAborted(() => {
        setQueueState('idle');
        endLiveCncToolSync();
        sentCount = 0;
        queuedTotal = 0;
        resetSimulation();
        drawToolpath();
        appendTerminalLine(
          '[SYS] Stop — program zastaven, fronta vynulována. Následuje $X (unlock).',
          'system',
        );
      });
    }
  }

  // Boot
  window.addEventListener('DOMContentLoaded', () => {
    wireUI();
    wireIpc();
    setQueueState('idle');
    resizeCanvas();
    drawToolpath();
    void initCameraUi();
    appendTerminalLine('[SYS] Připraveno.', 'system');
  });
})();

