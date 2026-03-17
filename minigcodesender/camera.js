(() => {
  'use strict';

  /** @type {MediaStream | null} */
  let stream = null;

  const video = /** @type {HTMLVideoElement | null} */ (document.getElementById('video'));
  const statusEl = document.getElementById('status');
  const zoomEl = document.getElementById('zoom');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function stop() {
    if (!stream) return;
    try {
      for (const t of stream.getTracks()) t.stop();
    } catch {
      // ignore
    }
    stream = null;
  }

  function getParams() {
    const url = new URL(window.location.href);
    const deviceId = url.searchParams.get('deviceId') || '';
    const zoomRaw = Number(url.searchParams.get('zoom') || '1');
    const zoom = Number.isFinite(zoomRaw) ? Math.max(1, Math.min(6, zoomRaw)) : 1;
    return { deviceId, zoom };
  }

  function applyZoom(zoom) {
    if (video) video.style.transform = `scale(${zoom})`;
    if (zoomEl) zoomEl.textContent = `Zoom ${zoom.toFixed(1)}×`;
  }

  async function start() {
    const { deviceId, zoom } = getParams();
    applyZoom(zoom);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Camera API not available.');
      return;
    }

    stop();
    setStatus('Starting camera…');

    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : { video: true, audio: false };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      setStatus('Camera running.');
    } catch (err) {
      setStatus(`Failed to start camera: ${err.message || String(err)}`);
    }
  }

  window.addEventListener('beforeunload', stop);

  // Start when loaded
  void start();
})();

