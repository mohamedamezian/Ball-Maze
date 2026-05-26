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

// Canvas grafieken (laatste 5 seconden)
const accelChart = document.getElementById('accelChart');
const rotChart = document.getElementById('rotChart');
const rotHint = document.getElementById('rotHint');

let running = false;

// 5-seconden window (rolling)
const WINDOW_MS = 5000;

// Opslag van samples in het window.
// We bewaren zowel accelerationIncludingGravity als rotationRate omdat acceleration vaak null kan zijn.
const samples = [];
let sampleStart = 0;

// Throttle sampling: sommige devices sturen >100Hz.
const SAMPLE_EVERY_MS = 16; // ~60Hz
let lastSampleMs = 0;

let rafId = null;

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

function nowMs() {
  // Date.now() is voldoende voor een sliding window.
  return Date.now();
}

function pruneOldSamples(cutoffMs) {
  // Verwijder alles ouder dan cutoff.
  // Gebruik een start-index om shift() (O(n)) te vermijden.
  while (sampleStart < samples.length && samples[sampleStart].t < cutoffMs) {
    sampleStart += 1;
  }

  // Af en toe compacten om geheugen/GC netjes te houden.
  if (sampleStart > 256) {
    samples.splice(0, sampleStart);
    sampleStart = 0;
  }
}

function resizeCanvasToDisplaySize(canvas) {
  // Zorg dat canvas (buffer) matcht met CSS size voor scherpe lijnen op retina.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssWidth = Math.max(1, Math.floor(canvas.clientWidth));
  const cssHeight = Math.max(1, Math.floor(canvas.clientHeight));

  const targetWidth = Math.floor(cssWidth * dpr);
  const targetHeight = Math.floor(cssHeight * dpr);

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    return true;
  }
  return false;
}

