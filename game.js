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

// Maze (scaled to current canvas size)
let mazeWalls = [];
let startRect = null;
let goalRect = null;
let hasWon = false;

// Throttling/cooldowns
let lastMotionMs = 0;
let lastVibrateMs = 0;

// Platform quirks
// iOS en Android verschillen soms in hoe accelG.x/y aanvoelt in de praktijk.
// We houden dit bewust simpel: Android/others -> flip X (zoals eerder nodig), iOS -> flip Y.
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const AXIS = isIOS
  ? { invertX: false, invertY: true }
  : { invertX: true, invertY: false };

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

/*
  Maze definition in normalized coordinates (0..1)
  - Walls are axis-aligned rectangles.
  - Start and goal are rectangles (visual zones; not colliders).
*/
const MAZE_NORM = {
  // Outer border is handled separately; these are inner walls.
  walls: [
    // Snake maze: alternating horizontal bars force left-right-left-right movement.
    // Gaps alternate (right, left, right, ...).
    { x: 0.04, y: 0.16, w: 0.78, h: 0.035 },
    { x: 0.18, y: 0.28, w: 0.78, h: 0.035 },
    { x: 0.04, y: 0.40, w: 0.78, h: 0.035 },
    { x: 0.18, y: 0.52, w: 0.78, h: 0.035 },
    { x: 0.04, y: 0.64, w: 0.78, h: 0.035 },
    { x: 0.18, y: 0.76, w: 0.78, h: 0.035 },

    // Extra obstacles (short vertical stubs) to make it less trivial.
    { x: 0.54, y: 0.20, w: 0.035, h: 0.07 },
    { x: 0.34, y: 0.32, w: 0.035, h: 0.07 },
    { x: 0.64, y: 0.44, w: 0.035, h: 0.07 },
    { x: 0.26, y: 0.56, w: 0.035, h: 0.07 },
    { x: 0.58, y: 0.68, w: 0.035, h: 0.07 },
  ],
  start: { x: 0.80, y: 0.04, w: 0.16, h: 0.10 },
  goal: { x: 0.04, y: 0.86, w: 0.16, h: 0.10 },
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

function getScreenAngle() {
  // iOS gebruikt vaak window.orientation (deprecated), andere browsers screen.orientation.angle
  const angle =
    (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number'
      ? screen.orientation.angle
      : typeof window.orientation === 'number'
        ? window.orientation
        : 0) || 0;

  // Normaliseer naar 0/90/180/270
  const norm = ((angle % 360) + 360) % 360;
  if (norm < 45 || norm >= 315) return 0;
  if (norm >= 45 && norm < 135) return 90;
  if (norm >= 135 && norm < 225) return 180;
  return 270;
}

function mapAccelToScreenAxes(ax, ay, angle) {
  // Remap zodat “links op het scherm” altijd links blijft, ook in landscape.
  switch (angle) {
    case 90:
      return { x: ay, y: -ax };
    case 180:
      return { x: -ax, y: -ay };
    case 270:
      return { x: -ay, y: ax };
    default:
      return { x: ax, y: ay };
  }
}

function updateInkColor() {
  // Vermijd getComputedStyle per frame.
  inkColor = getComputedStyle(document.body).color;
}

function recomputeMaze() {
  // Scale normalized maze to current canvas size.
  // Small padding from outer border (which is drawn at 1..width-2).
  const pad = 6;
  const w = Math.max(1, canvasWidth - pad * 2);
  const h = Math.max(1, canvasHeight - pad * 2);

  mazeWalls = MAZE_NORM.walls.map((r) => ({
    x: pad + r.x * w,
    y: pad + r.y * h,
    w: r.w * w,
    h: r.h * h,
  }));

  const s = MAZE_NORM.start;
  startRect = {
    x: pad + s.x * w,
    y: pad + s.y * h,
    w: s.w * w,
    h: s.h * h,
  };

  const g = MAZE_NORM.goal;
  goalRect = {
    x: pad + g.x * w,
    y: pad + g.y * h,
    w: g.w * w,
    h: g.h * h,
  };
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

  recomputeMaze();
}

function resetBallToCenter() {
  if (needsResize) resizeCanvasToDisplaySize();

  // Start inside the start zone (top-right).
  if (startRect) {
    ball.x = startRect.x + startRect.w / 2;
    ball.y = startRect.y + startRect.h / 2;
  } else {
    ball.x = canvasWidth - ball.r - 12;
    ball.y = ball.r + 12;
  }

  ball.vx = 0;
  ball.vy = 0;
  hasWon = false;
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
  const rawX = Number.isFinite(accelG.x) ? accelG.x : 0;
  const rawY = Number.isFinite(accelG.y) ? accelG.y : 0;

  // Eerst remap op basis van scherm-rotatie, daarna platform flips.
  const angle = getScreenAngle();
  const mapped = mapAccelToScreenAxes(rawX, rawY, angle);

  tiltAx = AXIS.invertX ? -mapped.x : mapped.x;
  tiltAy = AXIS.invertY ? -mapped.y : mapped.y;
}

function vibrateIfSupported(ms) {
  // iOS Safari ondersteunt vibrate meestal niet; we falen hier stil.
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(ms);
  } catch {
    // ignore
  }
}

