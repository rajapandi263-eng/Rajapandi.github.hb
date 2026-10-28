import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';

const PASSWORD = 'ChatPilotPassword2026!';

async function start(dbPath, options = {}) {
  const server = await createApp({ dbPath, demoMode: false, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'common-ground-chat-test-'));
  const dbPath = join(directory, 'network.sqlite');
  let app = await start(dbPath, options);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get app() { return app; },
    dbPath,
    async restart(beforeStart) {
      await app.close();
      if (beforeStart) await beforeStart(dbPath);
      app = await start(dbPath, options);
      return app;
    },
  };
}

function client(app) {
  let cookie = '';
  return {
    user: null,
    csrfToken: null,
    get cookie() { return cookie; },
    async request(path, { method = 'GET', body, csrf = false, origin = app.origin } = {}) {
      const response = await fetch(`${app.origin}${path}`, {
        method,
        headers: {
          ...(origin === null ? {} : { Origin: origin }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(csrf ? { 'X-CSRF-Token': csrf === true ? this.csrfToken : csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const session = response.headers.getSetCookie().find(value => value.startsWith('cg_session='));
      if (session) cookie = session.split(';', 1)[0];
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (response.ok && data?.user) this.user = data.user;
      if (response.ok && data?.csrfToken) this.csrfToken = data.csrfToken;
      return { status: response.status, body: data };
    },
    async register(name, email) {
      const result = await this.request('/api/auth/register', { method: 'POST', body: { name, email, password: PASSWORD } });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return this;
    },
    async login(email, password = PASSWORD) {
      const result = await this.request('/api/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return this;
    },
    async send(person, body, clientId = randomUUID()) {
      const result = await this.request(`/api/chats/${person}/messages`, {
        method: 'POST', csrf: true, body: { body, clientId },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.deepEqual(Object.keys(result.body.message).sort(), ['body', 'createdAt', 'id', 'senderId']);
      assert.ok(Number.isSafeInteger(result.body.message.id) && result.body.message.id > 0);
      assert.ok(Number.isSafeInteger(result.body.message.createdAt));
      assert.equal(result.body.message.senderId, this.user.id);
      assert.equal(result.body.message.body, body.trim());
      return result.body.message;
    },
    async inbox() {
      const result = await this.request('/api/chats');
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    },
    async thread(person, query = '') {
      const result = await this.request(`/api/chats/${person}${query}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    },
    async read(person, throughId) {
      const result = await this.request(`/api/chats/${person}/read`, { method: 'POST', csrf: true, body: { throughId } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true);
      assert.ok(Number.isSafeInteger(result.body.unreadCount) && result.body.unreadCount >= 0);
      assert.ok(Number.isSafeInteger(result.body.latestMessageId) && result.body.latestMessageId > 0);
      return result.body;
    },
  };
}

async function members(app, count = 2) {
  const accounts = [];
  for (let index = 0; index < count; index++) {
    accounts.push(await client(app).register(`Chat Member ${index + 1}`, `chat${index + 1}@example.com`));
  }
  return accounts;
}

function hiddenProfile(user) {
  return {
    name: user.name, title: user.title, team: user.team, location: user.location,
    bio: user.bio, skills: user.skills, interests: user.interests,
    available: user.available, listed: false,
  };
}

test('chat requires authentication, Origin and each session’s CSRF token', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second] = await members(fixtureData.app);
  const anonymous = client(fixtureData.app);
  for (const path of ['/api/chats', `/api/chats/${second.user.id}`]) {
    assert.equal((await anonymous.request(path)).status, 401);
  }
  for (const path of [`/api/chats/${second.user.id}/messages`, `/api/chats/${second.user.id}/read`]) {
    assert.equal((await anonymous.request(path, { method: 'POST', body: {} })).status, 401);
    for (const options of [
      { csrf: false }, { csrf: 'wrong-token' }, { csrf: second.csrfToken },
      { csrf: true, origin: 'https://unrelated.example' }, { csrf: true, origin: null },
    ]) {
      const response = await first.request(path, {
        method: 'POST', body: { body: 'Rejected write', clientId: randomUUID(), throughId: 1 }, ...options,
      });
      assert.equal(response.status, 403, `${path}: ${JSON.stringify(options)}`);
    }
  }
  assert.deepEqual(await first.inbox(), { conversations: [], unreadCount: 0, hasMore: false });
  assert.deepEqual(await second.inbox(), { conversations: [], unreadCount: 0, hasMore: false });
});

test('two members exchange messages without exposing conversations to a third member', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second, outsider] = await members(fixtureData.app, 3);
  const before = await first.thread(second.user.id);
  assert.deepEqual(before.messages, []);
  assert.deepEqual((await first.inbox()).conversations, [], 'opening an empty thread does not create an inbox item');
  const sent = await first.send(second.user.id, 'Private discussion about our shared Python interests.');
  const reply = await second.send(first.user.id, 'Happy to connect.');
  assert.deepEqual((await first.thread(second.user.id)).messages, [sent, reply]);
  assert.deepEqual((await second.thread(first.user.id)).messages, [sent, reply]);
  const inbox = await first.inbox();
  assert.equal(inbox.conversations.length, 1);
  assert.equal(inbox.conversations[0].person.id, second.user.id);
  assert.deepEqual(Object.keys(inbox.conversations[0].person).sort(), ['id', 'isDemo', 'name', 'team', 'title']);
  assert.deepEqual(inbox.conversations[0].lastMessage, reply);
  assert.equal(inbox.unreadCount, 1);
  assert.deepEqual(await outsider.inbox(), { conversations: [], unreadCount: 0, hasMore: false });
  assert.deepEqual((await outsider.thread(first.user.id)).messages, []);
  assert.deepEqual((await outsider.thread(second.user.id)).messages, []);
  const spoofedInbox = await outsider.request(`/api/chats?userId=${first.user.id}`);
  assert.deepEqual(spoofedInbox.body, { conversations: [], unreadCount: 0, hasMore: false });
  const unauthorizedRead = await outsider.request(`/api/chats/${first.user.id}/read`, {
    method: 'POST', csrf: true, body: { throughId: sent.id },
  });
  assert.equal(unauthorizedRead.status, 400);
  assert.equal((await second.inbox()).unreadCount, 1, 'another account cannot acknowledge received messages');
  const spoofedMessage = await outsider.request(`/api/chats/${first.user.id}/messages`, {
    method: 'POST', csrf: true,
    body: { body: 'Message from the actual session', clientId: randomUUID(), senderId: second.user.id, recipientId: second.user.id },
  });
  assert.equal(spoofedMessage.status, 201);
  assert.equal(spoofedMessage.body.message.senderId, outsider.user.id);
  assert.deepEqual((await second.thread(first.user.id)).messages, [sent, reply]);
});

test('read acknowledgements are monotonic, conversation-scoped and never clear newer arrivals', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second] = await members(fixtureData.app);
  const one = await first.send(second.user.id, 'First incoming message');
  const two = await first.send(second.user.id, 'Second incoming message');
  assert.equal((await second.inbox()).unreadCount, 2);
  await second.thread(first.user.id);
  assert.equal((await second.inbox()).unreadCount, 2, 'loading messages alone does not acknowledge them');
  assert.deepEqual(await second.read(first.user.id, one.id), { ok: true, unreadCount: 1, latestMessageId: two.id });
  assert.equal((await second.inbox()).unreadCount, 1);
  const three = await first.send(second.user.id, 'Arrived after the earlier read');
  assert.deepEqual(await second.read(first.user.id, one.id), { ok: true, unreadCount: 2, latestMessageId: three.id });
  assert.equal((await second.inbox()).unreadCount, 2, 'stale acknowledgement leaves both newer messages unread');
  await second.read(first.user.id, two.id);
  assert.equal((await second.inbox()).unreadCount, 1);
  const reply = await second.send(first.user.id, 'My outgoing reply');
  const ownRead = await second.request(`/api/chats/${first.user.id}/read`, {
    method: 'POST', csrf: true, body: { throughId: reply.id },
  });
  assert.equal(ownRead.status, 400, 'only a received message can be acknowledged');
  assert.equal((await second.inbox()).unreadCount, 1);
  assert.deepEqual(await second.read(first.user.id, three.id), { ok: true, unreadCount: 0, latestMessageId: reply.id });
  await second.read(first.user.id, three.id);
  const readInbox = await second.inbox();
  assert.equal(readInbox.unreadCount, 0);
  assert.equal(readInbox.conversations[0].unreadCount, 0);
  assert.equal((await first.inbox()).unreadCount, 1);
  await first.read(second.user.id, reply.id);
  assert.equal((await first.inbox()).unreadCount, 0);
});

test('message pagination uses exclusive scoped cursors and stable ascending order', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second, third] = await members(fixtureData.app, 3);
  const messages = [];
  for (let index = 1; index <= 55; index++) messages.push(await first.send(second.user.id, `Pagination message ${index}`));
  const newest = await second.thread(first.user.id);
  assert.deepEqual(newest.messages, messages.slice(5));
  assert.equal(newest.hasMore, true);
  const older = await second.thread(first.user.id, `?before=${messages[5].id}`);
  assert.deepEqual(older.messages, messages.slice(0, 5));
  assert.equal(older.hasMore, false);
  const limited = await second.thread(first.user.id, '?limit=3');
  assert.deepEqual(limited.messages, messages.slice(-3));
  assert.equal(limited.hasMore, true);
  const earlier = await second.thread(first.user.id, `?before=${messages[52].id}&limit=3`);
  assert.deepEqual(earlier.messages, messages.slice(49, 52));
  const after = await second.thread(first.user.id, `?after=${messages[0].id}&limit=3`);
  assert.deepEqual(after.messages, messages.slice(1, 4));
  assert.equal(after.hasMore, true);
  const latest = await second.thread(first.user.id, `?after=${messages[52].id}`);
  assert.deepEqual(latest.messages, messages.slice(53));
  assert.equal(latest.hasMore, false);
  assert.deepEqual((await second.thread(first.user.id, `?before=${messages[0].id}`)).messages, []);
  assert.deepEqual((await second.thread(first.user.id, `?after=${messages.at(-1).id}`)).messages, []);
  const otherConversation = await first.send(third.user.id, 'Another conversation’s cursor');
  for (const query of [
    '?before=0', '?after=-1', '?after=1.5', '?before=not-a-number', '?limit=0', '?limit=101',
    `?after=${messages[0].id}&before=${messages[1].id}`, `?after=${otherConversation.id}`, '?before=999999999',
  ]) {
    assert.equal((await second.request(`/api/chats/${first.user.id}${query}`)).status, 400, query);
  }
});

test('idempotent retries prevent duplicates and reject reused IDs with changed recipients or bodies', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second, third] = await members(fixtureData.app, 3);
  const clientId = randomUUID();
  const message = await first.send(second.user.id, '  Hello colleague  ', clientId);
  const retry = await first.request(`/api/chats/${second.user.id}/messages`, {
    method: 'POST', csrf: true, body: { body: 'Hello colleague', clientId },
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.message, message);
  for (const [recipient, body] of [[second.user.id, 'Changed text'], [third.user.id, 'Hello colleague']]) {
    const mismatch = await first.request(`/api/chats/${recipient}/messages`, { method: 'POST', csrf: true, body: { body, clientId } });
    assert.equal(mismatch.status, 409);
  }
  const sameIdOtherSender = await third.send(second.user.id, 'Independent sender can use its own ID', clientId);
  assert.notEqual(sameIdOtherSender.id, message.id);
  const simultaneousId = randomUUID();
  const simultaneous = await Promise.all([0, 1].map(() => first.request(`/api/chats/${second.user.id}/messages`, {
    method: 'POST', csrf: true, body: { body: 'Concurrent retry', clientId: simultaneousId },
  })));
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(simultaneous[0].body.message, simultaneous[1].body.message);
  const html = '<img src=x onerror=alert(1)> and O\'Reilly SQL';
  const literal = await first.send(second.user.id, html);
  assert.equal((await second.thread(first.user.id)).messages.at(-1).body, literal.body);
  assert.equal((await second.inbox()).unreadCount, 4, 'each unique received message is counted once');
});

test('message validation and recipient eligibility prevent invalid or fictional chats', async (t) => {
  const fixtureData = await fixture(t, { demoMode: true });
  const [first, second] = await members(fixtureData.app);
  for (const body of [
    { body: '', clientId: randomUUID() }, { body: '   ', clientId: randomUUID() },
    { body: 'x'.repeat(2001), clientId: randomUUID() }, { body: 42, clientId: randomUUID() },
    { body: 'Text', clientId: 'invalid-id' }, { body: 'Text' },
    { body: 'control\u0000character', clientId: randomUUID() },
  ]) {
    assert.equal((await first.request(`/api/chats/${second.user.id}/messages`, { method: 'POST', csrf: true, body })).status, 400);
  }
  for (const [recipient, expected] of [[first.user.id, 400], ['missing-person', 404], ['demo-alex', 403], ['demo-priya', 403]]) {
    assert.equal((await first.request(`/api/chats/${recipient}`)).status, expected);
    assert.equal((await first.request(`/api/chats/${recipient}/messages`, {
      method: 'POST', csrf: true, body: { body: 'Must not be sent', clientId: randomUUID() },
    })).status, expected);
  }
  const demo = await client(fixtureData.app).login('alex@company.example', 'WelcomePilot2026!');
  for (const path of ['/api/chats', `/api/chats/${first.user.id}`]) assert.equal((await demo.request(path)).status, 403);
  for (const path of [`/api/chats/${first.user.id}/messages`, `/api/chats/${first.user.id}/read`]) {
    assert.equal((await demo.request(path, { method: 'POST', csrf: true, body: { body: 'Shared demo account', clientId: randomUUID(), throughId: 1 } })).status, 403);
  }
  assert.deepEqual(await second.inbox(), { conversations: [], unreadCount: 0, hasMore: false });
  await first.send(second.user.id, 'x'.repeat(2000));
});

test('unlisted members can continue existing conversations while new callers cannot start one', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second, outsider] = await members(fixtureData.app, 3);
  const initial = await first.send(second.user.id, 'Established connection');
  assert.equal((await second.request('/api/profile', { method: 'PUT', csrf: true, body: hiddenProfile(second.user) })).status, 200);
  assert.equal((await first.request(`/api/people/${second.user.id}`)).status, 404);
  assert.deepEqual((await first.thread(second.user.id)).messages, [initial]);
  const followUp = await first.send(second.user.id, 'Continue after directory hiding');
  const reply = await second.send(first.user.id, 'The established chat still works');
  assert.deepEqual((await second.thread(first.user.id)).messages, [initial, followUp, reply]);
  await second.read(first.user.id, followUp.id);
  assert.equal((await second.inbox()).unreadCount, 0);
  assert.equal((await first.inbox()).conversations[0].person.id, second.user.id);
  assert.equal((await outsider.request(`/api/chats/${second.user.id}`)).status, 404);
  assert.equal((await outsider.request(`/api/chats/${second.user.id}/messages`, {
    method: 'POST', csrf: true, body: { body: 'New connection must be blocked', clientId: randomUUID() },
  })).status, 404);
  assert.equal((await second.request(`/api/chats/${outsider.user.id}`)).status, 403, 'an unlisted sender cannot open a new conversation');
  assert.equal((await second.request(`/api/chats/${outsider.user.id}/messages`, {
    method: 'POST', csrf: true, body: { body: 'Unlisted sender cannot initiate', clientId: randomUUID() },
  })).status, 403);
});

test('visibility changes while a message body arrives prevent starting an unauthorized conversation', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second] = await members(fixtureData.app);
  for (const [subject, expected] of [[first, 403], [second, 404]]) {
    const payload = JSON.stringify({ body: 'Delayed message must be rejected', clientId: randomUUID() });
    let request;
    const began = new Promise(resolve => fixtureData.app.server.once('request', resolve));
    const completed = new Promise((resolve, reject) => {
      request = httpRequest(`${fixtureData.app.origin}/api/chats/${second.user.id}/messages`, {
        method: 'POST', headers: {
          Origin: fixtureData.app.origin, Cookie: first.cookie,
          'Content-Type': 'application/json', 'X-CSRF-Token': first.csrfToken,
        },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
        response.once('error', reject);
      });
      request.once('error', reject);
      request.write(payload.slice(0, 2));
    });
    await began;
    try {
      const hidden = await subject.request('/api/profile', { method: 'PUT', csrf: true, body: hiddenProfile(subject.user) });
      assert.equal(hidden.status, 200);
    } finally { request.end(payload.slice(2)); }
    assert.equal(await completed, expected);
    assert.equal((await first.inbox()).conversations.length, 0);
    assert.equal((await second.inbox()).conversations.length, 0);
    const restored = await subject.request('/api/profile', { method: 'PUT', csrf: true, body: { ...hiddenProfile(subject.user), listed: true } });
    assert.equal(restored.status, 200);
  }
});

test('messages and read state persist across restart and legacy accounts migrate without losing data', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second] = await members(fixtureData.app);
  const firstId = first.user.id;
  const secondId = second.user.id;
  await fixtureData.restart((dbPath) => {
    const database = new DatabaseSync(dbPath);
    try {
      database.exec('DROP TABLE chat_reads; DROP TABLE chat_messages; DROP TABLE chat_conversations;');
      assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name LIKE 'chat_%'").get().total, 0);
    } finally { database.close(); }
  });
  const migratedFirst = await client(fixtureData.app).login('chat1@example.com');
  const migratedSecond = await client(fixtureData.app).login('chat2@example.com');
  assert.equal(migratedFirst.user.id, firstId);
  assert.equal(migratedSecond.user.id, secondId);
  assert.deepEqual(await migratedFirst.inbox(), { conversations: [], unreadCount: 0, hasMore: false });
  const one = await migratedFirst.send(secondId, 'Persisted initial message');
  const clientId = randomUUID();
  const two = await migratedFirst.send(secondId, 'Persisted unread message', clientId);
  await migratedSecond.read(firstId, one.id);
  const reply = await migratedSecond.send(firstId, 'Persisted reply');
  await fixtureData.restart();
  const returningFirst = await client(fixtureData.app).login('chat1@example.com');
  const returningSecond = await client(fixtureData.app).login('chat2@example.com');
  assert.deepEqual((await returningFirst.thread(secondId)).messages, [one, two, reply]);
  assert.equal((await returningFirst.inbox()).unreadCount, 1);
  assert.equal((await returningSecond.inbox()).unreadCount, 1);
  const retry = await returningFirst.request(`/api/chats/${secondId}/messages`, {
    method: 'POST', csrf: true, body: { body: 'Persisted unread message', clientId },
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.message, two);
});

test('new-message throttling spans sessions while safe idempotent retries still succeed', async (t) => {
  const fixtureData = await fixture(t);
  const [first, second] = await members(fixtureData.app);
  const anotherSession = await client(fixtureData.app).login('chat1@example.com');
  const initialClientId = randomUUID();
  const initial = await first.send(second.user.id, 'Initial retryable message', initialClientId);
  for (let index = 1; index < 60; index++) await first.send(second.user.id, `Throttling message ${index}`);
  const limited = await anotherSession.request(`/api/chats/${second.user.id}/messages`, {
    method: 'POST', csrf: true, body: { body: 'Over the sender limit', clientId: randomUUID() },
  });
  assert.equal(limited.status, 429);
  const safeRetry = await anotherSession.request(`/api/chats/${second.user.id}/messages`, {
    method: 'POST', csrf: true, body: { body: 'Initial retryable message', clientId: initialClientId },
  });
  assert.equal(safeRetry.status, 200);
  assert.deepEqual(safeRetry.body.message, initial);
  assert.equal((await second.inbox()).unreadCount, 60);
});

test('inbox pagination exposes older unread conversations without losing or leaking cursor scope', async (t) => {
  const fixtureData = await fixture(t);
  const [viewer, template] = await members(fixtureData.app);
  const database = new DatabaseSync(fixtureData.dbPath);
  let oldestPartner;
  let oldestMessage;
  try {
    // Seed historical test conversations directly instead of bypassing the
    // registration and live-message rate limits through the public API.
    const credentials = database.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(template.user.id);
    const insertPerson = database.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)');
    const insertConversation = database.prepare('INSERT INTO chat_conversations(id,user_one,user_two,created_at) VALUES(?,?,?,?)');
    const insertMessage = database.prepare('INSERT INTO chat_messages(conversation_id,sender_id,recipient_id,body,client_id,created_at) VALUES(?,?,?,?,?,?)');
    database.exec('BEGIN');
    for (let index = 0; index < 101; index++) {
      const personId = randomUUID();
      const conversationId = randomUUID();
      const [one, two] = [viewer.user.id, personId].sort();
      insertPerson.run(personId, `historical${index}@example.com`, `Historical Colleague ${index}`, credentials.password_salt, credentials.password_hash, Date.now());
      insertConversation.run(conversationId, one, two, Date.now());
      const inserted = insertMessage.run(conversationId, personId, viewer.user.id, `Historical unread ${index}`, randomUUID(), Date.now());
      if (index === 0) { oldestPartner = personId; oldestMessage = Number(inserted.lastInsertRowid); }
    }
    database.exec('COMMIT');
  } finally { database.close(); }
  const inbox = await viewer.inbox();
  assert.equal(inbox.unreadCount, 101);
  assert.equal(inbox.conversations.length, 100);
  assert.equal(inbox.hasMore, true);
  const before = inbox.conversations.at(-1).lastMessage.id;
  const older = await viewer.request(`/api/chats?before=${before}`);
  assert.equal(older.status, 200);
  assert.equal(older.body.unreadCount, 101, 'page totals describe all unread conversations');
  assert.equal(older.body.conversations.length, 1);
  assert.equal(older.body.conversations[0].person.id, oldestPartner);
  assert.equal(older.body.hasMore, false);
  const loaded = [...inbox.conversations, ...older.body.conversations].map(conversation => conversation.person.id);
  assert.equal(new Set(loaded).size, 101);
  const limited = await viewer.request('/api/chats?limit=3');
  assert.equal(limited.body.conversations.length, 3);
  assert.equal(limited.body.hasMore, true);
  const oldestReply = await viewer.send(oldestPartner, 'A later arrival changes this conversation’s latest message');
  const priorCursor = await viewer.request(`/api/chats?before=${oldestMessage}`);
  assert.equal(priorCursor.status, 200, 'a previously valid cursor remains usable after a newer arrival');
  const privateOtherPair = await template.send(oldestPartner, 'This cursor belongs to a different pair');
  for (const query of ['?before=0', '?before=-1', '?before=unknown', '?before=999999999', '?limit=0', '?limit=101', `?before=${privateOtherPair.id}`]) {
    assert.equal((await viewer.request(`/api/chats${query}`)).status, 400, query);
  }
  assert.deepEqual(await viewer.read(oldestPartner, oldestMessage), { ok: true, unreadCount: 0, latestMessageId: oldestReply.id });
  assert.equal((await viewer.inbox()).unreadCount, 100);
  const historicalSender = await client(fixtureData.app).login('historical0@example.com');
  const laterIncoming = await historicalSender.send(viewer.user.id, 'Arrived after the cached older inbox row');
  assert.deepEqual(await viewer.read(oldestPartner, oldestMessage), { ok: true, unreadCount: 1, latestMessageId: laterIncoming.id });
  assert.equal((await viewer.inbox()).unreadCount, 101, 'old acknowledgements retain a newly arrived unread message');
});
