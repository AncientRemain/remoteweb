// Beam Remote browser client: sign-in, the stream (WebRTC or WebSocket + WebCodecs),
// keyboard / mouse / touch control, the toolbar, the stats overlay and the settings drawer.
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r5 = v => Math.round(v * 100000) / 100000;
  const epoch = () => performance.timeOrigin + performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const ICONS = {
    gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    mute: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>',
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    shrink: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    gamepad: '<path d="M6 12h4M8 10v4"/><path d="M15 13h.01M18 11h.01"/><path d="M17.3 6H6.7a4 4 0 0 0-4 3.6l-.9 7.1a2.5 2.5 0 0 0 4.6 1.6L7.5 17h9l1.1 1.3a2.5 2.5 0 0 0 4.6-1.6l-.9-7.1a4 4 0 0 0-4-3.6z"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c5 0 9 4.6 10 7-.5 1.2-1.4 2.6-2.7 3.9M6.5 6.5C4.3 7.9 2.7 10 2 12c1 2.4 5 7 10 7 1.6 0 3.1-.4 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  };
  const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

  // ------------------------------------------------------------ this browser's own settings
  const PREFS_KEY = 'beam.prefs.v1';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { prefs = {}; }
  prefs.client = prefs.client || {};
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };
  const LOCAL_DEFAULTS = { metaAsCtrl: isMac };
  const cfg = k => (k in prefs.client ? prefs.client[k] : (S.client && k in S.client ? S.client[k] : LOCAL_DEFAULTS[k]));
  // Older versions stored a "buffer" choice; it became the latency mode.
  if (prefs.client.buffer && !prefs.client.latency) {
    const was = { low: 'lowest', balanced: 'balanced', smooth: 'smooth' }[prefs.client.buffer];
    if (was) prefs.client.latency = was;
  }
  delete prefs.client.buffer;

  // ------------------------------------------------------------ sign-in token
  // Sent with every request instead of relying on the cookie alone: inside another website's
  // frame, browsers often block cookies, but a token kept by the page itself always works.
  // "Keep me signed in" keeps it in this browser; otherwise only for this tab.
  const TOKEN_KEY = 'beam.token';
  let memToken = '';
  const stores = () => {
    const out = [];
    try { out.push(sessionStorage); } catch { /* blocked, e.g. sandboxed frame */ }
    try { out.push(localStorage); } catch { /* blocked */ }
    return out;
  };
  function getToken() {
    if (memToken) return memToken;
    for (const s of stores()) { try { const t = s.getItem(TOKEN_KEY); if (t) return (memToken = t); } catch { /* blocked */ } }
    return '';
  }
  function setToken(token, remember) {
    memToken = token || '';
    for (const s of stores()) { try { s.removeItem(TOKEN_KEY); } catch { /* blocked */ } }
    if (!token) return;
    try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token); } catch { /* kept in memory only */ }
  }
  const authHeaders = () => { const t = getToken(); return t ? { Authorization: `Bearer ${t}` } : {}; };
  async function fetchInfo() {
    const get = headers => fetch('/api/info', { cache: 'no-store', headers }).then(r => r.json());
    let info = await get(authHeaders());
    // A token from before a password change: fall back to the cookie, if there is one.
    if (info && !info.signedIn && getToken()) { setToken(''); info = await get({}); }
    return info;
  }

  // ------------------------------------------------------------ latency mode
  const LATENCY_MODES = ['lowest', 'balanced', 'smooth'];
  const LATENCY_NAMES = { lowest: 'Lowest latency', balanced: 'Balanced', smooth: 'Smoothest' };
  function latencyMode() { const v = cfg('latency'); return LATENCY_MODES.includes(v) ? v : 'lowest'; }

  // ------------------------------------------------------------ state
  const S = {
    info: null, welcome: null, client: {}, stream: {}, presets: [], schema: {}, displays: [], display: null, control: true,
    ws: null, intentional: false, kicked: false, reconnectTries: 0, reconnectTimer: null, reconnectPending: false,
    resume: null, lastDrop: null, lastMsgAt: 0, updating: false, noScreenAt: 0, captureRetries: 0, retryTimer: null,
    transport: null, pc: null, ctl: null, mv: null, remoteSet: false, pendingCandidates: [], fallbackTimer: null, discTimer: null,
    gotFrame: false, announced: false, rvfcToken: 0,
    decoder: null, wsConfig: null, needKey: true, ctx: null, frameMeta: new Map(), audioDecoder: null, actx: null, gain: null, nextAudio: 0,
    wsFrames: 0, wsBytes: 0, decodeSum: 0, decodeN: 0, latSum: 0, latN: 0, clientDropped: 0,
    rtcLatSum: 0, rtcLatN: 0, prevRtc: null, hostStats: null,
    ping: { id: 0, rtt: null, samples: [], offset: 0, synced: false },
    stats: {}, history: { ping: [], lat: [], fps: [] },
    pressed: new Set(), buttons: new Set(), rel: { x: 0, y: 0 }, wheel: { y: 0, x: 0, pending: false },
    cursor: { x: 0.5, y: 0.5 }, view: { zoom: 1, left: 0, top: 0, W: 0, H: 0 },
    tbHover: false, tbTimer: null, popFor: null, panelTab: 'stream', remoteClipboard: '', composing: false,
  };

  // Opt-in hook for testing tools: localStorage 'beam.debug' = '1' exposes the client state.
  try { if (localStorage.getItem('beam.debug') === '1') window.beamDebug = S; } catch { /* ignore */ }

  // ------------------------------------------------------------ look
  function applyAppearance(a) {
    if (!a) return;
    const st = document.documentElement.style;
    if (a.accent) st.setProperty('--accent', a.accent);
    if (a.accent2) st.setProperty('--accent-2', a.accent2);
    if (a.radius != null) st.setProperty('--radius', `${a.radius}px`);
    if (a.font) st.setProperty('--font', a.font);
    const theme = a.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : (a.theme || 'dark');
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.bg = a.background || 'aurora';
    if (a.appName) { document.title = a.appName; $('#app-name').textContent = a.appName; }
    if (a.welcomeText != null) $('#welcome').textContent = a.welcomeText;
  }

  function toast(text, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('hide'), 3600);
    setTimeout(() => t.remove(), 4000);
  }

  function overlay(title, text = '', spin = true, actions = []) {
    const o = $('#overlay');
    o.classList.remove('gone');
    $('#ov-title').textContent = title;
    $('#ov-text').textContent = text;
    $('#ov-spin').hidden = !spin;
    const box = $('#ov-actions');
    box.innerHTML = '';
    actions.forEach(([label, fn], i) => {
      const b = document.createElement('button');
      b.className = `btn${i === 0 ? ' primary' : ''}`;
      b.textContent = label;
      b.onclick = fn;
      box.appendChild(b);
    });
  }
  const hideOverlay = () => $('#overlay').classList.add('gone');

  // ------------------------------------------------------------ start
  async function boot() {
    let info = null;
    try { info = await fetchInfo(); } catch { /* offline */ }
    if (!info) {
      showLogin();
      $('#login-error').textContent = 'Could not reach your PC. Is the app running?';
      return;
    }
    S.info = info;
    applyAppearance({ ...info.appearance, appName: info.appName, welcomeText: info.welcomeText });
    if (info.signedIn) startSession(); else showLogin();
  }

  function showLogin(msg) {
    teardownMedia();
    $('#stream').hidden = true;
    $('#login').hidden = false;
    document.querySelector('.backdrop').hidden = false;
    const setup = S.info ? S.info.setup : true;
    $('#not-setup').hidden = setup;
    $('#login-fields').hidden = !setup;
    $('#totp-field').hidden = !(S.info && S.info.totp);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    $('#insecure-note').hidden = location.protocol === 'https:' || local;
    $('#login-error').textContent = msg || '';
    if (setup) setTimeout(() => $('#password').focus(), 60);
  }

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true; btn.textContent = 'Connecting…';
    $('#login-error').textContent = '';
    unlockAudio();
    try {
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#password').value, totp: $('#totp').value.replace(/\s/g, ''), remember: $('#remember').checked }),
      });
      const j = await r.json();
      if (j.ok) {
        setToken(j.token, $('#remember').checked);
        $('#password').value = ''; $('#totp').value = '';
        S.resume = null;
        startSession();
      } else {
        if (j.needTotp) { $('#totp-field').hidden = false; setTimeout(() => $('#totp').focus(), 30); }
        $('#login-error').textContent = j.error || (j.needTotp ? 'Enter the 6-digit code from your authenticator app.' : 'Sign-in failed.');
      }
    } catch {
      $('#login-error').textContent = 'Could not reach your PC.';
    } finally {
      btn.disabled = false; btn.textContent = 'Connect';
    }
  });

  function startSession() {
    $('#login').hidden = true;
    $('#stream').hidden = false;
    document.querySelector('.backdrop').hidden = true;
    S.announced = false;
    overlay('Connecting…', 'Reaching your PC');
    openSocket();
  }

  // The page keeps one socket to the PC. If it drops, the page reconnects within a second and
  // asks to resume its session: a WebRTC picture that is still flowing is never interrupted,
  // and a WebSocket stream picks up again at the next keyframe.
  const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  function openSocket() {
    clearTimeout(S.reconnectTimer);
    S.reconnectPending = false;
    if (S.ws) { const old = S.ws; S.ws = null; try { old.close(); } catch { /* ignore */ } }
    S.intentional = false; S.kicked = false;
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch { scheduleReconnect(false); return; }
    ws.binaryType = 'arraybuffer';
    S.ws = ws;
    let opened = false;
    // A tunnel having a bad moment can leave a socket "connecting" for a long time.
    const openTimer = setTimeout(() => { if (S.ws === ws && ws.readyState === 0) socketLost(ws, { code: 4008, reason: 'connect timeout' }, false); }, 8000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      if (S.ws !== ws) return;
      opened = true;
      S.lastMsgAt = performance.now();
      ws.send(JSON.stringify({ t: 'hello', token: getToken() || undefined, resume: S.resume || undefined, latency: latencyMode(), lastDrop: S.lastDrop || undefined }));
    };
    ws.onmessage = e => {
      if (S.ws !== ws) return;
      S.lastMsgAt = performance.now();
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        onMessage(m);
      } else onBinary(e.data);
    };
    ws.onclose = e => { clearTimeout(openTimer); socketLost(ws, e, opened); };
  }

  async function socketLost(ws, e, opened) {
    if (S.ws !== ws) return;
    S.ws = null;
    try { ws.close(); } catch { /* ignore */ }
    S.lastDrop = { code: e.code || 0, reason: String(e.reason || '').slice(0, 60) };
    if (S.intentional || S.kicked) { teardownMedia(); return; }
    // Keep the picture going while the socket comes back: WebRTC has its own path for picture,
    // sound and input, and a WebSocket stream only needs a fresh keyframe afterwards.
    const keep = !!S.resume && S.gotFrame && (S.transport === 'websocket' || (S.pc && S.pc.connectionState === 'connected'));
    if (!keep) teardownMedia();
    if (!opened && e.code !== 4008) {
      const info = await fetchInfo().catch(() => null);
      if (S.ws || S.intentional) return; // reconnected or left meanwhile
      if (info && !info.signedIn) { S.info = info; S.resume = null; teardownMedia(); hideNetNote(); showLogin('Please sign in again.'); return; }
    }
    scheduleReconnect(keep);
  }

  function scheduleReconnect(quiet) {
    clearTimeout(S.reconnectTimer);
    const delay = S.updating ? 3000 : [300, 1000, 2000, 4000, 6000, 10000][Math.min(S.reconnectTries, 5)];
    S.reconnectTries++;
    S.reconnectPending = true;
    if (quiet && S.gotFrame) netNote(S.updating ? 'Your PC is installing an update…' : 'Reconnecting…');
    else showOffline(delay);
    S.reconnectTimer = setTimeout(openSocket, delay);
  }

  function showOffline(delay = 0) {
    hideNetNote();
    if (S.updating) {
      overlay('Your PC is updating', 'It will be back in a moment. This page reconnects by itself.', true, [['Sign out', signOut]]);
      return;
    }
    const when = S.reconnectTries > 3 && delay >= 1000 ? ` Trying again in ${Math.round(delay / 1000)} s.` : '';
    overlay('Reconnecting…', `The connection to your PC dropped.${when}`, true, [['Try now', openSocket], ['Sign out', signOut]]);
  }

  function netNote(text) { const n = $('#netnote'); n.querySelector('span').textContent = text; n.hidden = false; }
  function hideNetNote() { $('#netnote').hidden = true; }

  // No message at all for 12 s (the PC sends one at least every 5 s) means the socket is dead
  // even if the browser hasn't noticed yet: drop it and reconnect.
  setInterval(() => {
    const ws = S.ws;
    if (ws && ws.readyState === 1 && performance.now() - S.lastMsgAt > 12000) socketLost(ws, { code: 4008, reason: 'silent' }, true);
  }, 2000);
  // Phones freeze background pages; when the page is back (or the network is), check at once.
  function wake() {
    if (document.hidden || $('#stream').hidden || S.intentional || S.kicked) return;
    if (!S.ws) { if (S.reconnectPending) openSocket(); return; }
    if (S.ws.readyState === 1 && performance.now() - S.lastMsgAt > 7000) socketLost(S.ws, { code: 4008, reason: 'page woke up' }, true);
  }
  document.addEventListener('visibilitychange', wake);
  addEventListener('online', wake);
  addEventListener('pageshow', e => { if (e.persisted) wake(); });

  function disconnect() {
    S.intentional = true;
    clearTimeout(S.reconnectTimer);
    teardownMedia();
    hideNetNote();
    const ws = S.ws; S.ws = null;
    try { if (ws) ws.close(1000, 'left'); } catch { /* ignore */ }
    S.resume = null;
    overlay('Disconnected', 'You ended the session. Your PC keeps running.', false, [['Reconnect', openSocket], ['Sign out', signOut]]);
  }

  async function signOut() {
    S.intentional = true;
    clearTimeout(S.reconnectTimer);
    hideNetNote();
    const ws = S.ws; S.ws = null;
    try { if (ws) ws.close(1000, 'signed out'); } catch { /* ignore */ }
    try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch { /* ignore */ }
    setToken('');
    S.resume = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    S.info = await fetchInfo().catch(() => S.info);
    showLogin();
  }

  const send = obj => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); };

  // ------------------------------------------------------------ messages from the PC
  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        padsForget(); // a new session on the PC: controllers are announced again
        S.resume = { id: m.id, key: m.resumeKey };
        S.reconnectTries = 0; S.updating = false;
        hideNetNote();
        teardownMedia(); // anything left from a session the PC no longer has
        applyWelcome(m, false);
        startTransport();
        break;
      case 'resumed':
        S.resume = { id: m.id, key: m.resumeKey };
        S.reconnectTries = 0; S.updating = false;
        hideNetNote();
        applyWelcome(m, true);
        if (S.transport === 'websocket' && S.gotFrame) { S.needKey = true; S.frameMeta.clear(); send({ t: 'keyframe' }); } // frame numbers restart
        else if (!(S.transport === 'webrtc' && S.pc && ['new', 'connecting', 'connected'].includes(S.pc.connectionState))) startTransport();
        break;
      case 'auth-failed':
        S.kicked = true; S.resume = null;
        setToken('');
        teardownMedia(); hideNetNote();
        fetchInfo().then(info => { if (info) S.info = info; }).catch(() => {}).finally(() => showLogin(m.message || 'Please sign in again.'));
        break;
      case 'tick': break;
      case 'notice':
        if (m.kind === 'updating') { S.updating = true; if (S.gotFrame) netNote('Your PC is installing an update…'); else showOffline(); }
        else if (m.kind === 'waking') { if (!S.gotFrame) overlay('Waking up your PC\'s screen…', m.message || '', true); }
        else if (m.message) toast(m.message);
        break;
      case 'config': applyWelcome(m, true); break;
      case 'live':
        S.stream = m.stream || S.stream;
        if (m.display) S.display = m.display;
        if (!$('#panel').hidden) renderPanel();
        break;
      case 'signal': onSignal(m.data); break;
      case 'pong': onPong(m); break;
      case 'wsconfig': onWsConfig(m); break;
      case 'audioconfig': onAudioConfig(m); break;
      case 'hoststats': S.hostStats = m.s; break;
      case 'pad': onPadReply(m); break;
      case 'rumble': onRumble(m); break;
      case 'update': onUpdateInfo(m); break;
      case 'controllers':
        S.controllers = { allowed: !!m.allowed, driver: m.driver };
        if (!S.controllers.allowed) for (const index of [...PADS.keys()]) padRemove(index);
        updateTouchPad(); buildToolbar();
        break;
      case 'cover': {
        const before = S.cover && S.cover.mode;
        S.cover = m;
        if (m.notice) toast(m.notice);
        else if (before && before !== m.mode) toast(`The PC's monitor now shows: ${((m.choices || []).find(c => c.id === m.mode) || {}).label || m.mode}`);
        buildToolbar();
        break;
      }
      case 'clipboard': onRemoteClipboard(m.text); break;
      case 'kicked':
        S.kicked = true; teardownMedia();
        overlay('Disconnected', m.message || 'Another device took over.', false, [['Reconnect', openSocket], ['Sign out', signOut]]);
        break;
      case 'busy':
        S.kicked = true;
        overlay('Your PC is busy', m.message || 'Another device is connected.', false, [['Try again', openSocket], ['Sign out', signOut]]);
        break;
      case 'error': onStreamError(m); break;
      case 'restart': if (m.message) toast(m.message); restartTransport(); break;
      default: break;
    }
  }

  function onStreamError(m) {
    if (m.code === 'no-screen') {
      // The PC's display is asleep or off and could not be woken. Try again a few times.
      clearTimeout(S.retryTimer);
      S.noScreenAt = Date.now();
      teardownMedia();
      const again = S.captureRetries++ < 3;
      overlay('No picture from your PC', `${m.message || ''}${again ? ' Trying again in 15 s.' : ''}`, false, [['Try again', () => { S.captureRetries = 0; restartTransport(); }], ['Sign out', signOut]]);
      if (again) S.retryTimer = setTimeout(() => { if (!S.gotFrame) restartTransport(); }, 15000);
      return;
    }
    if (m.code === 'capture') {
      if (Date.now() - S.noScreenAt < 5000) return; // already explained above
      if (!S.gotFrame) {
        teardownMedia();
        overlay('Could not capture the screen', m.message || '', false, [['Try again', restartTransport], ['Sign out', signOut]]);
        return;
      }
    }
    if (m.message) toast(m.message, 'error');
  }

  function applyWelcome(m, update) {
    S.welcome = { ...S.welcome, ...m };
    S.client = m.client || S.client;
    S.stream = m.stream || S.stream;
    S.presets = m.presets || S.presets;
    S.schema = m.schema || S.schema;
    S.displays = m.displays || S.displays;
    S.display = m.display || S.display;
    S.control = m.control !== false;
    if (m.cover) S.cover = m.cover;
    if (m.controllers) S.controllers = m.controllers;
    if (m.update) onUpdateInfo(m.update);
    applyAppearance({ ...m.appearance, appName: m.appName });
    applyClientSettings();
    buildToolbar();
    if (!$('#panel').hidden) renderPanel();
    if (!update && prefs.quality && Object.keys(prefs.quality).length) send({ t: 'quality', changes: prefs.quality });
  }

  // ------------------------------------------------------------ strict networks (school, work)
  // They often block what a direct WebRTC connection needs (UDP). The page notices within a few
  // seconds and remembers it for that network, so the next connection uses the web stream at once.
  const lanHost = h => /^(localhost|127.|[?::1]?$|10.|192.168.|172.(1[6-9]|2d|3[01]).|100.(6[4-9]|[7-9]d|1[01]d|12[0-7]).)/.test(h) || /.(local|ts.net)$/i.test(h);
  const remotePage = () => !lanHost(location.hostname);
  const rtcKey = () => `beam.rtcFail.${(S.welcome && S.welcome.ip) || 'any'}`;
  function rtcFailedRecently() {
    try { const t = Number(localStorage.getItem(rtcKey())); return !!t && Date.now() - t < 12 * 3600e3; } catch { return false; }
  }
  function rememberRtc(failed) {
    if (!remotePage()) return;
    try { if (failed) localStorage.setItem(rtcKey(), String(Date.now())); else localStorage.removeItem(rtcKey()); } catch { /* storage blocked */ }
  }

  // ------------------------------------------------------------ choosing a connection
  const canWs = () => window.isSecureContext && typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
  const canRtc = () => typeof RTCPeerConnection === 'function';
  const wantedTransport = () => prefs.transport || S.stream.transport || 'auto';

  function startTransport() {
    const t = wantedTransport();
    if (t === 'websocket') {
      if (canWs()) return startWsMode();
      toast('WebSocket streaming needs an https:// link (or this PC). Using WebRTC.');
    }
    if (!canRtc()) {
      if (canWs()) return startWsMode();
      return overlay('This browser is not supported', 'Please use a recent Chrome, Edge, Safari or Firefox.', false);
    }
    // Direct connections failed on this network recently: go straight to the web stream.
    if (t === 'auto' && canWs() && remotePage() && rtcFailedRecently()) return startWsMode();
    startWebRTC(t === 'auto' && canWs());
  }
  function restartTransport() {
    teardownMedia();
    if (S.ws && S.ws.readyState === 1) startTransport();
    else if (!S.intentional && !S.kicked) showOffline();
  }

  function teardownMedia() {
    clearTimeout(S.fallbackTimer); clearTimeout(S.discTimer); clearTimeout(S.retryTimer); clearTimeout(S.probeTimer);
    if (S.pc) { try { S.pc.close(); } catch { /* ignore */ } }
    S.pc = null; S.ctl = null; S.mv = null; S.rvfcToken++;
    const v = $('#video');
    if (v.srcObject) { v.srcObject = null; }
    if (S.audioEl) { S.audioEl.srcObject = null; }
    try { if (S.decoder && S.decoder.state !== 'closed') S.decoder.close(); } catch { /* ignore */ }
    try { if (S.audioDecoder && S.audioDecoder.state !== 'closed') S.audioDecoder.close(); } catch { /* ignore */ }
    S.decoder = null; S.audioDecoder = null; S.wsConfig = null;
    S.gotFrame = false; S.frameMeta.clear(); S.prevRtc = null; S.hostStats = null;
    releaseAll();
  }

  function firstFrame() {
    if (S.gotFrame) return;
    S.gotFrame = true;
    S.firstFrameAt = performance.now();
    S.captureRetries = 0;
    if (S.transport === 'webrtc') rememberRtc(false); // direct works on this network
    updateTouchPad();
    clearTimeout(S.fallbackTimer);
    hideOverlay();
    layout();
    if (!S.announced) {
      S.announced = true;
      toast(`Connected · ${S.transport === 'webrtc' ? 'direct (WebRTC)' : 'web stream (WebSocket)'}`);
      if (cfg('toolbar') !== 'hidden') showToolbar(3000);
    }
  }

  // ------------------------------------------------------------ WebRTC
  // Lowest latency: the PC marks each frame "show at once" and the browser adds no buffer of
  // its own. The other modes keep a little (or more) in hand against network hiccups.
  function bufferMs() { return { lowest: 0, balanced: 50, smooth: 160 }[latencyMode()]; }
  function applyBuffer(receiver) {
    try {
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = bufferMs();
      else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = bufferMs() / 1000;
    } catch { /* not supported */ }
  }

  async function startWebRTC(allowFallback) {
    teardownMedia();
    S.transport = 'webrtc'; S.remoteSet = false; S.pendingCandidates = [];
    showMedia('video');
    overlay('Connecting…', 'Opening a direct connection to your PC');
    send({ t: 'start', transport: 'webrtc', latency: latencyMode() });
    const pc = new RTCPeerConnection({ iceServers: (S.welcome && S.welcome.ice) || [], bundlePolicy: 'max-bundle' });
    S.pc = pc;
    const vt = pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    // Ask for the PC's chosen codec first. Automatic: HEVC (this browser only lists it when it
    // can decode it in hardware), then H.264, which every browser plays.
    try {
      const want = { H264: 'video/H264', H265: 'video/H265', VP9: 'video/VP9', AV1: 'video/AV1', VP8: 'video/VP8' };
      const pref = !S.stream.codec || S.stream.codec === 'auto' ? ['H265', 'H264'] : [S.stream.codec, 'H264', 'H265'];
      const order = [...pref, 'VP9', 'VP8', 'AV1'].map(k => want[k]).filter((v, i, a) => v && a.indexOf(v) === i);
      const caps = (RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
      const rank = c => { const i = order.indexOf(c.mimeType); return /rtx|red|fec/i.test(c.mimeType) ? 99 : i < 0 ? 50 : i; };
      if (caps.length && vt.setCodecPreferences) vt.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
    } catch { /* the PC still orders codecs itself */ }
    S.ctl = pc.createDataChannel('ctl', { ordered: true });
    S.mv = pc.createDataChannel('mv', { ordered: false, maxRetransmits: 0 });
    S.ctl.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'pong') onPong(m); } catch { /* ignore */ } };
    pc.ontrack = e => {
      if (S.pc !== pc) return;
      applyBuffer(e.receiver);
      if (e.track.kind === 'video') {
        // Picture and sound play in separate elements, so the picture is never held back for lip-sync.
        const v = $('#video');
        v.srcObject = new MediaStream([e.track]);
        v.muted = true;
        watchFrames();
        v.play().catch(() => {});
      } else {
        if (!S.audioEl) S.audioEl = new Audio();
        S.audioEl.srcObject = new MediaStream([e.track]);
        playSound();
      }
    };
    const kinds = new Set();
    pc.onicecandidate = e => {
      if (e.candidate && e.candidate.type) kinds.add(e.candidate.type);
      send({ t: 'signal', data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
    };
    pc.onconnectionstatechange = () => {
      if (S.pc !== pc) return;
      const st = pc.connectionState;
      clearTimeout(S.discTimer);
      if ((st === 'failed' || st === 'closed') && (!S.ws || S.ws.readyState !== 1)) {
        // The page's own connection is down too: start over once it is back.
        teardownMedia();
        if (!S.intentional && !S.kicked) showOffline();
        return;
      }
      if (st === 'failed') {
        if (allowFallback) { rememberRtc(true); toast('No direct path to your PC; streaming through the web connection instead.'); startWsMode(); }
        else overlay('Could not connect directly', 'Your PC and this device could not find a direct path. Switch "Connection type" to Auto or WebSocket in settings, or add a TURN server on the PC.', false, [['Retry', restartTransport], ['Use WebSocket', () => { prefs.transport = 'websocket'; savePrefs(); restartTransport(); }]]);
      } else if (st === 'disconnected') {
        S.discTimer = setTimeout(() => { if (S.pc === pc && pc.connectionState !== 'connected') restartTransport(); }, 4000);
      }
    };
    if (allowFallback) {
      S.fallbackTimer = setTimeout(() => {
        if (S.pc === pc && !S.gotFrame) { rememberRtc(true); toast('Direct connection is taking too long; switching to the web stream.'); startWsMode(); }
      }, 6000);
      // A public address normally turns up within a fraction of a second. None after 2.5 s on a
      // page opened from outside means the network blocks direct connections: don't wait.
      if (remotePage()) {
        S.probeTimer = setTimeout(() => {
          if (S.pc === pc && !S.gotFrame && pc.connectionState !== 'connected' && !kinds.has('srflx') && !kinds.has('relay')) {
            rememberRtc(true);
            toast('This network blocks direct connections; streaming through the web connection instead.');
            startWsMode();
          }
        }, 2500);
      }
    }
    try {
      await pc.setLocalDescription(await pc.createOffer());
      send({ t: 'signal', data: { sdp: { type: 'offer', sdp: pc.localDescription.sdp } } });
    } catch (e) {
      if (allowFallback) startWsMode(); else overlay('Could not start the stream', e.message, false, [['Retry', restartTransport]]);
    }
  }

  async function onSignal(data) {
    const pc = S.pc;
    if (!pc || !data) return;
    try {
      if (data.sdp && data.sdp.type === 'answer') {
        await pc.setRemoteDescription(data.sdp);
        S.remoteSet = true;
        for (const c of S.pendingCandidates) pc.addIceCandidate(c).catch(() => {});
        S.pendingCandidates = [];
      } else if (data.candidate) {
        if (!S.remoteSet) S.pendingCandidates.push(data.candidate);
        else await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch (e) { console.warn('signal', e); }
  }

  // WebRTC sound. Browsers only allow sound after a click or tap, so if that hasn't
  // happened (e.g. the page reconnected on its own) a "Tap to turn sound on" button appears.
  async function playSound() {
    const a = S.audioEl;
    if (!a || !a.srcObject) return;
    const want = cfg('sound') !== false;
    a.muted = !want;
    if (!want) return;
    try { await a.play(); $('#unmute').hidden = true; } catch { $('#unmute').hidden = false; }
  }

  function watchFrames() {
    const v = $('#video');
    const token = ++S.rvfcToken;
    // Frame callbacks pause in background tabs, so normal playback events count too.
    const ready = () => { if (token === S.rvfcToken && v.videoWidth > 0) firstFrame(); };
    for (const ev of ['loadeddata', 'playing', 'resize']) v.addEventListener(ev, ready, { once: true });
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
    const cb = (now, md) => {
      if (token !== S.rvfcToken) return;
      firstFrame();
      if (md && md.captureTime > 0) {
        const lat = (md.expectedDisplayTime || now) - md.captureTime;
        if (lat > 0 && lat < 5000) { S.rtcLatSum += lat; S.rtcLatN++; }
      }
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  // ------------------------------------------------------------ WebSocket + WebCodecs
  const DECODE = { H264: 'avc1.640034', H265: 'hvc1.1.6.L123.B0', VP9: 'vp09.00.51.08', AV1: 'av01.0.13M.08', VP8: 'vp8' };
  let decodable = null;
  async function decodableCodecs() {
    if (decodable) return decodable;
    const out = [];
    for (const [k, codec] of Object.entries(DECODE)) {
      try { if ((await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true })).supported) out.push(k); } catch { /* no */ }
    }
    decodable = out;
    return out;
  }

  async function startWsMode() {
    teardownMedia();
    S.transport = 'websocket'; S.needKey = true;
    showMedia('canvas');
    overlay('Connecting…', 'Starting the stream');
    const codecs = await decodableCodecs();
    if (!codecs.length) { overlay('This browser cannot decode video', 'Try Chrome or Edge, or switch the connection type to WebRTC.', false); return; }
    ensureAudio();
    send({ t: 'start', transport: 'websocket', codecs, latency: latencyMode() });
  }

  function onWsConfig(m) {
    S.wsConfig = m;
    if (S.transport === 'websocket') setupDecoder();
  }

  function setupDecoder() {
    try { if (S.decoder && S.decoder.state !== 'closed') S.decoder.close(); } catch { /* ignore */ }
    S.decoder = null;
    if (!S.wsConfig) return;
    const dec = new VideoDecoder({
      output: onDecoded,
      error: e => {
        console.warn('decoder', e);
        if (S.decoder !== dec) return;
        S.decoder = null; S.needKey = true;
        send({ t: 'keyframe' });
      },
    });
    dec.configure({ codec: S.wsConfig.codecString, optimizeForLatency: true });
    S.decoder = dec;
    S.needKey = true;
    send({ t: 'keyframe' });
  }

  function onBinary(buf) {
    if (buf.byteLength < 14) return;
    const dv = new DataView(buf);
    const type = dv.getUint8(0), key = (dv.getUint8(1) & 1) === 1, seq = dv.getUint32(2, true), ts = dv.getFloat64(6, true);
    const payload = new Uint8Array(buf, 14);
    if (type === 1) {
      send({ t: 'ack', s: seq });
      S.wsBytes += buf.byteLength;
      if (S.transport !== 'websocket') return;
      if (!S.decoder || S.decoder.state === 'closed') { if (S.wsConfig) setupDecoder(); else return; }
      if (S.needKey && !key) return;
      if (!key && S.decoder.decodeQueueSize > 3) { S.needKey = true; S.clientDropped++; send({ t: 'keyframe' }); return; }
      if (key) S.keyFrames = (S.keyFrames || 0) + 1; // shown in the debug state only
      S.frameMeta.set(seq, { host: ts, recv: performance.now() });
      try {
        S.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data: payload }));
        if (key) S.needKey = false;
      } catch (e) { console.warn('decode', e); S.needKey = true; send({ t: 'keyframe' }); }
    } else if (type === 2) {
      const d = S.audioDecoder;
      if (d && d.state === 'configured' && cfg('sound') !== false && S.actx && S.actx.state === 'running') {
        try { d.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts * 1000), data: payload })); } catch { /* skip */ }
      }
    }
  }

  function onDecoded(frame) {
    const meta = S.frameMeta.get(frame.timestamp);
    S.frameMeta.delete(frame.timestamp);
    if (S.frameMeta.size > 240) S.frameMeta.clear();
    const c = $('#canvas');
    if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
      c.width = frame.displayWidth; c.height = frame.displayHeight; S.ctx = null; layout();
    }
    if (!S.ctx) S.ctx = c.getContext('2d', { alpha: false, desynchronized: true });
    S.ctx.drawImage(frame, 0, 0);
    frame.close();
    S.wsFrames++;
    if (meta) {
      S.decodeSum += performance.now() - meta.recv; S.decodeN++;
      if (S.ping.synced) {
        const lat = epoch() - (meta.host - S.ping.offset);
        if (lat > -50 && lat < 10000) { S.latSum += Math.max(0, lat); S.latN++; }
      }
    }
    firstFrame();
  }

  function unlockAudio() { ensureAudio(); }
  function ensureAudio() {
    if (!S.actx) {
      try {
        S.actx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        S.gain = S.actx.createGain();
        S.gain.connect(S.actx.destination);
      } catch { S.actx = null; }
    }
    if (S.actx && S.actx.state === 'suspended') S.actx.resume().catch(() => {});
  }

  function onAudioConfig(m) {
    if (S.transport !== 'websocket' || typeof AudioDecoder !== 'function') return;
    try { if (S.audioDecoder && S.audioDecoder.state !== 'closed') S.audioDecoder.close(); } catch { /* ignore */ }
    const d = new AudioDecoder({ output: playAudio, error: e => { console.warn('audio', e); S.audioDecoder = null; } });
    try { d.configure({ codec: 'opus', sampleRate: m.sampleRate, numberOfChannels: m.numberOfChannels }); } catch (e) { console.warn(e); return; }
    S.audioDecoder = d;
    ensureAudio();
    setTimeout(() => { if (S.actx && S.actx.state !== 'running' && cfg('sound') !== false) $('#unmute').hidden = false; }, 400);
  }

  function playAudio(data) {
    const ctx = S.actx;
    if (!ctx || ctx.state !== 'running') { data.close(); return; }
    const n = data.numberOfFrames, ch = data.numberOfChannels;
    const buf = ctx.createBuffer(ch, n, data.sampleRate);
    for (let i = 0; i < ch; i++) {
      const tmp = new Float32Array(n);
      try { data.copyTo(tmp, { planeIndex: i, format: 'f32-planar' }); } catch { /* leave silent */ }
      buf.copyToChannel(tmp, i);
    }
    data.close();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(S.gain);
    const now = ctx.currentTime;
    const target = { lowest: 0.03, balanced: 0.07, smooth: 0.16 }[latencyMode()];
    if (S.nextAudio < now + 0.005 || S.nextAudio > now + target + 0.3) S.nextAudio = now + target;
    src.start(S.nextAudio);
    S.nextAudio += buf.duration;
  }

  $('#unmute').addEventListener('click', () => {
    ensureAudio();
    prefs.client.sound = true; savePrefs();
    playSound();
    $('#unmute').hidden = true;
    buildToolbar();
  });

  // ------------------------------------------------------------ ping, latency, stats
  function sendPing() {
    const id = ++S.ping.id, c = epoch();
    if (S.transport === 'webrtc' && S.ctl && S.ctl.readyState === 'open') S.ctl.send(JSON.stringify({ t: 'ping', id, c }));
    else send({ t: 'ping', id, c });
  }

  function onPong(m) {
    const rtt = epoch() - m.c;
    if (!(rtt >= 0 && rtt < 30000)) return;
    const offset = m.h - (m.c + rtt / 2);
    const s = S.ping.samples;
    s.push({ rtt, offset });
    if (s.length > 12) s.shift();
    S.ping.offset = s.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    S.ping.synced = true;
    S.ping.rtt = rtt;
  }

  async function sampleStats() {
    if (!S.transport || (!S.pc && (!S.ws || S.ws.readyState !== 1))) return;
    const st = { transport: S.transport, ping: S.ping.rtt };
    const host = S.hostStats || {};
    if (S.transport === 'webrtc' && S.pc) {
      let rep;
      try { rep = await S.pc.getStats(); } catch { return; }
      const byId = new Map();
      let inV = null, inA = null, tr = null;
      rep.forEach(r => {
        byId.set(r.id, r);
        if (r.type === 'inbound-rtp' && r.kind === 'video') inV = r;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') inA = r;
        if (r.type === 'transport') tr = r;
      });
      let pair = tr && tr.selectedCandidatePairId ? byId.get(tr.selectedCandidatePairId) : null;
      if (!pair) rep.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (inV) {
        const t = performance.now();
        const p = S.prevRtc;
        const cur = {
          t, bytes: inV.bytesReceived + (inA ? inA.bytesReceived : 0), lost: inV.packetsLost || 0, recv: inV.packetsReceived || 0,
          jbd: inV.jitterBufferDelay || 0, jbe: inV.jitterBufferEmittedCount || 0, dec: inV.totalDecodeTime || 0, fd: inV.framesDecoded || 0,
          drop: inV.framesDropped || 0,
        };
        S.prevRtc = cur;
        if (p) {
          const dt = (t - p.t) / 1000;
          st.kbps = ((cur.bytes - p.bytes) * 8) / dt / 1000;
          const lost = cur.lost - p.lost, recv = cur.recv - p.recv;
          st.loss = recv + lost > 0 ? (Math.max(0, lost) / (recv + Math.max(0, lost))) * 100 : 0;
          st.bufferMs = cur.jbe > p.jbe ? ((cur.jbd - p.jbd) / (cur.jbe - p.jbe)) * 1000 : null;
          st.decodeMs = cur.fd > p.fd ? ((cur.dec - p.dec) / (cur.fd - p.fd)) * 1000 : null;
          st.dropped = cur.drop - p.drop;
        }
        st.fps = inV.framesPerSecond || 0;
        st.w = inV.frameWidth; st.h = inV.frameHeight;
        if (!S.gotFrame && inV.framesDecoded > 0 && $('#video').videoWidth > 0) firstFrame();
        st.codec = (byId.get(inV.codecId)?.mimeType || '').replace('video/', '');
        st.decoder = inV.decoderImplementation || '';
        st.jitter = inV.jitter != null ? inV.jitter * 1000 : null;
      }
      if (pair) {
        const lc = byId.get(pair.localCandidateId), rc = byId.get(pair.remoteCandidateId);
        if (lc && rc) st.route = lc.candidateType === 'relay' || rc.candidateType === 'relay' ? 'Relayed (TURN)' : (lc.candidateType === 'host' && rc.candidateType === 'host' ? 'Direct · local network' : 'Direct · internet');
        if (pair.currentRoundTripTime != null && st.ping == null) st.ping = pair.currentRoundTripTime * 1000;
      }
      if (S.rtcLatN) {
        st.latency = S.rtcLatSum / S.rtcLatN; st.latencyEst = false;
      } else if (st.ping != null) {
        st.latency = st.ping / 2 + (st.bufferMs || 0) + (st.decodeMs || 0) + (host.encodeMs || 4) + (st.fps ? 1000 / st.fps : 16) / 2;
        st.latencyEst = true;
      }
      S.rtcLatSum = 0; S.rtcLatN = 0;
    } else if (S.transport === 'websocket') {
      const c = $('#canvas');
      st.fps = S.wsFrames; st.kbps = (S.wsBytes * 8) / 1000;
      st.decodeMs = S.decodeN ? S.decodeSum / S.decodeN : null;
      st.latency = S.latN ? S.latSum / S.latN : null; st.latencyEst = false;
      st.w = c.width; st.h = c.height;
      st.codec = S.wsConfig ? S.wsConfig.codec : '';
      st.decoder = S.wsConfig ? S.wsConfig.codecString : '';
      st.route = S.welcome && S.welcome.secureTunnel ? 'Web connection · tunnel' : 'Web connection';
      st.dropped = S.clientDropped;
      st.loss = null;
      S.wsFrames = 0; S.wsBytes = 0; S.decodeSum = 0; S.decodeN = 0; S.latSum = 0; S.latN = 0; S.clientDropped = 0;
    }
    st.encodeMs = host.encodeMs; st.encoder = host.encoder; st.limit = host.limit; st.hostFps = host.fps;
    st.audio = host.audio; st.audioLevel = host.audioLevel;
    S.stats = st;
    // Skip the first seconds of a connection so start-up spikes don't squash the graph.
    if (S.gotFrame && performance.now() - S.firstFrameAt > 3000) {
      const h = S.history;
      h.ping.push(st.ping ?? null); h.lat.push(st.latency ?? null); h.fps.push(st.fps ?? null);
      for (const k of Object.keys(h)) if (h[k].length > 60) h[k].shift();
    }
    renderHud();
    renderToolbarStats();
    if (S.ping.id % 2 === 0) {
      send({ t: 'stats', s: {
        ping: round1(st.ping), latency: round1(st.latency), latencyEst: !!st.latencyEst, fps: round1(st.fps), kbps: Math.round(st.kbps || 0),
        loss: round1(st.loss), w: st.w, h: st.h, codec: st.codec, route: st.route, transport: st.transport, decodeMs: round1(st.decodeMs), bufferMs: round1(st.bufferMs),
      } });
    }
  }
  const round1 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

  setInterval(sendPing, 1000);
  setInterval(sampleStats, 1000);

  // ------------------------------------------------------------ stats overlay
  const grade = (v, good, ok) => (v == null ? '' : v <= good ? 'good' : v <= ok ? 'warn' : 'bad');
  const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
  const mbps = k => (k == null ? '–' : (k / 1000).toFixed(k >= 10000 ? 0 : 1));

  function renderHud() {
    const hud = $('#stats');
    const mode = cfg('stats');
    if (mode === 'off' || !S.gotFrame) { hud.hidden = true; return; }
    hud.hidden = false;
    hud.className = `hud ${cfg('statsPosition') || 'top-left'} ${mode === 'full' ? 'full' : ''}`;
    const s = S.stats;
    const pingC = grade(s.ping, 40, 100), latC = grade(s.latency, 60, 130);
    const lat = `${s.latencyEst ? '~' : ''}${fmt(s.latency)}`;
    if (mode !== 'full') {
      hud.innerHTML = `<span class="m"><span class="k">ping</span><b class="${pingC}">${fmt(s.ping)}</b><span class="u">ms</span></span>
        <span class="m"><span class="k">latency</span><b class="${latC}">${lat}</b><span class="u">ms</span></span>
        <span class="m"><span class="k">fps</span><b>${fmt(s.fps)}</b></span>
        <span class="m"><span class="k">rate</span><b>${mbps(s.kbps)}</b><span class="u">Mb/s</span></span>`;
      return;
    }
    const row = (k, v, cls = '') => `<div><span>${k}</span><b class="${cls}">${v}</b></div>`;
    hud.innerHTML = `
      <div class="head">
        <div><span>Ping</span><b class="${pingC}">${fmt(s.ping)}<small>ms</small></b></div>
        <div><span>Latency${s.latencyEst ? ' (est.)' : ''}</span><b class="${latC}">${lat}<small>ms</small></b></div>
        <div><span>Frames</span><b>${fmt(s.fps)}<small>fps</small></b></div>
      </div>
      <canvas class="spark" width="560" height="88"></canvas>
      <div class="legend"><span><i class="sw a"></i>ping</span><span><i class="sw b"></i>latency</span><span class="r">60 s</span></div>
      <div class="rows">
        ${row('Bitrate', `${mbps(s.kbps)} Mb/s`)}
        ${row('Resolution', s.w ? `${s.w}×${s.h}` : '–')}
        ${row('Codec', esc(s.codec || '–'))}
        ${row('Packet loss', s.loss == null ? 'n/a' : `${fmt(s.loss, 1)}%`, grade(s.loss, 1, 4))}
        ${row('Jitter buffer', `${fmt(s.bufferMs)} ms`)}
        ${row('Decode', `${fmt(s.decodeMs, 1)} ms`)}
        ${row('Encode (PC)', `${fmt(s.encodeMs, 1)} ms`)}
        ${row('Dropped', String(s.dropped ?? 0))}
        ${row('Sound', s.audio === 'on' ? (cfg('sound') === false ? 'muted here' : `on · ${Math.round(Math.min(1, s.audioLevel || 0) * 100)}%`) : esc(s.audio || '–'))}
        ${row('Path', `${s.transport === 'webrtc' ? 'WebRTC' : 'WebSocket'}${s.route ? `, ${esc(s.route.replace(/^Direct · /, 'direct, ').replace(/^Web connection · /, '').toLowerCase())}` : ''}`)}
      </div>
      ${s.limit && s.limit !== 'none' ? `<div class="foot">Quality limited by ${esc(s.limit)}</div>` : ''}`;
    drawSpark(hud.querySelector('canvas'));
  }

  function drawSpark(cv) {
    if (!cv) return;
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const all = [...S.history.ping, ...S.history.lat].filter(v => v != null);
    const max = Math.max(20, ...all) * 1.2;
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
    for (let i = 0; i <= 2; i++) { const y = Math.round((H - 1) * i / 2) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const css = getComputedStyle(document.documentElement);
    const line = (arr, color) => {
      g.beginPath();
      let started = false;
      arr.forEach((v, i) => {
        if (v == null) return;
        const x = (i / 59) * W, y = H - 3 - (v / max) * (H - 6);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      });
      g.strokeStyle = color; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();
    };
    line(S.history.lat, css.getPropertyValue('--accent-2').trim() || '#e5a50a');
    line(S.history.ping, css.getPropertyValue('--accent').trim() || '#3a7afe');
    g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '19px ui-monospace, Consolas, monospace';
    g.fillText(`${Math.round(max)} ms`, 6, 22);
  }

  function renderToolbarStats() {
    const box = $('#toolbar .tb-stats');
    if (!box) return;
    const s = S.stats;
    box.innerHTML = `<span title="Ping: network round trip"><b class="${grade(s.ping, 40, 100)}">${fmt(s.ping)}</b> ms</span>
      <span title="Latency: from the PC's screen to yours"><b class="${grade(s.latency, 60, 130)}">${s.latencyEst ? '~' : ''}${fmt(s.latency)}</b> ms</span>
      <span class="opt" title="Frames per second"><b>${fmt(s.fps)}</b> fps</span>`;
  }

  // ------------------------------------------------------------ settings applied in the browser
  function applyClientSettings() {
    const stage = $('#stage');
    stage.classList.toggle('no-smooth', cfg('smoothing') === false);
    const tb = $('#toolbar');
    tb.classList.toggle('bottom', cfg('toolbar') === 'bottom');
    const edge = $('#edge');
    edge.classList.toggle('bottom', cfg('toolbar') === 'bottom');
    edge.hidden = cfg('toolbar') === 'hidden' || !isTouch;
    updateCursorStyle();
    layout();
    renderHud();
    if (S.pc) for (const r of S.pc.getReceivers()) applyBuffer(r);
    if (S.audioEl) S.audioEl.muted = cfg('sound') === false;
    if (S.gain) S.gain.gain.value = cfg('sound') === false ? 0 : 1;
    applyPicture();
    updateTouchPad();
  }

  function updateCursorStyle() {
    const stage = $('#stage');
    const dot = $('#cursor');
    const lc = cfg('localCursor');
    const touchpad = isTouch && cfg('touchMode') === 'touchpad';
    stage.classList.toggle('hide-cursor', !isTouch && lc !== 'arrow');
    dot.classList.toggle('arrow', touchpad);
    dot.hidden = !(touchpad || (!isTouch && lc === 'dot'));
  }

  // ------------------------------------------------------------ picture size and zoom
  function mediaEl() { return S.transport === 'websocket' ? $('#canvas') : $('#video'); }
  function showMedia(which) {
    $('#video').hidden = which !== 'video';
    $('#canvas').hidden = which !== 'canvas';
    S.view.zoom = 1;
  }
  function mediaSize() {
    if (S.transport === 'websocket') { const c = $('#canvas'); return [c.width, c.height]; }
    const v = $('#video'); return [v.videoWidth, v.videoHeight];
  }

  function layout() {
    const el = mediaEl();
    const [w, h] = mediaSize();
    if (!w || !h) return;
    const vw = innerWidth, vh = innerHeight;
    const mode = cfg('scaleMode');
    const s = mode === 'fill' ? Math.max(vw / w, vh / h) : mode === 'native' ? 1 / (devicePixelRatio || 1) : Math.min(vw / w, vh / h);
    const V = S.view;
    const W = w * s * V.zoom, H = h * s * V.zoom;
    if (V.zoom === 1 && mode !== 'native') { V.left = (vw - W) / 2; V.top = (vh - H) / 2; } else {
      V.left = W <= vw ? (vw - W) / 2 : clamp(V.left, vw - W, 0);
      V.top = H <= vh ? (vh - H) / 2 : clamp(V.top, vh - H, 0);
    }
    V.W = W; V.H = H;
    el.style.width = `${W}px`;
    el.style.height = `${H}px`;
    el.style.transform = `translate(${V.left}px, ${V.top}px)`;
    if (isTouch && cfg('touchMode') === 'touchpad') placeCursor();
  }
  addEventListener('resize', layout);
  $('#video').addEventListener('resize', layout);
  $('#video').addEventListener('loadedmetadata', layout);

  function norm(cx, cy) {
    const V = S.view;
    if (!V.W) return null;
    return { x: clamp((cx - V.left) / V.W, 0, 1), y: clamp((cy - V.top) / V.H, 0, 1) };
  }
  function placeCursor() {
    const V = S.view;
    const x = V.left + S.cursor.x * V.W, y = V.top + S.cursor.y * V.H;
    $('#cursor').style.transform = `translate(${x}px, ${y}px)`;
  }
  // When zoomed in on a phone, keep the cursor in view.
  function followCursor() {
    const V = S.view;
    if (V.zoom <= 1) return;
    const x = V.left + S.cursor.x * V.W, y = V.top + S.cursor.y * V.H;
    const mx = innerWidth * 0.18, my = innerHeight * 0.18;
    let moved = false;
    if (x < mx) { V.left += mx - x; moved = true; } else if (x > innerWidth - mx) { V.left -= x - (innerWidth - mx); moved = true; }
    if (y < my) { V.top += my - y; moved = true; } else if (y > innerHeight - my) { V.top -= y - (innerHeight - my); moved = true; }
    if (moved) layout();
  }

  // ------------------------------------------------------------ sending input
  function sendInput(ev, fast = false) {
    if (!S.control || !S.gotFrame) return;
    const ch = fast ? S.mv : S.ctl;
    if (S.transport === 'webrtc' && ch && ch.readyState === 'open') ch.send(JSON.stringify(ev));
    else send({ t: 'input', e: ev });
  }
  function releaseAll() {
    if (S.pressed.size || S.buttons.size) {
      for (const c of S.pressed) sendInput(['k', c, 0]);
      for (const b of S.buttons) sendInput(['b', b, 0]);
    }
    S.pressed.clear(); S.buttons.clear();
  }
  const active = () => !$('#stream').hidden && S.gotFrame && $('#overlay').classList.contains('gone');
  const uiTarget = t => t && t.closest && t.closest('#toolbar, #pop, #panel, #overlay, #unmute, #tpad');

  // keyboard
  const mapCode = (code, e) => {
    if (cfg('metaAsCtrl') && (code === 'MetaLeft' || code === 'MetaRight')) return code === 'MetaLeft' ? 'ControlLeft' : 'ControlRight';
    return code;
  };
  addEventListener('keydown', e => {
    if (!active()) return;
    if (e.ctrlKey && e.altKey && e.shiftKey) {
      if (e.code === 'KeyM') { e.preventDefault(); toggleToolbar(); return; }
      if (e.code === 'KeyS') { e.preventDefault(); cycleStats(); return; }
      if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); return; }
    }
    const t = e.target instanceof Element ? e.target : null;
    if (t && t !== document.body && t.id !== 'kbd' && (t.closest('#panel, #pop') || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
    if (t && t.id === 'kbd' && (!e.code || e.key === 'Unidentified' || e.keyCode === 229 || S.composing)) return;
    if (!e.code) return;
    e.preventDefault();
    const code = mapCode(e.code, e);
    const ctrl = e.ctrlKey || (cfg('metaAsCtrl') && e.metaKey);
    if (code === 'KeyV' && ctrl && !e.altKey && !e.repeat && cfg('clipboardSync') !== false && navigator.clipboard && navigator.clipboard.readText) {
      pasteThenSend();
      return;
    }
    S.pressed.add(code);
    sendInput(['k', code, 1]);
  }, true);
  addEventListener('keyup', e => {
    const code = mapCode(e.code, e);
    if (!S.pressed.has(code)) return;
    e.preventDefault();
    S.pressed.delete(code);
    sendInput(['k', code, 0]);
  }, true);
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  async function pasteThenSend() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { send({ t: 'clipboard', text: text.slice(0, 100000) }); await sleep(80); }
    } catch { /* no permission: just send the keys */ }
    sendInput(['k', 'KeyV', 1]);
    sendInput(['k', 'KeyV', 0]);
  }

  // phone / tablet keyboard
  const kbd = $('#kbd');
  const resetKbd = () => { kbd.value = '  '; try { kbd.setSelectionRange(2, 2); } catch { /* ignore */ } };
  resetKbd();
  kbd.addEventListener('compositionstart', () => { S.composing = true; });
  kbd.addEventListener('compositionend', e => { S.composing = false; if (e.data) sendInput(['t', e.data]); resetKbd(); });
  kbd.addEventListener('input', e => {
    if (S.composing || e.isComposing) return;
    const t = e.inputType || '';
    if (t === 'deleteContentBackward') sendInput(['c', ['Backspace']]);
    else if (t === 'deleteContentForward') sendInput(['c', ['Delete']]);
    else if (t === 'insertLineBreak' || t === 'insertParagraph') sendInput(['c', ['Enter']]);
    else if (e.data) sendInput(['t', e.data]);
    else if (t === 'insertFromPaste') { const v = kbd.value.trim(); if (v) sendInput(['t', v]); }
    resetKbd();
  });

  // mouse
  const stage = $('#stage');
  // 'pointerrawupdate' arrives as soon as the mouse moves instead of once per screen refresh,
  // which takes up to a frame off the cursor's delay. Plain mousemove where it isn't offered.
  const rawMoves = 'onpointerrawupdate' in window;
  stage.addEventListener(rawMoves ? 'pointerrawupdate' : 'mousemove', e => {
    if (!active() || (rawMoves && e.pointerType !== 'mouse')) return;
    if (document.pointerLockElement === stage) {
      S.rel.x += e.movementX; S.rel.y += e.movementY;
      const dx = Math.trunc(S.rel.x), dy = Math.trunc(S.rel.y);
      if (dx || dy) { S.rel.x -= dx; S.rel.y -= dy; sendInput(['m', dx, dy], true); }
      return;
    }
    const tbAt = cfg('toolbar');
    if (tbAt === 'top' && e.clientY <= 3) showToolbar();
    if (tbAt === 'bottom' && e.clientY >= innerHeight - 4) showToolbar();
    if (cfg('mouseMode') === 'relative') return;
    if (cfg('scaleMode') === 'native' && (S.view.W > innerWidth || S.view.H > innerHeight)) {
      if (S.view.W > innerWidth) S.view.left = -(e.clientX / innerWidth) * (S.view.W - innerWidth);
      if (S.view.H > innerHeight) S.view.top = -(e.clientY / innerHeight) * (S.view.H - innerHeight);
      layout();
    }
    const p = norm(e.clientX, e.clientY);
    if (!p) return;
    S.cursor = p;
    sendInput(['a', r5(p.x), r5(p.y)], true);
    if (cfg('localCursor') === 'dot') $('#cursor').style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  });
  stage.addEventListener('mousedown', e => {
    if (!active() || (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents)) return;
    closePop();
    e.preventDefault();
    if (cfg('mouseMode') === 'relative' && document.pointerLockElement !== stage) { lockPointer(); return; }
    S.buttons.add(e.button);
    if (document.pointerLockElement === stage) sendInput(['b', e.button, 1]);
    else { const p = norm(e.clientX, e.clientY); if (p) sendInput(['b', e.button, 1, r5(p.x), r5(p.y)]); }
  });
  addEventListener('mouseup', e => {
    if (!S.buttons.has(e.button)) return;
    S.buttons.delete(e.button);
    if (document.pointerLockElement === stage) sendInput(['b', e.button, 0]);
    else { const p = norm(e.clientX, e.clientY); sendInput(p ? ['b', e.button, 0, r5(p.x), r5(p.y)] : ['b', e.button, 0]); }
  });
  stage.addEventListener('contextmenu', e => e.preventDefault());
  stage.addEventListener('auxclick', e => e.preventDefault());
  stage.addEventListener('wheel', e => {
    if (!active()) return;
    e.preventDefault();
    const mult = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const speed = Number(cfg('scrollSpeed')) || 1;
    const inv = cfg('invertScroll') ? -1 : 1;
    S.wheel.y += -e.deltaY * mult * 1.2 * speed * inv;
    S.wheel.x += e.deltaX * mult * 1.2 * speed * inv;
    queueWheel();
  }, { passive: false });
  function queueWheel() {
    if (S.wheel.pending) return;
    S.wheel.pending = true;
    setTimeout(() => { // batches a burst of wheel events (rAF would stall in background tabs)
      S.wheel.pending = false;
      const y = Math.trunc(S.wheel.y), x = Math.trunc(S.wheel.x);
      if (y) { S.wheel.y -= y; sendInput(['w', y]); }
      if (x) { S.wheel.x -= x; sendInput(['h', x]); }
    }, 8);
  }

  function lockPointer() {
    try {
      const p = stage.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { stage.requestPointerLock(); } catch { /* ignore */ } });
    } catch { try { stage.requestPointerLock(); } catch { /* ignore */ } }
  }
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === stage;
    const hint = $('#lock-hint');
    hint.hidden = !locked;
    if (locked) { hint.style.animation = 'none'; void hint.offsetWidth; hint.style.animation = ''; }
    if (!locked) for (const b of [...S.buttons]) { sendInput(['b', b, 0]); S.buttons.delete(b); }
  });

  // touch
  const T = { pts: new Map(), start: 0, moved: false, lastTapEnd: 0, lastTapPos: null, dragging: false, longTimer: null, maxPts: 0,
    pinch: null, mode: null, lastMid: null, scrollY: 0, scrollX: 0, startPos: null, directDown: false };
  const tp = t => ({ x: t.clientX, y: t.clientY });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const click = (btn, x, y) => { sendInput(['b', btn, 1, r5(x), r5(y)]); sendInput(['b', btn, 0, r5(x), r5(y)]); };

  stage.addEventListener('touchstart', e => {
    if (!active()) return;
    e.preventDefault();
    closePop();
    for (const t of e.changedTouches) T.pts.set(t.identifier, tp(t));
    const n = T.pts.size;
    T.maxPts = Math.max(T.maxPts, n);
    if (n === 1) {
      const p = [...T.pts.values()][0];
      T.start = performance.now(); T.moved = false; T.startPos = p; T.mode = null; T.directDown = false;
      const direct = cfg('touchMode') === 'direct';
      if (direct) {
        const q = norm(p.x, p.y);
        if (q) { S.cursor = q; sendInput(['a', r5(q.x), r5(q.y)], true); }
      } else if (T.start - T.lastTapEnd < 320 && T.lastTapPos && dist(p, T.lastTapPos) < 40) {
        T.dragging = true;
        sendInput(['b', 0, 1, r5(S.cursor.x), r5(S.cursor.y)]);
      }
      clearTimeout(T.longTimer);
      T.longTimer = setTimeout(() => {
        if (T.moved || T.pts.size !== 1 || T.dragging || T.directDown) return;
        click(2, S.cursor.x, S.cursor.y);
        T.longFired = true;
        if (navigator.vibrate) navigator.vibrate(15);
      }, 550);
      T.longFired = false;
    } else if (n === 2) {
      clearTimeout(T.longTimer);
      const [a, b] = [...T.pts.values()];
      T.pinch = { d: dist(a, b), zoom: S.view.zoom };
      T.lastMid = mid(a, b);
      T.mode = null; T.scrollY = 0; T.scrollX = 0;
    }
  }, { passive: false });

  stage.addEventListener('touchmove', e => {
    if (!active()) return;
    e.preventDefault();
    const prev = new Map(T.pts);
    for (const t of e.changedTouches) if (T.pts.has(t.identifier)) T.pts.set(t.identifier, tp(t));
    const n = T.pts.size;
    if (n === 1) {
      const [id, p] = [...T.pts.entries()][0];
      const before = prev.get(id) || p;
      if (dist(p, T.startPos) > 8) { T.moved = true; clearTimeout(T.longTimer); }
      if (cfg('touchMode') === 'direct') {
        if (!T.moved) return;
        const q = norm(p.x, p.y);
        if (!q) return;
        if (!T.directDown) { const s0 = norm(T.startPos.x, T.startPos.y); T.directDown = true; sendInput(['b', 0, 1, r5(s0.x), r5(s0.y)]); }
        S.cursor = q;
        sendInput(['a', r5(q.x), r5(q.y)], true);
      } else {
        const V = S.view;
        if (!V.W) return;
        const sens = 1.25 / V.zoom;
        S.cursor.x = clamp(S.cursor.x + ((p.x - before.x) * sens) / (V.W / V.zoom), 0, 1);
        S.cursor.y = clamp(S.cursor.y + ((p.y - before.y) * sens) / (V.H / V.zoom), 0, 1);
        sendInput(['a', r5(S.cursor.x), r5(S.cursor.y)], true);
        followCursor();
        placeCursor();
      }
    } else if (n === 2 && T.pinch) {
      const [a, b] = [...T.pts.values()];
      const m = mid(a, b);
      const d = dist(a, b);
      if (!T.mode) {
        if (Math.abs(d - T.pinch.d) > 28) T.mode = 'pinch';
        else if (dist(m, T.lastMid) > 6) T.mode = 'scroll';
      }
      if (T.mode === 'pinch') {
        const V = S.view;
        const z = clamp(T.pinch.zoom * (d / T.pinch.d), 1, 5);
        const u = (m.x - V.left) / V.W, v = (m.y - V.top) / V.H;
        V.zoom = z;
        const [w, h] = mediaSize();
        const mode = cfg('scaleMode');
        const s = mode === 'fill' ? Math.max(innerWidth / w, innerHeight / h) : mode === 'native' ? 1 / (devicePixelRatio || 1) : Math.min(innerWidth / w, innerHeight / h);
        const W = w * s * z, H = h * s * z;
        V.left = m.x - u * W + (m.x - T.lastMid.x);
        V.top = m.y - v * H + (m.y - T.lastMid.y);
        layout();
        T.moved = true;
      } else if (T.mode === 'scroll') {
        const speed = Number(cfg('scrollSpeed')) || 1;
        const inv = cfg('invertScroll') ? -1 : 1;
        T.scrollY += (m.y - T.lastMid.y) * 3 * speed * inv;
        T.scrollX += -(m.x - T.lastMid.x) * 3 * speed * inv;
        const y = Math.trunc(T.scrollY / 10) * 10, x = Math.trunc(T.scrollX / 10) * 10;
        if (y) { T.scrollY -= y; sendInput(['w', y]); }
        if (x) { T.scrollX -= x; sendInput(['h', x]); }
        T.moved = true;
      }
      T.lastMid = m;
    }
  }, { passive: false });

  const touchEnd = e => {
    if (!active()) { T.pts.clear(); return; }
    e.preventDefault();
    for (const t of e.changedTouches) T.pts.delete(t.identifier);
    if (T.pts.size > 0) return;
    clearTimeout(T.longTimer);
    const dur = performance.now() - T.start;
    const direct = cfg('touchMode') === 'direct';
    if (T.maxPts >= 3 && !T.moved) toggleToolbar();
    else if (T.maxPts === 2 && !T.moved && dur < 350) click(2, S.cursor.x, S.cursor.y);
    else if (T.maxPts === 1) {
      if (T.dragging) { sendInput(['b', 0, 0, r5(S.cursor.x), r5(S.cursor.y)]); T.dragging = false; T.lastTapEnd = 0; }
      else if (T.directDown) { sendInput(['b', 0, 0, r5(S.cursor.x), r5(S.cursor.y)]); T.directDown = false; }
      else if (!T.moved && !T.longFired && dur < 300) {
        click(0, S.cursor.x, S.cursor.y);
        T.lastTapEnd = performance.now();
        T.lastTapPos = T.startPos;
      }
    }
    T.maxPts = 0; T.pinch = null; T.mode = null;
    if (direct && S.view.zoom > 1) layout();
  };
  stage.addEventListener('touchend', touchEnd, { passive: false });
  stage.addEventListener('touchcancel', touchEnd, { passive: false });

  // ------------------------------------------------------------ toolbar
  function buildToolbar() {
    const tb = $('#toolbar');
    const name = (S.welcome && S.welcome.appName) || 'Beam Remote';
    const sound = cfg('sound') !== false;
    const locked = cfg('mouseMode') === 'relative';
    const fs = !!document.fullscreenElement;
    const statsOn = cfg('stats') !== 'off';
    tb.innerHTML = `
      <div class="tb-name"><img src="icon.png" alt=""><span>${esc(name)}</span>${S.control ? '' : '<em class="badge">View only</em>'}</div>
      <div class="tb-sep"></div>
      <div class="tb-stats"></div>
      <div class="tb-sep"></div>
      <button class="tb-btn" data-act="quality" title="Quality">${icon('gauge')}</button>
      ${S.displays.length > 1 ? `<button class="tb-btn" data-act="display" title="Switch screen">${icon('monitor')}</button>` : ''}
      ${isTouch ? `<button class="tb-btn" data-act="keyboard" title="Keyboard">${icon('keyboard')}</button>` : ''}
      <button class="tb-btn" data-act="keys" title="Special keys">${icon('command')}</button>
      ${S.controllers && S.controllers.allowed && (PADS.size || gamepads().length || isTouch) ? `<button class="tb-btn ${[...PADS.values()].some(p => p.player) ? 'on' : ''}" data-act="pads" title="Controllers">${icon('gamepad')}</button>` : ''}
      ${S.cover && S.cover.allow ? `<button class="tb-btn ${S.cover.mode !== 'normal' && !S.cover.peek ? 'on' : ''}" data-act="cover" title="What this PC's monitor shows">${icon('eyeoff')}</button>` : ''}
      <button class="tb-btn" data-act="clipboard" title="Clipboard and typing">${icon('clipboard')}</button>
      ${isTouch ? '' : `<button class="tb-btn ${locked ? 'on' : ''}" data-act="mouse" title="${locked ? 'Mouse locked for games (click to unlock)' : 'Lock mouse for games'}">${icon(locked ? 'lock' : 'mouse')}</button>`}
      <button class="tb-btn ${sound ? '' : 'on'}" data-act="sound" title="${sound ? 'Mute' : 'Unmute'}">${icon(sound ? 'volume' : 'mute')}</button>
      <button class="tb-btn ${statsOn ? 'on' : ''}" data-act="stats" title="Stats overlay (Ctrl+Alt+Shift+S)">${icon('activity')}</button>
      <button class="tb-btn" data-act="fullscreen" title="Full screen (Ctrl+Alt+Shift+F)">${icon(fs ? 'shrink' : 'expand')}</button>
      <button class="tb-btn" data-act="settings" title="Settings">${icon('sliders')}</button>
      <div class="tb-sep"></div>
      <button class="tb-btn danger" data-act="power" title="Disconnect">${icon('power')}</button>`;
    renderToolbarStats();
  }

  $('#toolbar').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    b.blur(); // so Space / Enter keep going to the PC
    if (['quality', 'display', 'keys', 'clipboard', 'power', 'cover', 'pads'].includes(act)) return togglePop(act, b);
    closePop();
    if (act === 'keyboard') { kbd.focus(); resetKbd(); }
    if (act === 'mouse') { setClient('mouseMode', cfg('mouseMode') === 'relative' ? 'absolute' : 'relative'); if (cfg('mouseMode') === 'relative') toast('Click the picture to lock the mouse. Press Esc to release it.'); else if (document.pointerLockElement) document.exitPointerLock(); }
    if (act === 'sound') { setClient('sound', cfg('sound') === false); if (cfg('sound') !== false) { ensureAudio(); playSound(); } }
    if (act === 'stats') cycleStats();
    if (act === 'fullscreen') toggleFullscreen();
    if (act === 'settings') openPanel();
  });
  $('#toolbar').addEventListener('mouseenter', () => { S.tbHover = true; clearTimeout(S.tbTimer); });
  $('#toolbar').addEventListener('mouseleave', () => { S.tbHover = false; showToolbar(1200); });
  $('#edge').addEventListener('click', () => toggleToolbar());
  $('#edge').addEventListener('touchstart', e => { e.preventDefault(); toggleToolbar(); }, { passive: false });

  function showToolbar(ms = 2500) {
    const tb = $('#toolbar');
    tb.classList.add('show');
    clearTimeout(S.tbTimer);
    S.tbTimer = setTimeout(hideToolbar, ms);
  }
  function hideToolbar() {
    if (S.tbHover || S.popFor || !$('#panel').hidden) { S.tbTimer = setTimeout(hideToolbar, 1500); return; }
    $('#toolbar').classList.remove('show');
  }
  function toggleToolbar() {
    const tb = $('#toolbar');
    if (tb.classList.contains('show')) { closePop(); tb.classList.remove('show'); } else showToolbar(isTouch ? 6000 : 3000);
  }
  function cycleStats() {
    const order = ['compact', 'full', 'off'];
    setClient('stats', order[(order.indexOf(cfg('stats')) + 1) % order.length]);
  }

  function setClient(k, v) {
    prefs.client[k] = v;
    savePrefs();
    applyClientSettings();
    buildToolbar();
    if (!$('#panel').hidden) renderPanel();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {});
    } catch {
      toast(/iPhone|iPad/.test(navigator.userAgent) ? 'For full screen on iPhone: Share → Add to Home Screen, then open it from there.' : 'Full screen is not available here.');
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    buildToolbar();
    setTimeout(layout, 50);
  });

  // ------------------------------------------------------------ popovers
  const KEYS = [
    ['Task Manager', ['ControlLeft', 'ShiftLeft', 'Escape'], 'Ctrl+Shift+Esc'],
    ['Windows key', ['MetaLeft'], 'Win'],
    ['Show desktop', ['MetaLeft', 'KeyD'], 'Win+D'],
    ['Switch window', ['AltLeft', 'Tab'], 'Alt+Tab'],
    ['Task view', ['MetaLeft', 'Tab'], 'Win+Tab'],
    ['Close window', ['AltLeft', 'F4'], 'Alt+F4'],
    ['File Explorer', ['MetaLeft', 'KeyE'], 'Win+E'],
    ['Screenshot tool', ['MetaLeft', 'ShiftLeft', 'KeyS'], 'Win+Shift+S'],
    ['Copy', ['ControlLeft', 'KeyC'], 'Ctrl+C'],
    ['Paste', ['ControlLeft', 'KeyV'], 'Ctrl+V'],
    ['Undo', ['ControlLeft', 'KeyZ'], 'Ctrl+Z'],
    ['Select all', ['ControlLeft', 'KeyA'], 'Ctrl+A'],
  ];
  const PAD = [['Esc', 'Escape'], ['Tab', 'Tab'], ['↑', 'ArrowUp'], ['Del', 'Delete'], ['Enter', 'Enter'], ['←', 'ArrowLeft'], ['↓', 'ArrowDown'], ['→', 'ArrowRight']];

  function togglePop(kind, btn) {
    if (S.popFor === kind) return closePop();
    const pop = $('#pop');
    S.popFor = kind;
    let html = '';
    if (kind === 'quality') {
      const cur = S.stream;
      html = '<h4>Quality</h4>' + S.presets.map((p, i) => {
        const on = p.resolution === cur.resolution && p.fps === cur.fps && p.bitrateKbps === cur.bitrateKbps;
        return `<button class="menu-item ${on ? 'active' : ''}" data-preset="${i}"><span>${esc(p.name)}</span><small>${resLabel(p.resolution)} · ${p.fps} fps · ${mbps(p.bitrateKbps)} Mbps</small></button>`;
      }).join('') + `<button class="menu-item" data-open="stream"><span>Custom…</span><small>${resLabel(cur.resolution)} · ${cur.fps} fps · ${mbps(cur.bitrateKbps)} Mbps</small></button>`
        + '<h4>Latency</h4>' + [
        ['lowest', 'Shown on arrival'],
        ['balanced', 'Small buffer'],
        ['smooth', 'For weak networks'],
      ].map(([mode, note]) => `<button class="menu-item ${latencyMode() === mode ? 'active' : ''}" data-latency="${mode}"><span>${LATENCY_NAMES[mode]}</span><small>${note}</small></button>`).join('');
    } else if (kind === 'pads') {
      const list = [...PADS.entries()];
      const state = p => (p.error === 'nodriver' ? 'PC needs the driver' : p.error ? 'Not connected' : p.player ? `Player ${p.player}` : 'Connecting…');
      html = '<h4>Controllers</h4>' + (list.length
        ? list.map(([, p]) => `<div class="menu-item static"><span>${esc(p.name)}</span><small>${state(p)}</small></div>`).join('')
        : '<p class="pop-note">Connect a controller to this device (USB or Bluetooth) and press any button. It works on the PC as an Xbox controller.</p>')
        + (S.controllers && S.controllers.driver === 'missing' ? '<p class="pop-note">Your PC needs its one-time controller driver: on the PC, open the app, then Controllers, Install controller driver.</p>' : '')
        + `<button class="menu-item" data-padopt="vibration"><span>Vibration</span><small>${cfg('controllerVibration') === false ? 'Off' : 'On'}</small></button>`
        + (isTouch ? `<button class="menu-item ${cfg('touchController') === true ? 'active' : ''}" data-padopt="touch"><span>On-screen controller</span><small>${cfg('touchController') === true ? 'Shown' : 'Hidden'}</small></button>` : '');
    } else if (kind === 'cover') {
      const cv = S.cover || { choices: [] };
      html = '<h4>This PC\'s monitor</h4>' + cv.choices.map(c => `<button class="menu-item ${c.id === cv.mode ? 'active' : ''}" data-cover="${esc(c.id)}"><span>${esc(c.label)}</span></button>`).join('')
        + `<p class="pop-note">${cv.peek ? 'Someone at the PC is showing the screen (Ctrl+Alt+Shift+H).' : 'Only the monitor at the PC changes. You still see the real screen.'}</p>`;
    } else if (kind === 'display') {
      html = '<h4>Screen</h4>' + S.displays.map(d => `<button class="menu-item ${String(d.id) === String(S.display) ? 'active' : ''}" data-display="${esc(d.id)}"><span>${esc(d.name)}${d.primary ? ' (main)' : ''}</span><small>${d.width}×${d.height} · ${d.refresh} Hz</small></button>`).join('');
    } else if (kind === 'keys') {
      html = '<h4>Send keys</h4>' + KEYS.map((k, i) => `<button class="menu-item" data-key="${i}"><span>${k[0]}</span><kbd>${k[2]}</kbd></button>`).join('')
        + `<h4>Keys</h4><div class="keypad">${PAD.map((k, i) => `<button class="key" data-pad="${i}">${k[0]}</button>`).join('')}</div>
        <p class="pop-note">Ctrl+Alt+Del can't be sent by any app. Use Task Manager instead.</p>`;
    } else if (kind === 'clipboard') {
      const canRead = !!(navigator.clipboard && navigator.clipboard.readText);
      html = `<h4>Clipboard</h4>
        ${canRead ? '<button class="menu-item" data-clip="send"><span>Send my clipboard to the PC</span></button>' : ''}
        ${S.remoteClipboard ? '<button class="menu-item" data-clip="get"><span>Copy the PC\'s clipboard here</span></button>' : ''}
        <h4>Type on the PC</h4>
        <div class="pop-pad"><textarea id="type-text" placeholder="Text to type on the PC. Works where paste doesn't."></textarea>
        <div class="row end"><button class="btn primary small" data-clip="type">Type it</button></div></div>`;
    } else if (kind === 'power') {
      html = `<h4>${esc((S.welcome && S.welcome.appName) || 'Beam Remote')}</h4>
        <button class="menu-item" data-power="disconnect"><span>Disconnect</span><small>PC keeps running</small></button>
        <button class="menu-item" data-power="signout"><span>Sign out</span><small>Needs the password next time</small></button>`;
    }
    pop.innerHTML = html;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8);
    const top = cfg('toolbar') === 'bottom' ? Math.max(8, r.top - h - 10) : Math.min(innerHeight - h - 8, r.bottom + 10);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    clearTimeout(S.tbTimer);
  }
  function closePop() { $('#pop').hidden = true; S.popFor = null; }
  const resLabel = r => (r === 'native' ? 'Native' : r);

  $('#pop').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.preset != null) {
      const p = S.presets[+d.preset];
      applyQuality({ resolution: p.resolution, fps: p.fps, bitrateKbps: p.bitrateKbps }, true);
      toast(`Quality: ${p.name}`);
      closePop();
    } else if (d.latency) { closePop(); setLatencyMode(d.latency); }
    else if (d.cover) { closePop(); send({ t: 'cover', mode: d.cover }); }
    else if (d.padopt === 'vibration') { closePop(); setClient('controllerVibration', cfg('controllerVibration') === false); toast(`Controller vibration ${cfg('controllerVibration') === false ? 'off' : 'on'}`); }
    else if (d.padopt === 'touch') { closePop(); setClient('touchController', cfg('touchController') !== true); }
    else if (d.open) { closePop(); openPanel(d.open); }
    else if (d.display) { send({ t: 'display', id: d.display }); S.display = d.display; closePop(); toast('Switching screen…'); }
    else if (d.key != null) { sendInput(['c', KEYS[+d.key][1]]); }
    else if (d.pad != null) { sendInput(['c', [PAD[+d.pad][1]]]); }
    else if (d.clip === 'send') {
      try { const text = await navigator.clipboard.readText(); if (text) { send({ t: 'clipboard', text: text.slice(0, 100000) }); toast('Clipboard sent. Press Ctrl+V on the PC to paste.'); } else toast('Your clipboard is empty.'); } catch { toast('The browser did not allow reading the clipboard.', 'error'); }
      closePop();
    } else if (d.clip === 'get') {
      try { await navigator.clipboard.writeText(S.remoteClipboard); toast('Copied.'); } catch { toast('The browser did not allow writing the clipboard.', 'error'); }
      closePop();
    } else if (d.clip === 'type') {
      const t = $('#type-text').value;
      if (t) { sendInput(['t', t]); toast(`Typed ${t.length} characters.`); }
      closePop();
    } else if (d.power === 'disconnect') { closePop(); disconnect(); }
    else if (d.power === 'signout') { closePop(); signOut(); }
  });
  document.addEventListener('mousedown', e => { if (S.popFor && !e.target.closest('#pop, #toolbar')) closePop(); }, true);

  function onRemoteClipboard(text) {
    if (cfg('clipboardSync') === false || typeof text !== 'string') return;
    S.remoteClipboard = text;
    if (navigator.clipboard && navigator.clipboard.writeText && document.hasFocus()) navigator.clipboard.writeText(text).catch(() => {});
  }

  // The PC learns the mode at once (WebSocket queueing follows right away); a WebRTC stream is
  // restarted, since "show each frame at once" is agreed when it starts.
  function setLatencyMode(mode) {
    if (!LATENCY_MODES.includes(mode) || mode === latencyMode()) return;
    prefs.client.latency = mode;
    savePrefs();
    send({ t: 'latency', mode });
    toast(`Latency: ${LATENCY_NAMES[mode]}`);
    if (S.transport === 'webrtc' && S.pc) restartTransport();
    if (!$('#panel').hidden) renderPanel();
  }

  function applyQuality(changes, replace) {
    prefs.quality = replace ? { ...changes } : { ...(prefs.quality || {}), ...changes };
    savePrefs();
    S.stream = { ...S.stream, ...changes };
    send({ t: 'quality', changes, save: !!prefs.saveDefault });
  }

  // ------------------------------------------------------------ settings drawer
  const TABS = [
    ['stream', 'Stream'], ['controls', 'Controls'], ['display', 'Picture'], ['overlay', 'Overlay'], ['about', 'About'],
  ];
  const TAB_KEYS = {
    stream: ['client.latency', 'stream.resolution', 'stream.fps', 'stream.bitrateKbps', 'stream.codec', 'stream.audio', 'stream.contentHint', 'stream.degradation'],
    controls: ['client.mouseMode', 'client.touchMode', 'client.localCursor', 'client.scrollSpeed', 'client.invertScroll', 'client.clipboardSync', 'client.controllerVibration', 'client.touchController'],
    display: ['client.scaleMode', 'client.smoothing', 'client.toolbar', 'client.sound'],
    overlay: ['client.stats', 'client.statsPosition'],
  };

  function openPanel(tab) {
    if (tab) S.panelTab = tab;
    $('#panel').hidden = false;
    renderPanel();
    clearTimeout(S.tbTimer);
  }
  function closePanel() { $('#panel').hidden = true; S.panelSearch = ''; showToolbar(1500); }

  // Bitrate slider is logarithmic: fine steps at the low end, big steps at the top.
  const BMIN = 300, BMAX = 150000;
  const toSlider = k => Math.round((Math.log(k / BMIN) / Math.log(BMAX / BMIN)) * 1000);
  const fromSlider = v => {
    const k = BMIN * (BMAX / BMIN) ** (v / 1000);
    const step = k < 2000 ? 100 : k < 20000 ? 500 : 1000;
    return Math.round(k / step) * step;
  };

  function settingHtml(key) {
    const rule = S.schema[key];
    if (!rule) return '';
    const isStream = key.startsWith('stream.');
    const k = key.split('.')[1];
    const value = isStream ? S.stream[k] : cfg(k);
    const help = rule.help ? `<p class="help">${esc(rule.help)}</p>` : '';
    if (key === 'client.touchMode' && !isTouch) return '';
    if ((key === 'client.mouseMode' || key === 'client.localCursor') && isTouch && !matchMedia('(pointer: fine)').matches) return '';
    if (rule.type === 'bool') {
      return `<div class="setting"><label class="switch"><span>${esc(rule.label)}</span><input type="checkbox" data-key="${key}" ${value ? 'checked' : ''}></label>${help}</div>`;
    }
    if (rule.type === 'enum' || rule.type === 'enumInt') {
      const opts = rule.values.map((v, i) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(rule.labels ? rule.labels[i] : `${v}${key === 'stream.fps' ? ' fps' : ''}`)}</option>`).join('');
      return `<div class="setting"><label class="title">${esc(rule.label)}</label><select data-key="${key}">${opts}</select>${help}</div>`;
    }
    if (key === 'stream.bitrateKbps') {
      return `<div class="setting"><label class="title">${esc(rule.label.replace(' (kbps)', ''))}<output id="br-out">${mbps(value)} Mbps</output></label>
        <input type="range" min="0" max="1000" value="${toSlider(value)}" data-key="${key}" data-log="1">${help}</div>`;
    }
    if (rule.type === 'num' || rule.type === 'int') {
      return `<div class="setting"><label class="title">${esc(rule.label)}<output>${value}</output></label>
        <input type="range" min="${rule.min}" max="${rule.max}" step="${rule.step || 1}" value="${value}" data-key="${key}">${help}</div>`;
    }
    return '';
  }

  function renderPanel() {
    const p = $('#panel');
    const tab = S.panelTab;
    let body = '';
    if (tab === 'stream') {
      const cur = S.stream;
      body += `<div class="setting"><label class="title">Presets</label><div class="chips">${S.presets.map((pr, i) => {
        const on = pr.resolution === cur.resolution && pr.fps === cur.fps && pr.bitrateKbps === cur.bitrateKbps;
        return `<button class="chip-btn ${on ? 'active' : ''}" data-preset="${i}">${esc(pr.name)}</button>`;
      }).join('')}</div></div>`;
      body += TAB_KEYS.stream.map(settingHtml).join('');
      const t = wantedTransport();
      body += `<div class="setting"><label class="title">Connection type (this device)</label><select data-local="transport">
        ${[['auto', 'Auto (best available)'], ['webrtc', 'WebRTC (direct, lowest latency)'], ['websocket', 'WebSocket (works through any tunnel)']].map(([v, l]) => `<option value="${v}" ${v === t ? 'selected' : ''}>${l}</option>`).join('')}
        </select><p class="help">Now: ${S.transport === 'webrtc' ? 'WebRTC' : 'WebSocket'}.${canWs() ? '' : ' WebSocket mode needs an https:// address.'}</p></div>`;
      body += `<div class="setting"><label class="switch"><span>Save changes as the PC's defaults</span><input type="checkbox" data-local="saveDefault" ${prefs.saveDefault ? 'checked' : ''}></label>
        <p class="help">Off: changes last for this session and are remembered on this device only.</p></div>`;
    } else if (tab === 'controls') {
      body += TAB_KEYS.controls.map(settingHtml).join('');
      body += `<div class="setting"><label class="switch"><span>Use ⌘ Command as Ctrl (Mac keyboards)</span><input type="checkbox" data-key="client.metaAsCtrl" ${cfg('metaAsCtrl') ? 'checked' : ''}></label></div>`;
      body += `<div class="setting"><label class="title">Shortcuts</label><div class="kv">
        <span>Ctrl+Alt+Shift+M</span><b>Show the toolbar</b><span>Ctrl+Alt+Shift+S</span><b>Cycle the stats overlay</b>
        <span>Ctrl+Alt+Shift+F</span><b>Full screen</b><span>Esc</span><b>Release a locked mouse</b></div>
        ${isTouch ? `<p class="help">Touchpad: drag to move · tap to click · double-tap and drag to drag · two-finger tap or long press for right-click · two fingers to scroll · pinch to zoom · three-finger tap for the toolbar.</p>` : ''}</div>`;
    } else if (tab === 'display') {
      body += TAB_KEYS.display.map(settingHtml).join('');
      body += `<div class="setting"><label class="title">Adjustments</label><div class="chips">${PIC_PRESETS.map(([name, v]) => `<button class="chip-btn ${picPresetActive(v) ? 'active' : ''}" data-pic-preset="${esc(name)}">${esc(name)}</button>`).join('')}</div>
        <p class="help">Changes only how this device shows the picture. The PC and the stream are not affected.</p></div>`;
      body += PIC_KEYS.map(k => settingHtml(`client.${k}`)).join('');
    } else if (tab === 'overlay') {
      body += TAB_KEYS.overlay.map(settingHtml).join('');
    } else if (tab === 'about') {
      const s = S.stats;
      body += `<div class="setting"><div class="kv">
        <span>PC</span><b>${esc((S.welcome && S.welcome.appName) || '')}</b>
        <span>This device</span><b>${esc((S.welcome && S.welcome.device) || '')}</b>
        <span>Connection</span><b>${S.transport === 'webrtc' ? 'WebRTC' : 'WebSocket'} · ${esc(s.route || '–')}</b>
        <span>Video</span><b>${esc(s.codec || '–')} ${s.w ? `${s.w}×${s.h}` : ''}</b>
        <span>Decoder</span><b>${esc(s.decoder || '–')}</b>
        <span>PC encoder</span><b>${esc(s.encoder || '–')}</b>
        <span>Control</span><b>${S.control ? 'Keyboard and mouse' : 'View only'}</b>
        <span>Version</span><b>${esc((S.welcome && S.welcome.version) || '')}</b></div></div>
        ${updateRowHtml()}
        <div class="setting"><button class="btn" data-local="reset">Reset this device's settings</button>
        <p class="help">Clears quality, controls and overlay choices saved in this browser. The PC's own settings are not changed.</p></div>`;
    }
    const q = S.panelSearch || '';
    p.innerHTML = `<div class="panel-head"><h3>Settings</h3><button class="tb-btn" data-close="1" title="Close">${icon('x')}</button></div>
      <div class="panel-search"><input id="panel-search" type="search" placeholder="Search settings" value="${esc(q)}" spellcheck="false" autocomplete="off" aria-label="Search settings"></div>
      <div class="tabs" ${q ? 'hidden' : ''}>${TABS.map(([id, label]) => `<button class="tab ${id === tab ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>
      <div class="panel-body">${q ? panelSearchBody(q) : body}</div>`;
  }

  // Every setting from every tab whose name or description matches all the words typed.
  const PANEL_SYNONYMS = { lag: ['latency'], delay: ['latency'], gamepad: ['controller'], xbox: ['controller'], vibrate: ['vibration'], rumble: ['vibration'], audio: ['sound'], mute: ['sound'], fps: ['frame rate'], filter: ['brightness', 'contrast', 'saturation', 'hue', 'warmth', 'sharpness'], colour: ['color', 'saturation', 'hue'], color: ['saturation', 'hue'], blurry: ['sharpness', 'quality', 'bitrate'], mouse: ['mouse', 'cursor'], hevc: ['codec'], h264: ['codec'], wifi: ['latency', 'connection'] };
  function panelSearchBody(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const keys = [...TAB_KEYS.stream, ...TAB_KEYS.controls, ...TAB_KEYS.display, ...PIC_KEYS.map(k => `client.${k}`), ...TAB_KEYS.overlay].filter((k, i, a) => a.indexOf(k) === i);
    const matches = keys.filter(k => {
      const r = S.schema[k];
      if (!r) return false;
      const hay = `${r.label} ${r.help || ''} ${(r.labels || []).join(' ')}`.toLowerCase();
      return words.every(w => [w, ...(PANEL_SYNONYMS[w] || [])].some(a => hay.includes(a)));
    });
    let html = matches.map(settingHtml).join('');
    if (words.every(w => 'connection type webrtc websocket direct tunnel'.includes(w))) {
      const t = wantedTransport();
      html += `<div class="setting"><label class="title">Connection type (this device)</label><select data-local="transport">
        ${[['auto', 'Auto (best available)'], ['webrtc', 'WebRTC (direct, lowest latency)'], ['websocket', 'WebSocket (works through any tunnel)']].map(([v, l]) => `<option value="${v}" ${v === t ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>`;
    }
    return html || `<p class="help" style="margin-top:12px">Nothing matches “${esc(q)}”.</p>`;
  }

  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.close) return closePanel();
    if (b.dataset.tab) { S.panelTab = b.dataset.tab; return renderPanel(); }
    if (b.dataset.preset != null) {
      const p = S.presets[+b.dataset.preset];
      applyQuality({ resolution: p.resolution, fps: p.fps, bitrateKbps: p.bitrateKbps }, true);
      return renderPanel();
    }
    if (b.dataset.picPreset) return applyPicPreset(b.dataset.picPreset);
    if (b.dataset.local === 'update-install') {
      if (!confirm('Install the update now? Beam Remote on the PC restarts and this page reconnects by itself in about a minute.')) return;
      send({ t: 'update-install' });
      toast(S.update && S.update.state === 'ready' ? 'Installing the update…' : 'Downloading the update; it installs as soon as it is ready.');
      return;
    }
    if (b.dataset.local === 'reset') {
      prefs = { client: {} }; savePrefs();
      applyClientSettings(); buildToolbar(); renderPanel();
      toast('This device\'s settings were reset.');
    }
  });

  $('#panel').addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'panel-search') {
      S.panelSearch = t.value.trim();
      const tabs = $('#panel .tabs');
      if (tabs) tabs.hidden = !!S.panelSearch;
      const bodyEl = $('#panel .panel-body');
      if (S.panelSearch) bodyEl.innerHTML = panelSearchBody(S.panelSearch);
      else { renderPanel(); const box = $('#panel-search'); if (box) box.focus(); }
      return;
    }
    if (t.dataset.log) { const out = $('#br-out'); if (out) out.textContent = `${mbps(fromSlider(+t.value))} Mbps`; }
    else if (t.type === 'range') { const out = t.closest('.setting').querySelector('output'); if (out) out.textContent = t.value; }
    // Picture sliders preview live while dragging.
    if (t.dataset.key && t.dataset.key.startsWith('client.pic')) applyPicture({ [t.dataset.key.slice(7)]: Number(t.value) });
  });

  $('#panel').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.local === 'transport') { prefs.transport = t.value; savePrefs(); restartTransport(); renderPanel(); return; }
    if (t.dataset.local === 'saveDefault') { prefs.saveDefault = t.checked; savePrefs(); return; }
    const key = t.dataset.key;
    if (!key) return;
    let value;
    if (t.type === 'checkbox') value = t.checked;
    else if (t.dataset.log) value = fromSlider(+t.value);
    else if (t.type === 'range') value = Number(t.value);
    else {
      const rule = S.schema[key];
      value = rule && rule.type === 'enumInt' ? Number(t.value) : t.value;
    }
    const [group, k] = key.split('.');
    if (group === 'stream') { applyQuality({ [k]: value }, false); renderPanel(); }
    else if (k === 'latency') setLatencyMode(value);
    else setClient(k, value);
  });

  // ------------------------------------------------------------ game controllers
  // Controllers connected to this device (USB or Bluetooth; Chromebooks, phones, tablets, PCs)
  // and the on-screen controller become Xbox controllers on the PC. The full state goes out
  // on every change over the fast channel, and again every 250 ms, so a lost message can never
  // leave a button held.
  const XB = { up: 0x0001, down: 0x0002, left: 0x0004, right: 0x0008, start: 0x0010, back: 0x0020, ls: 0x0040, rs: 0x0080, lb: 0x0100, rb: 0x0200, guide: 0x0400, a: 0x1000, b: 0x2000, x: 0x4000, y: 0x8000 };
  // Browser "standard" layout: button number -> Xbox button (by position, so Nintendo and
  // PlayStation controllers work the same way).
  const STD = [['a', 0], ['b', 1], ['x', 2], ['y', 3], ['lb', 4], ['rb', 5], ['back', 8], ['start', 9], ['ls', 10], ['rs', 11], ['up', 12], ['down', 13], ['left', 14], ['right', 15], ['guide', 16]];
  const TOUCH_PAD = 100;
  const NEUTRAL = [0, 0, 0, 0, 0, 0, 0];
  const PADS = new Map(); // index -> { seq, key, sentAt, player, name, error }
  let padTimer = 0, padFast = null, padDriverTold = false;

  const padsAllowed = () => !!(S.controllers && S.controllers.allowed && S.control && S.gotFrame && !document.hidden);
  const gamepads = () => { try { return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(g => g && g.connected); } catch { return []; } };

  function readGamepad(gp) {
    const pressed = i => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
    let w = 0;
    for (const [k, i] of STD) if (pressed(i)) w |= XB[k];
    const trigger = i => Math.round(clamp(gp.buttons[i] ? gp.buttons[i].value : 0, 0, 1) * 255);
    const axis = i => Math.round(clamp(gp.axes[i] || 0, -1, 1) * 32767);
    // Xbox sticks count "up" as positive; browsers count "down" as positive.
    return [w, trigger(6), trigger(7), axis(0), -axis(1), axis(2), -axis(3)];
  }

  function padSend(index, st, force) {
    const p = PADS.get(index);
    if (!p) return;
    const key = st.join(',');
    const now = performance.now();
    if (!force && key === p.key && now - p.sentAt < 250) return;
    p.key = key; p.sentAt = now;
    sendInput(['g', index, ++p.seq, ...st], true);
  }

  function padAdd(index, name) {
    PADS.set(index, { seq: 0, key: '', sentAt: 0, player: 0, name: String(name || 'Controller').replace(/\s*\(.*?Vendor.*?\)\s*/i, ' ').trim().slice(0, 60), error: null });
    sendInput(['gc', index, PADS.get(index).name]);
    buildToolbar();
  }

  function padRemove(index) {
    if (!PADS.delete(index)) return;
    sendInput(['gd', index]);
    buildToolbar();
  }

  function pollPads() {
    const allowed = padsAllowed();
    const seen = new Set();
    for (const gp of gamepads()) {
      seen.add(gp.index);
      if (!allowed) continue;
      if (!PADS.has(gp.index)) padAdd(gp.index, gp.id);
      padSend(gp.index, readGamepad(gp));
    }
    for (const index of [...PADS.keys()]) {
      if (index === TOUCH_PAD) { if (allowed) padSend(index, touchState()); continue; }
      if (!seen.has(index)) padRemove(index);
    }
    // Poll fast (about 250 times a second) only while a controller is around.
    const fast = seen.size > 0 || PADS.size > 0;
    if (fast !== padFast) { padFast = fast; clearInterval(padTimer); padTimer = setInterval(pollPads, fast ? 4 : 500); }
  }
  addEventListener('gamepadconnected', () => { padFast = null; pollPads(); });
  addEventListener('gamepaddisconnected', () => pollPads());
  // Hidden page: the browser stops updating controllers, so let go of everything.
  document.addEventListener('visibilitychange', () => { if (document.hidden) for (const index of PADS.keys()) padSend(index, NEUTRAL, true); });
  pollPads();

  // A new session on the PC (not a resumed one) has none of our controllers yet.
  function padsForget() { PADS.clear(); padDriverTold = false; buildToolbar(); }

  function onPadReply(m) {
    const p = PADS.get(m.i);
    if (!p) return;
    if (m.error) {
      p.error = m.error;
      if (m.error === 'nodriver' && !padDriverTold) {
        padDriverTold = true;
        toast('Controllers need a one-time driver on your PC. On the PC, open the app: Controllers, Install controller driver.', 'error');
      } else if (m.error === 'full') toast('Up to 4 controllers can be used at once.');
      buildToolbar();
      return;
    }
    const first = !p.player;
    p.player = m.player || p.player || 1;
    p.error = null;
    if (first) toast(m.i === TOUCH_PAD ? `On-screen controller ready · Player ${p.player}` : `Controller connected · Player ${p.player}`);
    buildToolbar();
  }

  // Vibration from the game, played on the controller in your hand.
  const rumbleTimers = new Map();
  function onRumble(m) {
    clearInterval(rumbleTimers.get(m.i));
    rumbleTimers.delete(m.i);
    if (cfg('controllerVibration') === false) return;
    if (m.i === TOUCH_PAD) { if ((m.l || m.s) && navigator.vibrate) navigator.vibrate(Math.min(400, 60 + Math.max(m.l, m.s))); return; }
    const gp = gamepads().find(g => g.index === m.i);
    const act = gp && gp.vibrationActuator;
    if (!act) return;
    if (!m.l && !m.s) { try { act.reset ? act.reset() : act.playEffect('dual-rumble', { duration: 0, weakMagnitude: 0, strongMagnitude: 0 }); } catch { /* ignore */ } return; }
    const play = () => { try { act.playEffect('dual-rumble', { startDelay: 0, duration: 1000, weakMagnitude: m.s / 255, strongMagnitude: m.l / 255 }).catch(() => {}); } catch { /* ignore */ } };
    play();
    rumbleTimers.set(m.i, setInterval(play, 900)); // games set vibration until they change it
  }

  // ------------------------------------------------------------ on-screen controller
  const tpad = $('#tpad');
  const TP = { buttons: 0, lt: 0, rt: 0, l: [0, 0], r: [0, 0], ptr: new Map() };
  const touchState = () => [TP.buttons, TP.lt, TP.rt, Math.round(TP.l[0] * 32767), Math.round(-TP.l[1] * 32767), Math.round(TP.r[0] * 32767), Math.round(-TP.r[1] * 32767)];
  const touchPush = () => { if (PADS.has(TOUCH_PAD)) padSend(TOUCH_PAD, touchState(), true); };

  function updateTouchPad() {
    const want = isTouch && cfg('touchController') === true && padsAllowed();
    tpad.hidden = !want;
    if (want && !PADS.has(TOUCH_PAD)) { padAdd(TOUCH_PAD, 'On-screen controller'); padFast = null; pollPads(); }
    if (!want && PADS.has(TOUCH_PAD)) { padSend(TOUCH_PAD, NEUTRAL, true); padRemove(TOUCH_PAD); }
  }

  function stickMove(p, e) {
    let dx = (e.clientX - p.cx) / p.rad, dy = (e.clientY - p.cy) / p.rad;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    if (len > 0.15) p.moved = true;
    TP[p.stick] = [dx, dy];
    p.knob.style.transform = `translate(${dx * p.rad * 0.6}px, ${dy * p.rad * 0.6}px)`;
  }

  tpad.addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-b], [data-t], [data-stick]');
    if (!el) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    el.classList.add('on');
    if (el.dataset.stick) {
      const r = el.getBoundingClientRect();
      const p = { stick: el.dataset.stick, cx: r.left + r.width / 2, cy: r.top + r.height / 2, rad: r.width / 2, knob: el.firstElementChild, el, at: performance.now(), moved: false };
      TP.ptr.set(e.pointerId, p);
      stickMove(p, e);
    } else if (el.dataset.t) {
      TP[el.dataset.t] = 255;
      TP.ptr.set(e.pointerId, { trig: el.dataset.t, el });
    } else {
      TP.buttons |= XB[el.dataset.b];
      TP.ptr.set(e.pointerId, { btn: el.dataset.b, el });
    }
    touchPush();
  });
  tpad.addEventListener('pointermove', e => {
    const p = TP.ptr.get(e.pointerId);
    if (!p || !p.stick) return;
    e.preventDefault();
    stickMove(p, e);
    touchPush();
  });
  const touchEndPad = e => {
    const p = TP.ptr.get(e.pointerId);
    if (!p) return;
    TP.ptr.delete(e.pointerId);
    p.el.classList.remove('on');
    if (p.stick) {
      TP[p.stick] = [0, 0];
      p.knob.style.transform = '';
      // A quick tap on a stick clicks it (L3 / R3).
      if (!p.moved && performance.now() - p.at < 250) {
        const bit = p.stick === 'l' ? XB.ls : XB.rs;
        TP.buttons |= bit; touchPush();
        setTimeout(() => { TP.buttons &= ~bit; touchPush(); }, 90);
      }
    } else if (p.trig) TP[p.trig] = 0;
    else TP.buttons &= ~XB[p.btn];
    touchPush();
  };
  tpad.addEventListener('pointerup', touchEndPad);
  tpad.addEventListener('pointercancel', touchEndPad);
  tpad.addEventListener('contextmenu', e => e.preventDefault());

  // ------------------------------------------------------------ picture adjustments
  // Done by this browser on the picture it shows: costs the PC nothing and doesn't change
  // the stream. Sharpness uses a small sharpening filter; the rest are standard CSS filters.
  const PIC_KEYS = ['picBrightness', 'picContrast', 'picSaturation', 'picHue', 'picWarmth', 'picSharpen'];
  const PIC_NORMAL = { picBrightness: 100, picContrast: 100, picSaturation: 100, picHue: 0, picWarmth: 0, picSharpen: 0 };
  const PIC_PRESETS = [
    ['Normal', {}],
    ['Vivid', { picContrast: 110, picSaturation: 140 }],
    ['Cinema', { picBrightness: 95, picContrast: 115, picSaturation: 90, picWarmth: 10 }],
    ['Night', { picBrightness: 85, picContrast: 95, picWarmth: 40 }],
    ['High contrast', { picContrast: 140, picSaturation: 110 }],
    ['Crisp text', { picContrast: 105, picSharpen: 50 }],
    ['Grayscale', { picSaturation: 0 }],
  ];
  function picValue(k, over) {
    const v = Number(over && k in over ? over[k] : cfg(k));
    return Number.isFinite(v) ? v : PIC_NORMAL[k];
  }
  function applyPicture(over) {
    const v = k => picValue(k, over);
    const parts = [];
    const sharp = clamp(v('picSharpen'), 0, 100);
    if (sharp > 0) {
      const k = (sharp / 100) * 0.9;
      $('#beam-sharpen-k').setAttribute('kernelMatrix', `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`);
      parts.push('url(#beam-sharpen)');
    }
    if (v('picBrightness') !== 100) parts.push(`brightness(${v('picBrightness') / 100})`);
    if (v('picContrast') !== 100) parts.push(`contrast(${v('picContrast') / 100})`);
    if (v('picSaturation') !== 100) parts.push(`saturate(${v('picSaturation') / 100})`);
    if (v('picHue')) parts.push(`hue-rotate(${v('picHue')}deg)`);
    if (v('picWarmth')) parts.push(`sepia(${v('picWarmth') / 100})`);
    $('#stage').style.setProperty('--pic', parts.length ? parts.join(' ') : 'none');
  }
  function picPresetActive(values) {
    const want = { ...PIC_NORMAL, ...values };
    return PIC_KEYS.every(k => picValue(k) === want[k]);
  }
  function applyPicPreset(name) {
    const preset = PIC_PRESETS.find(p => p[0] === name);
    if (!preset) return;
    for (const [k, v] of Object.entries({ ...PIC_NORMAL, ...preset[1] })) prefs.client[k] = v;
    savePrefs();
    applyClientSettings();
    if (!$('#panel').hidden) renderPanel();
  }

  // ------------------------------------------------------------ updates on the PC
  // The person connected hears about a new version of Beam Remote on the PC (once per
  // version) and can install it from Settings, About.
  function onUpdateInfo(m) {
    S.update = m;
    const fresh = m && m.latest && ['available', 'downloading', 'ready'].includes(m.state);
    if (fresh && S.updateToasted !== m.latest) {
      S.updateToasted = m.latest;
      toast(`Beam Remote ${m.latest} is ${m.state === 'ready' ? 'ready to install' : 'available'} for this PC. Settings, About to install it now.`);
    }
    if (!$('#panel').hidden && S.panelTab === 'about') renderPanel();
  }

  function updateRowHtml() {
    const u = S.update;
    if (!u || !u.latest || !['available', 'downloading', 'ready', 'installing'].includes(u.state)) return '';
    const what = u.state === 'installing' ? 'Installing now…' : u.state === 'downloading' ? `Downloading (${u.progress || 0}%)` : u.state === 'ready' ? 'Downloaded, ready to install' : 'Available';
    const auto = u.mode === 'auto' ? ' It also installs by itself once nobody is connected.' : '';
    return `<div class="setting"><label class="title">Update for this PC: version ${esc(u.latest)}</label>
      <p class="help">${what}.${auto}</p>
      ${u.state === 'installing' ? '' : '<button class="btn" data-local="update-install">Install now</button>'}</div>`;
  }

  // ------------------------------------------------------------ go
  boot();
})();