function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

function circleIntersectsRect(cx, cy, cr, rect) {
  // Standard closest-point check.
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= cr * cr;
}

function resolveCircleRectCollision(rect) {
  // Axis-aligned rect vs circle (ball). If overlapping, push ball out on the minimum-penetration axis.
  const bx = ball.x;
  const by = ball.y;
  const r = ball.r;

  const insideX = bx + r > rect.x && bx - r < rect.x + rect.w;
  const insideY = by + r > rect.y && by - r < rect.y + rect.h;
  if (!insideX || !insideY) return 0;

  const penLeft = bx + r - rect.x;
  const penRight = rect.x + rect.w - (bx - r);
  const penTop = by + r - rect.y;
  const penBottom = rect.y + rect.h - (by - r);

  const minPenX = Math.min(penLeft, penRight);
  const minPenY = Math.min(penTop, penBottom);

  let impactSpeed = 0;

  if (minPenX < minPenY) {
    // Resolve on X
    if (penLeft < penRight) {
      impactSpeed = Math.abs(ball.vx);
      ball.x -= penLeft;
    } else {
      impactSpeed = Math.abs(ball.vx);
      ball.x += penRight;
    }
    ball.vx = -ball.vx * SETTINGS.restitution;
  } else {
    // Resolve on Y
    if (penTop < penBottom) {
      impactSpeed = Math.abs(ball.vy);
      ball.y -= penTop;
    } else {
      impactSpeed = Math.abs(ball.vy);
      ball.y += penBottom;
    }
    ball.vy = -ball.vy * SETTINGS.restitution;
  }

  return impactSpeed;
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

  // Maze walls
  ctx.fillStyle = inkColor;
  for (const w of mazeWalls) {
    ctx.fillRect(w.x, w.y, w.w, w.h);
  }

  // Start zone (visual only)
  if (startRect) {
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = inkColor;
    ctx.fillRect(startRect.x, startRect.y, startRect.w, startRect.h);
    ctx.globalAlpha = 1;

    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = inkColor;
    ctx.strokeRect(startRect.x, startRect.y, startRect.w, startRect.h);
    ctx.setLineDash([]);

    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillStyle = inkColor;
    ctx.fillText('START', startRect.x + 8, startRect.y + 18);
  }

  // Goal (turns green on win)
  if (goalRect) {
    if (hasWon) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#00c853';
      ctx.fillRect(goalRect.x, goalRect.y, goalRect.w, goalRect.h);
      ctx.globalAlpha = 1;

      ctx.lineWidth = 4;
      ctx.strokeStyle = '#00c853';
      ctx.strokeRect(goalRect.x, goalRect.y, goalRect.w, goalRect.h);
    } else {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = inkColor;
      ctx.strokeRect(goalRect.x, goalRect.y, goalRect.w, goalRect.h);
      ctx.globalAlpha = 1;
    }

    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillStyle = inkColor;
    ctx.fillText('GOAL', goalRect.x + 8, goalRect.y + 18);
  }

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

  // Maze wall collisions
  let wallImpact = 0;
  for (const rect of mazeWalls) {
    wallImpact = Math.max(wallImpact, resolveCircleRectCollision(rect));
  }

  if (wallImpact > SETTINGS.minImpactSpeedForVibrate) {
    const now = performance.now();
    if (now - lastVibrateMs > SETTINGS.vibrateCooldownMs) {
      lastVibrateMs = now;
      vibrateIfSupported(SETTINGS.vibrateMs);
    }
  }

  // Win condition
  if (!hasWon && goalRect && circleIntersectsRect(ball.x, ball.y, ball.r, goalRect)) {
    hasWon = true;
    ball.vx = 0;
    ball.vy = 0;
    tiltAx = 0;
    tiltAy = 0;
    setStatus('Finished!');
    draw();
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
  hasWon = false;

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
