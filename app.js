/*
  app.js
  -------
  Leest live sensordata uit op een telefoon en toont dit op het scherm.

  Sensor-events die we gebruiken:
  - DeviceMotionEvent       -> acceleratie/rotatie (beweging)

  Belangrijk:
  - Op iOS (Safari) moet je permissie vragen NA een user gesture (klik/tap).
  - Veel browsers vereisen HTTPS (of localhost) om sensoren te mogen gebruiken.
*/

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

const motionOut = document.getElementById('motionOut');

let running = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function round(value) {
  // Sensor-waarden zijn vaak floats; dit maakt de output leesbaar.
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function formatObj(obj) {
  // Toon als pretty JSON.
  return JSON.stringify(obj, null, 2);
}

async function requestIOSPermissionIfNeeded() {
  /*
    iOS 13+ heeft een speciale permission-API voor motion.
    Bestaat requestPermission() niet, dan is het niet nodig.
  */
  const permissionRequests = [];

  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    permissionRequests.push(DeviceMotionEvent.requestPermission());
  }

  if (permissionRequests.length === 0) {
    return { ok: true, details: 'Geen iOS permission API nodig.' };
  }

  const results = await Promise.allSettled(permissionRequests);
  const granted = results.every((r) => r.status === 'fulfilled' && r.value === 'granted');

  return {
    ok: granted,
    details: results.map((r) => (r.status === 'fulfilled' ? r.value : String(r.reason))).join(', '),
  };
}

function attachListeners() {
  // Passive listeners: we doen geen preventDefault.
  window.addEventListener('devicemotion', onMotion, { passive: true });
}

function detachListeners() {
  window.removeEventListener('devicemotion', onMotion);
}

function onMotion(event) {
  const accel = event.acceleration || {};
  const accelG = event.accelerationIncludingGravity || {};
  const rot = event.rotationRate || {};

  const payload = {
    ts: new Date().toISOString(),
    intervalMs: round(event.interval),
    acceleration: {
      x: round(accel.x),
      y: round(accel.y),
      z: round(accel.z),
    },
    accelerationIncludingGravity: {
      x: round(accelG.x),
      y: round(accelG.y),
      z: round(accelG.z),
    },
    rotationRate: {
      alpha: round(rot.alpha),
      beta: round(rot.beta),
      gamma: round(rot.gamma),
    },
  };

  motionOut.textContent = formatObj(payload);
}

async function start() {
  if (running) return;

  // Tip: zonder secure context werkt dit vaak niet.
  if (!window.isSecureContext) {
    setStatus('Tip: serveer via HTTPS of localhost voor sensoren.');
  } else {
    setStatus('');
  }

  try {
    // iOS permissie flow (moet na klik).
    const permission = await requestIOSPermissionIfNeeded();
    if (!permission.ok) {
      setStatus(`Permissie geweigerd/geen toegang: ${permission.details}`);
      return;
    }

    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    attachListeners();

    setStatus('Leest sensoren uit...');
  } catch (e) {
    setStatus(`Starten mislukt: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function stop() {
  if (!running) return;
  running = false;

  detachListeners();

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setStatus('Gestopt.');
}

// UI wiring
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);

// Kleine hint meteen bij laden
if (!window.isSecureContext) {
  setStatus('Tip: serveer via HTTPS of localhost voor sensoren.');
}
