import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

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

// Cover Image Generation Proxy
app.post('/api/generate-cover', async (req, res) => {
  try {
    const clientKey = req.headers['x-goog-api-key'];
    const apiKey = clientKey || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(400).json({
        error: {
          message: 'Nenhuma chave Gemini API configurada para geração de imagem.'
        }
      });
    }

    const { prompt, title, voice, style } = req.body || {};
    const ai = new GoogleGenAI({ apiKey });

    const themeDesc = style ? `in ${style} visual aesthetic` : 'in modern cinematic studio aesthetic';
    const visualPrompt = prompt || `A square album cover art for an audio narration project titled "${title || 'Narração'}" with voice "${voice || 'Voz'}" ${themeDesc}. Abstract luminous soundwaves, cosmic atmospheric lighting, audio studio vibe, vibrant contrast, minimalist typography, 1:1 aspect ratio, high resolution graphic design.`;

    let imageUrl = null;
    let methodUsed = null;

    // 1. Try gemini-3.1-flash-lite-image
    try {
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
      console.warn('gemini-3.1-flash-lite-image failed, attempting imagen fallback:', liteErr.message);
    }

    // 2. Fallback to imagen-3.0-generate-002 if first didn't return image
    if (!imageUrl) {
      try {
        const imagenRes = await ai.models.generateImages({
          model: 'imagen-3.0-generate-002',
          prompt: visualPrompt,
          config: {
            numberOfImages: 1,
            aspectRatio: '1:1',
            outputMimeType: 'image/jpeg'
          }
        });
        const b64 = imagenRes.generatedImages?.[0]?.image?.imageBytes;
        if (b64) {
          imageUrl = `data:image/jpeg;base64,${b64}`;
          methodUsed = 'imagen-3.0-generate-002';
        }
      } catch (imagenErr) {
        console.warn('imagen fallback failed:', imagenErr.message);
      }
    }

    if (imageUrl) {
      return res.json({ ok: true, imageUrl, model: methodUsed });
    }

    return res.status(422).json({
      error: {
        message: 'O modelo de IA não retornou imagem para este prompt. Use o gerador gráfico do estúdio.'
      }
    });
  } catch (error) {
    console.error('Error in /api/generate-cover:', error);
    return res.status(500).json({
      error: {
        message: error.message || 'Erro de comunicação ao gerar imagem de capa'
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

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
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
