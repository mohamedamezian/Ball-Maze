/*
  game.js
  -------
  Simpele 2D bal op canvas die beweegt door device sensoren.

  Input:
  - DeviceMotionEvent.accelerationIncludingGravity (ax/ay)

  UX:
  - Start/Stop knoppen (nodig voor iOS permissies)
  - Vibratie bij muur-hit (navigator.vibrate)
*/

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('gameCanvas');

const ctx = canvas.getContext('2d');

let running = false;
let rafId = null;
let lastFrameMs = null;

// Rendering/cache
let inkColor = null;
let needsResize = true;
let canvasWidth = 0;
let canvasHeight = 0;

// Throttling/cooldowns
let lastMotionMs = 0;
let lastVibrateMs = 0;

// Laatste sensorwaarden (m/s^2)
let tiltAx = 0;
let tiltAy = 0;

// Game state in “canvas pixels” (wordt geschaald met dpr)
const ball = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  r: 18,
};

// Tuning (bewust simpel gehouden)
const SETTINGS = {
  accelScale: 180, // hoe hard de tilt versnelt (px/s^2 per 1 m/s^2)
  friction: 0.985, // simpele demping per frame
  restitution: 0.55, // bounciness bij muren
  maxSpeed: 1400, // cap om ‘escape velocity’ te voorkomen
  vibrateMs: 25, // vibratie bij muur-hit
  minImpactSpeedForVibrate: 220, // geen vibratie bij hele zachte tik
  vibrateCooldownMs: 90, // voorkom vibrate-spam als je tegen een muur “ratelt”
  motionSampleEveryMs: 16, // ~60Hz input sampling
};

