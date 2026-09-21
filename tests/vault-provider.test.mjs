import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.VAULT_TEST_PORT) || 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const PIN = '2468';

let child;

before(async () => {
  // Isolated data dir so this test never touches the developer's real vault.
  const fs = await import('node:fs');
  const os = await import('node:os');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozforge-vault-test-'));

  const env = { ...process.env, PORT: String(PORT), VOZFORGE_DATA_DIR: dataDir };
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

let dataDir;

after(() => {
  child?.kill();
  if (dataDir) {
    import('node:fs').then((fs) => fs.rmSync(dataDir, { recursive: true, force: true }));
  }
});

const post = (url, body, headers = {}) =>
  fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const getStats = async () =>
  (await (await fetch(`${BASE}/api/vault/admin/stats?pin=${PIN}`)).json());

test('POST /api/vault/keys accepts a Cartesia key (cartesia:true) and returns masked info', async () => {
  const res = await post('/api/vault/keys', {
    pin: PIN,
    name: 'Cartesia Sonic Teste',
    key: 'sk_cs_test_key_1234567890',
    cartesia: true,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.keyInfo.name, 'Cartesia Sonic Teste');
  assert.match(body.keyInfo.masked, /^sk_cs_/);
  assert.equal(body.keyInfo.active, true);
});

test('Cartesia key stored in vault makes /api/cartesia/status available with vault source', async () => {
  const res = await fetch(`${BASE}/api/cartesia/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.source, 'vault_custom');
});

test('admin stats tag Cartesia keys with cartesia:true', async () => {
  const stats = await getStats();
  const csKey = stats.vault.keys.find((k) => k.cartesia === true);
  assert.ok(csKey, 'expected a vault key tagged as Cartesia');
  assert.match(csKey.name, /Cartesia/i);
});

test('adding a Gemini key does not deactivate the active Cartesia key (per-provider scoping)', async () => {
  await post('/api/vault/keys', { pin: PIN, name: 'Gemini Teste', key: 'AIzaSyTESTKEY1234567890' });
  const stats = await getStats();
  const csActive = stats.vault.keys.find((k) => k.cartesia && k.active);
  const gemActive = stats.vault.keys.find((k) => !k.cartesia && k.active);
  assert.ok(csActive, 'Cartesia key should remain active');
  assert.ok(gemActive, 'Gemini key should be active');
});

test('toggling a Cartesia key off makes Cartesia unavailable but keeps Gemini untouched', async () => {
  const stats = await getStats();
  const csKey = stats.vault.keys.find((k) => k.cartesia);
  const res = await post('/api/vault/keys/toggle', { pin: PIN, keyId: csKey.id, active: false });
  assert.equal(res.status, 200);

  const st = await (await fetch(`${BASE}/api/cartesia/status`)).json();
  assert.equal(st.available, false);

  const gemRes = await fetch(`${BASE}/api/config`);
  const cfg = await gemRes.json();
  assert.equal(cfg.vaultActive, true, 'Gemini vault should stay active');
});

test('vault keys endpoint still rejects a wrong admin PIN', async () => {
  const res = await post('/api/vault/keys', { pin: 'wrong-pin', name: 'X', key: 'AIzaSyFAKEKEY1234567890' });
  assert.equal(res.status, 401);
});
