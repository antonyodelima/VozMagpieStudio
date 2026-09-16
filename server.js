import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '15mb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Environment config endpoint
app.get('/api/config', (req, res) => {
  res.json({
    hasServerKey: Boolean(process.env.GEMINI_API_KEY)
  });
});

// Firebase / OAuth configuration endpoint
app.get('/api/firebase-config', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      return res.send(raw);
    }
    return res.status(404).json({ error: 'Configuração do Firebase não encontrada' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Audio MP3 conversion library vendor route
app.get('/vendor/lame.min.js', (req, res) => {
  const p = path.join(__dirname, 'node_modules', 'lamejs', 'lame.min.js');
  if (fs.existsSync(p)) {
    res.setHeader('Content-Type', 'application/javascript');
    return res.sendFile(p);
  }
  return res.status(404).send('// lame.min.js not found');
});

// Procedural high-resolution studio cover generator
async function generateStudioCoverPng({ title = 'Narração', voice = 'Kore', style = 'cyberpunk' }) {
  const themes = {
    cyberpunk: { bg1: '#090a1a', bg2: '#1a0d33', accent1: '#8b5cf6', accent2: '#38bdf8', glow: '#ec4899' },
    cosmic: { bg1: '#050814', bg2: '#0e1838', accent1: '#818cf8', accent2: '#c084fc', glow: '#38bdf8' },
    vintage: { bg1: '#190e08', bg2: '#2f1a0e', accent1: '#fbbf24', accent2: '#f59e0b', glow: '#d97706' },
    zen: { bg1: '#041611', bg2: '#0b2e23', accent1: '#34d399', accent2: '#10b981', glow: '#6ee7b7' },
    epic: { bg1: '#1b070c', bg2: '#300f17', accent1: '#f43f5e', accent2: '#fb7185', glow: '#fda4af' },
    minimal: { bg1: '#0a0e17', bg2: '#141d2e', accent1: '#f8fafc', accent2: '#a855f7', glow: '#06b6d4' }
  };
  const themeKey = style && themes[style.toLowerCase()] ? style.toLowerCase() : 'cyberpunk';
  const t = themes[themeKey] || themes.cyberpunk;

  // Waveform visualization bars
  let bars = '';
  const numBars = 32;
  const barW = 6;
  const gap = 3.5;
  const totalW = numBars * (barW + gap);
  const startX = 256 - totalW / 2;
  for (let i = 0; i < numBars; i++) {
    const norm = i / (numBars - 1);
    const wave = Math.sin(norm * Math.PI) * Math.sin(norm * 4 * Math.PI + 1.2);
    const h = Math.round(22 + Math.abs(wave) * 115 + (i % 4 === 0 ? 16 : 0));
    const bx = startX + i * (barW + gap);
    const by = 210 - h / 2;
    bars += `<rect x="${bx}" y="${by}" width="${barW}" height="${h}" rx="3" fill="url(#waveGrad)"/>`;
  }

  // Sanitized text content
  const cleanTitle = String(title || 'Narração').slice(0, 32).replace(/[&<>'"]/g, '');
  const cleanVoice = String(voice || 'Kore').slice(0, 20).replace(/[&<>'"]/g, '').toUpperCase();

  const svg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${t.bg1}"/>
        <stop offset="100%" stop-color="${t.bg2}"/>
      </linearGradient>
      <radialGradient id="centerGlow" cx="50%" cy="42%" r="48%">
        <stop offset="0%" stop-color="${t.accent1}" stop-opacity="0.38"/>
        <stop offset="60%" stop-color="${t.accent2}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="transparent" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="waveGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${t.accent1}"/>
        <stop offset="50%" stop-color="${t.accent2}"/>
        <stop offset="100%" stop-color="${t.glow}"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" fill="url(#bgGrad)"/>
    <rect width="512" height="512" fill="url(#centerGlow)"/>
    <circle cx="256" cy="210" r="110" fill="none" stroke="${t.accent1}" stroke-width="1.5" stroke-opacity="0.25" stroke-dasharray="4 4"/>
    <circle cx="256" cy="210" r="85" fill="none" stroke="${t.accent2}" stroke-width="1" stroke-opacity="0.25"/>
    ${bars}
    <text x="256" y="44" fill="${t.accent2}" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="11" text-anchor="middle" letter-spacing="2">VOZFORGE STUDIO • NARRAÇÃO IA</text>
    <line x1="70" y1="56" x2="442" y2="56" stroke="#ffffff" stroke-opacity="0.15" stroke-width="1"/>
    <text x="256" y="385" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-weight="bold" font-size="22" text-anchor="middle">${cleanTitle}</text>
    <rect x="121" y="422" width="270" height="34" rx="17" fill="#080d1b" fill-opacity="0.88" stroke="${t.accent1}" stroke-width="1" stroke-opacity="0.4"/>
    <text x="256" y="444" fill="#c7d0e8" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="12" text-anchor="middle">🎙️ VOZ: ${cleanVoice}</text>
  </svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// Cover Image Generation Proxy
app.post('/api/generate-cover', async (req, res) => {
  try {
    const clientKey = req.headers['x-goog-api-key'];
    const apiKey = clientKey || process.env.GEMINI_API_KEY;

    const { prompt, title, voice, style } = req.body || {};

    let imageUrl = null;
    let methodUsed = null;

    // 1. Try Gemini image model if API key is provided
    if (apiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const themeDesc = style ? `in ${style} visual aesthetic` : 'in modern cinematic studio aesthetic';
        const visualPrompt = prompt || `A square album cover art for an audio narration project titled "${title || 'Narração'}" with voice "${voice || 'Voz'}" ${themeDesc}. Abstract luminous soundwaves, cosmic atmospheric lighting, audio studio vibe, vibrant contrast, minimalist typography, 1:1 aspect ratio, high resolution graphic design.`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite-image',
          contents: {
            parts: [{ text: visualPrompt }]
          },
          config: {
            imageConfig: {
              aspectRatio: '1:1'
            }
          }
        });

        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
            methodUsed = 'gemini-3.1-flash-lite-image';
            break;
          }
        }
      } catch (liteErr) {
        // Quota exceeded (429) or model unavailable on current tier - handle gracefully without error logs
      }
    }

    // 2. High-resolution procedural graphic studio engine fallback
    if (!imageUrl) {
      const pngBuf = await generateStudioCoverPng({ title, voice, style });
      imageUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
      methodUsed = 'procedural-studio-engine';
    }

    return res.json({
      ok: true,
      imageUrl,
      model: methodUsed,
      note: methodUsed === 'gemini-3.1-flash-lite-image'
        ? 'Capa com IA gerada com sucesso!'
        : 'Capa temática em alta resolução gerada pelo motor gráfico do estúdio.'
    });
  } catch (error) {
    console.error('Error in /api/generate-cover:', error);
    return res.status(500).json({
      error: {
        message: error.message || 'Erro ao gerar imagem de capa'
      }
    });
  }
});

// Gemini TTS & Interactions Proxy (server-side API call)
app.post('/api/interactions', async (req, res) => {
  try {
    const clientKey = req.headers['x-goog-api-key'];
    const apiKey = clientKey || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(400).json({
        error: {
          message: 'Nenhuma chave Gemini API configurada. Adicione sua chave na aba API ou configure a variável GEMINI_API_KEY no ambiente.'
        }
      });
    }

    const payload = { ...(req.body || {}) };

    // Strip client-only or invalid parameters that the Interactions API rejects
    delete payload.speed;
    delete payload.speaking_rate;

    // Convert legacy/client response_format to response_modalities
    if (payload.response_format?.type === 'audio' || !payload.response_modalities) {
      if (payload.model?.includes('tts') || payload.response_format?.type === 'audio') {
        payload.response_modalities = ['audio'];
        delete payload.response_format;
      }
    }

    // Sanitize speech_config if present
    if (payload.generation_config?.speech_config) {
      if (Array.isArray(payload.generation_config.speech_config)) {
        payload.generation_config.speech_config = payload.generation_config.speech_config.map(item => {
          const clean = { ...item };
          delete clean.speed;
          delete clean.speaking_rate;
          return clean;
        });
      }
    }

    const doCallInteractions = async () => {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      return { status: response.status, headers: response.headers, data };
    };

    let result = await doCallInteractions();

    // Handle 429 Resource Exhausted / Rate Limit
    if (result.status === 429) {
      const errMsg = result.data?.error?.message || '';
      let retrySec = null;
      const retryHeader = result.headers?.get ? result.headers.get('retry-after') : null;
      if (retryHeader) {
        const parsed = parseFloat(retryHeader);
        if (!isNaN(parsed) && parsed > 0) retrySec = parsed;
      }
      if (!retrySec) {
        const match = errMsg.match(/Please retry in ([0-9.]+)s/i);
        if (match && match[1]) {
          retrySec = parseFloat(match[1]);
        }
      }

      // If retry duration is brief (<= 8.5s), wait on server and retry once automatically
      if (retrySec !== null && retrySec <= 8.5) {
        const waitMs = Math.ceil(retrySec * 1000) + 500;
        await new Promise(r => setTimeout(r, waitMs));
        result = await doCallInteractions();
      }

      // If still 429, decorate error with friendly localized message and retry metadata
      if (result.status === 429) {
        const finalMsg = result.data?.error?.message || '';
        const match2 = finalMsg.match(/Please retry in ([0-9.]+)s/i);
        const finalSec = match2 && match2[1] ? Math.ceil(parseFloat(match2[1])) : (retrySec ? Math.ceil(retrySec) : 10);
        return res.status(429).json({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            isQuota: true,
            retryAfterSeconds: finalSec,
            message: `Limite temporário de requisições por minuto da API atingido (10 req/min). Aguarde ${finalSec}s.`,
            rawDetails: finalMsg
          }
        });
      }
    }

    const data = result.data;

    // Normalize audio output so data.output_audio.data is always accessible to clients
    if (data && !data.output_audio && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (step.type === 'model_output' && Array.isArray(step.content)) {
          const audioPart = step.content.find(c => c.type === 'audio');
          if (audioPart && audioPart.data) {
            data.output_audio = {
              data: audioPart.data,
              mime_type: audioPart.mime_type || 'audio/l16; rate=24000; channels=1'
            };
            break;
          }
        }
      }
    }

    return res.status(result.status).json(data);
  } catch (error) {
    console.error('Error in /api/interactions proxy:', error);
    return res.status(500).json({
      error: {
        message: error.message || 'Erro de comunicação com a API do Gemini'
      }
    });
  }
});

// Serve static assets from root directory
app.use(express.static(__dirname));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VozForge Studio running on http://0.0.0.0:${PORT}`);
});
