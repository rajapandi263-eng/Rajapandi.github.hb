import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';

const PASSWORD = 'LocalPilotPassword2026!';

async function start(dbPath, options = {}) {
  const server = await createApp({ dbPath, demoMode: false, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'company-network-test-'));
  const dbPath = join(directory, 'pilot.sqlite');
  const app = await start(dbPath, options);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...app, directory, dbPath };
}

function client(app) {
  const cookies = new Map();
  return {
    csrfToken: null,
    user: null,
    get cookie() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    async request(path, options = {}) {
      const { method = 'GET', body, csrf = false, origin = app.origin, cookie, headers = {} } = options;
      const requestHeaders = { ...headers };
      if (origin !== null) requestHeaders.Origin = origin;
      if (cookie !== undefined || this.cookie) requestHeaders.Cookie = cookie ?? this.cookie;
      if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
      if (csrf) requestHeaders['X-CSRF-Token'] = csrf === true ? this.csrfToken : csrf;
      const response = await fetch(`${app.origin}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookies = response.headers.getSetCookie();
      for (const setCookie of setCookies) {
        const pair = setCookie.split(';', 1)[0];
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); }
        catch { assert.fail(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`); }
      }
      if (response.ok && data?.csrfToken) this.csrfToken = data.csrfToken;
      if (response.ok && data?.user) this.user = data.user;
      return { status: response.status, body: data, headers: response.headers, setCookies };
    },
    async register(name, email, password = PASSWORD) {
      const result = await this.request('/api/auth/register', { method: 'POST', body: { name, email, password } });
      assert.ok([200, 201].includes(result.status), `registration failed: ${JSON.stringify(result)}`);
      assert.equal(result.body.user.email, email.trim().toLowerCase());
      assert.ok(result.body.user.id);
      assert.ok(result.body.csrfToken);
      return result;
    },
    async login(email, password = PASSWORD) {
      const result = await this.request('/api/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(result.status, 200, `login failed: ${JSON.stringify(result.body)}`);
      assert.ok(result.body.csrfToken);
      return result;
    },
    async profile(fields) {
      const result = await this.request('/api/profile', { method: 'PUT', csrf: true, body: fields });
      assert.equal(result.status, 200, `profile update failed: ${JSON.stringify(result.body)}`);
      return result.body.user;
    },
  };
}

function profile(name, overrides = {}) {
  return {
    name,
    title: 'Software engineer',
    team: 'Engineering',
    location: 'Denver',
    bio: 'Happy to share what I know and learn from colleagues.',
    skills: ['JavaScript'],
    interests: ['Photography'],
    available: true,
    listed: true,
    ...overrides,
  };
}

function assertNoCredentialFields(person) {
  for (const field of ['password', 'passwordHash', 'password_hash', 'salt', 'session', 'csrfToken']) {
    assert.equal(Object.hasOwn(person, field), false, `profile exposes ${field}`);
  }
}

test('directory and member APIs require a real authenticated session', async (t) => {
  const app = await fixture(t);
  const anonymous = client(app);
  assert.equal((await anonymous.request('/api/config')).status, 200);
  for (const path of ['/api/auth/me', '/api/people', '/api/people/not-a-member']) {
    assert.equal((await anonymous.request(path)).status, 401, path);
  }
  assert.equal((await anonymous.request('/api/profile', { method: 'PUT', body: profile('Anonymous') })).status, 401);
  assert.equal((await anonymous.request('/api/saved/not-a-member', { method: 'POST', body: {} })).status, 401);
  const forged = await anonymous.request('/api/people', { cookie: 'cg_session=forged-session' });
  assert.equal(forged.status, 401);
});

