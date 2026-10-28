import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEMO_EMAIL = 'alex@company.example';
const DEMO_PASSWORD = 'WelcomePilot2026!';
const COOKIE_NAME = 'cg_session';
const BODY_LIMIT = 16 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/mobile.css', ['mobile.css', 'text/css; charset=utf-8']],
  ['/install.mjs', ['install.mjs', 'text/javascript; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ...['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png']
    .map(filename => [`/icons/${filename}`, [`icons/${filename}`, 'image/png']]),
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function digest(token) { return createHash('sha256').update(token).digest('hex'); }
function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await scryptAsync(password, salt, 64, SCRYPT_OPTIONS);
  return { salt, hash: hash.toString('hex') };
}

function textField(value, label, max, min = 0) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) {
    throw new HttpError(400, `${label} must be ${min ? `${min}–` : 'at most '}${max} characters.`);
  }
  return cleaned;
}

function emailField(value) {
  const email = textField(value, 'Email', 254, 3).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email)
      || email.includes('..')) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function passwordField(value, registering = false) {
  if (typeof value !== 'string' || value.length > 128 || value.length < (registering ? 12 : 1)) {
    throw new HttpError(400, registering ? 'Use a password between 12 and 128 characters.' : 'Enter your email and password.');
  }
  return value;
}

function tagsField(value, label) {
  if (!Array.isArray(value) || value.length > 12) throw new HttpError(400, `Choose at most 12 ${label.toLowerCase()}.`);
  const tags = value.map(item => textField(item, label, 40, 1));
  return [...new Map(tags.map(item => [item.toLowerCase(), item])).values()];
}

function profileFields(body) {
  if (typeof body.available !== 'boolean' || typeof body.listed !== 'boolean') {
    throw new HttpError(400, 'Availability and directory visibility must be true or false.');
  }
  return {
    name: textField(body.name, 'Name', 80, 2),
    title: textField(body.title, 'Title', 120),
    team: textField(body.team, 'Team', 100),
    location: textField(body.location, 'Location', 100),
    bio: textField(body.bio, 'Bio', 1200),
    skills: tagsField(body.skills, 'Skills'),
    interests: tagsField(body.interests, 'Interests'),
    available: body.available,
    listed: body.listed,
  };
}

function ensureObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object.');
  return body;
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) {
    req.resume();
    throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    req.resume();
    throw new HttpError(415, 'Compressed request bodies are not supported.');
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume();
    throw new HttpError(413, 'The request is too large.');
  }
  const bytes = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const onData = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) return fail(new HttpError(413, 'The request is too large.'));
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => fail(new HttpError(400, 'The request could not be read.'));
    const onAborted = () => fail(new HttpError(400, 'The request could not be read.'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
  try {
    return ensureObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Send valid JSON.');
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function personFromRow(row) {
  return {
    id: row.id, name: row.name, email: row.email, title: row.title,
    team: row.team, location: row.location, bio: row.bio,
    skills: JSON.parse(row.skills), interests: JSON.parse(row.interests),
    available: Boolean(row.available), listed: Boolean(row.listed),
    saved: Boolean(row.saved), isDemo: Boolean(row.is_demo),
  };
}

function chatPersonFromRow(row) {
  return { id: row.id, name: row.name, title: row.title, team: row.team, isDemo: Boolean(row.is_demo) };
}

function messageFromRow(row) {
  return { id: row.id, senderId: row.sender_id, body: row.body, createdAt: row.created_at };
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, `${label} must be a positive integer.`);
  return value;
}

function queryInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9]\d*$/.test(value || '')) throw new HttpError(400, `${label} must be a positive integer.`);
  const number = positiveInteger(Number(value), label);
  if (number > max) throw new HttpError(400, `${label} must be at most ${max}.`);
  return number;
}

