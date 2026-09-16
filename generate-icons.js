import fs from 'fs';
import sharp from 'sharp';

// 1. Standard SVG Icon
const standardSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0e1730" />
      <stop offset="100%" stop-color="#080d1b" />
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6" />
      <stop offset="50%" stop-color="#6d28d9" />
      <stop offset="100%" stop-color="#2563eb" />
    </linearGradient>
    <linearGradient id="waveGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#e0e7ff" />
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="#8b5cf6" flood-opacity="0.45" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="512" height="512" rx="112" fill="url(#bgGrad)" />
  <rect width="508" height="508" x="2" y="2" rx="110" fill="none" stroke="#263452" stroke-width="3" opacity="0.6" />

  <!-- Center Glowing Brand Mark -->
  <rect x="106" y="106" width="300" height="300" rx="72" fill="url(#cardGrad)" filter="url(#glow)" />

  <!-- Audio Waveform Bars inside Mark -->
  <g fill="url(#waveGrad)">
    <rect x="162" y="206" width="22" height="100" rx="11" />
    <rect x="198" y="156" width="22" height="200" rx="11" />
    <rect x="234" y="126" width="22" height="260" rx="11" fill="#c4b5fd" />
    <rect x="270" y="176" width="22" height="160" rx="11" />
    <rect x="306" y="196" width="22" height="120" rx="11" />
  </g>
</svg>
`.trim();

// 2. Maskable SVG (designed for Android circular/squircle crop with 15% safe margin)
const maskableSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="mbg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#111a2e" />
      <stop offset="100%" stop-color="#080d1b" />
    </linearGradient>
    <linearGradient id="mcard" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6" />
      <stop offset="50%" stop-color="#6d28d9" />
      <stop offset="100%" stop-color="#2563eb" />
    </linearGradient>
    <linearGradient id="mwave" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#e0e7ff" />
    </linearGradient>
  </defs>

  <!-- Full bleed background for Android masking -->
  <rect width="512" height="512" fill="url(#mbg)" />

  <!-- Centered safe-zone brand badge (within central 80%) -->
  <rect x="131" y="131" width="250" height="250" rx="60" fill="url(#mcard)" />

  <!-- Waveform inside badge -->
  <g fill="url(#mwave)">
    <rect x="180" y="216" width="18" height="80" rx="9" />
    <rect x="210" y="176" width="18" height="160" rx="9" />
    <rect x="240" y="151" width="18" height="210" rx="9" fill="#c4b5fd" />
    <rect x="270" y="191" width="18" height="130" rx="9" />
    <rect x="300" y="206" width="18" height="100" rx="9" />
  </g>
</svg>
`.trim();

async function generate() {
  fs.writeFileSync('./icon.svg', standardSvg);

  const svgBuffer = Buffer.from(standardSvg);
  const maskableBuffer = Buffer.from(maskableSvg);

  await sharp(svgBuffer).resize(192, 192).png().toFile('./icon-192.png');
  await sharp(svgBuffer).resize(512, 512).png().toFile('./icon-512.png');
  await sharp(maskableBuffer).resize(512, 512).png().toFile('./icon-maskable-512.png');
  await sharp(svgBuffer).resize(180, 180).png().toFile('./apple-touch-icon.png');
  await sharp(svgBuffer).resize(64, 64).png().toFile('./favicon.png');

  console.log('PWA icons successfully generated!');
}

generate().catch(err => {
  console.error(err);
  process.exit(1);
});