test('registration, email normalization, login and logout preserve account isolation', async (t) => {
  const app = await fixture(t);
  const member = client(app);
  const registered = await member.register('Alex Engineer', 'Alex@Example.COM');
  assertNoCredentialFields(registered.body.user);
  const cookie = registered.setCookies.find((value) => value.startsWith('cg_session='));
  assert.ok(cookie, 'registration sets session cookie');
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*SameSite=Strict/i);
  assert.match(cookie, /;\s*Path=\//i);
  const me = await member.request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, registered.body.user.id);
  assert.ok(me.body.csrfToken);

  const duplicate = await client(app).request('/api/auth/register', {
    method: 'POST', body: { name: 'Duplicate', email: 'alex@example.com', password: PASSWORD },
  });
  assert.ok([400, 409].includes(duplicate.status));

  const invalid = client(app);
  const wrongPassword = await invalid.request('/api/auth/login', {
    method: 'POST', body: { email: 'alex@example.com', password: 'IncorrectPassword2026!' },
  });
  const unknownAccount = await invalid.request('/api/auth/login', {
    method: 'POST', body: { email: 'absent@example.com', password: 'IncorrectPassword2026!' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownAccount.status, 401);
  assert.deepEqual(wrongPassword.body, unknownAccount.body, 'login errors must not reveal whether an account exists');
  assert.equal((await invalid.request('/api/auth/me')).status, 401);

  const login = await client(app).login('ALEX@example.com');
  assert.equal(login.body.user.id, registered.body.user.id);
  const oldCookie = member.cookie;
  assert.equal((await member.request('/api/auth/logout', { method: 'POST', csrf: true })).status, 204);
  assert.equal((await member.request('/api/auth/me')).status, 401);
  assert.equal((await invalid.request('/api/auth/me', { cookie: oldCookie })).status, 401, 'logged-out session cannot be replayed');
});

test('password and account input validation reject invalid registrations', async (t) => {
  const app = await fixture(t);
  const visitor = client(app);
  for (const [email, password] of [
    ['short@example.com', 'too-short'],
    ['long@example.com', 'a'.repeat(129)],
    ['not-an-email', PASSWORD],
  ]) {
    const result = await visitor.request('/api/auth/register', {
      method: 'POST', body: { name: 'Pilot Member', email, password },
    });
    assert.equal(result.status, 400, `${email}: ${JSON.stringify(result.body)}`);
  }
  assert.equal((await visitor.request('/api/auth/me')).status, 401);
});

test('JSON body size and content-type limits reject input without damaging the server', async (t) => {
  const app = await fixture(t);
  const visitor = client(app);
  const oversized = await visitor.request('/api/auth/register', {
    method: 'POST', body: { name: 'Large Body', email: 'large@example.com', password: PASSWORD, padding: 'x'.repeat(20 * 1024) },
  });
  assert.equal(oversized.status, 413);
  const unsupported = await visitor.request('/api/auth/register', {
    method: 'POST', body: { name: 'Wrong Type', email: 'type@example.com', password: PASSWORD },
    headers: { 'Content-Encoding': 'gzip' },
  });
  assert.equal(unsupported.status, 415);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.write('{"padding":"');
    request.write('x'.repeat(20 * 1024));
    request.end('"}');
  });
  assert.equal(chunkedStatus, 413);
  const unsupportedType = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'text/plain' },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end('{}');
  });
  assert.equal(unsupportedType, 415);
  await visitor.register('Valid After Rejection', 'valid@example.com');
  assert.equal((await visitor.request('/api/auth/me')).status, 200);
});

test('optional company domain restricts registration to an exact email domain', async (t) => {
  const app = await fixture(t, { companyDomain: 'Example.COM' });
  const visitor = client(app);
  assert.equal((await visitor.request('/api/config')).body.companyDomain, 'example.com');
  for (const email of ['outsider@elsewhere.com', 'subdomain@sub.example.com', 'suffix@example.com.attacker.com']) {
    const result = await visitor.request('/api/auth/register', {
      method: 'POST', body: { name: 'Outside Domain', email, password: PASSWORD },
    });
    assert.equal(result.status, 400);
  }
  await visitor.register('Company Member', 'member@EXAMPLE.com');
});

