# Telefoon sensordata webapp

Kleine webapp die live `DeviceMotion` (acceleratie/rotatie) uitleest en op het scherm toont.

## Bestanden

- `index.html` – markup
- `styles.css` – styling
- `app.js` – DeviceMotion logica

## Idee om dit op je mobiel te gebruiken

1. Host deze repo via **GitHub Pages** (HTTPS).
2. Open de URL op je telefoon.
3. Tik op **Start** en geef permissie (vooral op iPhone/iPad).
4. Voeg toe aan je startscherm:
	- iOS Safari: Share → Add to Home Screen
	- Android Chrome: menu → Add to Home screen

## Belangrijk (waarom HTTPS)

Veel browsers laten sensoren alleen toe in een **secure context**:

- ✅ `https://...`
- ✅ `http://localhost/...` (alleen op hetzelfde apparaat)
- ❌ `file://...` (meestal geen sensoren)
