// The web server end to end: sign-in tokens, frame/CORS headers, and WebSocket sessions that
// survive a dropped connection. Runs a real server on 127.0.0.1 with a random port.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { Auth } = require('../src/main/auth');
const { StreamServer } = require('../src/main/server');

const PASSWORD = 'a good long test password';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-srv-'));
  const webDir = path.join(dir, 'web');
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>t</title>');
  const values = {
    'server.port': 0, 'server.bindAddress': '127.0.0.1', 'server.https': false, 'server.httpsPort': 0,
    'security.embedOrigins': '', 'security.sessionDays': 30, 'security.maxClients': 2, 'security.newClientPolicy': 'replace',
    'security.maxFailedAttempts': 5, 'security.lockoutMinutes': 1, 'security.allowedIps': '',
    appearance: { appName: 'Test PC', welcomeText: '' },
    ...over,
  };
  const config = { get: k => values[k], values };
  const auth = new Auth(dir, k => values[k]);
  auth.setPassword(PASSWORD);
  const server = new StreamServer({ config, auth, webDir, assetsDir: dir, userDir: dir, version: 'test', getWelcome: () => ({ appName: 'Test PC' }) });
  await server.start(null);
  const port = server.servers[0].address().port;
  const events = [];
  for (const ev of ['client-join', 'client-leave', 'client-detach', 'client-resume', 'latency', 'cover']) server.on(ev, (c, info) => events.push([ev, c.id, info]));
  const done = async () => { for (const t of server.timers) clearInterval(t); await server.stop(); };
  return { server, auth, config, port, events, done, base: `http://127.0.0.1:${port}` };
}

function req(base, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    r.on('error', reject);
    r.end(data);
  });
}

const login = async (base, headers = {}) => (await req(base, 'POST', '/api/login', { headers, body: { password: PASSWORD } })).json;

// Opens a socket and collects its JSON messages.
function socket(port, { headers = {}, hello } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const msgs = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const closed = new Promise(r => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); ws.on('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
  const next = (t, ms = 3000) => {
    const found = msgs.find(m => m.t === t);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred: m => m.t === t, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`no "${t}" within ${ms} ms (got ${msgs.map(m => m.t).join(', ') || 'nothing'})`)), ms);
    });
  };
  if (hello) opened.then(() => ws.send(JSON.stringify({ t: 'hello', ...hello }))).catch(() => {});
  return { ws, msgs, next, closed, opened };
}