test('stored passwords and session tokens are hashed and expired sessions stop authenticating', async (t) => {
  const app = await fixture(t);
  const member = client(app);
  await member.register('Stored Safely', 'storage@example.com');
  const file = await stat(app.dbPath);
  assert.equal(file.mode & 0o777, 0o600, 'database is readable only by its owner');
  const database = new DatabaseSync(app.dbPath);
  t.after(() => database.close());
  const credentials = database.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(member.user.id);
  assert.match(credentials.password_salt, /^[a-f0-9]{32}$/);
  assert.match(credentials.password_hash, /^[a-f0-9]{128}$/);
  assert.notEqual(credentials.password_hash, PASSWORD);
  const rawToken = member.cookie.match(/cg_session=([a-f0-9]{64})/)[1];
  const stored = database.prepare('SELECT token_hash, expires_at FROM sessions WHERE user_id = ?').get(member.user.id);
  assert.equal(stored.token_hash, createHash('sha256').update(rawToken).digest('hex'));
  assert.notEqual(stored.token_hash, rawToken);
  const remaining = stored.expires_at - Date.now();
  assert.ok(remaining > 11 * 60 * 60 * 1000 && remaining <= 12 * 60 * 60 * 1000);
  database.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(member.user.id);
  assert.equal((await member.request('/api/auth/me')).status, 401);
  assert.equal((await member.request('/api/people')).status, 401);
});

test('Origin and CSRF validation prevent cross-site auth and member writes', async (t) => {
  const app = await fixture(t);
  const member = client(app);
  const registration = { name: 'Cross Site', email: 'cross@example.com', password: PASSWORD };
  for (const origin of ['https://unrelated.example', null]) {
    const result = await member.request('/api/auth/register', { method: 'POST', origin, body: registration });
    assert.equal(result.status, 403);
  }
  await member.register('Secure Member', 'secure@example.com');
  const originalName = member.user.name;
  for (const options of [
    { csrf: false },
    { csrf: 'invalid-token' },
    { csrf: true, origin: 'https://unrelated.example' },
    { csrf: true, origin: null },
  ]) {
    const result = await member.request('/api/profile', {
      method: 'PUT', body: profile('Should Not Change'), ...options,
    });
    assert.equal(result.status, 403, JSON.stringify(options));
  }
  const me = await member.request('/api/auth/me');
  assert.equal(me.body.user.name, originalName);
  assert.equal((await member.request('/api/auth/logout', { method: 'POST' })).status, 403);
  assert.equal((await member.request('/api/auth/me')).status, 200, 'rejected logout preserves the session');
  await member.profile(profile('Authorized Change'));
  assert.equal(member.user.name, 'Authorized Change');
});

test('a colleague cannot use another session token or choose whose profile to update', async (t) => {
  const app = await fixture(t);
  const first = client(app);
  const second = client(app);
  await first.register('First Member', 'first@example.com');
  await second.register('Second Member', 'second@example.com');
  const firstId = first.user.id;
  const secondId = second.user.id;
  const crossSession = await second.request('/api/profile', {
    method: 'PUT', csrf: first.csrfToken, body: profile('Cross Session Change'),
  });
  assert.equal(crossSession.status, 403);
  const update = await first.profile({
    ...profile('Own Updated Name'), id: secondId, email: 'replacement@example.com', isDemo: true,
  });
  assert.equal(update.id, firstId);
  assert.equal(update.email, 'first@example.com');
  assert.equal(update.isDemo, false);
  const untouched = await second.request('/api/auth/me');
  assert.equal(untouched.body.user.id, secondId);
  assert.equal(untouched.body.user.name, 'Second Member');
});

