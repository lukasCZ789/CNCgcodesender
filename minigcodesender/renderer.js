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

  // Machine position and UI zero offsets (MPos fallback when GRBL neposílá WPos)
  let machinePos = { x: 0, y: 0, z: 0 };
  let offsetPos = { x: 0, y: 0, z: 0 };
  /** @type {'work' | 'machine'} */
  let positionFrame = 'machine';

  // Current G-code file
  let currentFileName = null;
  let currentGcodeLines = [];

  const SETTINGS = {
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

  // Interactive 3D view rotation (drag on canvas)
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
      statusDot.classList.add('error');
      text = `Error: ${error}`;
      appendTerminalLine(`[ERR] ${error}`, 'error');
    } else if (connected) {
      statusDot.classList.add('connected');
      text = `Connected${port ? ` (${port})` : ''}`;
    } else {
      text = message || 'Disconnected';
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

    machinePos = { x, y, z };
    positionFrame = pos.frame === 'work' ? 'work' : 'machine';

    const px = $('pos-x');
    const py = $('pos-y');
    const pz = $('pos-z');

    if (positionFrame === 'work') {
      if (px) px.textContent = x.toFixed(3);
      if (py) py.textContent = y.toFixed(3);
      if (pz) pz.textContent = z.toFixed(3);
    } else {
      const dx = x - offsetPos.x;
      const dy = y - offsetPos.y;
      const dz = z - offsetPos.z;
      if (px) px.textContent = dx.toFixed(3);
      if (py) py.textContent = dy.toFixed(3);
      if (pz) pz.textContent = dz.toFixed(3);
    }
  }

  function setAxisHome(axis) {
    if (!machinePos) return;
    if (axis === 'x' || axis === 'y' || axis === 'z') {
      offsetPos[axis] = machinePos[axis];
    } else if (axis === 'xy') {
      offsetPos.x = machinePos.x;
      offsetPos.y = machinePos.y;
    }
    updateMachinePosition(machinePos);
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
      appendTerminalLine(`[SYS] Set work zero (${axis.toUpperCase()})`, 'system');
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
    if (ok) appendTerminalLine(`[SYS] Go to ${which.toUpperCase()}0`, 'system');
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
    simulationState.currentPoint = { x: 0, y: 0, z: 0 };
    simulationState.running = false;
    simulationState.segmentIndex = 0;
    simulationState.segmentT = 0;
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
    const hasCoord = nx != null || ny != null || nz != null;
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

    if (liveInterp.mode === 'G1') {
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

  // Rotatable 3D-to-2D projection (yaw + pitch)
  function createProjector(bounds) {
    if (!bounds) return { project: () => ({ x: 0, y: 0 }), scale: 1 };
    const { minX, minY, minZ, maxX, maxY, maxZ } = bounds;

    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const spanZ = maxZ - minZ || 1;

    const centerX = minX + spanX / 2;
    const centerY = minY + spanY / 2;
    const centerZ = minZ + spanZ / 2;

    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) {
      return { project: () => ({ x: 0, y: 0 }), scale: 1 };
    }

    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;

    const margin = 20;
    const maxSpan = Math.max(spanX, spanY, spanZ);
    const scale =
      maxSpan > 0
        ? (Math.min(width, height) / maxSpan) * 0.8
        : Math.min(width, height) * 0.5;

    const centerScreenX = width / 2;
    const centerScreenY = height / 2;

    const cosYaw = Math.cos(viewYaw);
    const sinYaw = Math.sin(viewYaw);
    const cosPitch = Math.cos(viewPitch);
    const sinPitch = Math.sin(viewPitch);

    function rotatePoint(dx, dy, dz) {
      // Yaw around Z axis
      const x1 = dx * cosYaw - dy * sinYaw;
      const y1 = dx * sinYaw + dy * cosYaw;
      const z1 = dz;

      // Pitch around X axis
      const x2 = x1;
      const y2 = y1 * cosPitch - z1 * sinPitch;
      const z2 = y1 * sinPitch + z1 * cosPitch;
      return { x: x2, y: y2, z: z2 };
    }

    const project = (point) => {
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const dz = point.z - centerZ;

      const rotated = rotatePoint(dx, dy, dz);

      const sx = centerScreenX + rotated.x * scale;
      const sy = centerScreenY + rotated.y * scale;
      return { x: sx, y: sy };
    };
    return { project, scale, rotatePoint };
  }

  function clearCanvas() {
    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) return;
    ctxLocal.save();
    ctxLocal.setTransform(1, 0, 0, 1, 0, 0);
    ctxLocal.clearRect(0, 0, canvas.width, canvas.height);
    ctxLocal.restore();
  }

  function drawToolpath() {
    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) return;

    resizeCanvas();
    clearCanvas();

    if (!toolpathSegments.length || !toolpathBounds) {
      // Draw subtle grid even when empty
      drawGrid(ctxLocal);
      return;
    }

    drawGrid(ctxLocal);

    const { project, scale, rotatePoint } = createProjector(toolpathBounds);

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

      // Žlutý „řez“: buď z reálného běhu (G1 body), nebo offline simulace.
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

    // Draw cutter as a tall red cylinder.
    if (simulationState.currentPoint) {
      const pBottom = project(simulationState.currentPoint);
      const toolDiameterMm = readToolDiameterFromUi();
      const radiusPx = Math.max(3, (toolDiameterMm * scale) / 2);
      const cylinderHeightMm = Math.max(toolDiameterMm * 6, 30);
      const toolTopPoint = {
        x: simulationState.currentPoint.x,
        y: simulationState.currentPoint.y,
        z: simulationState.currentPoint.z + cylinderHeightMm,
      };
      const pTop = project(toolTopPoint);

      // Compute how circular top/bottom appear after rotation.
      const center = toolpathBounds
        ? {
            x: (toolpathBounds.minX + toolpathBounds.maxX) / 2,
            y: (toolpathBounds.minY + toolpathBounds.maxY) / 2,
            z: (toolpathBounds.minZ + toolpathBounds.maxZ) / 2,
          }
        : { x: 0, y: 0, z: 0 };
      const local = rotatePoint(
        simulationState.currentPoint.x - center.x,
        simulationState.currentPoint.y - center.y,
        simulationState.currentPoint.z - center.z,
      );
      const localRim = rotatePoint(
        simulationState.currentPoint.x + toolDiameterMm / 2 - center.x,
        simulationState.currentPoint.y - center.y,
        simulationState.currentPoint.z - center.z,
      );
      const rimRadiusPx = Math.max(2, Math.abs(localRim.x - local.x) * scale);
      const ellipseRy = Math.max(2, rimRadiusPx * (0.35 + 0.35 * Math.abs(Math.sin(viewPitch))));

      ctxLocal.save();

      // Side wall
      ctxLocal.beginPath();
      ctxLocal.moveTo(pBottom.x - rimRadiusPx, pBottom.y);
      ctxLocal.lineTo(pTop.x - rimRadiusPx, pTop.y);
      ctxLocal.lineTo(pTop.x + rimRadiusPx, pTop.y);
      ctxLocal.lineTo(pBottom.x + rimRadiusPx, pBottom.y);
      ctxLocal.closePath();
      ctxLocal.fillStyle = 'rgba(220, 38, 38, 0.72)';
      ctxLocal.fill();

      // Top cap
      ctxLocal.beginPath();
      ctxLocal.ellipse(pTop.x, pTop.y, rimRadiusPx, ellipseRy, 0, 0, Math.PI * 2);
      ctxLocal.fillStyle = 'rgba(239, 68, 68, 0.95)';
      ctxLocal.fill();

      // Bottom cap
      ctxLocal.beginPath();
      ctxLocal.ellipse(pBottom.x, pBottom.y, rimRadiusPx, ellipseRy, 0, 0, Math.PI * 2);
      ctxLocal.fillStyle = 'rgba(185, 28, 28, 0.85)';
      ctxLocal.fill();

      ctxLocal.strokeStyle = 'rgba(254, 202, 202, 0.95)';
      ctxLocal.lineWidth = 1.2;
      ctxLocal.beginPath();
      ctxLocal.ellipse(pTop.x, pTop.y, rimRadiusPx, ellipseRy, 0, 0, Math.PI * 2);
      ctxLocal.stroke();
      ctxLocal.restore();
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
      appendTerminalLine('[SYS] Cut simulation complete.', 'system');
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
    appendTerminalLine(
      `[SYS] Simulating cut with tool diameter ${readToolDiameterFromUi().toFixed(2)} mm.`,
      'system',
    );
    simulationRaf = requestAnimationFrame(stepSimulation);
  }

  function drawGrid(ctxLocal) {
    if (!canvas) return;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;

    ctxLocal.save();
    ctxLocal.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctxLocal.lineWidth = 0.5;

    const step = 40;
    for (let x = 0; x < width; x += step) {
      ctxLocal.beginPath();
      ctxLocal.moveTo(x, 0);
      ctxLocal.lineTo(x, height);
      ctxLocal.stroke();
    }
    for (let y = 0; y < height; y += step) {
      ctxLocal.beginPath();
      ctxLocal.moveTo(0, y);
      ctxLocal.lineTo(width, y);
      ctxLocal.stroke();
    }

    // Origin marker
    ctxLocal.fillStyle = 'rgba(72, 187, 120, 0.9)';
    ctxLocal.beginPath();
    ctxLocal.arc(24, height - 24, 3, 0, Math.PI * 2);
    ctxLocal.fill();

    ctxLocal.restore();
  }

  function loadAndVisualizeGcode(content, filePath) {
    currentGcodeLines = content.split(/\r?\n/);
    const parsed = parseGcode(currentGcodeLines);
    toolpathSegments = parsed.segments;
    toolpathBounds = parsed.bounds;

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

    appendTerminalLine(
      `[SYS] Loaded G-code file with ${currentGcodeLines.length} lines.`,
      'system',
    );
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
      appendTerminalLine(
        `[OUT] JOG ${axis}${direction} ${steps} kroků (${stepMm.toFixed(3)} mm)`,
        'sent',
      );
    } catch (err) {
      appendTerminalLine(
        `[ERR] Jog failed: ${err.message || String(err)}`,
        'error',
      );
    }
  }

  // --- UI wiring -----------------------------------------------------------

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

        viewYaw += dx * 0.01;
        viewPitch += dy * 0.01;
        // Yaw keep bounded for numeric stability; pitch intentionally unbounded.
        const tau = Math.PI * 2;
        viewYaw = ((viewYaw % tau) + tau) % tau;
        drawToolpath();
      });
    }

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
            appendTerminalLine('[SYS] Queue resumed.', 'system');
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
            appendTerminalLine(
              `[SYS] Queue started with ${queuedTotal} lines.`,
              'system',
            );
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
          appendTerminalLine('[SYS] Queue paused.', 'system');
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
          appendTerminalLine(
            `[SYS] Connecting to ${port} @ ${baudRate}...`,
            'system',
          );
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
          appendTerminalLine('[SYS] Disconnected serial port.', 'system');
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
      appendTerminalLine(`< ${data.line}`, 'recv');
    });

    api.onMachinePosition((pos) => {
      if (!pos) return;
      updateMachinePosition(pos);
    });

    api.onGcodeSentLine((info) => {
      if (!info || !info.line) return;
      appendTerminalLine(`> ${info.line}`, 'sent');
      sentCount += 1;
      if (
        liveCncToolSync &&
        queueState === 'running' &&
        info.fromQueue === true
      ) {
        applyLiveToolLine(info.line);
        drawToolpath();
      }
      setQueueState(queueState); // refresh counters
    });

    api.onGcodeQueueStarted((info) => {
      stopSimulation();
      queuedTotal = (info && info.total) || currentGcodeLines.length;
      setQueueState('running');
    });

    api.onGcodeQueueComplete(() => {
      endLiveCncToolSync();
      setQueueState('idle');
      drawToolpath();
      appendTerminalLine('[SYS] Queue complete.', 'system');
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
          '[SYS] Stop — běh zrušen; fronta prázdná, můžeš znovu načíst G-code nebo jogovat. GRBL soft reset (0x18). Při Alarm odemkni ($X).',
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
    appendTerminalLine(
      '[SYS] Ready. Connect to a GRBL device and open a G-code file.',
      'system',
    );
  });
})();