const DEMO_PEOPLE = [
  { id: 'demo-alex', name: 'Alex Morgan', email: DEMO_EMAIL, title: 'Frontend Engineer', team: 'Engineering', location: 'Denver', bio: 'I build accessible interfaces and love connecting design with code. Happy to trade ideas over coffee.', skills: ['JavaScript', 'React', 'Accessibility'], interests: ['Coffee', 'Hiking', 'Photography'], available: true },
  { id: 'demo-priya', name: 'Priya Shah', email: 'priya@company.example', title: 'Senior Product Designer', team: 'Design', location: 'San Francisco', bio: 'Turning customer insights into thoughtful products. Ask me about research or starting a design system.', skills: ['User Research', 'Design Systems', 'Prototyping'], interests: ['Photography', 'Coffee', 'Travel'], available: true },
  { id: 'demo-jordan', name: 'Jordan Lee', email: 'jordan@company.example', title: 'Product Manager', team: 'Product', location: 'New York', bio: 'I help teams make clear product decisions and bring new ideas to life. Always curious about your next big question.', skills: ['Product Strategy', 'Roadmapping', 'Facilitation'], interests: ['Running', 'Reading', 'Volunteering'], available: true },
  { id: 'demo-maya', name: 'Maya Patel', email: 'maya@company.example', title: 'Data Scientist', team: 'Data & Analytics', location: 'Austin', bio: 'Finding the story in data and making AI useful. Happy to help with Python, SQL, or a tricky analysis.', skills: ['Python', 'SQL', 'AI'], interests: ['Hiking', 'Cooking', 'Board Games'], available: true },
  { id: 'demo-ethan', name: 'Ethan Williams', email: 'ethan@company.example', title: 'Cloud Architect', team: 'Engineering', location: 'Denver', bio: 'Building reliable cloud platforms. I enjoy helping people understand how their systems fit together.', skills: ['Cloud', 'AWS', 'System Architecture'], interests: ['Cycling', 'Coffee', 'Music'], available: false },
  { id: 'demo-sofia', name: 'Sofia Martinez', email: 'sofia@company.example', title: 'People Partner', team: 'People', location: 'Austin', bio: 'Helping colleagues grow and teams work well together. Let’s talk mentoring, leadership, or volunteering.', skills: ['Leadership', 'Mentoring', 'Team Development'], interests: ['Volunteering', 'Reading', 'Hiking'], available: true },
  { id: 'demo-noah', name: 'Noah Kim', email: 'noah@company.example', title: 'Analytics Engineer', team: 'Data & Analytics', location: 'New York', bio: 'Making trustworthy data easier to use. I can help turn a question into a query or a useful dashboard.', skills: ['SQL', 'Python', 'Data Visualization'], interests: ['Photography', 'Coffee', 'Cooking'], available: false },
  { id: 'demo-avery', name: 'Avery Chen', email: 'avery@company.example', title: 'Design Engineer', team: 'Design', location: 'San Francisco', bio: 'Exploring the space between design and engineering. I enjoy sharing small experiments and learning from other teams.', skills: ['Design Systems', 'CSS', 'Interaction Design'], interests: ['Art', 'Hiking', 'Board Games'], available: true },
];