test('loopback Host enforcement and the static allowlist protect local source and data', async (t) => {
  const app = await fixture(t);
  const visitor = client(app);
  assert.throws(() => app.server.listen(0, '0.0.0.0'), /loopback/i);
  // Node's fetch normalizes Host, so send this header using the raw HTTP client.
  const remoteHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.origin}/api/config`, { headers: { Host: 'company.example' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(remoteHostStatus, 403);
  for (const path of ['/server.mjs', '/data/network.sqlite', '/.env', '/test/backend.test.mjs']) {
    assert.equal((await visitor.request(path)).status, 404, path);
  }
  const config = await visitor.request('/api/config');
  assert.equal(config.status, 200);
  assert.match(config.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(config.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(config.headers.get('cache-control'), 'no-store');
});

test('profile updates and directory searches discover skills, interests, teams and locations', async (t) => {
  const app = await fixture(t);
  const engineer = client(app);
  const designer = client(app);
  await engineer.register('Jordan Engineer', 'jordan@example.com');
  await designer.register('Casey Designer', 'casey@example.com');
  await engineer.profile(profile('Jordan Engineer', {
    skills: ['Kubernetes', 'Python'], interests: ['Trail running', 'Mentoring'],
  }));
  await designer.profile(profile('Casey Designer', {
    title: 'Product designer', team: 'Design', location: 'Austin', skills: ['Figma'], interests: ['Ceramics'],
    available: false,
  }));

  for (const search of ['kubernetes', 'Trail running', 'Jordan']) {
    const result = await designer.request(`/api/people?search=${encodeURIComponent(search)}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.people.map((person) => person.id), [engineer.user.id]);
    assert.equal(result.body.total, 1);
    assertNoCredentialFields(result.body.people[0]);
  }
  const filtered = await designer.request('/api/people?team=Engineering&location=Denver&available=1');
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.people.map((person) => person.id), [engineer.user.id]);
  const directory = await designer.request('/api/people');
  assert.equal(directory.body.total, 2);
  assert.ok(directory.body.facets.teams.includes('Engineering'));
  assert.ok(directory.body.facets.teams.includes('Design'));
  assert.ok(directory.body.facets.locations.includes('Denver'));
  const detail = await designer.request(`/api/people/${engineer.user.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.person.skills, ['Kubernetes', 'Python']);
  assert.deepEqual(detail.body.person.interests, ['Trail running', 'Mentoring']);
});

test('saved colleagues are scoped to each viewer and can be removed', async (t) => {
  const app = await fixture(t);
  const first = client(app);
  const second = client(app);
  await first.register('First Member', 'first@example.com');
  await second.register('Second Member', 'second@example.com');
  const save = await first.request(`/api/saved/${second.user.id}`, { method: 'POST', csrf: true });
  assert.equal(save.status, 200);
  assert.equal(save.body.saved, true);
  const savedFirst = await first.request('/api/people?saved=1');
  assert.deepEqual(savedFirst.body.people.map((person) => person.id), [second.user.id]);
  assert.equal(savedFirst.body.people[0].saved, true);
  const savedSecond = await second.request('/api/people?saved=1');
  assert.equal(savedSecond.body.total, 0);
  assert.deepEqual(savedSecond.body.people, []);
  const detailForSecond = await second.request(`/api/people/${first.user.id}`);
  assert.equal(detailForSecond.body.person.saved, false);
  const remove = await first.request(`/api/saved/${second.user.id}`, { method: 'DELETE', csrf: true });
  assert.equal(remove.status, 200);
  assert.equal(remove.body.saved, false);
  assert.equal((await first.request('/api/people?saved=1')).body.total, 0);
});

test('unlisted profiles disappear from directory and cannot be opened or saved by colleagues', async (t) => {
  const app = await fixture(t);
  const owner = client(app);
  const viewer = client(app);
  await owner.register('Private Member', 'private@example.com');
  await viewer.register('Viewer Member', 'viewer@example.com');
  assert.equal((await viewer.request(`/api/saved/${owner.user.id}`, { method: 'POST', csrf: true })).status, 200);
  await owner.profile(profile('Private Member', { listed: false }));
  assert.equal((await viewer.request('/api/people?search=Private')).body.total, 0);
  assert.equal((await viewer.request('/api/people?saved=1')).body.total, 0);
  assert.equal((await viewer.request(`/api/people/${owner.user.id}`)).status, 404);
  assert.equal((await viewer.request(`/api/saved/${owner.user.id}`, { method: 'POST', csrf: true })).status, 404);
  const ownDetail = await owner.request(`/api/people/${owner.user.id}`);
  assert.equal(ownDetail.status, 200);
  assert.equal(ownDetail.body.person.listed, false);
  assert.equal((await owner.request('/api/auth/me')).body.user.listed, false);
  assert.equal((await owner.request('/api/people?search=Private')).body.total, 0);
});

test('SQL-like searches remain data and HTML profile strings remain inert API data', async (t) => {
  const app = await fixture(t);
  const member = client(app);
  const viewer = client(app);
  await member.register('Input Member', 'input@example.com');
  await viewer.register('Viewer Member', 'viewer@example.com');
  const html = '<img src=x onerror=alert(1)>';
  await member.profile(profile('Input Member', { bio: html, skills: ["O'Reilly SQL"] }));
  const detail = await viewer.request(`/api/people/${member.user.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.person.bio, html);
  assert.deepEqual(detail.body.person.skills, ["O'Reilly SQL"]);
  for (const search of ["' OR 1=1 --", "'; DROP TABLE users; --", '%', '_']) {
    const result = await viewer.request(`/api/people?search=${encodeURIComponent(search)}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 0, `search must treat ${search} literally`);
  }
  const literalQuote = await viewer.request(`/api/people?search=${encodeURIComponent("O'Reilly")}`);
  assert.deepEqual(literalQuote.body.people.map((person) => person.id), [member.user.id]);
  assert.equal((await viewer.request('/api/people')).body.total, 2, 'search does not damage stored accounts');
});

test('accounts, profile changes and saved colleagues survive reopening the same database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'company-network-persistence-test-'));
  const dbPath = join(directory, 'pilot.sqlite');
  let app = await start(dbPath);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = client(app);
  const colleague = client(app);
  await owner.register('Persistent Member', 'persistent@example.com');
  await colleague.register('Saved Colleague', 'colleague@example.com');
  const ownerId = owner.user.id;
  const colleagueId = colleague.user.id;
  await owner.profile(profile('Persistent Member', { skills: ['Rust', 'Distributed systems'], interests: ['Hiking'] }));
  assert.equal((await owner.request(`/api/saved/${colleagueId}`, { method: 'POST', csrf: true })).status, 200);
  await app.close();
  app = await start(dbPath);
  const returning = client(app);
  const login = await returning.login('persistent@example.com');
  assert.equal(login.body.user.id, ownerId);
  assert.deepEqual(login.body.user.skills, ['Rust', 'Distributed systems']);
  assert.deepEqual(login.body.user.interests, ['Hiking']);
  const saved = await returning.request('/api/people?saved=1');
  assert.deepEqual(saved.body.people.map((person) => person.id), [colleagueId]);
});

test('turning off demo mode blocks sample login and removes existing sample profiles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'company-network-demo-test-'));
  const dbPath = join(directory, 'pilot.sqlite');
  let app = await start(dbPath, { demoMode: true });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const pilot = client(app);
  await pilot.register('Real Pilot Member', 'pilot@example.com');
  const demo = client(app);
  await demo.login('alex@company.example', 'WelcomePilot2026!');
  const seeded = await pilot.request('/api/people');
  assert.ok(seeded.body.people.some((person) => person.isDemo));
  await app.close();
  app = await start(dbPath, { demoMode: false });
  const member = client(app);
  await member.login('pilot@example.com');
  const config = await member.request('/api/config');
  assert.equal(config.body.demoMode, false);
  assert.equal(Object.hasOwn(config.body, 'demoPassword'), false);
  const disabledDemo = await client(app).request('/api/auth/login', {
    method: 'POST', body: { email: 'alex@company.example', password: 'WelcomePilot2026!' },
  });
  assert.equal(disabledDemo.status, 401);
  const directoryResponse = await member.request('/api/people');
  assert.equal(directoryResponse.body.total, 1);
  assert.equal(directoryResponse.body.people.some((person) => person.isDemo), false);
  assert.equal((await member.request('/api/people/demo-alex')).status, 404);
});
