import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

async function frontend(registrationCodeRequired) {
  const listeners = new Map();
  const calls = [];
  const root = { innerHTML: '', addEventListener: (name, callback) => listeners.set(name, callback), querySelectorAll: () => [], querySelector: () => null };
  const dialog = { open: false, addEventListener() {}, close() { this.open = false; } };
  const toast = { dataset:{} };
  const user = { id:'user-1', name:'Test Person', email:'test@example.com', skills:[], interests:[], listed:true, team:'QA', title:'', location:'', bio:'', available:true, isDemo:false };
  const document = {
    visibilityState: 'visible',
    getElementById: id => ({ app:root, 'person-dialog':dialog, toast })[id] || null,
    addEventListener() {},
  };
  const location = { hash:'' };
  const context = vm.createContext({
    document, navigator:{ onLine:true }, location,
    window:{ scrollTo() {}, addEventListener() {} },
    history:{ replaceState(_state, _title, hash) { location.hash = hash; } },
    setTimeout: () => 1, clearTimeout() {}, URLSearchParams,
    FormData: class { constructor(form) { this.values=form.values; } get(name) { return this.values[name] ?? null; } has(name) { return name in this.values; } },
    async fetch(path, options) {
      calls.push({ path, options });
      let body, status=200;
      if (path==='/api/config') body={ registrationCodeRequired, registrationEnabled:true, demoMode:false };
      else if (path==='/api/auth/me') { body={ error:'Sign in' }; status=401; }
      else if (path==='/api/auth/register') body={ user, csrfToken:'test-csrf' };
      else if (path==='/api/profile') body={ user };
      else if (path==='/api/chats') body={ conversations:[], unreadCount:0, hasMore:false };
      else throw new Error(`Unexpected path ${path}`);
      return { status, ok:status<400, json:async()=>body };
    },
  });
  vm.runInContext(source, context);
  await new Promise(resolve=>setImmediate(resolve));
  async function register() {
    await listeners.get('click')({ target:{ closest:()=>({ disabled:false, dataset:{ action:'auth-mode', mode:'register' } }) } });
    const signupMarkup=root.innerHTML;
    const form={ id:'auth-form', values:{ name:user.name, email:user.email, password:'UniqueTestPassword2026!', registrationCode:'pilot-join-code-for-test-only' }, querySelector:()=>({ disabled:false }) };
    await listeners.get('submit')({ preventDefault() {}, target:form });
    return signupMarkup;
  }
  return { root, calls, listeners, register };
}

test('join-code signup renders required secret input and sends it with the shared API contract', async()=>{
  const app=await frontend(true);
  const markup=await app.register();
  assert.match(markup, /name="registrationCode" type="password"/);
  assert.match(markup, /Employee identities are not verified/);
  assert.doesNotMatch(markup, /demo-login|saved on this computer|device-store|IndexedDB/);
  const request=app.calls.find(call=>call.path==='/api/auth/register');
  assert.equal(JSON.parse(request.options.body).registrationCode, 'pilot-join-code-for-test-only');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
});

test('signup omits the join-code field and payload when the server does not require it', async()=>{
  const app=await frontend(false);
  const markup=await app.register();
  assert.doesNotMatch(markup, /name="registrationCode"/);
  const payload=JSON.parse(app.calls.find(call=>call.path==='/api/auth/register').options.body);
  assert.equal('registrationCode' in payload, false);
});

test('signed-in mutations retain CSRF, same-origin credentials, and no-store transport', async()=>{
  const app=await frontend(true);
  await app.register();
  const form={ id:'profile-form', values:{ name:'Test Person', title:'Engineer', team:'QA', location:'Remote', bio:'Test profile', skills:'JavaScript', interests:'Hiking', listed:'on' }, querySelector:()=>({ disabled:false }) };
  await app.listeners.get('submit')({ preventDefault() {}, target:form });
  const request=app.calls.find(call=>call.path==='/api/profile');
  assert.equal(request.options.method, 'PUT');
  assert.equal(request.options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
});
