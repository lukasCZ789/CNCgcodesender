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

  // Machine position and UI zero offsets
  let machinePos = { x: 0, y: 0, z: 0 };
  let offsetPos = { x: 0, y: 0, z: 0 };

  // Current G-code file
  let currentFileName = null;
  let currentGcodeLines = [];

  const SETTINGS = {
    zLiftMmKey: 'settings.zLiftMm',
    defaultZLiftMm: 10,
    cameraDeviceIdKey: 'settings.camera.deviceId',
    cameraZoomKey: 'settings.camera.zoom',
    defaultCameraZoom: 1,
  };

  function $(id) {
    return document.getElementById(id);
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

  function updateMachinePosition({ x, y, z }) {
    machinePos = { x, y, z };
    const px = $('pos-x');
    const py = $('pos-y');
    const pz = $('pos-z');
    const dx = x - offsetPos.x;
    const dy = y - offsetPos.y;
    const dz = z - offsetPos.z;
    if (px) px.textContent = dx.toFixed(3);
    if (py) py.textContent = dy.toFixed(3);
    if (pz) pz.textContent = dz.toFixed(3);
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

  // --- G-code parsing and 3D-ish projection drawing -----------------------

  function parseGcode(lines) {
    /** @type {{from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}, type:'rapid'|'linear'}[]} */
    const segments = [];

    let x = 0;
    let y = 0;
    let z = 0;
    let mode = null; // 'G0' or 'G1'
    let lastPoint = { x, y, z };

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let raw of lines) {
      let line = String(raw || '');
      // Strip inline comments in parentheses and after ';'
      line = line.replace(/\(.*?\)/g, '');
      const semi = line.indexOf(';');
      if (semi >= 0) line = line.slice(0, semi);
      line = line.trim();
      if (!line) continue;

      const upper = line.toUpperCase();

      if (upper.includes('G0 ') || upper.includes('G00')) {
        mode = 'G0';
      } else if (upper.includes('G1 ') || upper.includes('G01')) {
        mode = 'G1';
      }

      // Extract coordinates (absolute only; relative G91 not handled)
      const xMatch = upper.match(/X(-?\d+(\.\d+)?)/);
      const yMatch = upper.match(/Y(-?\d+(\.\d+)?)/);
      const zMatch = upper.match(/Z(-?\d+(\.\d+)?)/);

      const hasCoord = !!(xMatch || yMatch || zMatch);
      if (!mode || !hasCoord) continue;

      if (xMatch) x = parseFloat(xMatch[1]);
      if (yMatch) y = parseFloat(yMatch[1]);
      if (zMatch) z = parseFloat(zMatch[1]);

      const nextPoint = { x, y, z };

      segments.push({
        from: { ...lastPoint },
        to: { ...nextPoint },
        type: mode === 'G0' ? 'rapid' : 'linear',
      });

      lastPoint = nextPoint;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }

    if (!segments.length) {
      return { segments: [], bounds: null };
    }

    return {
      segments,
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    };
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

  // Simple isometric projection of (x,y,z) into 2D canvas
  function createProjector(bounds) {
    if (!bounds) return () => ({ x: 0, y: 0 });
    const { minX, minY, minZ, maxX, maxY, maxZ } = bounds;

    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const spanZ = maxZ - minZ || 1;

    const centerX = minX + spanX / 2;
    const centerY = minY + spanY / 2;
    const centerZ = minZ + spanZ / 2;

    const ctxLocal = ensureCanvasContext();
    if (!canvas || !ctxLocal) {
      return () => ({ x: 0, y: 0 });
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

    const angle = Math.PI / 6; // 30°
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    return (point) => {
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const dz = point.z - centerZ;

      const isoX = (dx - dy) * cosA;
      const isoY = (dx + dy) * sinA - dz;

      const sx = centerScreenX + isoX * scale;
      const sy = centerScreenY - isoY * scale;
      return { x: sx, y: sy };
    };
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

    const project = createProjector(toolpathBounds);

    ctxLocal.lineWidth = 1;
    ctxLocal.lineCap = 'round';
    ctxLocal.lineJoin = 'round';

    for (const seg of toolpathSegments) {
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
    }
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
    const jogStepInput = $('jog-step-input');
    const step =
      jogStepInput && jogStepInput.value
        ? Number(jogStepInput.value)
        : 1.0;

    try {
      const res = await window.electronAPI.sendJog({
        axis,
        direction,
        step,
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
        `[OUT] JOG ${axis}${direction}${step.toFixed(3)} mm`,
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
    }

    const openFileBtn = $('open-file-btn');
    const startBtn = $('start-btn');
    const pauseBtn = $('pause-btn');
    const stopBtn = $('stop-btn');
    const connectBtn = $('connect-btn');
    const disconnectBtn = $('disconnect-btn');
    const zliftInput = /** @type {HTMLInputElement | null} */ ($('zlift-input'));

    // Load persisted settings
    loadSettingsIntoUi();
    if (zliftInput) {
      zliftInput.addEventListener('change', persistZLiftMmFromUi);
      zliftInput.addEventListener('blur', persistZLiftMmFromUi);
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
            const zLiftMm = readZLiftMmFromUi();
            persistZLiftMmFromUi();
            const res = await window.electronAPI.sendGcodeQueue({
              lines: currentGcodeLines,
              zLiftMm,
            });
            if (!res || res.success === false) {
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
          setQueueState('idle');
          appendTerminalLine('[SYS] Queue stopped.', 'system');
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
        const port = portInput ? portInput.value.trim() : '';
        const baudRate = baudInput ? Number(baudInput.value) || 115200 : 115200;

        if (!port) {
          appendTerminalLine(
            '[ERR] Please enter a serial COM port (e.g. COM3).',
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

    // Home / zero buttons (UI-only zeroing)
    const homeXBtn = $('home-x-btn');
    const homeYBtn = $('home-y-btn');
    const homeZBtn = $('home-z-btn');
    const xy0Btn = $('jog-xy0-btn');
    const z0Btn = $('jog-z0-btn');

    if (homeXBtn) {
      homeXBtn.addEventListener('click', () => setAxisHome('x'));
    }
    if (homeYBtn) {
      homeYBtn.addEventListener('click', () => setAxisHome('y'));
    }
    if (homeZBtn) {
      homeZBtn.addEventListener('click', () => setAxisHome('z'));
    }
    if (xy0Btn) {
      xy0Btn.addEventListener('click', () => setAxisHome('xy'));
    }
    if (z0Btn) {
      z0Btn.addEventListener('click', () => setAxisHome('z'));
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
      setQueueState(queueState); // refresh counters
    });

    api.onGcodeQueueStarted((info) => {
      queuedTotal = (info && info.total) || currentGcodeLines.length;
      sentCount = 0;
      setQueueState('running');
    });

    api.onGcodeQueueComplete(() => {
      setQueueState('idle');
      appendTerminalLine('[SYS] Queue complete.', 'system');
    });
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

