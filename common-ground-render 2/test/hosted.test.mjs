import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const ORIGIN = 'https://common-ground.example';
const CODE = 'SyntheticHostedPilotCode2026-OnlyForTests';
const PASSWORD = 'SyntheticAccountPassword2026!';

async function start(dbPath, options = {}) {
  const server = await createApp({ deploymentMode: 'hosted', dbPath, appOrigin: ORIGIN,
    registrationCode: CODE, demoMode: false, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'common-ground-hosted-'));
  const dbPath = join(directory, 'network.sqlite');
  const app = await start(dbPath, options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...app, dbPath };
}

function client(app) {
  return {
    cookie: '', csrfToken: '', user: null,
    async request(path, { method = 'GET', body, headers = {}, csrf = true } = {}) {
      const requestHeaders = { Host: new URL(ORIGIN).host, Origin: ORIGIN, ...headers };
      if (this.cookie) requestHeaders.Cookie = this.cookie;
      if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
      if (csrf && this.csrfToken) requestHeaders['X-CSRF-Token'] = this.csrfToken;
      // Model Render's HTTP hop with its actual external Host header. fetch()
      // deliberately rewrites Host, so raw HTTP is required for these tests.
      const response = await new Promise((resolve, reject) => {
        const request = http.request(app.url + path, { method, headers: requestHeaders }, incoming => {
          const chunks = [];
          incoming.on('data', chunk => chunks.push(chunk));
          incoming.on('error', reject);
          incoming.on('end', () => resolve({ status: incoming.statusCode, raw: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers }));
        });
        request.on('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
      const cookies = response.headers['set-cookie'] || [];
      if (cookies.length) this.cookie = cookies[0].split(';')[0];
      const raw = response.raw;
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch {} }
      if (response.status < 400 && data?.csrfToken) this.csrfToken = data.csrfToken;
      if (response.status < 400 && data?.user) this.user = data.user;
      return { status: response.status, data, headers: new Headers(response.headers), cookies, raw };
    },
    async register(name, email) {
      const response = await this.request('/api/auth/register', { method: 'POST', body: { name, email, password: PASSWORD, registrationCode: CODE } });
      assert.equal(response.status, 201, response.raw);
      return response;
    },
    async login(email) {
      const response = await this.request('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
      assert.equal(response.status, 200, response.raw);
      return response;
    },
  };
}

test('hosted configuration fails closed and local binding remains restricted', async () => {
  const base = { deploymentMode: 'hosted', dbPath: '/tmp/common-ground-config-only.sqlite', appOrigin: ORIGIN, registrationCode: CODE, demoMode: false };
  for (const bad of [
    { demoMode: true }, { appOrigin: null }, { appOrigin: 'http://common-ground.example' },
    { appOrigin: `${ORIGIN}/path` }, { registrationCode: null }, { registrationCode: 'short' },
    { registrationCode: 'x'.repeat(129) }, { dbPath: 'relative.sqlite' }, { dbPath: ':memory:' },
    { host: '127.0.0.1' }, { deploymentMode: 'mistyped' },
  ]) await assert.rejects(createApp({ ...base, ...bad }));
  await assert.rejects(createApp({ deploymentMode: 'hosted', appOrigin: ORIGIN, registrationCode: CODE, demoMode: false }), /DB_PATH/);
  await assert.rejects(createApp({ dbPath: ':memory:', host: '0.0.0.0' }), /loopback/i);
  const oldEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(createApp({ ...base, demoMode: true }), /Demo/); }
  finally { if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment; }
});

test('health and shared config disclose no database or registration secret', async t => {
  const app = await fixture(t);
  const anonymous = client(app);
  assert.equal(app.server.address().address, '0.0.0.0');
  const health = await anonymous.request('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { ok: true });
  const config = await anonymous.request('/api/config');
  assert.equal(config.data.storageMode, 'shared');
  assert.equal(config.data.hosted, true);
  assert.equal(config.data.registrationCodeRequired, true);
  assert.equal(config.data.companyDomain, null);
  assert.equal(config.data.demoMode, false);
  assert.equal(Object.hasOwn(config.data, 'demoPassword'), false);
  assert.equal(config.raw.includes(CODE), false);
  assert.equal(config.raw.includes(app.dbPath), false);
  assert.match(config.headers.get('strict-transport-security'), /max-age=/);
  assert.equal((await anonymous.request('/server.mjs')).status, 404);
  assert.equal((await anonymous.request('/.env')).status, 404);
});

test('only configured Host and exact HTTPS Origin are accepted; forwarded headers cannot override them', async t => {
  const app = await fixture(t);
  const anonymous = client(app);
  for (const Host of ['attacker.example', '127.0.0.1', `${new URL(ORIGIN).host}:443`]) {
    const result = await anonymous.request('/api/config', { headers: { Host,
      'X-Forwarded-Host': new URL(ORIGIN).host, 'X-Forwarded-Proto': 'https' } });
    assert.equal(result.status, 403);
  }
  for (const Origin of ['https://attacker.example', ORIGIN.replace('https:', 'http:'), 'null']) {
    const result = await anonymous.request('/api/auth/login', { method: 'POST', headers: { Origin },
      body: { email: 'absent@example.com', password: PASSWORD } });
    assert.equal(result.status, 403);
  }
  const legitimate = await anonymous.request('/healthz', { headers: {
    'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '198.51.100.3',
  } });
  assert.equal(legitimate.status, 200, 'untrusted forwarded metadata has no effect');
});

test('hosted registration requires the code and sets HTTPS-only session cookies', async t => {
  const app = await fixture(t);
  const member = client(app);
  for (const registrationCode of [undefined, '', 'incorrect', 'x'.repeat(129)]) {
    const result = await member.request('/api/auth/register', { method: 'POST', body: {
      name: 'Pilot Member', email: 'member@example.com', password: PASSWORD, registrationCode,
    } });
    assert.equal(result.status, 403);
  }
  const registered = await member.register('Pilot Member', 'member@example.com');
  const cookie = registered.cookies[0];
  for (const flag of [/;\s*Secure/i, /;\s*HttpOnly/i, /;\s*SameSite=Strict/i, /;\s*Path=\//i]) assert.match(cookie, flag);
  assert.equal((await member.request('/api/auth/me')).status, 200);
  const badWrite = await member.request('/api/saved/unknown', { method: 'POST', body: {}, csrf: false });
  assert.equal(badWrite.status, 403, 'hosted writes retain CSRF protection');
});

test('separate hosted clients share real accounts/chat and retain data across reopening', async t => {
  const app = await fixture(t);
  const alice = client(app), bob = client(app), outsider = client(app);
  await alice.register('Alice Engineer', 'alice@example.com');
  await bob.register('Bob Designer', 'bob@example.com');
  await outsider.register('Outside Colleague', 'outside@example.com');
  const sent = await alice.request(`/api/chats/${bob.user.id}/messages`, { method: 'POST', body: { body: 'Hello from another browser.', clientId: randomUUID() } });
  assert.equal(sent.status, 201);
  const inbox = await bob.request('/api/chats');
  assert.equal(inbox.data.unreadCount, 1);
  assert.equal(inbox.data.conversations[0].person.id, alice.user.id);
  assert.equal((await outsider.request(`/api/chats/${alice.user.id}`)).data.messages.length, 0);
  const read = await bob.request(`/api/chats/${alice.user.id}/read`, { method: 'POST', body: { throughId: sent.data.message.id } });
  assert.deepEqual(read.data, { ok: true, unreadCount: 0, latestMessageId: sent.data.message.id });
  assert.equal((await alice.request(`/api/saved/${bob.user.id}`, { method: 'POST', body: {} })).status, 200);
  await app.close();
  const reopened = await start(app.dbPath);
  try {
    const restoredAlice = client(reopened);
    await restoredAlice.login('alice@example.com');
    const thread = await restoredAlice.request(`/api/chats/${bob.user.id}`);
    assert.equal(thread.data.messages[0].body, 'Hello from another browser.');
    assert.equal((await restoredAlice.request('/api/people?saved=1')).data.people[0].id, bob.user.id);
  } finally { await reopened.close(); }
});

test('spoofed XFF does not bypass account limits or lock unrelated accounts behind one proxy', async t => {
  const app = await fixture(t);
  const alice = client(app), bob = client(app), attacker = client(app);
  await alice.register('Alice', 'alice@example.com');
  await bob.register('Bob', 'bob@example.com');
  for (let attempt = 0; attempt < 13; attempt++) {
    const result = await attacker.request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': `198.51.100.${attempt + 1}` },
      body: { email: 'alice@example.com', password: 'IncorrectPassword2026!' } });
    assert.equal(result.status, attempt < 12 ? 401 : 429);
  }
  assert.equal((await bob.login('bob@example.com')).status, 200, 'one account limit does not throttle the proxy IP');
});

test('public password hashing concurrency is bounded and failed overload does not corrupt accounts', async t => {
  const app = await fixture(t);
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => client(app).request('/api/auth/register', {
    method: 'POST', body: { name: `Member ${index}`, email: `concurrent${index}@example.com`, password: PASSWORD, registrationCode: CODE },
  })));
  assert.ok(attempts.some(result => result.status === 201));
  assert.ok(attempts.some(result => result.status === 503), 'excess concurrent scrypt jobs are rejected rather than queued');
  assert.ok(attempts.every(result => [201, 503].includes(result.status)));
  assert.equal((await client(app).request('/healthz')).status, 200);
});

test('production CLI accepts Render external URL without APP_ORIGIN and shuts down cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'common-ground-render-cli-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DEPLOYMENT_MODE: 'hosted', NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '0',
      APP_ORIGIN: '', RENDER_EXTERNAL_URL: ORIGIN, DB_PATH: join(directory, 'network.sqlite'),
      DEMO_MODE: 'false', REGISTRATION_ENABLED: 'true', REGISTRATION_CODE: CODE, COMPANY_DOMAIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Hosted CLI did not become ready.')), 10_000);
      child.on('error', error => { clearTimeout(deadline); reject(error); });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('Common Ground shared pilot is ready.')) { clearTimeout(deadline); resolve(); }
      });
      exited.then(result => { clearTimeout(deadline); if (result.code !== null) reject(new Error(`CLI exited before ready: ${errors}`)); });
    });
    assert.equal(output.includes(CODE), false);
    assert.equal(errors.includes(CODE), false);
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