/** Create an HTTP server. Public hosting requires an explicit hosted configuration. */
export async function createApp({
  deploymentMode = 'local', dbPath = deploymentMode === 'hosted' ? null : resolve(ROOT, 'data/network.sqlite'), demoMode = deploymentMode !== 'hosted',
  companyDomain = null, appOrigin = null, host = deploymentMode === 'hosted' ? '0.0.0.0' : '127.0.0.1',
  registrationEnabled = true, registrationCode = null, logger = console,
} = {}) {
  if (!['local', 'hosted'].includes(deploymentMode)) throw new Error('DEPLOYMENT_MODE must be local or hosted.');
  const hosted = deploymentMode === 'hosted';
  if ((!hosted && !LOOPBACK_HOSTS.has(host)) || (hosted && host !== '0.0.0.0')) throw new Error(hosted ? 'Hosted mode must bind to 0.0.0.0.' : 'Local mode can only bind to a loopback host.');
  if (typeof demoMode !== 'boolean' || typeof registrationEnabled !== 'boolean') throw new Error('Configuration flags must be boolean.');
  if ((hosted || process.env.NODE_ENV === 'production') && demoMode) throw new Error('Demo mode is not allowed in hosted or production mode.');
  if (hosted && (typeof dbPath !== 'string' || !isAbsolute(dbPath) || dbPath === ':memory:')) throw new Error('Hosted mode requires an absolute persistent DB_PATH.');
  if (hosted && registrationEnabled && (typeof registrationCode !== 'string'
      || registrationCode.length < 24 || registrationCode.length > 128
      || registrationCode.trim() !== registrationCode || /[\u0000-\u001F\u007F]/.test(registrationCode))) {
    throw new Error('Hosted registration requires REGISTRATION_CODE with 24–128 non-control characters and no surrounding whitespace.');
  }
  const registrationCodeRequired = hosted && registrationEnabled;
  const registrationCodeHash = registrationCodeRequired ? digest(registrationCode) : null;
  if (companyDomain) {
    companyDomain = companyDomain.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(companyDomain) || companyDomain.includes('..')) {
      throw new Error('COMPANY_DOMAIN must be a domain without an @, path, or scheme.');
    }
  } else companyDomain = null;
  if (appOrigin) {
    const origin = new URL(appOrigin);
    if ((!hosted && !LOOPBACK_HOSTS.has(origin.hostname)) || !['http:', 'https:'].includes(origin.protocol)
        || origin.origin !== appOrigin || origin.username || origin.password) {
      throw new Error(hosted ? 'APP_ORIGIN must be an exact HTTPS origin.' : 'APP_ORIGIN must be an exact local HTTP or HTTPS origin.');
    }
  } else appOrigin = null;
  if (hosted && !appOrigin?.startsWith('https://')) throw new Error('Hosted mode requires an exact HTTPS APP_ORIGIN or RENDER_EXTERNAL_URL.');
  if (!hosted && process.env.NODE_ENV === 'production' && (!companyDomain || !appOrigin?.startsWith('https://'))) {
    throw new Error('Production requires COMPANY_DOMAIN and an HTTPS APP_ORIGIN; company deployment needs further integration.');
  }
  const externalHost = hosted ? new URL(appOrigin).host.toLowerCase() : null;

  if (dbPath !== ':memory:') {
    dbPath = resolve(ROOT, dbPath);
    await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  try {
    if (dbPath !== ':memory:') await chmod(dbPath, 0o600);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', team TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
        skills TEXT NOT NULL DEFAULT '[]', interests TEXT NOT NULL DEFAULT '[]',
        available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
        listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0, 1)),
        is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
        login_enabled INTEGER NOT NULL DEFAULT 1 CHECK (login_enabled IN (0, 1)),
        password_salt TEXT, password_hash TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS saved_people (
        viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(viewer_id, person_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      -- Additive chat migration: existing accounts, profiles, and power bumps remain intact.
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        user_one TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_two TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        UNIQUE(user_one, user_two), CHECK(user_one <> user_two)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
        client_id TEXT NOT NULL CHECK(length(client_id) = 36),
        created_at INTEGER NOT NULL,
        UNIQUE(sender_id, client_id), CHECK(sender_id <> recipient_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS chat_reads (
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        through_message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        PRIMARY KEY(conversation_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chat_conversations_second_user ON chat_conversations(user_two);
      CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS chat_messages_recipient ON chat_messages(recipient_id, conversation_id, id);
    `);
    if (demoMode) {
      const demoHash = await hashPassword(DEMO_PASSWORD);
      const seed = db.prepare(`INSERT OR IGNORE INTO users
        (id,email,name,title,team,location,bio,skills,interests,available,listed,is_demo,login_enabled,password_salt,password_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)`);
      for (const person of DEMO_PEOPLE) {
        const alex = person.email === DEMO_EMAIL;
        seed.run(person.id, person.email, person.name, person.title, person.team, person.location,
          person.bio, JSON.stringify(person.skills), JSON.stringify(person.interests), Number(person.available),
          Number(alex), alex ? demoHash.salt : null, alex ? demoHash.hash : null, Date.now());
      }
    }
    const dummyPassword = await hashPassword(randomBytes(32).toString('hex'));
    const rates = new Map();
    let passwordJobs = 0;
    async function boundedPasswordHash(password, salt) {
      if (hosted && passwordJobs >= 4) throw new HttpError(503, 'Sign-in is busy. Please try again in a moment.');
      passwordJobs++;
      try { return await hashPassword(password, salt); }
      finally { passwordJobs--; }
    }
    const healthCheck = db.prepare('SELECT 1 AS ok');
    const userById = db.prepare(`SELECT u.*, EXISTS(SELECT 1 FROM saved_people s WHERE s.viewer_id = ? AND s.person_id = u.id) AS saved FROM users u WHERE u.id = ?`);
    const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
    const sessionByHash = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?');
    const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
    const expireSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    const insertSession = db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)');
    const conversationByPair = db.prepare('SELECT * FROM chat_conversations WHERE user_one = ? AND user_two = ?');
    const messageByClient = db.prepare('SELECT * FROM chat_messages WHERE sender_id = ? AND client_id = ?');
    const messageInConversation = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?');
    const insertConversation = db.prepare('INSERT OR IGNORE INTO chat_conversations(id,user_one,user_two,created_at) VALUES(?,?,?,?)');
    const insertMessage = db.prepare('INSERT INTO chat_messages(conversation_id,sender_id,recipient_id,body,client_id,created_at) VALUES(?,?,?,?,?,?)');
    const updateRead = db.prepare(`INSERT INTO chat_reads(conversation_id,user_id,through_message_id) VALUES(?,?,?)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET through_message_id = MAX(through_message_id, excluded.through_message_id)`);
    const readSnapshot = db.prepare(`SELECT
      (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = ? AND m.recipient_id = ?
        AND m.id > COALESCE((SELECT through_message_id FROM chat_reads WHERE conversation_id = ? AND user_id = ?), 0)) AS unread_count,
      COALESCE((SELECT MAX(id) FROM chat_messages WHERE conversation_id = ?), 0) AS latest_message_id`);
    const inbox = db.prepare(`SELECT p.id,p.name,p.title,p.team,p.is_demo,
      m.id AS message_id,m.sender_id,m.body,m.created_at,
      (SELECT COUNT(*) FROM chat_messages incoming
        WHERE incoming.conversation_id = c.id AND incoming.recipient_id = ?
        AND incoming.id > COALESCE((SELECT through_message_id FROM chat_reads
          WHERE conversation_id = c.id AND user_id = ?), 0)) AS unread_count
      FROM chat_conversations c
      JOIN users p ON p.id = CASE WHEN c.user_one = ? THEN c.user_two ELSE c.user_one END
      JOIN chat_messages m ON m.id = (SELECT MAX(id) FROM chat_messages WHERE conversation_id = c.id)
      WHERE (c.user_one = ? OR c.user_two = ?) AND p.is_demo = 0 AND p.login_enabled = 1
      AND (? IS NULL OR m.id < ?)
      ORDER BY m.id DESC LIMIT ?`);
    const inboxCursor = db.prepare(`SELECT m.id FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      JOIN users p ON p.id = CASE WHEN c.user_one = ? THEN c.user_two ELSE c.user_one END
      WHERE m.id = ? AND (c.user_one = ? OR c.user_two = ?)
      AND p.is_demo = 0 AND p.login_enabled = 1`);
    const unreadTotal = db.prepare(`SELECT COUNT(*) AS total FROM chat_messages m
      JOIN users sender ON sender.id = m.sender_id
      LEFT JOIN chat_reads r ON r.conversation_id = m.conversation_id AND r.user_id = ?
      WHERE m.recipient_id = ? AND m.id > COALESCE(r.through_message_id, 0)
      AND sender.is_demo = 0 AND sender.login_enabled = 1`);

    function rateLimit(req, key, limit, windowMs, principal = req.socket.remoteAddress) {
      const now = Date.now();
      const identity = `${principal}:${key}`;
      let bucket = rates.get(identity);
      if (!bucket || bucket.reset <= now) {
        if (rates.size >= 5000) for (const [key, value] of rates) if (value.reset <= now) rates.delete(key);
        if (rates.size >= 10_000) rates.delete(rates.keys().next().value);
        bucket = { count: 0, reset: now + windowMs };
        rates.set(identity, bucket);
      }
      bucket.count += 1;
      if (bucket.count > limit) throw new HttpError(429, 'Too many attempts. Please try again later.');
    }

    function chatContext(viewer, personId) {
      if (personId === viewer.id) throw new HttpError(400, 'Choose another person to chat with.');
      const person = userById.get(viewer.id, personId);
      if (!person) throw new HttpError(404, 'This conversation is unavailable.');
      if (person.is_demo || !person.login_enabled) throw new HttpError(403, 'Private chat is only available between individual accounts.');
      const [one, two] = [viewer.id, person.id].sort();
      const conversation = conversationByPair.get(one, two);
      if (!conversation && !person.listed) throw new HttpError(404, 'This conversation is unavailable.');
      const currentViewer = userById.get(viewer.id, viewer.id);
      if (!conversation && !currentViewer?.listed) throw new HttpError(403, 'Show your profile in the directory to start a new conversation.');
      return { person, conversation, one, two };
    }

    function duplicateMessage(row, recipientId, body) {
      if (row.recipient_id !== recipientId || row.body !== body) throw new HttpError(409, 'This message retry does not match the original message.');
      return messageFromRow(row);
    }

    function requestOrigin(req, server) {
      if (hosted) {
        // Render terminates TLS. Trust the configured origin, never forwarded
        // host/proto/IP headers supplied by a client or arbitrary intermediary.
        if (typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== externalHost) throw new HttpError(403, 'This request is not allowed.');
        return appOrigin;
      }
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new HttpError(403, 'This request is not allowed.');
      let url;
      try { url = new URL(`http://${req.headers.host || ''}`); } catch { throw new HttpError(403, 'This request is not allowed.'); }
      if (!LOOPBACK_HOSTS.has(url.hostname) || Number(url.port || 80) !== bound.port || url.username || url.password
          || url.pathname !== '/' || url.search || url.hash) throw new HttpError(403, 'This request is not allowed.');
      return appOrigin || url.origin;
    }

    function sameOrigin(req, expected) {
      if (req.headers.origin !== expected) throw new HttpError(403, 'This request is not allowed.');
    }

    function cookieToken(req) {
      const match = (req.headers.cookie || '').match(/(?:^|;\s*)cg_session=([a-f0-9]{64})(?:;|$)/);
      return match?.[1] || null;
    }

    function authenticate(req) {
      const token = cookieToken(req);
      if (!token) throw new HttpError(401, 'Please sign in to continue.');
      const session = sessionByHash.get(digest(token), Date.now());
      if (!session) throw new HttpError(401, 'Please sign in to continue.');
      const row = userById.get(session.user_id, session.user_id);
      if (!row || !row.login_enabled || (!demoMode && row.is_demo)) throw new HttpError(401, 'Please sign in to continue.');
      return { session, row, token };
    }

    function signedWrite(req, auth, origin) {
      sameOrigin(req, origin);
      if (!secureEqual(req.headers['x-csrf-token'], auth.session.csrf_token)) throw new HttpError(403, 'Refresh the page and try again.');
      rateLimit(req, 'writes', 90, 60 * 1000, hosted ? auth.row.id : req.socket.remoteAddress);
    }

    function sessionCookie(token, secure, clear = false) {
      return `${COOKIE_NAME}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL / 1000}${secure ? '; Secure' : ''}`;
    }

    function establishSession(req, res, row, origin) {
      const previous = cookieToken(req);
      if (previous) deleteSession.run(digest(previous));
      expireSessions.run(Date.now());
      const token = randomBytes(32).toString('hex');
      const csrfToken = randomBytes(32).toString('hex');
      insertSession.run(digest(token), row.id, csrfToken, Date.now() + SESSION_TTL);
      res.setHeader('Set-Cookie', sessionCookie(token, origin.startsWith('https://')));
      return { user: personFromRow(userById.get(row.id, row.id)), csrfToken };
    }

    const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
      // A client disconnect must not turn into an unhandled stream error.
      req.on('error', () => {});
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (hosted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      try {
        const origin = requestOrigin(req, server);
        let url;
        try { url = new URL(req.url, origin); } catch { throw new HttpError(400, 'Invalid request.'); }
        // Reject absolute-form cross-origin request targets, too.
        if (url.origin !== origin) throw new HttpError(403, 'This request is not allowed.');
        const path = url.pathname;
        const method = req.method;
        if (method === 'GET' && path === '/healthz') return json(res, 200, { ok: healthCheck.get().ok === 1 });
        if (method === 'GET' && path === '/api/config') {
          return json(res, 200, { appName: 'Common Ground', companyDomain, demoMode,
            ...(demoMode ? { demoEmail: DEMO_EMAIL, demoPassword: DEMO_PASSWORD } : {}), registrationEnabled,
            storageMode: hosted ? 'shared' : 'local', hosted, registrationCodeRequired });
        }
        if (method === 'POST' && path === '/api/auth/register') {
          sameOrigin(req, origin);
          rateLimit(req, 'register', hosted ? 40 : 10, hosted ? 60_000 : 60 * 60 * 1000, hosted ? 'shared-service' : req.socket.remoteAddress);
          if (!registrationEnabled) throw new HttpError(403, 'Registration is unavailable.');
          const body = await readJson(req);
          if (registrationCodeRequired && (typeof body.registrationCode !== 'string' || body.registrationCode.length > 128
              || !secureEqual(digest(body.registrationCode), registrationCodeHash))) throw new HttpError(403, 'A valid pilot access code is required.');
          const name = textField(body.name, 'Name', 80, 2);
          const email = emailField(body.email);
          const password = passwordField(body.password, true);
          if (companyDomain && email.split('@')[1] !== companyDomain) throw new HttpError(400, `Use your @${companyDomain} email address.`);
          if (hosted) rateLimit(req, 'register-account', 6, 10 * 60_000, digest(email));
          const passwordData = await boundedPasswordHash(password);
          if (userByEmail.get(email)) throw new HttpError(409, 'Unable to create this account. Try signing in or use a different email.');
          const id = randomUUID();
          db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)')
            .run(id, email, name, passwordData.salt, passwordData.hash, Date.now());
          return json(res, 201, establishSession(req, res, userByEmail.get(email), origin));
        }
        if (method === 'POST' && path === '/api/auth/login') {
          sameOrigin(req, origin);
          if (hosted) rateLimit(req, 'login-global', 120, 60_000, 'shared-service');
          else rateLimit(req, 'login', 12, 10 * 60 * 1000);
          const body = await readJson(req);
          const email = emailField(body.email);
          const password = passwordField(body.password);
          if (hosted) rateLimit(req, 'login-account', 12, 10 * 60_000, digest(email));
          const row = userByEmail.get(email);
          const eligible = row?.login_enabled && (demoMode || !row.is_demo);
          const passwordData = eligible ? { salt: row.password_salt, hash: row.password_hash } : dummyPassword;
          const attempt = await boundedPasswordHash(password, passwordData.salt);
          if (!secureEqual(attempt.hash, passwordData.hash) || !eligible) throw new HttpError(401, 'Email or password is incorrect.');
          return json(res, 200, establishSession(req, res, row, origin));
        }
        if (method === 'GET' && path === '/api/auth/me') {
          const auth = authenticate(req);
          return json(res, 200, { user: personFromRow(auth.row), csrfToken: auth.session.csrf_token });
        }
        if (method === 'POST' && path === '/api/auth/logout') {
          const auth = authenticate(req);
          signedWrite(req, auth, origin);
          deleteSession.run(digest(auth.token));
          res.setHeader('Set-Cookie', sessionCookie('', origin.startsWith('https://'), true));
          res.writeHead(204);
          return res.end();
        }
        if (path.startsWith('/api/')) {
          const auth = authenticate(req);
          if (path === '/api/chats' || path.startsWith('/api/chats/')) {
            // The shared demo login must never enter private conversations.
            if (auth.row.is_demo) throw new HttpError(403, 'Create an individual account to use private chat.');
            if (method === 'GET' && path === '/api/chats') {
              const limit = url.searchParams.has('limit') ? queryInteger(url.searchParams.get('limit'), 'Limit', 100) : 100;
              const before = url.searchParams.has('before') ? queryInteger(url.searchParams.get('before'), 'Conversation cursor') : null;
              // A cursor remains valid if a newer message arrives in its pair.
              if (before && !inboxCursor.get(auth.row.id, before, auth.row.id, auth.row.id)) {
                throw new HttpError(400, 'Use a message cursor from one of your conversations.');
              }
              const rows = inbox.all(auth.row.id, auth.row.id, auth.row.id, auth.row.id, auth.row.id, before, before, limit + 1);
              return json(res, 200, {
                conversations: rows.slice(0, limit).map(row => ({
                  person: chatPersonFromRow(row),
                  lastMessage: messageFromRow({ ...row, id: row.message_id }),
                  unreadCount: row.unread_count,
                })),
                unreadCount: unreadTotal.get(auth.row.id, auth.row.id).total,
                hasMore: rows.length > limit,
              });
            }
            const threadMatch = path.match(/^\/api\/chats\/([^/]+)$/);
            if (method === 'GET' && threadMatch) {
              if (url.searchParams.has('before') && url.searchParams.has('after')) throw new HttpError(400, 'Choose either before or after, not both.');
              const limit = url.searchParams.has('limit') ? queryInteger(url.searchParams.get('limit'), 'Limit', 100) : 50;
              const direction = url.searchParams.has('after') ? 'after' : url.searchParams.has('before') ? 'before' : null;
              const cursor = direction ? queryInteger(url.searchParams.get(direction), 'Message cursor') : null;
              const context = chatContext(auth.row, threadMatch[1]);
              if (cursor && (!context.conversation || !messageInConversation.get(cursor, context.conversation.id))) {
                throw new HttpError(400, 'Use a message cursor from this conversation.');
              }
              if (!context.conversation) return json(res, 200, { person: chatPersonFromRow(context.person), messages: [], hasMore: false });
              const comparison = direction === 'after' ? ' AND id > ?' : direction === 'before' ? ' AND id < ?' : '';
              const order = direction === 'after' ? 'ASC' : 'DESC';
              const params = [context.conversation.id, ...(cursor ? [cursor] : []), limit + 1];
              const rows = db.prepare(`SELECT * FROM chat_messages WHERE conversation_id = ?${comparison} ORDER BY id ${order} LIMIT ?`).all(...params);
              const page = rows.slice(0, limit);
              if (order === 'DESC') page.reverse();
              return json(res, 200, { person: chatPersonFromRow(context.person), messages: page.map(messageFromRow), hasMore: rows.length > limit });
            }
            const sendMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
            if (method === 'POST' && sendMatch) {
              signedWrite(req, auth, origin);
              const requestBody = await readJson(req);
              const body = textField(requestBody.body, 'Message', 2000, 1);
              const clientId = textField(requestBody.clientId, 'Message retry ID', 36, 36).toLowerCase();
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientId)) {
                throw new HttpError(400, 'Message retry ID must be a UUID.');
              }
              const context = chatContext(auth.row, sendMatch[1]);
              const prior = messageByClient.get(auth.row.id, clientId);
              if (prior) return json(res, 200, { message: duplicateMessage(prior, context.person.id, body) });
              rateLimit(req, 'chat-send', 60, 60 * 1000, auth.row.id);
              let stored;
              let created = false;
              db.exec('BEGIN IMMEDIATE');
              try {
                // Recheck under the write lock in case another local process retried.
                const retry = messageByClient.get(auth.row.id, clientId);
                if (retry) {
                  stored = duplicateMessage(retry, context.person.id, body);
                } else {
                  // A profile can change while the request body is arriving or
                  // another process owns the DB; check visibility under the lock.
                  const currentContext = chatContext(auth.row, sendMatch[1]);
                  insertConversation.run(randomUUID(), currentContext.one, currentContext.two, Date.now());
                  const conversation = conversationByPair.get(currentContext.one, currentContext.two);
                  const result = insertMessage.run(conversation.id, auth.row.id, currentContext.person.id, body, clientId, Date.now());
                  stored = messageFromRow(messageInConversation.get(Number(result.lastInsertRowid), conversation.id));
                  created = true;
                }
                db.exec('COMMIT');
              } catch (error) {
                db.exec('ROLLBACK');
                throw error;
              }
              return json(res, created ? 201 : 200, { message: stored });
            }
            const readMatch = path.match(/^\/api\/chats\/([^/]+)\/read$/);
            if (method === 'POST' && readMatch) {
              signedWrite(req, auth, origin);
              const requestBody = await readJson(req);
              const throughId = positiveInteger(requestBody.throughId, 'Read position');
              const context = chatContext(auth.row, readMatch[1]);
              const message = context.conversation && messageInConversation.get(throughId, context.conversation.id);
              if (!message || message.recipient_id !== auth.row.id) throw new HttpError(400, 'Choose a received message from this conversation.');
              updateRead.run(context.conversation.id, auth.row.id, throughId);
              // Both values come from one SQLite read snapshot, including any
              // message that arrived after the acknowledged read position.
              const snapshot = readSnapshot.get(context.conversation.id, auth.row.id,
                context.conversation.id, auth.row.id, context.conversation.id);
              return json(res, 200, { ok: true, unreadCount: snapshot.unread_count, latestMessageId: snapshot.latest_message_id });
            }
            throw new HttpError(404, 'This conversation could not be found.');
          }
          if (method === 'GET' && path === '/api/people') {
            const search = textField(url.searchParams.get('search') || '', 'Search', 160);
            const team = textField(url.searchParams.get('team') || '', 'Team filter', 100);
            const location = textField(url.searchParams.get('location') || '', 'Location filter', 100);
            const clauses = ['u.listed = 1', '(? = 1 OR u.is_demo = 0)'];
            const params = [auth.row.id, Number(demoMode)];
            for (const term of search.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)) {
              clauses.push("lower(u.name || ' ' || u.title || ' ' || u.team || ' ' || u.location || ' ' || u.bio || ' ' || u.skills || ' ' || u.interests) LIKE ? ESCAPE '\\'");
              params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
            }
            if (team) { clauses.push('u.team = ? COLLATE NOCASE'); params.push(team); }
            if (location) { clauses.push('u.location = ? COLLATE NOCASE'); params.push(location); }
            if (['1', 'true'].includes(url.searchParams.get('available'))) clauses.push('u.available = 1');
            if (['1', 'true'].includes(url.searchParams.get('saved'))) {
              clauses.push('EXISTS(SELECT 1 FROM saved_people s WHERE s.viewer_id = ? AND s.person_id = u.id)');
              params.push(auth.row.id);
            }
            const rows = db.prepare(`SELECT u.*, EXISTS(SELECT 1 FROM saved_people s WHERE s.viewer_id = ? AND s.person_id = u.id) AS saved
              FROM users u WHERE ${clauses.join(' AND ')} ORDER BY u.name COLLATE NOCASE, u.id`).all(...params);
            const facets = db.prepare('SELECT team,location FROM users WHERE listed = 1 AND (? = 1 OR is_demo = 0)').all(Number(demoMode));
            const values = key => [...new Set(facets.map(row => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            return json(res, 200, { people: rows.map(personFromRow), total: rows.length, facets: { teams: values('team'), locations: values('location') } });
          }
          const personMatch = path.match(/^\/api\/people\/([^/]+)$/);
          if (method === 'GET' && personMatch) {
            const row = userById.get(auth.row.id, personMatch[1]);
            if (!row || (!row.listed && row.id !== auth.row.id) || (!demoMode && row.is_demo)) throw new HttpError(404, 'This profile is unavailable.');
            return json(res, 200, { person: personFromRow(row) });
          }
          if (method === 'PUT' && path === '/api/profile') {
            signedWrite(req, auth, origin);
            const fields = profileFields(await readJson(req));
            db.prepare('UPDATE users SET name=?,title=?,team=?,location=?,bio=?,skills=?,interests=?,available=?,listed=? WHERE id=?')
              .run(fields.name, fields.title, fields.team, fields.location, fields.bio,
                JSON.stringify(fields.skills), JSON.stringify(fields.interests), Number(fields.available), Number(fields.listed), auth.row.id);
            return json(res, 200, { user: personFromRow(userById.get(auth.row.id, auth.row.id)) });
          }
          const savedMatch = path.match(/^\/api\/saved\/([^/]+)$/);
          if (savedMatch && ['POST', 'DELETE'].includes(method)) {
            signedWrite(req, auth, origin);
            const person = userById.get(auth.row.id, savedMatch[1]);
            if (method === 'POST') {
              if (!person || !person.listed || (!demoMode && person.is_demo)) throw new HttpError(404, 'This profile is unavailable.');
              db.prepare('INSERT OR IGNORE INTO saved_people(viewer_id,person_id) VALUES(?,?)').run(auth.row.id, person.id);
            } else {
              db.prepare('DELETE FROM saved_people WHERE viewer_id = ? AND person_id = ?').run(auth.row.id, savedMatch[1]);
            }
            return json(res, 200, { saved: method === 'POST' });
          }
          throw new HttpError(404, 'This page could not be found.');
        }
        if (['GET', 'HEAD'].includes(method) && STATIC_FILES.has(path)) {
          const [filename, contentType] = STATIC_FILES.get(path);
          let file;
          try { file = await readFile(resolve(ROOT, 'public', filename)); }
          catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'This page could not be found.'); throw error; }
          if (path === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.length });
          return res.end(method === 'HEAD' ? undefined : file);
        }
        throw new HttpError(404, 'This page could not be found.');
      } catch (error) {
        if (res.headersSent || res.destroyed) return;
        if (!(error instanceof HttpError)) logger?.error?.('[Common Ground] A request failed.', error.code || 'internal_error');
        json(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
      }
    });
    // Binding remains constrained in both modes, including alternate signatures.
    const originalListen = server.listen;
    server.listen = function (...args) {
      if (typeof args[0] === 'object' && args[0] !== null) {
        if ('path' in args[0] || 'fd' in args[0]) throw new Error('Use a TCP port for this deployment mode.');
        args[0] = { ...args[0], host: args[0].host || host };
        if (hosted ? args[0].host !== '0.0.0.0' : !LOOPBACK_HOSTS.has(args[0].host)) throw new Error(hosted ? 'Hosted mode must bind to 0.0.0.0.' : 'This pilot can only bind to a loopback host.');
      } else {
        if (typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0 || args[0] > 65535) throw new Error('Use a valid TCP port.');
        if (typeof args[1] !== 'string') args.splice(1, 0, host);
        if (hosted ? args[1] !== '0.0.0.0' : !LOOPBACK_HOSTS.has(args[1])) throw new Error(hosted ? 'Hosted mode must bind to 0.0.0.0.' : 'This pilot can only bind to a loopback host.');
      }
      return originalListen.apply(this, args);
    };
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    server.once('close', () => db.close());
    return server;
  } catch (error) {
    db.close();
    throw error;
  }
}