test('sign-in returns a token that works without cookies', async () => {
  const s = await setup();
  try {
    const j = await login(s.base);
    assert.ok(j.ok && typeof j.token === 'string' && j.token.length > 20);
    assert.strictEqual((await req(s.base, 'GET', '/api/info')).json.signedIn, false);
    assert.strictEqual((await req(s.base, 'GET', '/api/info', { headers: { Authorization: `Bearer ${j.token}` } })).json.signedIn, true);
    assert.strictEqual((await req(s.base, 'GET', '/api/info', { headers: { Authorization: 'Bearer nope' } })).json.signedIn, false);
    // The cookie only counts for our own pages, never for requests started by another site.
    const cookie = `beam_sid=${j.token}`;
    assert.strictEqual((await req(s.base, 'GET', '/api/info', { headers: { Cookie: cookie } })).json.signedIn, true);
    assert.strictEqual((await req(s.base, 'GET', '/api/info', { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).json.signedIn, false);
    // Signing out ends the token.
    await req(s.base, 'POST', '/api/logout', { headers: { Authorization: `Bearer ${j.token}` } });
    assert.strictEqual((await req(s.base, 'GET', '/api/info', { headers: { Authorization: `Bearer ${j.token}` } })).json.signedIn, false);
  } finally { await s.done(); }
});

test('embedding off: frames refused, other sites cannot sign in or connect', async () => {
  const s = await setup();
  try {
    const page = await req(s.base, 'GET', '/');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.strictEqual(page.headers['x-frame-options'], 'DENY');
    const r = await req(s.base, 'POST', '/api/login', { headers: { Origin: 'https://evil.example' }, body: { password: PASSWORD } });
    assert.strictEqual(r.status, 403);
    const sock = socket(s.port, { headers: { Origin: 'https://evil.example' } });
    await assert.rejects(sock.opened, /403/);
  } finally { await s.done(); }
});

test('embedding for listed sites, or any site with *', async () => {
  const s = await setup({ 'security.embedOrigins': 'https://my.site' });
  try {
    const page = await req(s.base, 'GET', '/');
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /frame-ancestors 'self' https:\/\/my\.site http:\/\/localhost:\d+ http:\/\/127\.0\.0\.1:\d+/);
    assert.strictEqual(page.headers['x-frame-options'], undefined);
    // Sandboxed frames have no origin of their own, so the API answers CORS preflights.
    const pre = await req(s.base, 'OPTIONS', '/api/info', { headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers['access-control-allow-origin'], '*');
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
    // A framed page signs in and gets a token even though its cookie may be blocked.
    const j = await login(s.base, { Origin: 'https://my.site' });
    assert.ok(j.ok && j.token);

    s.config.values['security.embedOrigins'] = '*';
    const any = await req(s.base, 'GET', '/');
    assert.doesNotMatch(any.headers['content-security-policy'], /frame-ancestors/);
    assert.strictEqual(any.headers['x-frame-options'], undefined);
    // The test page frames anything but can't itself be framed.
    const t = await req(s.base, 'GET', '/embed-test');
    assert.strictEqual(t.status, 404); // (no test page in this temporary web folder)
  } finally { await s.done(); }
});

test('socket: hello with token gets a session; bad token is refused', async () => {
  const s = await setup({ 'security.embedOrigins': '*' });
  try {
    const { token } = await login(s.base);
    const a = socket(s.port, { headers: { Origin: 'https://other.site' }, hello: { token, latency: 'balanced' } });
    const w = await a.next('welcome');
    assert.ok(w.id && w.resumeKey && w.appName === 'Test PC');
    assert.strictEqual(s.server.clients.get(w.id).latency, 'balanced');
    a.ws.send(JSON.stringify({ t: 'latency', mode: 'smooth' }));
    await wait(100);
    assert.strictEqual(s.server.clients.get(w.id).latency, 'smooth');
    assert.ok(s.events.some(e => e[0] === 'latency'));
    a.ws.send(JSON.stringify({ t: 'cover', mode: 'clock' }));
    a.ws.send(JSON.stringify({ t: 'cover', mode: 42 }));
    await wait(100);
    assert.deepStrictEqual(s.events.filter(e => e[0] === 'cover').map(e => e[2]), ['clock'], 'the PC hears the chosen cover (bad values are dropped)');

    const b = socket(s.port, { headers: { Origin: 'https://other.site' }, hello: { token: 'wrong' } });
    await b.next('auth-failed');
    assert.strictEqual((await b.closed).code, 4401);
    // A cookie from another site doesn't count either.
    const c = socket(s.port, { headers: { Origin: 'https://other.site', Cookie: `beam_sid=${token}` }, hello: {} });
    await c.next('auth-failed');
    a.ws.close(1000);
  } finally { await s.done(); }
});

test('socket: older pages signed in by cookie still work', async () => {
  const s = await setup();
  try {
    const { token } = await login(s.base);
    const a = socket(s.port, { headers: { Cookie: `beam_sid=${token}` } });
    await a.opened;
    a.ws.send(JSON.stringify({ t: 'ping', id: 7, c: 1 }));
    await a.next('welcome');
    const pong = await a.next('pong');
    assert.strictEqual(pong.id, 7);
    a.ws.close(1000);
  } finally { await s.done(); }
});

test('socket: a dropped connection resumes the same session', async () => {
  const s = await setup();
  try {
    const { token } = await login(s.base);
    const a = socket(s.port, { hello: { token } });
    const w = await a.next('welcome');
    a.ws.terminate(); // like a network drop: no goodbye
    await wait(150);
    const c = s.server.clients.get(w.id);
    assert.ok(c && c.detachedAt > 0, 'kept while it may come back');
    assert.ok(s.events.some(e => e[0] === 'client-detach' && e[1] === w.id));

    const b = socket(s.port, { hello: { token, resume: { id: w.id, key: w.resumeKey }, lastDrop: { code: 1006 } } });
    const r = await b.next('resumed');
    assert.strictEqual(r.id, w.id);
    assert.strictEqual(s.server.clients.size, 1);
    assert.ok(!s.events.some(e => e[0] === 'client-leave'), 'the stream was never ended');
    assert.ok(s.events.some(e => e[0] === 'client-resume' && e[1] === w.id));

    // Someone else's session (or a wrong key) can't take it over: it starts fresh instead.
    b.ws.terminate();
    await wait(150);
    const other = await login(s.base);
    const x = socket(s.port, { hello: { token: other.token, resume: { id: w.id, key: w.resumeKey } } });
    const xw = await x.next('welcome');
    assert.notStrictEqual(xw.id, w.id);
    const y = socket(s.port, { hello: { token, resume: { id: w.id, key: 'not-the-key' } } });
    const yw = await y.next('welcome');
    assert.notStrictEqual(yw.id, w.id);
    await wait(50);
    assert.ok(!s.server.clients.has(w.id), 'the dropped session from the same browser was replaced');
    x.ws.close(1000); y.ws.close(1000);
  } finally { await s.done(); }
});

test('socket: closing the page ends the session at once', async () => {
  const s = await setup();
  try {
    const { token } = await login(s.base);
    const a = socket(s.port, { hello: { token } });
    const w = await a.next('welcome');
    a.ws.close(1001); // tab closed
    await wait(150);
    assert.ok(!s.server.clients.has(w.id));
    const leave = s.events.find(e => e[0] === 'client-leave');
    assert.deepStrictEqual([leave[1], leave[2]], [w.id, 'left']);
  } finally { await s.done(); }
});

test('socket: signing out ends that browser\'s streams', async () => {
  const s = await setup();
  try {
    const { token } = await login(s.base);
    const a = socket(s.port, { hello: { token } });
    await a.next('welcome');
    await req(s.base, 'POST', '/api/logout', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual((await a.closed).code, 4000);
    assert.strictEqual(s.server.clients.size, 0);
  } finally { await s.done(); }
});

test('keyframe requests close together share one, but none is lost', async () => {
  const s = await setup();
  try {
    let n = 0;
    s.server.on('keyframe', () => n++);
    s.server.requestKey(); s.server.requestKey(); s.server.requestKey();
    assert.strictEqual(n, 1);
    await wait(320);
    assert.strictEqual(n, 2, 'the request that came too soon is sent once the gap is up');
    await wait(300);
    assert.strictEqual(n, 2);
  } finally { await s.done(); }
});

test('websocket media: stops behind a slow connection, then asks for a keyframe until one gets through', async () => {
  const s = await setup();
  const sent = [];
  const c = {
    id: 'fake', transport: 'websocket', latency: 'lowest', rtt: 50, fps: 60,
    seq: 0, acked: 0, needKey: true, keySeq: 0, keyAskedAt: 0, dropped: 0, sent: 0, bytes: 0,
    ws: { readyState: 1, send: b => { if (Buffer.isBuffer(b)) sent.push({ key: b[1] === 1, seq: b.readUInt32LE(2) }); } },
  };
  try {
    const keys = [];
    s.server.on('keyframe', () => keys.push(Date.now()));
    s.server.clients.set(c.id, c);
    const frame = Buffer.alloc(10);
    const media = key => s.server.media('video', key, Date.now(), frame, 60);
    media(false); // nothing to build on yet: skipped, and a keyframe asked for
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(keys.length, 1);
    media(true);
    assert.deepStrictEqual(sent.map(f => f.key), [true]);
    for (let i = 0; i < 60; i++) media(false); // never acknowledged: sending stops
    const through = sent.length;
    assert.ok(through > 9 && through < 60, `room behind a keyframe, but not unlimited (sent ${through})`);
    assert.strictEqual(c.needKey, true);
    assert.strictEqual(keys.length, 1, 'no keyframe asked for while the line is still full');
    media(true); // a keyframe sent into a full line would only queue: held back too
    assert.strictEqual(sent.length, through);
    c.acked = c.seq; // the backlog clears
    await wait(450);
    media(false); // still skipped, and now a keyframe is asked for again
    assert.strictEqual(sent.length, through);
    assert.strictEqual(keys.length, 2);
    media(true);
    assert.strictEqual(sent.length, through + 1);
    assert.strictEqual(c.needKey, false);
    media(false);
    assert.strictEqual(sent.length, through + 2, 'the picture carries on after the keyframe');
  } finally { s.server.clients.delete(c.id); await s.done(); }
});

test('websocket media: a paused page gets sound but no picture, then restarts from a keyframe', async () => {
  const s = await setup();
  const sent = [];
  const c = {
    id: 'pz', transport: 'websocket', latency: 'balanced', rtt: 40, fps: 60,
    seq: 0, acked: 0, needKey: false, keySeq: 0, keyAskedAt: 0, dropped: 0, sent: 0, bytes: 0,
    ws: { readyState: 1, send: b => { if (Buffer.isBuffer(b)) { sent.push(b[0] === 1 ? (b[1] ? 'K' : 'v') : 'a'); c.acked = c.seq; } } },
  };
  try {
    const pauses = [], keys = [];
    s.server.on('pause', x => pauses.push(x.paused));
    s.server.on('keyframe', () => keys.push(1));
    s.server.clients.set(c.id, c);
    const frame = Buffer.alloc(8);
    s.server.media('video', false, 0, frame, 60);
    s.server.message(c, { t: 'pause', on: true });
    s.server.message(c, { t: 'pause', on: true }); // repeated: no change
    s.server.media('video', false, 0, frame, 60);
    s.server.media('audio', false, 0, frame, 60);
    s.server.message(c, { t: 'pause', on: false });
    assert.strictEqual(c.needKey, true);
    assert.strictEqual(keys.length, 1, 'a keyframe is asked for on resume');
    s.server.media('video', false, 0, frame, 60);
    s.server.media('video', true, 0, frame, 60);
    s.server.media('video', false, 0, frame, 60);
    assert.deepStrictEqual(sent, ['v', 'a', 'K', 'v']);
    assert.deepStrictEqual(pauses, [true, false]);
  } finally { s.server.clients.delete(c.id); await s.done(); }
});

test('connection test download: signed-in only, the size asked for, capped', async () => {
  const s = await setup();
  try {
    assert.strictEqual((await req(s.base, 'GET', '/api/speedtest?n=1000')).status, 401);
    const { token } = await login(s.base);
    const r = await req(s.base, 'GET', '/api/speedtest?n=300000', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(Number(r.headers['content-length']), 300000);
    assert.strictEqual(r.headers['cache-control'], 'no-store, no-transform');
    const big = await req(s.base, 'GET', '/api/speedtest?n=999999999', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(Number(big.headers['content-length']), 32 * 1048576);
  } finally { await s.done(); }
});
