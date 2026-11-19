// The web side of the app: serves the browser client, handles sign-in, and keeps one
// WebSocket per connected device. The WebSocket carries WebRTC signalling, pings,
// fallback input, settings changes and (in WebSocket mode) the video and sound itself.
//
// Connections are built to survive bad networks:
//  - every page says "hello" first (with its sign-in token when cookies can't be used,
//    e.g. inside another website's frame), and can ask to resume its previous session;
//  - a dropped socket keeps its session for GRACE_MS, so a page that reconnects picks up
//    where it left off instead of restarting the stream (WebRTC video keeps flowing meanwhile);
//  - heartbeats find dead connections in seconds instead of minutes.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const EventEmitter = require('events');
const { WebSocketServer } = require('ws');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
const CSP_BASE = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:", "connect-src 'self' ws: wss:", "worker-src 'self' blob:",
  "base-uri 'none'", "form-action 'self'",
].join('; ');
const COOKIE = 'beam_sid';
const HEADER = 14;          // binary frame header: type u8, flags u8, seq u32, capture time f64
const GRACE_MS = 25000;     // a dropped session waits this long for its page to come back
const HELLO_MS = 4000;      // time a new socket gets to say hello
const HEARTBEAT_MS = 6000;  // ping each socket; no pong by the next beat = dead
const TICK_MS = 5000;       // small message so pages can tell a silent socket from a dead one
const MAX_PENDING = 40;
const LATENCY = ['lowest', 'balanced', 'smooth'];

// "https://a.com, b.org/x" -> ['https://a.com', 'https://b.org'], or ['*'] for any site.
// Only sites listed here may show this page inside a frame (stops clickjacking).
function parseEmbedOrigins(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,]+/)) {
    if (!raw) continue;
    if (raw === '*') return ['*'];
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (/^https?:$/.test(u.protocol) && /^[a-z0-9.*-]+(:\d+)?$/i.test(u.host)) out.push(`${u.protocol}//${u.host}`);
    } catch { /* skip junk */ }
  }
  return [...new Set(out)];
}

function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

// The real address of the person connecting. Tunnels run on this PC, so their requests
// come from loopback with the visitor's address in a header; only then is it trusted.
function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  if (isLoopback(raw)) {
    const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return { ip: fwd, tunnel: true };
  }
  return { ip: raw.replace(/^::ffff:/, ''), tunnel: false };
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

