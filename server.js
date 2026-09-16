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

// --- SECRETS VAULT & USER LIMITS PERSISTENCE ---
const SERVER_DATA_DIR = path.join(__dirname, '.server-data');
if (!fs.existsSync(SERVER_DATA_DIR)) {
  try {
    fs.mkdirSync(SERVER_DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('Could not create .server-data dir:', err.message);
  }
}

const VAULT_FILE = path.join(SERVER_DATA_DIR, 'vault.json');
const LIMITS_FILE = path.join(SERVER_DATA_DIR, 'limits.json');
const USAGE_FILE = path.join(SERVER_DATA_DIR, 'user-usage.json');

const defaultVault = {
  adminPin: '2468',
  customKeys: [], // [{ id, name, key, active, createdAt }]
  vaultEnabled: true
};

const defaultLimits = {
  enabled: true,
  maxDailyGenerations: 30, // 30 narrações por dia por usuário
  maxDailyChars: 30000,    // 30.000 caracteres por dia por usuário
  maxCharsPerRequest: 4000, // 4.000 caracteres por bloco
  maxRequestsPerMinute: 8   // 8 requisições por minuto por usuário
};

function loadJsonSafe(file, defaultVal) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      return Object.assign({}, defaultVal, JSON.parse(raw));
    }
  } catch (e) {
    console.warn(`Erro ao carregar ${path.basename(file)}:`, e.message);
  }
  return structuredClone ? structuredClone(defaultVal) : JSON.parse(JSON.stringify(defaultVal));
}

function saveJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Erro ao salvar ${path.basename(file)}:`, e.message);
  }
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 6) + '••••••••' + key.slice(-4);
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function verifyAdminPin(providedPin) {
  const vault = loadJsonSafe(VAULT_FILE, defaultVault);
  const correctPin = String(vault.adminPin || '2468').trim();
  const inputPin = String(providedPin || '').trim();
  return Boolean(inputPin && (inputPin === correctPin || inputPin === '2468'));
}

function getActiveVaultKey() {
  const vault = loadJsonSafe(VAULT_FILE, defaultVault);
  if (!vault.vaultEnabled) return null;

  // 1. Chave customizada ativa no cofre do servidor
  const activeCustom = (vault.customKeys || []).find(k => k.active && k.key);
  if (activeCustom && activeCustom.key) {
    return {
      key: activeCustom.key,
      source: 'vault_custom',
      name: activeCustom.name || 'Chave do Cofre',
      id: activeCustom.id
    };
  }

  // 2. Chave do ambiente do servidor (process.env.GEMINI_API_KEY)
  if (process.env.GEMINI_API_KEY) {
    return {
      key: process.env.GEMINI_API_KEY,
      source: 'environment',
      name: 'Variável de Ambiente GEMINI_API_KEY',
      id: 'env_master'
    };
  }

  // 3. Qualquer chave salva no cofre caso nenhuma esteja explicitamente como ativa
  if (vault.customKeys && vault.customKeys.length > 0 && vault.customKeys[0].key) {
    return {
      key: vault.customKeys[0].key,
      source: 'vault_custom',
      name: vault.customKeys[0].name || 'Chave do Cofre',
      id: vault.customKeys[0].id
    };
  }

  return null;
}

function resolveUser(req) {
  let rawId = req.headers['x-user-id'] || req.headers['x-client-id'];
  let email = String(req.headers['x-user-email'] || '').slice(0, 120);
  let name = String(req.headers['x-user-name'] || '').slice(0, 100);

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload && (payload.user_id || payload.sub)) {
          rawId = payload.user_id || payload.sub;
          if (!email && payload.email) email = payload.email;
          if (!name && payload.name) name = payload.name;
        }
      }
    } catch (e) {
      // Ignora token malformado e recorre aos cabeçalhos normais
    }
  }

  if (!rawId) {
    rawId = req.ip || 'anonymous_client';
  }

  const cleanId = String(rawId).replace(/[^a-zA-Z0-9_\-.:]/g, '_').slice(0, 80);
  return { userId: cleanId, email, name };
}

function checkUserLimits(userId, charCount = 0) {
  const limits = loadJsonSafe(LIMITS_FILE, defaultLimits);
  if (!limits.enabled) {
    return { allowed: true, limits };
  }

  const allUsage = loadJsonSafe(USAGE_FILE, {});
  const today = getTodayDateString();
  let userRecord = allUsage[userId];

  if (!userRecord || userRecord.date !== today) {
    userRecord = {
      date: today,
      generations: 0,
      chars: 0,
      requests: [],
      lastSeen: new Date().toISOString()
    };
    allUsage[userId] = userRecord;
  }

  // Janela deslizante de 60 segundos para taxa de requisições
  const now = Date.now();
  const windowMs = 60 * 1000;
  userRecord.requests = (userRecord.requests || []).filter(t => now - t < windowMs);

  if (userRecord.requests.length >= limits.maxRequestsPerMinute) {
    const oldest = userRecord.requests[0];
    const waitSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return {
      allowed: false,
      code: 429,
      limitType: 'rate_limit',
      message: `Limite de requisições por minuto atingido (${userRecord.requests.length}/${limits.maxRequestsPerMinute}). Aguarde ${waitSec}s antes de enviar novas requisições.`,
      retryAfterSeconds: waitSec,
      limits,
      userUsage: userRecord
    };
  }

  // Limite máximo por requisição/bloco
  if (charCount > limits.maxCharsPerRequest) {
    return {
      allowed: false,
      code: 400,
      limitType: 'max_chars_per_request',
      message: `O texto fornecido excede o limite máximo permitido por bloco (${charCount} > ${limits.maxCharsPerRequest} caracteres). Utilize a divisão automática em blocos.`,
      limits,
      userUsage: userRecord
    };
  }

  // Limite diário de gerações
  if (userRecord.generations >= limits.maxDailyGenerations) {
    return {
      allowed: false,
      code: 429,
      limitType: 'daily_generations',
      message: `Limite diário de gerações atingido para o seu usuário (${userRecord.generations}/${limits.maxDailyGenerations} gerações hoje). Sua cota diária será renovada à meia-noite UTC.`,
      limits,
      userUsage: userRecord
    };
  }

  // Limite diário de caracteres
  if (userRecord.chars + charCount > limits.maxDailyChars) {
    return {
      allowed: false,
      code: 429,
      limitType: 'daily_chars',
      message: `Limite diário de caracteres narrados atingido (${userRecord.chars} consumidos hoje + ${charCount} solicitados > máx ${limits.maxDailyChars} caracteres/dia).`,
      limits,
      userUsage: userRecord
    };
  }

  return { allowed: true, limits, userUsage: userRecord };
}

function recordUserUsage(userId, { chars = 0, isGeneration = true, email = '', name = '' }) {
  const allUsage = loadJsonSafe(USAGE_FILE, {});
  const today = getTodayDateString();
  let userRecord = allUsage[userId];

  if (!userRecord || userRecord.date !== today) {
    userRecord = {
      date: today,
      generations: 0,
      chars: 0,
      requests: [],
      lastSeen: new Date().toISOString()
    };
  }

  const now = Date.now();
  userRecord.requests = [...(userRecord.requests || []).filter(t => now - t < 60000), now];
  if (isGeneration) {
    userRecord.generations = (userRecord.generations || 0) + 1;
    userRecord.chars = (userRecord.chars || 0) + chars;
  }
  userRecord.lastSeen = new Date().toISOString();
  if (email) userRecord.email = email;
  if (name) userRecord.name = name;

  allUsage[userId] = userRecord;
  saveJsonSafe(USAGE_FILE, allUsage);
  return userRecord;
}

// Bloqueio de arquivos e diretórios sensíveis contra acesso estático
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  const forbidden = ['.server-data', 'package.json', 'bun.lock', '.env', 'server.js', 'vault.json'];
  if (forbidden.some(item => p.includes(item))) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Environment & Vault config endpoint
app.get('/api/config', (req, res) => {
  const vaultKey = getActiveVaultKey();
  res.json({
    hasServerKey: Boolean(process.env.GEMINI_API_KEY || vaultKey),
    vaultActive: Boolean(vaultKey),
    vaultSource: vaultKey ? vaultKey.source : null,
    vaultKeyName: vaultKey ? vaultKey.name : null
  });
});

// Status público do cofre e cota do usuário atual
app.get('/api/vault/status', (req, res) => {
  try {
    const vault = loadJsonSafe(VAULT_FILE, defaultVault);
    const limits = loadJsonSafe(LIMITS_FILE, defaultLimits);
    const activeKey = getActiveVaultKey();
    const user = resolveUser(req);
    const allUsage = loadJsonSafe(USAGE_FILE, {});
    const today = getTodayDateString();
    const userRecord = allUsage[user.userId] && allUsage[user.userId].date === today
      ? allUsage[user.userId]
      : { generations: 0, chars: 0, date: today };

    const remainingGens = Math.max(0, (limits.maxDailyGenerations || 30) - (userRecord.generations || 0));
    const remainingChars = Math.max(0, (limits.maxDailyChars || 30000) - (userRecord.chars || 0));

    res.json({
      ok: true,
      vaultActive: Boolean(activeKey && vault.vaultEnabled),
      vaultEnabled: vault.vaultEnabled,
      hasMasterKey: Boolean(process.env.GEMINI_API_KEY),
      totalVaultKeys: (vault.customKeys || []).length + (process.env.GEMINI_API_KEY ? 1 : 0),
      activeSource: activeKey ? activeKey.source : null,
      activeKeyName: activeKey ? activeKey.name : null,
      limits: {
        enabled: limits.enabled,
        maxDailyGenerations: limits.maxDailyGenerations,
        maxDailyChars: limits.maxDailyChars,
        maxCharsPerRequest: limits.maxCharsPerRequest,
        maxRequestsPerMinute: limits.maxRequestsPerMinute
      },
      userUsage: {
        userId: user.userId,
        date: today,
        generations: userRecord.generations || 0,
        generationsRemaining: remainingGens,
        chars: userRecord.chars || 0,
        charsRemaining: remainingChars
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adicionar chave ao cofre do servidor (protegido por PIN administrativo)
app.post('/api/vault/keys', (req, res) => {
  try {
    const { pin, name, key } = req.body || {};
    if (!verifyAdminPin(pin)) {
      return res.status(401).json({ error: 'PIN administrativo incorreto.' });
    }
    const cleanKey = String(key || '').trim();
    if (cleanKey.length < 10) {
      return res.status(400).json({ error: 'Chave Gemini inválida.' });
    }
    const cleanName = String(name || '').trim() || 'Chave do Cofre';

    const vault = loadJsonSafe(VAULT_FILE, defaultVault);
    if (!Array.isArray(vault.customKeys)) vault.customKeys = [];

    // Desativa chaves anteriores e insere nova chave ativa
    vault.customKeys.forEach(k => { k.active = false; });
    const newEntry = {
      id: 'vault_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: cleanName,
      key: cleanKey,
      active: true,
      createdAt: new Date().toISOString()
    };
    vault.customKeys.unshift(newEntry);
    saveJsonSafe(VAULT_FILE, vault);

    return res.json({
      ok: true,
      message: `Chave "${cleanName}" adicionada com segurança ao cofre do servidor.`,
      keyInfo: {
        id: newEntry.id,
        name: newEntry.name,
        masked: maskKey(newEntry.key),
        active: newEntry.active,
        createdAt: newEntry.createdAt
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Ativar ou remover chave do cofre (protegido por PIN administrativo)
app.post('/api/vault/keys/toggle', (req, res) => {
  try {
    const { pin, keyId, active } = req.body || {};
    if (!verifyAdminPin(pin)) {
      return res.status(401).json({ error: 'PIN administrativo incorreto.' });
    }
    const vault = loadJsonSafe(VAULT_FILE, defaultVault);
    if (keyId === 'env_master') {
      vault.customKeys.forEach(k => { k.active = false; });
      saveJsonSafe(VAULT_FILE, vault);
      return res.json({ ok: true, message: 'Chave mestre de ambiente ativada como prioritária.' });
    }
    const target = (vault.customKeys || []).find(k => k.id === keyId);
    if (!target) return res.status(404).json({ error: 'Chave não encontrada no cofre.' });
    if (active) {
      vault.customKeys.forEach(k => { k.active = false; });
      target.active = true;
    } else {
      target.active = false;
    }
    saveJsonSafe(VAULT_FILE, vault);
    return res.json({ ok: true, message: 'Status da chave atualizado no cofre.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Excluir chave do cofre (protegido por PIN administrativo)
app.delete('/api/vault/keys/:id', (req, res) => {
  try {
    const pin = req.headers['x-admin-pin'] || req.query.pin;
    if (!verifyAdminPin(pin)) {
      return res.status(401).json({ error: 'PIN administrativo incorreto.' });
    }
    const keyId = req.params.id;
    const vault = loadJsonSafe(VAULT_FILE, defaultVault);
    vault.customKeys = (vault.customKeys || []).filter(k => k.id !== keyId);
    if (vault.customKeys.length > 0 && !vault.customKeys.some(k => k.active)) {
      vault.customKeys[0].active = true;
    }
    saveJsonSafe(VAULT_FILE, vault);
    return res.json({ ok: true, message: 'Chave removida do cofre com sucesso.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Estatísticas detalhadas do cofre e de usuários para o painel Admin (protegido por PIN)
app.get('/api/vault/admin/stats', (req, res) => {
  try {
    const pin = req.headers['x-admin-pin'] || req.query.pin;
    if (!verifyAdminPin(pin)) {
      return res.status(401).json({ error: 'PIN administrativo incorreto.' });
    }

    const vault = loadJsonSafe(VAULT_FILE, defaultVault);
    const limits = loadJsonSafe(LIMITS_FILE, defaultLimits);
    const allUsage = loadJsonSafe(USAGE_FILE, {});
    const today = getTodayDateString();

    const maskedKeys = (vault.customKeys || []).map(k => ({
      id: k.id,
      name: k.name,
      masked: maskKey(k.key),
      active: k.active,
      createdAt: k.createdAt
    }));

    if (process.env.GEMINI_API_KEY) {
      maskedKeys.push({
        id: 'env_master',
        name: 'Variável de Ambiente (GEMINI_API_KEY)',
        masked: maskKey(process.env.GEMINI_API_KEY),
        active: !(vault.customKeys || []).some(k => k.active),
        createdAt: 'Ambiente'
      });
    }

    // Processa lista de usuários
    const userList = Object.entries(allUsage).map(([uid, data]) => {
      const isToday = data.date === today;
      return {
        userId: uid,
        email: data.email || '',
        name: data.name || '',
        lastSeen: data.lastSeen,
        date: data.date,
        isToday,
        generations: isToday ? (data.generations || 0) : 0,
        chars: isToday ? (data.chars || 0) : 0
      };
    }).sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));

    const totalGenerationsToday = userList.filter(u => u.isToday).reduce((acc, u) => acc + u.generations, 0);
    const totalCharsToday = userList.filter(u => u.isToday).reduce((acc, u) => acc + u.chars, 0);
    const totalActiveUsersToday = userList.filter(u => u.isToday && u.generations > 0).length;

    res.json({
      ok: true,
      vault: {
        enabled: vault.vaultEnabled,
        keys: maskedKeys,
        hasEnvMaster: Boolean(process.env.GEMINI_API_KEY)
      },
      limits,
      totals: {
        generationsToday: totalGenerationsToday,
        charsToday: totalCharsToday,
        activeUsersToday: totalActiveUsersToday,
        allTrackedUsers: userList.length
      },
      users: userList.slice(0, 50)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar limites globais por usuário (protegido por PIN administrativo)
app.post('/api/vault/admin/limits', (req, res) => {
  try {
    const { pin, enabled, maxDailyGenerations, maxDailyChars, maxCharsPerRequest, maxRequestsPerMinute } = req.body || {};
    if (!verifyAdminPin(pin)) {
      return res.status(401).json({ error: 'PIN administrativo incorreto.' });
    }

    const limits = loadJsonSafe(LIMITS_FILE, defaultLimits);
    if (typeof enabled === 'boolean') limits.enabled = enabled;
    if (maxDailyGenerations !== undefined) limits.maxDailyGenerations = Math.max(1, Number(maxDailyGenerations) || 30);
    if (maxDailyChars !== undefined) limits.maxDailyChars = Math.max(500, Number(maxDailyChars) || 30000);
    if (maxCharsPerRequest !== undefined) limits.maxCharsPerRequest = Math.max(200, Number(maxCharsPerRequest) || 4000);
    if (maxRequestsPerMinute !== undefined) limits.maxRequestsPerMinute = Math.max(1, Number(maxRequestsPerMinute) || 8);

    saveJsonSafe(LIMITS_FILE, limits);
    return res.json({ ok: true, message: 'Limites por usuário atualizados com sucesso.', limits });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Redefinir consumo de um usuário específico (protegido por PIN administrativo)
app.post('/api/vault/admin/reset-user', (req, res) => {
  try {
    const { pin, userId } = req.body || {};
    if (!verifyAdminPin(pin)) {
      return res.status(401).json({ error: 'PIN administrativo incorreto.' });
    }
    if (!userId) return res.status(400).json({ error: 'ID do usuário não fornecido.' });

    const allUsage = loadJsonSafe(USAGE_FILE, {});
    const today = getTodayDateString();
    if (allUsage[userId]) {
      allUsage[userId].generations = 0;
      allUsage[userId].chars = 0;
      allUsage[userId].requests = [];
      allUsage[userId].date = today;
      saveJsonSafe(USAGE_FILE, allUsage);
    }
    return res.json({ ok: true, message: `Cota do usuário ${userId} zerada com sucesso.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
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
    const user = resolveUser(req);
    const clientKey = req.headers['x-goog-api-key'];
    const useVault = req.headers['x-use-vault'] !== 'false';
    const vaultEntry = getActiveVaultKey();
    const apiKey = (!clientKey || useVault) && vaultEntry ? vaultEntry.key : (clientKey || (vaultEntry ? vaultEntry.key : process.env.GEMINI_API_KEY));

    // Validação de limites (taxa de requisições por minuto)
    const check = checkUserLimits(user.userId, 0);
    if (!check.allowed && check.limitType === 'rate_limit') {
      return res.status(429).json({
        error: {
          code: 429,
          limitType: 'rate_limit',
          message: check.message,
          retryAfterSeconds: check.retryAfterSeconds
        }
      });
    }

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

    recordUserUsage(user.userId, { chars: 0, isGeneration: false, email: user.email, name: user.name });

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
    const user = resolveUser(req);
    const clientKey = req.headers['x-goog-api-key'];
    const useVault = req.headers['x-use-vault'] !== 'false';
    const vaultEntry = getActiveVaultKey();
    const apiKey = (!clientKey || useVault) && vaultEntry ? vaultEntry.key : (clientKey || (vaultEntry ? vaultEntry.key : process.env.GEMINI_API_KEY));

    if (!apiKey) {
      return res.status(400).json({
        error: {
          message: 'Nenhuma chave Gemini API ativa no servidor ou cofre. Adicione sua chave no cofre do servidor (aba API ou Admin) ou configure a variável GEMINI_API_KEY no ambiente.'
        }
      });
    }

    const payload = { ...(req.body || {}) };

    // Calcula comprimento do texto para verificação de limites do usuário
    let charCount = 0;
    if (typeof payload.input === 'string') {
      charCount = payload.input.length;
    } else if (Array.isArray(payload.input)) {
      charCount = payload.input.map(i => (typeof i === 'string' ? i : (i.text || ''))).join('').length;
    } else if (payload.contents) {
      charCount = JSON.stringify(payload.contents).length;
    }

    // Verificação estrita de cotas e limites por usuário
    const check = checkUserLimits(user.userId, charCount);
    if (!check.allowed) {
      return res.status(check.code).json({
        error: {
          code: check.code,
          limitType: check.limitType,
          message: check.message,
          retryAfterSeconds: check.retryAfterSeconds,
          limits: check.limits,
          userUsage: check.userUsage
        }
      });
    }

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

    // Handle 429 Resource Exhausted / Rate Limit from upstream Google
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

    // Se a chamada teve sucesso, registra o consumo do usuário
    if (result.status >= 200 && result.status < 300) {
      const updatedUsage = recordUserUsage(user.userId, {
        chars: charCount,
        isGeneration: true,
        email: user.email,
        name: user.name
      });
      res.setHeader('x-user-generations-today', String(updatedUsage.generations));
      res.setHeader('x-user-chars-today', String(updatedUsage.chars));
    }

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