function drawTimeSeries({
  canvas,
  ctx,
  series,
  yUnitLabel,
  inkColor,
}) {
  // Teken een simpele line chart van de laatste WINDOW_MS.
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Padding binnen canvas
  const padL = 42;
  const padR = 12;
  const padT = 18;
  const padB = 22;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  // Inks op basis van body color (geen hard-coded kleuren)
  ctx.strokeStyle = inkColor;
  ctx.fillStyle = inkColor;
  ctx.lineWidth = 2;

  // Bepaal y-range uit samples
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = sampleStart; i < samples.length; i += 1) {
    const s = samples[i];
    for (const def of series) {
      const v = def.get(s);
      if (v === null || v === undefined) continue;
      if (!Number.isFinite(v)) continue;
      minY = Math.min(minY, v);
      maxY = Math.max(maxY, v);
    }
  }

  // Geen data? Teken lege box met tekst.
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    ctx.strokeRect(padL, padT, plotW, plotH);
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('Nog geen data…', padL + 8, padT + 18);
    return;
  }

  // Als alles gelijk is, geef een beetje range.
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }

  // Kleine marge zodat lijn niet tegen rand zit.
  const padY = (maxY - minY) * 0.1;
  minY -= padY;
  maxY += padY;

  const tMax = nowMs();
  const tMin = tMax - WINDOW_MS;

  const xForT = (t) => padL + ((t - tMin) / WINDOW_MS) * plotW;
  const yForV = (v) => {
    const norm = (v - minY) / (maxY - minY);
    return padT + (1 - norm) * plotH;
  };

  // Frame / as
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(padL, padT, plotW, plotH);

  // 0-lijn als 0 binnen range valt
  if (minY < 0 && maxY > 0) {
    const y0 = yForV(0);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(padL, y0);
    ctx.lineTo(padL + plotW, y0);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Labels links (min/max)
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(`${round(maxY)} ${yUnitLabel}`, 6, padT + 10);
  ctx.fillText(`${round(minY)} ${yUnitLabel}`, 6, padT + plotH);

  // Serie(s) tekenen (dash patterns i.p.v. kleuren)
  ctx.lineWidth = 2;
  for (const def of series) {
    ctx.setLineDash(def.dash);
    ctx.beginPath();
    let started = false;

    for (let i = sampleStart; i < samples.length; i += 1) {
      const s = samples[i];
      if (s.t < tMin) continue;
      const v = def.get(s);
      if (v === null || v === undefined || !Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = xForT(s.t);
      const y = yForV(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }

  // Legend bovenin
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  const legendY = 12;
  let legendX = padL + 8;
  for (const def of series) {
    // klein lijntje met dash
    ctx.setLineDash(def.dash);
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 18, legendY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(def.name, legendX + 22, legendY + 4);
    legendX += 70;
  }
}

function render() {
  if (!running) return;

  const cutoff = nowMs() - WINDOW_MS;
  pruneOldSamples(cutoff);

  // 1x per frame ink bepalen (i.p.v. per chart)
  const inkColor = getComputedStyle(document.body).color;

  // AccelerationIncludingGravity chart
  if (accelChart) {
    resizeCanvasToDisplaySize(accelChart);
    const ctx = accelChart.getContext('2d');
    if (ctx) {
      drawTimeSeries({
        canvas: accelChart,
        ctx,
        yUnitLabel: 'm/s²',
        inkColor,
        series: [
          { name: 'x', dash: [], get: (s) => s.ax },
          { name: 'y', dash: [8, 5], get: (s) => s.ay },
          { name: 'z', dash: [2, 6], get: (s) => s.az },
        ],
      });
    }
  }

  // RotationRate chart (kan null zijn op sommige devices/browsers)
  if (rotChart) {
    resizeCanvasToDisplaySize(rotChart);
    const ctx = rotChart.getContext('2d');
    if (ctx) {
      drawTimeSeries({
        canvas: rotChart,
        ctx,
        yUnitLabel: 'deg/s',
        inkColor,
        series: [
          { name: 'alpha', dash: [], get: (s) => s.ra },
          { name: 'beta', dash: [8, 5], get: (s) => s.rb },
          { name: 'gamma', dash: [2, 6], get: (s) => s.rg },
        ],
      });
    }
  }

  rafId = window.requestAnimationFrame(render);
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

  // Bewaar sample voor grafiek (5s window)
  const t = nowMs();
  if (t - lastSampleMs >= SAMPLE_EVERY_MS) {
    lastSampleMs = t;

    samples.push({
      t,
      // AccelerationIncludingGravity is meestal het meest consistent beschikbaar
      ax: accelG.x ?? null,
      ay: accelG.y ?? null,
      az: accelG.z ?? null,
      // RotationRate kan ontbreken
      ra: rot.alpha ?? null,
      rb: rot.beta ?? null,
      rg: rot.gamma ?? null,
    });

    pruneOldSamples(t - WINDOW_MS);

    // Kleine hint als rotationrate ontbreekt
    if (rotHint) {
      let hasRot = false;
      for (let i = sampleStart; i < samples.length; i += 1) {
        const s = samples[i];
        if (Number.isFinite(s.ra) || Number.isFinite(s.rb) || Number.isFinite(s.rg)) {
          hasRot = true;
          break;
        }
      }
      rotHint.textContent = hasRot ? '' : 'Geen rotationRate data (niet ondersteund of geen permissie).';
    }
  }

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

    // Nieuwe sessie: buffer leegmaken
    samples.length = 0;
    sampleStart = 0;
    lastSampleMs = 0;
    if (rotHint) rotHint.textContent = '';

    attachListeners();

    // Start render loop voor grafieken
    if (rafId === null) {
      rafId = window.requestAnimationFrame(render);
    }

    setStatus('Leest sensoren uit...');
  } catch (e) {
    setStatus(`Starten mislukt: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function stop() {
  if (!running) return;
  running = false;

  detachListeners();

  // Stop render loop
  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  // Buffer leegmaken en UI resetten
  samples.length = 0;
  sampleStart = 0;
  lastSampleMs = 0;
  if (rotHint) rotHint.textContent = '';

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