function setStatus(message) {
  statusEl.textContent = message;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function updateInkColor() {
  // Vermijd getComputedStyle per frame.
  inkColor = getComputedStyle(document.body).color;
}

function resizeCanvasToDisplaySize() {
  // Houd canvas scherp op high-dpi schermen
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssWidth = Math.max(1, Math.floor(canvas.clientWidth));
  const cssHeight = Math.max(1, Math.floor(canvas.clientHeight));

  const targetWidth = Math.floor(cssWidth * dpr);
  const targetHeight = Math.floor(cssHeight * dpr);

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  canvasWidth = canvas.width;
  canvasHeight = canvas.height;
  needsResize = false;
}

function resetBallToCenter() {
  if (needsResize) resizeCanvasToDisplaySize();
  ball.x = canvasWidth / 2;
  ball.y = canvasHeight / 2;
  ball.vx = 0;
  ball.vy = 0;
}

async function requestIOSPermissionIfNeeded() {
  /*
    iOS 13+ vereist permissie via user gesture.
    Android/desktop hebben dit meestal niet nodig.
  */
  if (typeof DeviceMotionEvent === 'undefined') {
    return { ok: false, details: 'DeviceMotionEvent niet beschikbaar in deze browser.' };
  }

  if (typeof DeviceMotionEvent.requestPermission !== 'function') {
    return { ok: true, details: 'Geen iOS permission API nodig.' };
  }

  try {
    const res = await DeviceMotionEvent.requestPermission();
    return { ok: res === 'granted', details: res };
  } catch (e) {
    return { ok: false, details: e instanceof Error ? e.message : String(e) };
  }
}

function onMotion(event) {
  // Sommige devices sturen heel hoge frequenties. Sampling op ~60Hz is ruim genoeg.
  const t = event.timeStamp || performance.now();
  if (t - lastMotionMs < SETTINGS.motionSampleEveryMs) return;
  lastMotionMs = t;

  const accelG = event.accelerationIncludingGravity;
  if (!accelG) return;

  // In de praktijk is accelG.x/y genoeg voor ‘tilt’.
  // (Assumptie: telefoon in portrait; bij landscape kan mapping anders voelen.)
  tiltAx = Number.isFinite(accelG.x) ? accelG.x : 0;
  tiltAy = Number.isFinite(accelG.y) ? accelG.y : 0;
}

function vibrateIfSupported(ms) {
  if (!('vibrate' in navigator)) return;
  try {
    navigator.vibrate(ms);
  } catch {
    // ignore
  }
}

function draw() {
  if (needsResize) resizeCanvasToDisplaySize();
  if (!inkColor) updateInkColor();

  // Achtergrond
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Border (maze “muren”)
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeStyle = inkColor;
  ctx.strokeRect(1, 1, canvasWidth - 2, canvasHeight - 2);

  // Bal
  ctx.fillStyle = inkColor;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
  ctx.fill();
}

function step(frameMs) {
  if (!running) return;

  if (lastFrameMs === null) lastFrameMs = frameMs;
  const dt = clamp((frameMs - lastFrameMs) / 1000, 0, 0.05); // cap dt
  lastFrameMs = frameMs;

  if (needsResize) resizeCanvasToDisplaySize();

  // Versnelling vanuit tilt (m/s^2) -> px/s^2
  // Canvas heeft y naar beneden positief.
  const ax = tiltAx * SETTINGS.accelScale;
  const ay = tiltAy * SETTINGS.accelScale;

  ball.vx += ax * dt;
  ball.vy += ay * dt;

  // Demping
  ball.vx *= SETTINGS.friction;
  ball.vy *= SETTINGS.friction;

  // Speed cap
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > SETTINGS.maxSpeed) {
    const s = SETTINGS.maxSpeed / speed;
    ball.vx *= s;
    ball.vy *= s;
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Muur-collisions
  let hit = false;
  let impactSpeed = 0;

  if (ball.x - ball.r < 2) {
    impactSpeed = Math.max(impactSpeed, Math.abs(ball.vx));
    ball.x = ball.r + 2;
    ball.vx = -ball.vx * SETTINGS.restitution;
    hit = true;
  } else if (ball.x + ball.r > canvasWidth - 2) {
    impactSpeed = Math.max(impactSpeed, Math.abs(ball.vx));
    ball.x = canvasWidth - ball.r - 2;
    ball.vx = -ball.vx * SETTINGS.restitution;
    hit = true;
  }

  if (ball.y - ball.r < 2) {
    impactSpeed = Math.max(impactSpeed, Math.abs(ball.vy));
    ball.y = ball.r + 2;
    ball.vy = -ball.vy * SETTINGS.restitution;
    hit = true;
  } else if (ball.y + ball.r > canvasHeight - 2) {
    impactSpeed = Math.max(impactSpeed, Math.abs(ball.vy));
    ball.y = canvasHeight - ball.r - 2;
    ball.vy = -ball.vy * SETTINGS.restitution;
    hit = true;
  }

  if (hit && impactSpeed > SETTINGS.minImpactSpeedForVibrate) {
    const now = performance.now();
    if (now - lastVibrateMs > SETTINGS.vibrateCooldownMs) {
      lastVibrateMs = now;
      vibrateIfSupported(SETTINGS.vibrateMs);
    }
  }

  draw();
  rafId = window.requestAnimationFrame(step);
}

function attachListeners() {
  window.addEventListener('devicemotion', onMotion, { passive: true });
}

function detachListeners() {
  window.removeEventListener('devicemotion', onMotion);
}

async function start() {
  if (running) return;

  if (!window.isSecureContext) {
    setStatus('Tip: gebruik HTTPS of localhost voor sensoren.');
  } else {
    setStatus('');
  }

  const permission = await requestIOSPermissionIfNeeded();
  if (!permission.ok) {
    setStatus(`Geen toegang tot sensoren: ${permission.details}`);
    return;
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  updateInkColor();

  tiltAx = 0;
  tiltAy = 0;
  lastFrameMs = null;

  attachListeners();
  resetBallToCenter();

  setStatus('Running…');
  rafId = window.requestAnimationFrame(step);
}

function stop() {
  if (!running) return;
  running = false;

  detachListeners();

  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Gestopt.');
}

// UI wiring
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);

// Init
updateInkColor();
resetBallToCenter();
if (!window.isSecureContext) {
  setStatus('Tip: gebruik HTTPS of localhost voor sensoren.');
}

// Keep canvas sized correctly on rotate/resize.
// Op mobiel kan resize vaak getriggerd worden (browser UI). Niet steeds recenteren.
window.addEventListener('resize', () => {
  needsResize = true;
  if (!running) {
    resetBallToCenter();
  }
});

// Als het thema/kleuren veranderen (light/dark), refresh de kleur.
try {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => updateInkColor());
} catch {
  // ignore
}
