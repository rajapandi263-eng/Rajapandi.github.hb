(() => {
  'use strict';
  const root = document.getElementById('app');
  const dialog = document.getElementById('person-dialog');
  const toastEl = document.getElementById('toast');
  const state = {config: null, user: null, authVersion:0, authBusy:false, csrf: '', view: 'directory', authMode: 'login', people: [], search: '', team: '', location: '', available: false, request: 0, person: null};
  let searchTimer, toastTimer;
  const paths = {
    chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8Z"/><path d="M7 8h10M7 12h7"/>',
    send: '<path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/>',
    back: '<path d="m14 5-7 7 7 7"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    powerbump: '<path d="M5 12V6a2 2 0 0 1 4 0v4m0-4V4a2 2 0 0 1 4 0v6m0-4a2 2 0 0 1 4 0v4m0-2a2 2 0 0 1 4 0v7c0 4-3 7-7 7h-2c-4 0-7-3-7-7v-3a2 2 0 0 1 2-2h6a2 2 0 0 1 0 4H9"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    pin: '<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    leaf: '<path d="M20 4C11 1 3 6 4 13c1 7 8 8 13 3 3-3 3-8 3-12ZM5 20 16 9"/>',
    logout: '<path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h11"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    coffee: '<path d="M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Zm12 1h2a3 3 0 0 1 0 6h-2M6 3v2m4-2v2m4-2v2"/>',
    device: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    edit: '<path d="m4 16-1 5 5-1L20 8a2.8 2.8 0 0 0-4-4ZM14 6l4 4"/>'
  };
  function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.user}</svg>`; }
  function esc(value = '') { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function initials(name) { return String(name || '?').trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase(); }
  function color(name) { return [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % 5; }
  function avatar(person, extra = '') { return `<span class="avatar ${extra}" data-color="${color(person.name)}" aria-hidden="true">${esc(initials(person.name))}</span>`; }
  function brand() { return '<div class="brand"><span class="brand-mark" aria-hidden="true">cg</span><div class="brand-name">Common Ground<span>Your company network</span></div></div>'; }
  function toast(message, error = false) { clearTimeout(toastTimer); toastEl.textContent = message; toastEl.dataset.error = String(error); toastEl.hidden = false; toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500); }
  async function api(path, options = {}) {
    const callerId=state.user?.id, callerVersion=state.authVersion;
    const method = options.method || 'GET';
    const headers = {'Accept': 'application/json'};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    let response;
    try { response = await fetch(path, {method, headers, credentials: 'same-origin', cache: 'no-store', ...(options.body !== undefined ? {body: JSON.stringify(options.body)} : {})}); }
    catch { throw new Error(navigator.onLine === false ? 'You’re offline. Connect to the internet and try again.' : 'Could not reach the shared pilot. Check your connection and try again.'); }
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) {
      if (response.status === 401 && callerId && state.user?.id === callerId && state.authVersion===callerVersion) { state.user = null; state.csrf = ''; if (dialog.open) dialog.close(); renderAuth('Please sign in again to continue.'); }
      const error = new Error(data.error || 'Something went wrong. Please try again.');
      error.status = response.status; throw error;
    }
    return data;
  }
  function renderAuth(message = '') {
    state.authVersion++;
    resetChat();
    if (state.config?.registrationEnabled === false) state.authMode = 'login';
    const register = state.authMode === 'register';
    root.innerHTML = `<main class="auth-layout">
      <section class="auth-story">${brand()}<div class="auth-story-content"><div class="eyebrow">Good things start with people</div><h1>Your next connection<br>is closer than<br>you think.</h1><p>Discover the skills, interests, and people that make your company more than a place to work.</p><div class="network-cards" aria-label="Ways to find common ground">
        <div class="mini-person">${avatar({name:'Shared skills'})}<div><strong>Learn from each other</strong><p>Find the skills you need</p></div><span class="pill">Shared skills</span></div>
        <div class="mini-person">${avatar({name:'Common interests'})}<div><strong>Find common interests</strong><p>Meet beyond your team</p></div><span class="pill">New connections</span></div>
        <div class="mini-person">${avatar({name:'Good conversations'})}<div><strong>Start a conversation</strong><p>Keep in touch across devices</p></div><span class="pill">Say hello</span></div>
      </div></div><div class="story-decoration" aria-hidden="true"></div><p class="auth-story-footer">A little curiosity can go a long way.</p></section>
      <section class="auth-panel"><div class="auth-form-wrap"><span class="pilot-badge"><span class="dot"></span>Shared pilot</span><h2>${register ? 'Make yourself discoverable.' : 'Welcome to your network.'}</h2><p>${register ? 'Create an account and share what makes you, you.' : 'Find a fresh perspective. Meet someone new.'}</p>
      <div class="auth-tabs" role="group" aria-label="Account access"><button type="button" class="auth-tab ${register?'':'active'}" data-action="auth-mode" data-mode="login" aria-pressed="${!register}">Sign in</button>${state.config?.registrationEnabled!==false?`<button type="button" class="auth-tab ${register?'active':''}" data-action="auth-mode" data-mode="register" aria-pressed="${register}">Create account</button>`:''}</div>
      <form id="auth-form" class="auth-fields">${register?'<div class="field"><label for="auth-name">Full name</label><input id="auth-name" name="name" autocomplete="name" placeholder="Your name" maxlength="80" minlength="2" required></div>':''}
        <div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="username" placeholder="you@company.com" maxlength="254" required></div>
        <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${register?'new-password':'current-password'}" placeholder="${register?'At least 12 characters':'Your password'}" ${register?'minlength="12"':''} maxlength="128" required>${register?'<span class="field-help">Use a unique password with at least 12 characters.</span>':''}</div>
        ${register&&state.config?.registrationCodeRequired?'<div class="field"><label for="auth-registration-code">Pilot join code</label><input id="auth-registration-code" name="registrationCode" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="128" required><span class="field-help">Ask your pilot organizer for the join code.</span></div>':''}
        <div id="auth-error" class="error" role="alert" ${message?'':'hidden'}>${esc(message)}</div><button class="primary" type="submit">${register?'Create my account':'Sign in'}${icon('arrow')}</button>
      </form>
      <div class="privacy-note">${icon('lock')}<span>Accounts, profiles, and messages use this pilot’s shared service. Employee identities are not verified. An internet connection is required.</span></div><button class="quiet shared-install-help" data-action="install-help">Add to Home Screen</button></div></section>
    </main>`;
  }
  function currentView() { return ['directory','saved','messages','profile'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'directory'; }
  function navigate(view) { state.request++; state.view = view; if (location.hash !== `#${view}`) history.replaceState(null,'',`#${view}`); renderApp(); }
  function renderApp() {
    if (!state.user) return renderAuth();
    const user = state.user, view = state.view;
    const labels = {directory:'Discover people',saved:'Power bumps',messages:'Messages',profile:'My profile'};
    root.innerHTML = `<div class="app-shell"><aside class="sidebar">${brand()}<div><p class="workspace-label">Your workspace</p><nav class="nav-list" aria-label="Main navigation">${[['directory','grid','Discover people'],['saved','powerbump','Power bumps'],['messages','chat','Messages'],['profile','user','My profile']].map(([key,ico,label])=>`<button class="nav-button ${view===key?'active':''}" data-action="navigate" data-view="${key}" ${view===key?'aria-current="page"':''}>${icon(ico)}<span class="nav-label">${label}</span>${key==='messages'?'<span id="messages-unread" class="unread-badge" hidden></span>':''}</button>`).join('')}</nav></div><div class="sidebar-bottom"><div class="pilot-note"><strong>A small start. Real possibilities.</strong><p>Add your skills and interests so the right people can find you.</p></div><div class="user-chip">${avatar(user,'tiny')}<div class="user-details"><strong>${esc(user.name)}</strong><p>${esc(user.team||'Your workspace')}</p></div><button class="icon-button" data-action="logout" aria-label="Sign out">${icon('logout')}</button></div></div></aside>
      <div class="app-main"><header class="topbar"><div class="breadcrumbs"><span>Workspace</span><span aria-hidden="true">/</span><strong>${labels[view]}</strong></div><div class="topbar-right"><span class="pilot-badge"><span class="dot"></span>Shared pilot</span>${view!=='profile'?'<button class="primary" data-action="navigate" data-view="profile">'+icon('edit')+'Edit my profile</button>':''}<button class="icon-button shared-install-button" data-action="install-help" aria-label="Install Common Ground">${icon('device')}</button>${avatar(user,'tiny')}<button class="icon-button mobile-logout" data-action="logout" aria-label="Sign out" hidden>${icon('logout')}</button></div></header><main class="content" id="main-content">${view==='profile'?profileView():view==='messages'?messagesView():directoryView()}</main></div></div>`;
    window.scrollTo(0, 0);
    if(view==='messages' && !user.isDemo) {renderInbox();renderChatPanel();if(chat.person)refreshChat();}
    else if(view!=='profile' && view!=='messages')loadPeople();
    loadChatInbox();
    startChatPolling();
  }
  function directoryView() {
    const saved = state.view === 'saved';
    return `<div class="page-heading"><div><p class="eyebrow">${saved?'Your growing network':'People & possibility'}</p><h1>${saved?'Keep good connections close.':'Find your people.'}</h1><p class="intro">${saved?'The colleagues you want to learn from, collaborate with, or get to know.':'A new idea, a shared interest, a different perspective. It starts here.'}</p></div></div>
    ${saved?'':`<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="eyebrow">Across teams. Beyond job titles.</p><h2 id="hero-title">A little curiosity.<br>A new connection.</h2><p>Meet someone who knows what you’re learning—or loves what you love.</p><div class="hero-topics"><button data-action="topic" data-topic="AI">Explore AI ${icon('arrow')}</button><button data-action="topic" data-topic="Design">Talk design ${icon('arrow')}</button><button data-action="topic" data-topic="Hiking">Find fellow hikers ${icon('arrow')}</button></div></div><div class="hero-art" aria-hidden="true"><span class="hero-orbit"></span><span class="hero-orbit second"></span><span class="avatar">MC</span><span class="avatar" data-color="1">JE</span><span class="avatar" data-color="2">PS</span><span class="avatar" data-color="3">AO</span><span class="hero-spark">✧</span></div></section>`}
    <div class="directory-toolbar"><div class="search-wrap">${icon('search')}<input id="people-search" type="search" aria-label="Search colleagues by name, skill, or interest" placeholder="Search by name, skill, or interest…" value="${esc(state.search)}" maxlength="150"><button class="clear-search" data-action="clear-search" aria-label="Clear search" ${state.search?'':'hidden'}>×</button></div><select id="team-filter" aria-label="Filter by team"><option value="">All teams</option></select><select id="location-filter" aria-label="Filter by location"><option value="">All locations</option></select></div>
    <div class="filter-bottom"><label class="check-label"><input id="available-filter" type="checkbox" ${state.available?'checked':''}>${icon('coffee')}Open to a coffee chat</label><button class="quiet" data-action="reset-filters">Reset filters</button></div><div class="results-heading"><h2>${saved?'Your power bumps':'Meet your colleagues'}</h2><p id="result-count" role="status" aria-live="polite">Loading people…</p></div><div id="people-grid" class="people-grid" aria-label="Colleague profiles"><div class="loading-results">Finding your people…</div></div><p class="directory-footer">Shared pilot · Employee identities are not verified.</p>`;
  }
  async function loadPeople() {
    if(state.view==='messages' || state.view==='profile')return;
    const request = ++state.request;
    const params = new URLSearchParams();
    if(state.search) params.set('search',state.search);
    if(state.team) params.set('team',state.team);
    if(state.location) params.set('location',state.location);
    if(state.available) params.set('available','1');
    if(state.view==='saved') params.set('saved','1');
    try {
      const result = await api(`/api/people?${params}`);
      if(request!==state.request || ['profile','messages'].includes(state.view) || !state.user) return;
      state.people = result.people;
      const grid = document.getElementById('people-grid');
      if(!grid) return;
      grid.innerHTML = result.people.length ? result.people.map(personCard).join('') : emptyState();
      document.getElementById('result-count').textContent = `${result.total} ${result.total===1?'colleague':'colleagues'}`;
      updateSelect('team-filter',result.facets.teams,state.team,'All teams');
      updateSelect('location-filter',result.facets.locations,state.location,'All locations');
    } catch(error) {
      if(request!==state.request || !state.user) return;
      const grid = document.getElementById('people-grid');
      if(grid) grid.innerHTML = `<div class="empty-state"><h3>Couldn’t load your colleagues</h3><p>${esc(error.message)}</p><button class="secondary" data-action="retry">Try again</button></div>`;
      const count = document.getElementById('result-count'); if(count) count.textContent='';
    }
  }
  function updateSelect(id,values,selected,label) {
    const el=document.getElementById(id); if(!el)return;
    const options=[...new Set([...(values||[]),...(selected?[selected]:[])])].sort();
    el.innerHTML=`<option value="">${label}</option>${options.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
    el.value=selected;
  }
  function personCard(person) {
    const own=person.id===state.user.id;
    return `<article class="person-card"><div class="card-top">${avatar(person)}${own?'<span class="pill">You</span>':`<button class="icon-button ${person.saved?'saved':''}" data-action="save" data-id="${esc(person.id)}" aria-pressed="${!!person.saved}" aria-label="${person.saved?'Undo power bump with':'Power bump with'} ${esc(person.name)}">${icon('powerbump')}</button>`}</div><button class="card-name" data-action="person" data-id="${esc(person.id)}">${esc(person.name)}</button><p class="card-title">${esc(person.title||'Add a job title to your profile')}</p><p class="card-meta">${esc(person.team||'Team not added')}<span class="meta-separator">·</span>${icon('pin')}${esc(person.location||'Location not added')}</p><p class="card-bio">${esc(person.bio||'A new face in the network. Add skills and interests to start a conversation.')}</p><div class="tags card-tags">${(person.skills||[]).slice(0,3).map(skill=>`<button class="tag" data-action="topic" data-topic="${esc(skill)}" aria-label="Find people with ${esc(skill)} skills">${esc(skill)}</button>`).join('')}${person.skills?.length>3?`<span class="tag">+${person.skills.length-3}</span>`:''}</div><p class="card-interest">${icon('leaf')}<span>${esc((person.interests||[]).slice(0,3).join(' · ')||'Interests to come')}</span></p><div class="card-footer"><span class="available-label">${person.available?'<span class="dot"></span>Open to coffee':'Let’s find common ground'}</span><button class="view-profile" data-action="person" data-id="${esc(person.id)}">View profile${icon('arrow')}</button></div></article>`;
  }
  function emptyState() {
    const filtering=state.search||state.team||state.location||state.available;
    const isSaved=state.view==='saved';
    return `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">${isSaved?'♡':'⌕'}</div><h3>${filtering?'No colleagues match just yet.':isSaved?'Your next connection is waiting.':'Be the first face in your network.'}</h3><p>${filtering?'Try another skill or interest, or broaden your filters.':isSaved?'Give a colleague a power bump to keep them in your network.':'Complete your profile and invite coworkers to this shared pilot.'}</p><button class="secondary" data-action="${filtering?'reset-filters':'navigate'}" data-view="${isSaved?'directory':'profile'}">${filtering?'Clear filters':isSaved?'Discover people':'Edit my profile'}${icon('arrow')}</button></div>`;
  }
  const chat = {generation:0, request:0, inboxRequest:0, person:null, conversations:[], messages:[], unreadCount:0, fetchedThrough:0, hasMore:false, loading:false, fetching:0, sending:false, polling:false, error:'', inboxError:'', inboxHasMore:false, inboxOlderLoaded:false, inboxFetchingOlder:false, drafts:Object.create(null), pending:Object.create(null), readThrough:Object.create(null), reading:Object.create(null)};
  let chatTimer;
  function resetChat() {
    clearTimeout(chatTimer);
    chat.generation++; chat.request++; chat.inboxRequest++;
    Object.assign(chat, {person:null, conversations:[], messages:[], unreadCount:0, fetchedThrough:0, hasMore:false, loading:false, fetching:0, sending:false, polling:false, error:'', inboxError:'', inboxHasMore:false, inboxOlderLoaded:false, inboxFetchingOlder:false, drafts:Object.create(null), pending:Object.create(null), readThrough:Object.create(null), reading:Object.create(null)});
  }
  function messagesView() {
    if (state.user.isDemo) return `<div class="page-heading"><div><p class="eyebrow">A little hello goes a long way</p><h1>Make room for a conversation.</h1></div></div><section class="chat-demo"><div class="chat-empty-icon">${icon('chat')}</div><h2>Private chat starts with your account.</h2><p>The sample account is shared, and the sample colleagues are fictional. Create your own pilot account to message another participant.</p><button class="primary" data-action="create-chat-account">Create an account for chat${icon('arrow')}</button></section>`;
    return `<div class="page-heading"><div><p class="eyebrow">A little hello goes a long way</p><h1>Your conversations.</h1><p class="intro">Trade ideas, find common ground, and keep in touch.</p></div><button class="secondary" data-action="navigate" data-view="directory">${icon('user')}Find a colleague</button></div><p class="chat-pilot-note">${icon('lock')}Conversations are shared with their two participants across devices. Sign-in and chat need an internet connection.</p><section class="chat-layout ${chat.person?'has-conversation':''}" aria-label="Messages"><aside class="chat-inbox"><div class="inbox-heading"><h2>Messages</h2><span class="small muted">One to one</span></div><p id="inbox-error" class="chat-notice" role="status" ${chat.inboxError?'':'hidden'}>${esc(chat.inboxError)}</p><div id="conversation-list" class="conversation-list" aria-label="Your conversations"></div></aside><div id="conversation-panel" class="conversation-panel"></div></section>`;
  }
  function conversationTime(value, long = false) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, long ? {dateStyle:'medium',timeStyle:'short'} : {hour:'numeric',minute:'2-digit'}).format(new Date(value));
  }
  function updateUnreadBadge() {
    const badge = document.getElementById('messages-unread');
    if (badge) { badge.hidden = !chat.unreadCount; badge.textContent = chat.unreadCount > 99 ? '99+' : String(chat.unreadCount); }
    const nav = root.querySelector('[data-view="messages"]');
    if (nav) nav.setAttribute('aria-label', chat.unreadCount ? `Messages, ${chat.unreadCount} unread` : 'Messages');
  }
  function renderInbox() {
    updateUnreadBadge();
    const list = document.getElementById('conversation-list');
    if (!list) return;
    const revision=JSON.stringify([chat.conversations,chat.person?.id,chat.inboxHasMore,chat.inboxFetchingOlder]);
    if(list.dataset.revision!==revision){
    list.dataset.revision=revision;
    list.innerHTML = chat.conversations.length ? chat.conversations.map(c => `<button class="conversation-item ${c.person.id===chat.person?.id?'active':''} ${c.unreadCount?'unread':''}" data-action="open-chat" data-id="${esc(c.person.id)}" ${c.person.id===chat.person?.id?'aria-current="true"':''}>${avatar(c.person,'tiny')}<span class="conversation-summary"><span class="conversation-name">${esc(c.person.name)}</span><span class="conversation-preview">${c.lastMessage.senderId===state.user.id?'You: ':''}${esc(c.lastMessage.body)}</span></span><span class="conversation-meta"><time datetime="${new Date(c.lastMessage.createdAt).toISOString()}" title="${conversationTime(c.lastMessage.createdAt,true)}">${conversationTime(c.lastMessage.createdAt)}</time>${c.unreadCount?`<span class="unread-badge" aria-label="${c.unreadCount} unread messages">${c.unreadCount>99?'99+':c.unreadCount}</span>`:''}</span></button>`).join('') : '<div class="inbox-empty"><p>No conversations yet.</p><span>Open a colleague’s profile and choose Send message.</span></div>';
    if(chat.inboxHasMore)list.insertAdjacentHTML('beforeend',`<button class="quiet" data-action="earlier-conversations" ${chat.inboxFetchingOlder?'disabled':''}>Load earlier conversations</button>`);
    }
    const error = document.getElementById('inbox-error');
    if (error) {error.hidden=!chat.inboxError;error.textContent=chat.inboxError;}
  }
  function renderChatPanel() {
    const panel = document.getElementById('conversation-panel');
    if (!panel) return;
    const p = chat.person;
    if (!p) {
      panel.innerHTML = `<div class="chat-welcome"><div class="chat-empty-icon">${icon('chat')}</div><h2>Good conversations start here.</h2><p>Choose a conversation, or find a colleague and send a hello.</p><button class="secondary" data-action="navigate" data-view="directory">Discover people${icon('arrow')}</button></div>`;
      return;
    }
    panel.innerHTML = `<header class="chat-header"><button class="icon-button chat-back" data-action="chat-back" aria-label="All messages">${icon('back')}</button>${avatar(p,'tiny')}<div><h2 id="chat-person-name">${esc(p.name)}</h2><p id="chat-person-title">${esc(p.title||p.team||'Your colleague')}</p></div><span class="chat-private">${icon('lock')}One-to-one chat</span></header><div class="message-history" id="message-history" role="log" aria-label="Conversation with ${esc(p.name)}" aria-live="polite" aria-relevant="additions" tabindex="0"></div><button class="new-message-link" id="new-message-link" data-action="latest-messages" hidden>New messages ↓</button><p id="chat-status" class="chat-status" role="status" aria-live="polite"></p><form id="message-form" class="message-form"><label for="chat-message">Your message</label><textarea id="chat-message" name="message" placeholder="Say hello. Share an idea. Ask a question…" rows="3" maxlength="2000" required>${esc(chat.drafts[p.id]||'')}</textarea><div class="composer-bottom"><span id="message-length" class="muted small">${(chat.drafts[p.id]||'').length} / 2,000</span><button class="primary" type="submit" ${chat.sending?'disabled':''}>${icon('send')}Send message</button></div></form>`;
    renderMessages({toEnd:true});
    updateChatStatus();
  }
  function updateChatStatus() {
    const status = document.getElementById('chat-status');
    if (!status) return;
    status.textContent = chat.error || (chat.loading ? 'Opening your conversation…' : chat.sending ? 'Sending your message…' : 'Messages refresh automatically while this app is open.');
    status.dataset.error = String(!!chat.error);
  }
  function renderMessages({older=false,toEnd=false} = {}) {
    const history = document.getElementById('message-history');
    if (!history) return;
    const height = history.scrollHeight, top = history.scrollTop;
    const nearEnd = height - top - history.clientHeight < 90;
    let day = '';
    const rows = chat.messages.map(m => {
      const own = m.senderId === state.user.id;
      const nextDay = new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(m.createdAt));
      const separator = nextDay!==day ? `<div class="message-date">${nextDay}</div>` : '';
      day = nextDay;
      return `${separator}<div class="message-row ${own?'from-me':'from-colleague'}"><div class="message-bubble"><p>${esc(m.body)}</p><span class="message-byline">${own?'You':esc(chat.person.name)} · <time datetime="${new Date(m.createdAt).toISOString()}" title="${conversationTime(m.createdAt,true)}">${conversationTime(m.createdAt)}</time></span></div></div>`;
    }).join('');
    history.innerHTML = (chat.hasMore ? '<div class="earlier-messages"><button class="quiet" data-action="earlier-messages">Load earlier messages</button></div>' : '') + (rows || (chat.loading ? '<p class="thread-empty">Opening your conversation…</p>' : '<div class="thread-empty"><strong>A simple hello is a good start.</strong><span>This conversation is just between you and '+esc(chat.person.name)+'.</span></div>'));
    if (older) history.scrollTop = top + history.scrollHeight - height;
    else if (toEnd || nearEnd) history.scrollTop = history.scrollHeight;
    else document.getElementById('new-message-link').hidden = false;
    if (toEnd || (!older && nearEnd)) markChatRead();
  }
  async function loadChatInbox(older = false) {
    if (!state.user || state.user.isDemo || chat.inboxFetchingOlder) return;
    const epoch=chat.generation, request=++chat.inboxRequest;
    const cursor=older ? chat.conversations.at(-1)?.lastMessage.id : null;
    if(older && !cursor)return;
    if(older){chat.inboxFetchingOlder=true;renderInbox();}
    try {
      const result = await api('/api/chats'+(cursor?'?before='+cursor:''));
      if (epoch!==chat.generation || request!==chat.inboxRequest || !state.user) return;
      if(older || chat.inboxOlderLoaded){
        const merged=new Map(chat.conversations.map(c=>[c.person.id,c]));
        for(const c of result.conversations)merged.set(c.person.id,c);
        chat.conversations=[...merged.values()].sort((a,b)=>b.lastMessage.id-a.lastMessage.id);
      }else chat.conversations=result.conversations;
      if(older){chat.inboxOlderLoaded=true;chat.inboxHasMore=result.hasMore;}
      else if(!chat.inboxOlderLoaded)chat.inboxHasMore=result.hasMore;
      chat.unreadCount=result.unreadCount;chat.inboxError='';
      renderInbox();
    } catch(error) {
      if (epoch!==chat.generation || request!==chat.inboxRequest || !state.user) return;
      chat.inboxError='Couldn’t refresh messages. '+error.message;
      renderInbox();
    } finally {
      if(epoch===chat.generation && older){chat.inboxFetchingOlder=false;renderInbox();}
    }
  }
  async function refreshChat(older = false) {
    if (!state.user || state.user.isDemo || !chat.person || chat.fetching) return;
    const id=chat.person.id, epoch=chat.generation, request=++chat.request;
    const last=chat.fetchedThrough;
    const params=new URLSearchParams();
    if (older && chat.messages.length) params.set('before',chat.messages[0].id);
    else if (last) params.set('after',last);
    chat.fetching=request;
    if (!last) {chat.loading=true;updateChatStatus();}
    const earlier=root.querySelector('[data-action="earlier-messages"]');
    if (older && earlier) earlier.disabled=true;
    try {
      const result=await api(`/api/chats/${encodeURIComponent(id)}${params.toString()?'?'+params:''}`);
      if (epoch!==chat.generation || id!==chat.person?.id || request!==chat.request || !state.user) return;
      chat.person=result.person;chat.loading=false;chat.error='';
      if(!older && result.messages.length)chat.fetchedThrough=result.messages.at(-1).id;
      if (older || !last) chat.hasMore=result.hasMore;
      const merged=new Map(chat.messages.map(m=>[m.id,m]));
      for (const m of result.messages) merged.set(m.id,m);
      const changed=merged.size!==chat.messages.length;
      chat.messages=[...merged.values()].sort((a,b)=>a.id-b.id);
      const name=document.getElementById('chat-person-name');
      if (name) {name.textContent=chat.person.name;document.getElementById('chat-person-title').textContent=chat.person.title||chat.person.team||'Your colleague';}
      if (changed || !last || older) renderMessages({older,toEnd:!last});
      else markChatRead();
      updateChatStatus();
    } catch(error) {
      if (epoch!==chat.generation || id!==chat.person?.id || !state.user) return;
      chat.loading=false;chat.error='Couldn’t refresh this conversation. '+error.message;
      updateChatStatus();
    } finally {
      if (chat.fetching===request) chat.fetching=0;
      if (older && earlier?.isConnected) earlier.disabled=false;
    }
  }
  async function markChatRead() {
    const history=document.getElementById('message-history');
    if (!state.user || document.visibilityState!=='visible' || state.view!=='messages' || !chat.person || !history || history.scrollHeight-history.scrollTop-history.clientHeight>90) return;
    const id=chat.person.id, epoch=chat.generation;
    const incoming=chat.messages.findLast(m=>m.senderId!==state.user.id);
    if (!incoming || (chat.readThrough[id]||0)>=incoming.id || chat.reading[id]) return;
    chat.reading[id]=true;
    try {
      const result=await api(`/api/chats/${encodeURIComponent(id)}/read`,{method:'POST',body:{throughId:incoming.id}});
      if (epoch!==chat.generation || !state.user) return;
      chat.readThrough[id]=incoming.id;
      const row=chat.conversations.find(c=>c.person.id===id);
      if(row && row.lastMessage.id<=result.latestMessageId){row.unreadCount=result.unreadCount;renderInbox();}
      await loadChatInbox();
    } catch(error) {
      if (epoch===chat.generation && state.user && chat.person?.id===id) {chat.error='Your messages are here, but the unread count could not update. '+error.message;updateChatStatus();}
    } finally {if(epoch===chat.generation)chat.reading[id]=false;}
  }
  function startChatPolling() {
    clearTimeout(chatTimer);
    if (!state.user || state.user.isDemo) return;
    chatTimer=setTimeout(pollChat,document.visibilityState==='visible'?4000:12000);
  }
  async function pollChat() {
    if (!state.user || state.user.isDemo || chat.polling) return;
    const epoch=chat.generation;chat.polling=true;
    try {
      if (document.visibilityState==='visible') {
        await loadChatInbox();
        if (state.view==='messages' && chat.person) await refreshChat();
      }
    } finally {
      if (epoch===chat.generation) {chat.polling=false;startChatPolling();}
    }
  }
  function openChat(id) {
    if (state.user.isDemo) return toast('Create your own account to use private chat.');
    if (id===state.user.id) return;
    const p=state.people.find(p=>p.id===id)||chat.conversations.find(c=>c.person.id===id)?.person||(state.person?.id===id?state.person:null);
    if (p?.isDemo) return toast('Sample profiles cannot receive messages.');
    if (dialog.open) dialog.close();
    chat.request++;chat.fetching=0;chat.person=p||{id,name:'Your colleague',title:'',team:''};chat.messages=[];chat.fetchedThrough=0;chat.hasMore=false;chat.loading=true;chat.error='';
    navigate('messages');
  }
  async function sendChatMessage(form) {
    if (!chat.person || chat.sending) return;
    const field=form.elements.message, raw=field.value, body=raw.trim();
    if (!body || body.length>2000) {chat.error='Write a message between 1 and 2,000 characters.';updateChatStatus();field.focus();return;}
    const id=chat.person.id, epoch=chat.generation;
    chat.drafts[id]=raw;
    let pending=chat.pending[id];
    if (!pending || pending.body!==body) pending=chat.pending[id]={body,clientId:crypto.randomUUID()};
    chat.sending=true;chat.error='';form.querySelector('[type="submit"]').disabled=true;updateChatStatus();
    try {
      const result=await api(`/api/chats/${encodeURIComponent(id)}/messages`,{method:'POST',body:pending});
      if (epoch!==chat.generation || !state.user) return;
      delete chat.pending[id];
      if (chat.drafts[id]===raw) chat.drafts[id]='';
      if (chat.person?.id===id) {
        const merged=new Map(chat.messages.map(m=>[m.id,m]));merged.set(result.message.id,result.message);
        chat.messages=[...merged.values()].sort((a,b)=>a.id-b.id);
        renderMessages({toEnd:true});
        const composer=document.getElementById('chat-message');
        if (composer) {composer.value=chat.drafts[id]||'';document.getElementById('message-length').textContent=`${composer.value.length} / 2,000`;}
      }
      await loadChatInbox();
    } catch(error) {
      if (epoch===chat.generation && state.user && chat.person?.id===id) {chat.error=error.message+' Your draft is still here.';updateChatStatus();}
    } finally {
      if (epoch===chat.generation) {
        chat.sending=false;
        const button=document.querySelector('#message-form [type="submit"]');
        if(button)button.disabled=false;
        updateChatStatus();
      }
    }
  }
  async function signOutForChat() {
    try {
      await api('/api/auth/logout',{method:'POST',body:{}});
      state.user=null;state.csrf='';state.person=null;state.authMode='register';state.request++;
      if(dialog.open)dialog.close();
      renderAuth();
    } catch(error){toast(error.message,true);}
  }
  function profileView() {
    const user=state.user;
    return `<div class="page-heading"><div><p class="eyebrow">A little more about you</p><h1>Let people find your spark.</h1><p class="intro">Your expertise opens doors. Your interests start conversations.</p></div></div><div class="profile-layout"><form id="profile-form" class="profile-form"><div><h2 class="section-title">The essentials</h2><p class="section-description">Help colleagues put a name to a face—and know where to find you.</p></div><div class="field-grid"><div class="field"><label for="profile-name">Full name</label><input id="profile-name" name="name" value="${esc(user.name)}" autocomplete="name" maxlength="80" minlength="2" required></div><div class="field"><label for="profile-title">Job title</label><input id="profile-title" name="title" value="${esc(user.title)}" placeholder="e.g. Product designer" maxlength="120"></div><div class="field"><label for="profile-team">Team</label><input id="profile-team" name="team" value="${esc(user.team)}" placeholder="e.g. Engineering" maxlength="100"></div><div class="field"><label for="profile-location">Location</label><input id="profile-location" name="location" value="${esc(user.location)}" placeholder="e.g. Denver · Remote" maxlength="100"></div></div><div class="field"><label for="profile-bio">A little about you</label><textarea id="profile-bio" name="bio" placeholder="What do you work on? What would you love to learn?" maxlength="1200">${esc(user.bio)}</textarea><span class="field-help">Up to 1,200 characters.</span></div><div class="field"><label for="profile-skills">Skills & expertise</label><input id="profile-skills" name="skills" value="${esc((user.skills||[]).join(', '))}" placeholder="Python, Design systems, Leadership" maxlength="800"><span class="field-help">Separate skills with commas. Up to 12, each at most 40 characters.</span></div><div class="field"><label for="profile-interests">Interests beyond work</label><input id="profile-interests" name="interests" value="${esc((user.interests||[]).join(', '))}" placeholder="Hiking, Photography, Coffee" maxlength="800"><span class="field-help">A shared interest is a great icebreaker. Separate up to 12 with commas, each at most 40 characters.</span></div><label class="profile-toggle"><input name="available" type="checkbox" ${user.available?'checked':''}><div><strong>Open to a coffee chat</strong><span>Let colleagues know you’re happy to meet and exchange ideas.</span></div></label><label class="profile-toggle"><input name="listed" type="checkbox" ${user.listed?'checked':''}><div><strong>Show my profile in the directory</strong><span>Signed-in users of this pilot can see your profile and email. Turn this off to hide your profile.</span></div></label><div id="profile-error" class="error" role="alert" hidden></div><div class="profile-actions"><p>Account email: ${esc(user.email)}</p><button class="primary" type="submit">Save my profile${icon('arrow')}</button></div></form><aside class="profile-aside"><div class="profile-preview">${avatar(user,'large')}<h3>${esc(user.name)}</h3><p>${esc(user.title||'Your next introduction')}</p><div class="tags">${(user.skills||[]).slice(0,4).map(s=>`<span class="tag">${esc(s)}</span>`).join('')}</div><p class="preview-label">${user.listed?'Visible in the directory':'Hidden from the directory'}</p></div><p class="profile-tip"><strong>Make it easy to say hello.</strong>Add a few things you can help with, and one thing you’d love to learn.</p></aside></div>`;
  }
  async function showPerson(id) {
    const version=state.authVersion, viewer=state.user?.id;
    try {
      const {person}=await api(`/api/people/${encodeURIComponent(id)}`);
      if(version!==state.authVersion || viewer!==state.user?.id)return;
      state.person=person;renderPerson();if(!dialog.open)dialog.showModal();
    } catch(error){if(version===state.authVersion && viewer===state.user?.id)toast(error.message,true);}
  }
  function renderPerson() {
    const p=state.person, own=p.id===state.user.id;
    const emailLink=`mailto:${encodeURIComponent(p.email)}`;
    dialog.innerHTML=`<div class="dialog-cover"><button class="icon-button dialog-close" data-action="close-person" aria-label="Close profile">${icon('close')}</button>${avatar(p,'large')}<h2 id="person-title">${esc(p.name)}</h2><p>${esc(p.title||'Your colleague')}</p></div><div class="dialog-content"><div class="detail-meta"><span>${icon('grid')}${esc(p.team||'Team not added')}</span><span>${icon('pin')}${esc(p.location||'Location not added')}</span>${p.available?'<span><span class="dot"></span>Open to coffee</span>':''}</div><p class="dialog-bio">${esc(p.bio||'This person is just getting started. A little more about them will be here soon.')}</p><section class="detail-section"><h3>Skills & expertise</h3><div class="tags">${(p.skills||[]).map(s=>`<button class="tag" data-action="dialog-topic" data-topic="${esc(s)}">${esc(s)}</button>`).join('')||'<span class="muted small">No skills added yet</span>'}</div></section><section class="detail-section"><h3>Common ground</h3><div class="tags">${(p.interests||[]).map(s=>`<button class="tag" data-action="dialog-topic" data-topic="${esc(s)}">${esc(s)}</button>`).join('')||'<span class="muted small">No interests added yet</span>'}</div></section><div class="detail-actions">${own?'<button class="primary" data-action="edit-own">'+icon('edit')+'Edit my profile</button>':`<button class="${p.saved?'secondary':'primary'}" data-action="save" data-id="${esc(p.id)}" aria-pressed="${!!p.saved}">${icon('powerbump')}${p.saved?'Undo power bump':'Power bump'}</button>${!p.isDemo&&!state.user.isDemo?`<button class="primary" data-action="open-chat" data-id="${esc(p.id)}">${icon('chat')}Send message</button>`:''}${p.isDemo?'':`<a class="secondary" href="${esc(emailLink)}">${icon('mail')}Say hello by email</a>`}`}</div>${p.isDemo?'<p class="sample-notice">Fictional sample profile for exploring the pilot.</p>':own?'<p class="own-notice">This is how colleagues see your profile.</p>':''}</div>`;
  }
  async function savePerson(id,button) {
    const person=state.people.find(p=>String(p.id)===String(id))||(String(state.person?.id)===String(id)?state.person:null);
    if(!person)return;
    const version=state.authVersion, viewer=state.user.id;
    button.disabled=true;
    try {
      const result=await api(`/api/saved/${encodeURIComponent(id)}`,{method:person.saved?'DELETE':'POST',body:{}});
      if(version!==state.authVersion || viewer!==state.user?.id)return;
      person.saved=result.saved;
      if(String(state.person?.id)===String(id)){state.person.saved=result.saved;if(dialog.open)renderPerson();}
      toast(result.saved?'Colleague added to your network.':'Power bump removed.');
      await loadPeople();
    } catch(error){if(version===state.authVersion && viewer===state.user?.id)toast(error.message,true);} finally {button.disabled=false;}
  }
  function applyTopic(topic) {state.search=topic;state.team='';state.location='';state.available=false;navigate('directory');}
  function resetFilters() {state.search='';state.team='';state.location='';state.available=false;renderApp();}
  function authBusy(busy) {
    state.authBusy=busy;
    for(const button of root.querySelectorAll('#auth-form button,.auth-tab,[data-action="demo-login"]'))button.disabled=busy;
  }
  async function login(email,password,button) {
    if(state.authBusy)return;
    const version=state.authVersion;
    authBusy(true);
    try {
      const data=await api('/api/auth/login',{method:'POST',body:{email,password}});
      if(version!==state.authVersion)return;
      resetChat();state.authVersion++;state.user=data.user;state.csrf=data.csrfToken;state.authMode='login';state.view=currentView();renderApp();
    } catch(error) {
      if(version!==state.authVersion)return;
      const el=document.getElementById('auth-error');if(el){el.textContent=error.message;el.hidden=false;}
    } finally {authBusy(false);}
  }
  async function handleAction(event) {
    const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
    const action=button.dataset.action;
    if(action==='install-help'){window.CommonGroundInstall?.show();return;}
    if(action==='auth-mode'){state.authMode=button.dataset.mode;renderAuth();}
    if(action==='navigate')navigate(button.dataset.view);
    if(action==='open-chat')openChat(button.dataset.id);
    if(action==='create-chat-account')await signOutForChat();
    if(action==='chat-back'){chat.request++;chat.fetching=0;chat.person=null;chat.messages=[];navigate('messages');}
    if(action==='earlier-messages')await refreshChat(true);
    if(action==='earlier-conversations')await loadChatInbox(true);
    if(action==='latest-messages'){const history=document.getElementById('message-history');if(history)history.scrollTop=history.scrollHeight;button.hidden=true;markChatRead();}
    if(action==='topic')applyTopic(button.dataset.topic);
    if(action==='dialog-topic'){dialog.close();applyTopic(button.dataset.topic);}
    if(action==='clear-search'){state.search='';document.getElementById('people-search').value='';button.hidden=true;loadPeople();}
    if(action==='reset-filters')resetFilters();
    if(action==='retry')loadPeople();
    if(action==='person')await showPerson(button.dataset.id);
    if(action==='close-person')dialog.close();
    if(action==='edit-own'){dialog.close();navigate('profile');}
    if(action==='save')await savePerson(button.dataset.id,button);
    if(action==='logout'){
      const viewer=state.user.id,version=++state.authVersion;
      button.disabled=true;
      try {await api('/api/auth/logout',{method:'POST',body:{}});if(version!==state.authVersion||viewer!==state.user?.id)return;state.user=null;state.csrf='';state.authMode='login';state.person=null;state.search='';state.team='';state.location='';state.available=false;state.request++;if(dialog.open)dialog.close();renderAuth();}
      catch(error){toast(error.message,true);button.disabled=false;}
    }
  }
  root.addEventListener('click',handleAction);
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();else handleAction(event);});
  root.addEventListener('input',event=>{
    if(event.target.id==='chat-message' && chat.person){chat.drafts[chat.person.id]=event.target.value;document.getElementById('message-length').textContent=`${event.target.value.length} / 2,000`;}
    if(event.target.id==='people-search'){state.search=event.target.value;const clear=root.querySelector('.clear-search');if(clear)clear.hidden=!state.search;clearTimeout(searchTimer);searchTimer=setTimeout(loadPeople,200);}
  });
  root.addEventListener('change',event=>{
    if(event.target.id==='team-filter'){state.team=event.target.value;loadPeople();}
    if(event.target.id==='location-filter'){state.location=event.target.value;loadPeople();}
    if(event.target.id==='available-filter'){state.available=event.target.checked;loadPeople();}
  });
  root.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target,formData=new FormData(form),button=form.querySelector('[type="submit"]');
    if(form.id==='message-form')return sendChatMessage(form);
    if(form.id==='auth-form'){
      const email=formData.get('email'),password=formData.get('password');
      if(state.authMode==='login')return login(email,password,button);
      if(state.authBusy)return;
      const version=state.authVersion;
      authBusy(true);
      try {const data=await api('/api/auth/register',{method:'POST',body:{name:formData.get('name'),email,password,...(state.config?.registrationCodeRequired?{registrationCode:formData.get('registrationCode')}:{})}});if(version!==state.authVersion)return;resetChat();state.authVersion++;state.user=data.user;state.csrf=data.csrfToken;state.authMode='login';navigate('profile');toast('Welcome! Add your skills and interests to get started.');}
      catch(error){if(version!==state.authVersion)return;const el=document.getElementById('auth-error');if(el){el.textContent=error.message;el.hidden=false;}}
      finally{authBusy(false);}
    }
    if(form.id==='profile-form'){
      const viewer=state.user.id,version=state.authVersion;
      const tags=name=>String(formData.get(name)||'').split(',').map(s=>s.trim()).filter(Boolean);
      const payload={name:formData.get('name'),title:formData.get('title'),team:formData.get('team'),location:formData.get('location'),bio:formData.get('bio'),skills:tags('skills'),interests:tags('interests'),available:formData.has('available'),listed:formData.has('listed')};
      button.disabled=true;
      try{const data=await api('/api/profile',{method:'PUT',body:payload});if(version!==state.authVersion||viewer!==state.user?.id)return;state.user=data.user;renderApp();toast('Your profile is saved.');}
      catch(error){if(version!==state.authVersion||viewer!==state.user?.id)return;const el=document.getElementById('profile-error');if(el){el.textContent=error.message;el.hidden=false;}else toast(error.message,true);}
      finally{button.disabled=false;}
    }
  });
  root.addEventListener('keydown',event=>{if(event.target.id==='chat-message' && event.key==='Enter' && (event.ctrlKey||event.metaKey)){event.preventDefault();event.target.form.requestSubmit();}});
  root.addEventListener('scroll',event=>{if(event.target.id==='message-history' && event.target.scrollHeight-event.target.scrollTop-event.target.clientHeight<90){const link=document.getElementById('new-message-link');if(link)link.hidden=true;markChatRead();}},true);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pollChat();});
  window.addEventListener('hashchange',()=>{if(state.user){state.view=currentView();renderApp();}});
  async function boot() {
    try {
      state.config=await api('/api/config');
      try{const data=await api('/api/auth/me');state.user=data.user;state.csrf=data.csrfToken;state.authMode='login';}catch(error){if(error.status!==401)throw error;}
      state.view=currentView();state.user?renderApp():renderAuth();
    }catch(error){root.innerHTML=`<main class="boot"><div class="brand-mark" aria-hidden="true">cg</div><h1>Let’s reconnect.</h1><p>${esc(error.message)}</p><button class="primary" id="reconnect">Try again</button></main>`;document.getElementById('reconnect').addEventListener('click',boot);}
  }
  boot();
})();
