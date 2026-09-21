import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT) || 3179;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

before(async () => {
  // Mirror the workspace env (mirrors how the platform runs the server):
  // .env.local overrides .env, real environment variables override both.
  const fs = await import('node:fs');
  const env = { ...process.env, PORT: String(PORT) };
  for (const file of ['.env', '.env.local']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(file === '.env' && m[1] in env)) env[m[1]] = m[2];
    }
  }
  child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { if (process.env.SMOKE_VERBOSE) process.stdout.write(`[server] ${d}`); });
  child.stderr.on('data', (d) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server:err] ${d}`); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
});

after(() => {
  child?.kill();
});

test('GET /api/health returns ok', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /api/config reports vault key status', async () => {
  const res = await fetch(`${BASE}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.hasServerKey, 'boolean');
  assert.equal(typeof body.vaultActive, 'boolean');
});

test('GET /api/vault/status exposes limits and consistent usage', async () => {
  const res = await fetch(`${BASE}/api/vault/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.limits.enabled, true);
  // Usage reflects the caller's persisted counters (anonymous user), which are
  // not guaranteed to be zero on a shared workspace - assert the invariant.
  assert.equal(typeof body.userUsage.generations, 'number');
  assert.ok(body.userUsage.generations >= 0);
  assert.equal(body.userUsage.generationsRemaining, body.limits.maxDailyGenerations - body.userUsage.generations);
});

test('vault endpoints reject wrong admin PIN', async () => {
  const addRes = await fetch(`${BASE}/api/vault/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: 'wrong-pin', name: 'Teste', key: 'AIzaSyFAKEKEY1234567890' }),
  });
  assert.equal(addRes.status, 401);

  const statsRes = await fetch(`${BASE}/api/vault/admin/stats?pin=wrong-pin`);
  assert.equal(statsRes.status, 401);
});

test('POST /api/interactions behaves correctly for key state', async () => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  const res = await fetch(`${BASE}/api/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  const msg = body.error?.message || '';
  if (cfg.hasServerKey) {
    // With a (valid or invalid) server key, the request is proxied to Google,
    // which answers with upstream validation or auth errors.
    assert.match(msg, /model|agent|inválid|invalid|api key|api_key/i);
  } else {
    assert.match(msg, /chave|GEMINI_API_KEY/i);
  }
});

test('POST /api/generate-cover returns a valid PNG data URI', async () => {
  const res = await fetch(`${BASE}/api/generate-cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Teste', voice: 'Kore', style: 'cosmic' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.imageUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(body.imageUrl.split(',')[1], 'base64');
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'response should decode to a real PNG file'
  );
});

test('vendor lame.min.js is served', async () => {
  const res = await fetch(`${BASE}/vendor/lame.min.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
});

test('sensitive files are blocked from static access', async () => {
  for (const file of ['/package.json', '/server.js', '/.server-data/vault.json']) {
    const res = await fetch(`${BASE}${file}`);
    assert.equal(res.status, 403, `${file} should be forbidden`);
  }
});

test('GET /api/cartesia/status reflects server config', async () => {
  const res = await fetch(`${BASE}/api/cartesia/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.available, 'boolean');
});

test('Cartesia endpoints return clear error without API key', async () => {
  const status = await fetch(`${BASE}/api/cartesia/status`);
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  if (cfg.hasCartesiaKey) return; // server has a key; cannot test the no-key path

  const ttsRes = await fetch(`${BASE}/api/cartesia/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'Olá mundo', voice_id: 'v1' }),
  });
  assert.equal(ttsRes.status, 400);
  const ttsBody = await ttsRes.json();
  assert.match(ttsBody.error.message, /CARTESIA_API_KEY/i);

  const voicesRes = await fetch(`${BASE}/api/cartesia/voices`);
  assert.equal(voicesRes.status, 400);
});

test('POST /api/cartesia/tts validates required fields', async () => {
  const res = await fetch(`${BASE}/api/cartesia/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  // Without a key, the key error comes first (400). With a key, missing fields -> 400.
  assert.equal(res.status, 400);
});

test('POST /api/cartesia/clone without sample returns 400', async () => {
  const res = await fetch(`${BASE}/api/cartesia/clone`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('SPA fallback serves index.html for unknown routes', async () => {
  const res = await fetch(`${BASE}/alguma-rota-inexistente`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /VozForge Studio/);
});