function envBoolean(key, fallback) {
  if (process.env[key] === undefined || process.env[key] === '') return fallback;
  if (!['true', 'false'].includes(process.env[key])) throw new Error(`${key} must be true or false.`);
  return process.env[key] === 'true';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const deploymentMode = process.env.DEPLOYMENT_MODE || 'local';
    const hosted = deploymentMode === 'hosted';
    const host = process.env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1');
    const port = Number(process.env.PORT || (hosted ? 10000 : 4310));
    const server = await createApp({
      deploymentMode, host, dbPath: process.env.DB_PATH || (hosted ? null : resolve(ROOT, 'data/network.sqlite')),
      demoMode: envBoolean('DEMO_MODE', !hosted), companyDomain: process.env.COMPANY_DOMAIN || null,
      appOrigin: process.env.APP_ORIGIN || (hosted ? process.env.RENDER_EXTERNAL_URL : null) || null,
      registrationEnabled: envBoolean('REGISTRATION_ENABLED', true), registrationCode: process.env.REGISTRATION_CODE || null,
    });
    server.on('error', error => {
      console.error(`[Common Ground] Could not start (${error.code || 'startup_error'}).`);
      process.exitCode = 1;
      server.close();
    });
    server.listen(port, host, () => {
      console.log(hosted ? 'Common Ground shared pilot is ready.' : `Common Ground is running locally at http://${host === '::1' ? '[::1]' : host}:${server.address().port}`);
      if (!hosted) console.log('This is a local pilot. Company deployment and verified employee access are not configured.');
    });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
      deadline.unref();
      server.close(() => clearTimeout(deadline));
      server.closeIdleConnections();
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
  } catch (error) {
    console.error(`[Common Ground] ${error.message}`);
    process.exitCode = 1;
  }
}