class StreamServer extends EventEmitter {
  constructor({ config, auth, webDir, assetsDir, userDir, version, getWelcome }) {
    super();
    this.config = config;
    this.auth = auth;
    this.webDir = webDir;
    this.assetsDir = assetsDir;
    this.userDir = userDir;
    this.version = version;
    this.getWelcome = getWelcome;
    this.clients = new Map();
    this.pending = new Set();
    this.servers = [];
    this.recentFails = [];
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20, perMessageDeflate: false });
    this.lastKeyRequest = 0;
    this.status = { http: null, https: null, error: null };
    this.timers = [setInterval(() => this.beat(), HEARTBEAT_MS), setInterval(() => this.tick(), TICK_MS)];
  }

  async start(httpsCreds) {
    await this.stop();
    const port = this.config.get('server.port');
    const bind = this.config.get('server.bindAddress');
    this.status = { http: null, https: null, error: null };
    const handler = (req, res) => this.handle(req, res).catch(e => { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end(); } });
    const listenOn = (srv, p, host) => new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(p, host, () => { srv.removeListener('error', reject); resolve(); });
    });
    // "Everyone" listens on IPv6 and IPv4 together; falls back to IPv4 only where IPv6 is off.
    const listen = async (srv, p) => {
      if (bind !== '0.0.0.0') return listenOn(srv, p, bind);
      try { await listenOn(srv, p, '::'); } catch (e) {
        if (e.code === 'EADDRINUSE') throw e;
        await listenOn(srv, p, '0.0.0.0');
      }
    };
    const plain = http.createServer(handler);
    plain.on('upgrade', (req, sock, head) => this.upgrade(req, sock, head, false));
    try { await listen(plain, port); this.servers.push(plain); this.status.http = port; } catch (e) {
      this.status.error = e.code === 'EADDRINUSE' ? `Port ${port} is already in use by another program. Change the port in Settings > App.` : e.message;
    }
    if (httpsCreds && this.config.get('server.https')) {
      const secure = https.createServer(httpsCreds, handler);
      secure.on('upgrade', (req, sock, head) => this.upgrade(req, sock, head, true));
      try { await listen(secure, this.config.get('server.httpsPort')); this.servers.push(secure); this.status.https = this.config.get('server.httpsPort'); } catch (e) {
        this.status.error = (this.status.error ? this.status.error + ' ' : '') + `HTTPS: ${e.message}`;
      }
    }
    return this.status;
  }

  async stop() {
    for (const c of this.clients.values()) { if (c.ws) { try { c.ws.close(4001, 'Server restarting'); } catch { /* ignore */ } } }
    for (const ws of this.pending) { try { ws.terminate(); } catch { /* ignore */ } }
    this.pending.clear();
    await Promise.all(this.servers.map(s => new Promise(r => { s.close(() => r()); s.closeAllConnections?.(); })));
    this.servers = [];
  }

  embedOrigins() { return parseEmbedOrigins(this.config.get('security.embedOrigins')); }

  // Pages on this PC itself (used by the embedding test page).
  ownOrigins() {
    const p = this.config.get('server.port');
    return [`http://localhost:${p}`, `http://127.0.0.1:${p}`];
  }

  // Cookie flags: inside another site's frame the browser only sends cookies marked
  // SameSite=None (https only); "Partitioned" keeps them working where third-party cookies are
  // blocked. Pages that can't use cookies at all sign in with their token instead.
  cookieFlags(secure) {
    if (secure && this.embedOrigins().length) return 'HttpOnly; SameSite=None; Secure; Partitioned';
    return `HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  headers(res, extra = {}, csp = null) {
    const embed = this.embedOrigins();
    // "*" = no frame restriction at all (also allows file:// and sandboxed pages).
    const frames = embed[0] === '*' ? '' : embed.length ? `; frame-ancestors 'self' ${[...embed, ...this.ownOrigins()].join(' ')}` : "; frame-ancestors 'none'";
    res.setHeader('Content-Security-Policy', csp || `${CSP_BASE}${frames}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!embed.length && !csp) res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }

  // When embedding is on, sandboxed frames (opaque origin) can still reach the API.
  // Safe because the API trusts only explicit tokens from such pages, never cookies.
  cors(res) {
    if (!this.embedOrigins().length) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  json(res, code, obj, extra = {}) {
    this.headers(res, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
    res.writeHead(code);
    res.end(JSON.stringify(obj));
  }

  // Who is asking: a Bearer token (embedded pages) or, for our own pages only, the cookie.
  authOf(req) {
    const h = String(req.headers.authorization || '');
    if (h.startsWith('Bearer ')) {
      const token = h.slice(7).trim();
      return { token, session: this.auth.sessionFor(token) };
    }
    if (!this.sameOrigin(req)) return { token: null, session: null };
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return { token, session: this.auth.sessionFor(token) };
  }

  info() {
    const a = this.config.get('appearance');
    return {
      appName: a.appName, welcomeText: a.welcomeText, appearance: a, version: this.version,
      setup: this.auth.passwordSet, totp: this.auth.totpEnabled,
    };
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const { ip, tunnel } = clientIp(req);
    const secure = !!req.socket.encrypted || (tunnel && /https/i.test(String(req.headers['x-forwarded-proto'] || req.headers['cf-visitor'] || '')));

    if (p.startsWith('/api/')) {
      this.cors(res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    if (p === '/api/info' && req.method === 'GET') {
      return this.json(res, 200, { ...this.info(), signedIn: !!this.authOf(req).session });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (!this.sameOrigin(req) && !this.embedOrigins().length) return this.json(res, 403, { ok: false, error: 'Blocked: request came from another website.' });
      let body;
      try { body = await readBody(req); } catch { return this.json(res, 413, { ok: false }); }
      const result = this.auth.login(ip, body, { device: deviceName(req.headers['user-agent']) });
      if (!result.ok) {
        const now = Date.now();
        if (!result.needTotp || body.totp) {
          this.recentFails = this.recentFails.filter(t => now - t < 600000);
          this.recentFails.push(now);
          // Many failures from all over = someone guessing from many addresses: slow everyone down.
          const wait = this.recentFails.length > 40 ? 2500 : 400 + Math.random() * 300;
          await new Promise(r => setTimeout(r, wait));
        }
        return this.json(res, 200, { ok: false, error: result.error, needTotp: !!result.needTotp, lockedSeconds: result.lockedSeconds || 0 });
      }
      const days = this.config.get('security.sessionDays');
      const cookie = [`${COOKIE}=${result.token}`, 'Path=/', this.cookieFlags(secure)];
      if (body.remember) cookie.push(`Max-Age=${days * 86400}`);
      this.emit('signin', { ip, tunnel, device: result.session.device });
      return this.json(res, 200, { ok: true, token: result.token }, { 'Set-Cookie': cookie.join('; ') });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const { token, session } = this.authOf(req);
      if (token) this.auth.logout(token);
      if (session) for (const c of [...this.clients.values()]) if (c.sessionId === session.id) this.finish(c, 'signed out');
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; ${this.cookieFlags(secure)}; Max-Age=0` });
    }
    if (p.startsWith('/api/')) return this.json(res, 404, { ok: false });

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    if (p === '/custom.css') {
      let css = '';
      try { css = fs.readFileSync(path.join(this.userDir, 'custom.css'), 'utf8'); } catch { /* none */ }
      this.headers(res, { 'Content-Type': TYPES['.css'], 'Cache-Control': 'no-store' });
      res.writeHead(200); return res.end(css);
    }
    if (p === '/icon.png' || p === '/favicon.ico') {
      return this.file(res, path.join(this.assetsDir, 'icon.png'), 'public, max-age=86400');
    }
    if (p === '/embed-test' || p === '/embed-test.html') {
      // A page that frames the stream page, to try embedding before putting it on a site.
      const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src *; frame-ancestors 'none'";
      return this.file(res, path.join(this.webDir, 'embed-test.html'), 'no-cache', csp);
    }
    const name = p === '/' ? 'index.html' : p.slice(1);
    if (!/^[a-z0-9._-]+$/i.test(name) || name === 'embed-test.html') { res.writeHead(404); return res.end(); }
    return this.file(res, path.join(this.webDir, name), 'no-cache');
  }

  file(res, file, cache, csp = null) {
    fs.readFile(file, (err, data) => {
      if (err) { this.headers(res); res.writeHead(404); return res.end('Not found'); }
      this.headers(res, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache }, csp);
      res.writeHead(200);
      res.end(data);
    });
  }

  // Blocks other websites from using a signed-in browser's cookie to talk to this PC.
  sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    let oh;
    try { oh = new URL(origin).host.toLowerCase(); } catch { return false; }
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => String(h).split(',')[0].trim().toLowerCase());
    if (hosts.includes(oh)) return true;
    const { tunnel } = clientIp(req);
    return tunnel && origin.startsWith('https://') && !!this.tunnelHost && oh === this.tunnelHost;
  }

  upgrade(req, socket, head, secure) {
    const url = new URL(req.url, 'http://x');
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); socket.destroy(); };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    const { ip, tunnel } = clientIp(req);
    if (!this.auth.ipAllowed(ip)) return reject(403, 'Forbidden');
    const same = this.sameOrigin(req);
    if (!same && !this.embedOrigins().length) {
      this.auth.record('blocked', `Blocked a connection started by another website (${req.headers.origin}).`, ip);
      return reject(403, 'Forbidden');
    }
    if (this.pending.size >= MAX_PENDING) return reject(503, 'Busy');
    // A cookie only counts when the page is our own; embedded pages say hello with their token.
    const cookieSession = same ? this.auth.sessionFor(parseCookies(req.headers.cookie)[COOKIE]) : null;
    this.wss.handleUpgrade(req, socket, head, ws => this.greet(ws, { ip, tunnel, secure, ua: req.headers['user-agent'], cookieSession }));
  }

  // A new socket must say hello (or, for older pages, be signed in by cookie) before anything else.
  greet(ws, meta) {
    this.pending.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    let done = false;
    const settle = () => { done = true; clearTimeout(timer); this.pending.delete(ws); };
    const timer = setTimeout(() => {
      if (done) return;
      settle();
      if (meta.cookieSession) this.attach(ws, meta, meta.cookieSession, null);
      else { try { ws.close(4401, 'Sign in first'); } catch { /* ignore */ } }
    }, HELLO_MS);
    ws.once('message', (data, isBinary) => {
      if (done) return;
      settle();
      let m = null;
      if (!isBinary) { try { m = JSON.parse(data.toString()); } catch { m = null; } }
      if (!m || m.t !== 'hello') {
        if (!meta.cookieSession) { try { ws.close(4401, 'Sign in first'); } catch { /* ignore */ } return; }
        const c = this.attach(ws, meta, meta.cookieSession, null);
        if (c && m) this.message(c, m);
        return;
      }
      const session = (typeof m.token === 'string' && m.token && this.auth.sessionFor(m.token)) || meta.cookieSession;
      if (!session) {
        try { ws.send(JSON.stringify({ t: 'auth-failed', message: 'Please sign in again.' })); } catch { /* ignore */ }
        try { ws.close(4401, 'Sign in first'); } catch { /* ignore */ }
        return;
      }
      this.attach(ws, meta, session, m);
    });
    ws.once('close', () => { if (!done) settle(); });
  }

  attach(ws, meta, session, hello) {
    // Pick up a dropped session where it left off: no new stream, no new negotiation.
    const r = hello && hello.resume;
    if (r && typeof r.id === 'string') {
      const c = this.clients.get(r.id);
      if (c && !c.ended && c.resumeKey === r.key && c.sessionId === session.id) {
        clearTimeout(c.graceTimer);
        c.graceTimer = null;
        const old = c.ws;
        const away = c.detachedAt ? Date.now() - c.detachedAt : 0;
        c.ws = ws; c.detachedAt = 0; c.ip = meta.ip; c.tunnel = meta.tunnel; c.resumes = (c.resumes || 0) + 1;
        if (old && old !== ws) { try { old.terminate(); } catch { /* ignore */ } }
        this.bind(c, ws);
        if (LATENCY.includes(hello.latency)) c.latency = hello.latency;
        if (c.transport === 'websocket') { c.seq = 0; c.acked = 0; c.needKey = true; this.requestKey(); }
        this.send(c.id, { t: 'resumed', id: c.id, resumeKey: c.resumeKey, ...this.getWelcome(c) });
        this.emit('client-resume', c, { away, drop: hello.lastDrop });
        return c;
      }
    }

    const max = this.config.get('security.maxClients');
    const policy = this.config.get('security.newClientPolicy');
    let live = [...this.clients.values()].filter(c => !c.ended);
    // A dropped session from this same browser isn't "another device".
    for (const s of live.filter(c => c.detachedAt && c.sessionId === session.id)) this.finish(s, 'replaced');
    live = [...this.clients.values()].filter(c => !c.ended);
    if (live.length >= max) {
      if (policy === 'reject') {
        try { ws.send(JSON.stringify({ t: 'busy', message: 'Another device is already connected to this PC.' })); } catch { /* ignore */ }
        try { ws.close(4002, 'busy'); } catch { /* ignore */ }
        return null;
      }
      for (const old of live.slice(0, live.length - max + 1)) this.kick(old.id, 'Another device connected and took over.');
    }
    const id = crypto.randomBytes(5).toString('hex');
    const c = {
      id, ws, ip: meta.ip, tunnel: meta.tunnel, device: deviceName(meta.ua), sessionId: session.id,
      resumeKey: crypto.randomBytes(16).toString('base64url'),
      connectedAt: Date.now(), ended: false, detachedAt: 0, transport: null, stats: null,
      latency: hello && LATENCY.includes(hello.latency) ? hello.latency : 'lowest',
      seq: 0, acked: 0, needKey: true, dropped: 0, sent: 0, bytes: 0, rtt: 50, fps: 60,
    };
    this.clients.set(id, c);
    this.bind(c, ws);
    this.send(id, { t: 'welcome', id, resumeKey: c.resumeKey, ...this.getWelcome(c) });
    this.emit('client-join', c, { drop: hello && hello.lastDrop });
    return c;
  }

  bind(c, ws) {
    ws.isAlive = true;
    ws.on('message', (data, isBinary) => {
      if (c.ws !== ws || isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      this.message(c, m);
    });
    ws.on('close', (code, reason) => {
      if (c.ws !== ws) return; // replaced by a resumed socket
      c.ws = null;
      if (c.ended) return;
      // 1000 = the page said goodbye (Disconnect); 1001 = the tab was closed or left.
      if (code === 1000 || code === 1001) { this.finish(c, 'left'); return; }
      c.detachedAt = Date.now();
      c.lastClose = { code, reason: String(reason || '') };
      this.emit('client-detach', c, c.lastClose);
      c.graceTimer = setTimeout(() => this.finish(c, 'lost'), GRACE_MS);
    });
  }

  // Ends a session for good.
  finish(c, why = 'left') {
    if (!this.clients.has(c.id)) return;
    c.ended = true;
    clearTimeout(c.graceTimer);
    const ws = c.ws;
    c.ws = null;
    if (ws) { try { ws.close(4000, why); } catch { /* ignore */ } }
    this.clients.delete(c.id);
    this.emit('client-leave', c, why);
  }

  // Ends a dropped session right away (e.g. its WebRTC connection died too).
  endIfDetached(id) {
    const c = this.clients.get(id);
    if (c && c.detachedAt) this.finish(c, 'lost');
  }

  beat() {
    for (const c of this.clients.values()) {
      const ws = c.ws;
      if (!ws) continue;
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }

  tick() { for (const c of this.clients.values()) if (c.ws) this.send(c.id, { t: 'tick' }); }

  message(c, m) {
    switch (m.t) {
      case 'ping': this.send(c.id, { t: 'pong', id: m.id, c: m.c, h: Date.now() }); break;
      case 'ack': if (Number.isInteger(m.s) && m.s > c.acked && m.s <= c.seq) c.acked = m.s; break;
      case 'start':
        if (m.transport === 'webrtc' || m.transport === 'websocket') {
          c.transport = m.transport; c.needKey = true; c.seq = 0; c.acked = 0;
          if (LATENCY.includes(m.latency)) c.latency = m.latency;
          this.emit('start', c, m);
        }
        break;
      case 'latency':
        if (LATENCY.includes(m.mode) && m.mode !== c.latency) { c.latency = m.mode; this.emit('latency', c); }
        break;
      case 'signal': this.emit('signal', c, m.data); break;
      case 'input': if (Array.isArray(m.e)) this.emit('input', c, m.e); break;
      case 'quality': this.emit('quality', c, m); break;
      case 'display': this.emit('display', c, m.id); break;
      case 'keyframe': this.requestKey(); break;
      case 'stats':
        if (m.s && typeof m.s === 'object') {
          c.stats = m.s;
          if (Number.isFinite(m.s.ping) && m.s.ping > 0) c.rtt = m.s.ping;
          this.emit('stats', c, m.s);
        }
        break;
      case 'clipboard': if (typeof m.text === 'string') this.emit('clipboard', c, m.text.slice(0, 100000)); break;
      default: break;
    }
  }

  send(id, obj) {
    const c = this.clients.get(id);
    if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
  }
  broadcast(obj) { for (const id of this.clients.keys()) this.send(id, obj); }

  requestKey() {
    const now = Date.now();
    if (now - this.lastKeyRequest < 250) return;
    this.lastKeyRequest = now;
    this.emit('keyframe');
  }

  // WebSocket-mode media. Frames that would queue up behind a slow connection are skipped
  // (and a fresh keyframe asked for), so the picture stays live instead of lagging behind.
  // Lowest-latency mode allows the least queueing; Smoothest the most.
  media(kind, key, ts, data, fps) {
    for (const c of this.clients.values()) {
      if (c.transport !== 'websocket' || !c.ws || c.ws.readyState !== 1) continue;
      c.fps = fps || c.fps;
      const inflight = c.seq - c.acked;
      const slack = c.latency === 'lowest' ? 0.05 : c.latency === 'smooth' ? 0.35 : 0.12;
      const limit = Math.max(3, Math.round(c.fps * (Math.min(c.rtt, 1000) / 1000 + slack)));
      if (kind === 'video') {
        if (!key && (c.needKey || inflight > limit)) {
          if (!c.needKey) { c.needKey = true; this.requestKey(); }
          c.dropped++;
          continue;
        }
        if (key && inflight > limit * 2) { c.dropped++; c.needKey = true; this.requestKey(); continue; }
        if (key) c.needKey = false;
      } else if (inflight > limit * 3) continue;
      const buf = Buffer.allocUnsafe(HEADER + data.byteLength);
      buf[0] = kind === 'video' ? 1 : 2;
      buf[1] = key ? 1 : 0;
      const seq = kind === 'video' ? ++c.seq : c.seq;
      buf.writeUInt32LE(seq, 2);
      buf.writeDoubleLE(ts, 6);
      Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength).copy(buf, HEADER);
      c.ws.send(buf, { binary: true });
      if (kind === 'video') { c.sent++; c.bytes += buf.length; }
    }
  }

  kick(id, reason) {
    const c = this.clients.get(id);
    if (!c) return;
    c.ended = true;
    clearTimeout(c.graceTimer);
    const ws = c.ws;
    c.ws = null;
    if (ws) {
      try { ws.send(JSON.stringify({ t: 'kicked', message: reason })); } catch { /* ignore */ }
      setTimeout(() => { try { ws.close(4003, 'kicked'); } catch { /* ignore */ } }, 50);
    }
    this.clients.delete(id);
    this.emit('client-leave', c, 'kicked');
  }

  kickAll(reason) { for (const id of [...this.clients.keys()]) this.kick(id, reason); }
}

module.exports = { StreamServer, deviceName, clientIp, parseEmbedOrigins, HEADER, GRACE_MS };
