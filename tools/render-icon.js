'use strict';
// Renderiza o ícone do app (SVG → PNG 1024) usando o próprio Electron.
// Uso: npx electron tools/render-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;

// Squircle no grid da Apple: quadrado de 824 centralizado, raio ~185.
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="#22222b"/>
      <stop offset="100%" stop-color="#0d0d11"/>
    </radialGradient>
    <clipPath id="fabric"><circle cx="512" cy="512" r="300"/></clipPath>
  </defs>

  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>

  <!-- tecido -->
  <circle cx="512" cy="512" r="300" fill="#26262f"/>

  <!-- costura em ponto corrido -->
  <g clip-path="url(#fabric)">
    <path d="M 240 700 C 380 560, 470 660, 560 520 S 740 360, 820 300"
          fill="none" stroke="#b8324a" stroke-width="30"
          stroke-dasharray="66 48" stroke-linecap="round"/>
  </g>

  <!-- bastidor: anel interno e externo -->
  <circle cx="512" cy="512" r="300" fill="none" stroke="#8a5f1e" stroke-width="14" opacity="0.9"/>
  <circle cx="512" cy="512" r="332" fill="none" stroke="#e8a13d" stroke-width="36"/>

  <!-- parafuso de aperto -->
  <g transform="rotate(-45 512 512)">
    <rect x="484" y="128" width="56" height="74" rx="16" fill="#e8a13d"/>
    <rect x="497" y="96" width="30" height="48" rx="10" fill="#c9882c"/>
  </g>
</svg>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(10);

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>html,body{margin:0;background:transparent;overflow:hidden}</style>
    </head><body>${SVG}</body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
      const out = path.join(__dirname, '..', 'build', 'icon.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, image.toPNG());
      console.log('ícone gravado em', out);
      app.quit();
    }, 400);
  });
});
