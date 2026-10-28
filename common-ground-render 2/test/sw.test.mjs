import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin='https://pilot.example';
const shell=['/index.html','/app.js','/styles.css','/mobile.css','/install.mjs','/favicon.svg','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png','/icons/apple-touch-icon.png'];

function worker() {
  const handlers=new Map(), stored=new Map(), precached=[], deletions=[], fetches=[];
  let offline=false;
  const cache={
    async addAll(requests) { for(const request of requests) { precached.push(request); stored.set(new URL(request.url).pathname, new Response(new URL(request.url).pathname==='/index.html'?'PUBLIC APP SHELL':'PUBLIC ASSET')); } },
    async match(request) { const path=typeof request==='string'?new URL(request,origin).pathname:new URL(request.url).pathname; return stored.get(path)?.clone(); },
  };
  const context=vm.createContext({
    URL, Response,
    Request:class extends Request { constructor(path,options) { super(new URL(path,origin),options); } },
    self:{ location:{ origin }, clients:{ async claim() {} }, async skipWaiting() {}, addEventListener:(name,handler)=>handlers.set(name,handler) },
    caches:{ async open() { return cache; }, async keys() { return ['common-ground-shared-shell-old','another-app-cache']; }, async delete(name) { deletions.push(name); } },
    async fetch(request) { fetches.push(request); if(offline)throw new TypeError('offline'); return new Response('NETWORK PUBLIC SHELL'); },
  });
  vm.runInContext(source,context);
  return {
    precached, stored, deletions, fetches,
    setOffline() { offline=true; },
    async lifecycle(name) { let completion; handlers.get(name)({ waitUntil(promise) { completion=promise; } }); await completion; },
    fetch(path,method='GET',mode='cors') {
      let response;
      handlers.get('fetch')({ request:{ url:new URL(path,origin).href, method, mode }, respondWith(promise) { response=promise; } });
      return response;
    },
  };
}

test('install precaches only the explicit public shell without session credentials', async()=>{
  const sw=worker();
  await sw.lifecycle('install');
  assert.deepEqual(sw.precached.map(request=>new URL(request.url).pathname).sort(), [...shell].sort());
  assert.ok(sw.precached.every(request=>request.credentials==='omit' && request.cache==='reload'));
  assert.ok([...sw.stored.keys()].every(path=>!path.startsWith('/api')));
});

test('private APIs, writes, unknown paths and cross-origin requests bypass the worker', async()=>{
  const sw=worker();
  await sw.lifecycle('install');
  for(const path of ['/api','/api/config','/api/auth/me','/api/people','/api/saved/other','/api/chats','/api/chats/other/messages','/api%2Fauth%2Fme','/private/messages']) {
    assert.equal(sw.fetch(path), undefined, path);
    assert.equal(sw.fetch(path,'POST'), undefined, `${path} POST`);
  }
  assert.equal(sw.fetch('/app.js','POST'), undefined);
  assert.equal(sw.fetch('https://another.example/app.js'), undefined);
  assert.equal(sw.fetch('/private/messages','GET','navigate'), undefined);
  assert.equal(sw.fetches.length, 0);
  assert.equal(sw.stored.size, shell.length);
});

test('offline navigation returns only the public connection shell and no private records', async()=>{
  const sw=worker();
  await sw.lifecycle('install');
  sw.setOffline();
  const response=await sw.fetch('/','GET','navigate');
  assert.equal(await response.text(), 'PUBLIC APP SHELL');
  const script=await sw.fetch('/app.js');
  assert.equal(await script.text(), 'PUBLIC ASSET');
  assert.equal(sw.fetch('/api/chats'), undefined);
  assert.equal(sw.stored.size, shell.length);
});

test('activation removes only old caches owned by this shared shell', async()=>{
  const sw=worker();
  await sw.lifecycle('activate');
  assert.deepEqual(sw.deletions, ['common-ground-shared-shell-old']);
});
