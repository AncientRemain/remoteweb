// Settings: defaults, a schema that both checks the file and draws the Settings screens,
// and load/save of config.json in the user's data folder. Anything in config.json can be
// edited by hand; bad or missing values fall back to the defaults below.
const fs = require('fs');
const path = require('path');

const RESOLUTIONS = ['native', '2160p', '1440p', '1080p', '900p', '720p', '540p', '480p', '360p'];
const FPS = [10, 15, 24, 30, 45, 60, 75, 90, 120, 144, 165, 240];

const DEFAULTS = {
  version: 1,
  server: {
    port: 8420,
    bindAddress: '0.0.0.0',
    https: false,
    httpsPort: 8421,
  },
  security: {
    sessionDays: 30,
    maxFailedAttempts: 5,
    lockoutMinutes: 15,
    maxClients: 1,
    newClientPolicy: 'replace',
    allowControl: true,
    blockWinKey: false,
    notifyOnSignIn: true,
    allowedIps: '',
    embedOrigins: '',
  },
  stream: {
    display: 'primary',
    resolution: '1080p',
    fps: 60,
    bitrateKbps: 20000,
    codec: 'H264',
    audio: 'loopback',
    contentHint: 'motion',
    degradation: 'balanced',
    transport: 'auto',
    keyframeSeconds: 3,
    hardwareEncoding: 'prefer-hardware',
  },
  presets: [
    { name: 'Ultra', resolution: 'native', fps: 60, bitrateKbps: 40000 },
    { name: 'High', resolution: '1080p', fps: 60, bitrateKbps: 20000 },
    { name: 'Gaming', resolution: '1080p', fps: 120, bitrateKbps: 35000 },
    { name: 'Balanced', resolution: '1080p', fps: 30, bitrateKbps: 8000 },
    { name: 'Data saver', resolution: '720p', fps: 30, bitrateKbps: 3000 },
    { name: 'Mobile data', resolution: '540p', fps: 24, bitrateKbps: 1200 },
  ],
  network: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    tunnel: 'cloudflare',
    tunnelAutoStart: false,
    tunnelCommand: '',
    publicUrl: '',
    domain: '',
  },
  client: {
    stats: 'compact',
    statsPosition: 'top-left',
    mouseMode: 'absolute',
    touchMode: 'touchpad',
    localCursor: 'dot',
    scrollSpeed: 1,
    invertScroll: false,
    scaleMode: 'fit',
    smoothing: true,
    latency: 'lowest',
    clipboardSync: true,
    toolbar: 'top',
    sound: true,
  },
  appearance: {
    appName: 'Beam Remote',
    welcomeText: 'Sign in to connect to this PC.',
    accent: '#3a7afe',
    accent2: '#e5a50a',
    theme: 'dark',
    background: 'solid',
    radius: 8,
    font: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", sans-serif',
  },
  app: {
    startWithWindows: false,
    startMinimized: false,
    closeToTray: true,
    keepAwake: true,
    streamPriority: 'high',
    updates: 'auto',
  },
};

const enumOf = (values, labels) => ({ type: 'enum', values, labels });

// Every setting: type, limits, and the words the Settings screens show for it.
const SCHEMA = {
  'server.port': { type: 'int', min: 1024, max: 65535, label: 'Port', help: 'The port the stream page is served on. Tunnels and port forwarding point here.', restart: true },
  'server.bindAddress': { ...enumOf(['0.0.0.0', '127.0.0.1'], ['This PC + home network', 'This PC only (tunnel)']), label: 'Who can reach the page directly', help: '"This PC only" hides it from your home network; only a tunnel on this PC can reach it.', restart: true },
  'server.https': { type: 'bool', label: 'Also serve HTTPS', help: 'Adds an encrypted https:// address (self-signed certificate) for home network or port-forward use. Your browser will warn once; that is expected.', restart: true },
  'server.httpsPort': { type: 'int', min: 1024, max: 65535, label: 'HTTPS port', restart: true },

  'security.sessionDays': { type: 'int', min: 1, max: 365, label: 'Stay signed in for (days)', help: 'Only when "Remember this device" is ticked at sign-in. Otherwise the sign-in ends when the browser closes.' },
  'security.maxFailedAttempts': { type: 'int', min: 3, max: 50, label: 'Wrong passwords before lockout' },
  'security.lockoutMinutes': { type: 'int', min: 1, max: 1440, label: 'Lockout length (minutes)' },
  'security.maxClients': { type: 'int', min: 1, max: 4, label: 'Devices streaming at once' },
  'security.newClientPolicy': { ...enumOf(['replace', 'reject'], ['New device takes over', 'Keep the current device']), label: 'When another device connects' },
  'security.allowControl': { type: 'bool', label: 'Allow mouse and keyboard control', help: 'Turn off for view-only streaming.' },
  'security.blockWinKey': { type: 'bool', label: 'Block the Windows key', help: 'Stops the remote device from pressing the Windows key.' },
  'security.notifyOnSignIn': { type: 'bool', label: 'Notify me on this PC when someone signs in' },
  'security.allowedIps': { type: 'text', label: 'Only allow these IP addresses (optional)', help: 'Comma-separated, prefixes allowed, e.g. "192.168.1., 100.". Leave empty to allow any address that knows the password.', placeholder: 'any' },

  'security.embedOrigins': { type: 'text', max: 1000, label: 'Websites allowed to embed this page', help: 'Comma-separated, e.g. "https://mysite.com, https://dash.example.org", or * to let any website embed it (less safe: any site could frame your sign-in page). Leave empty to block embedding (safest). Embedding only works when the page is opened over https (quick link or your own domain).', placeholder: 'none' },
  'stream.display': { type: 'display', label: 'Screen to stream', help: 'You can also switch screens from the browser toolbar.' },
  'stream.resolution': { ...enumOf(RESOLUTIONS, ['Native (full)', '4K (2160p)', '1440p', '1080p', '900p', '720p', '540p', '480p', '360p']), label: 'Resolution', help: 'Biggest picture sent. Lower = less data and lower latency on slow connections. Many graphics cards only hardware-encode up to 1080p; above that the processor does the work.' },
  'stream.fps': { type: 'enumInt', values: FPS, label: 'Frames per second', help: 'Above 60 needs a fast connection and a high-refresh monitor on this PC.' },
  'stream.bitrateKbps': { type: 'int', min: 300, max: 150000, step: 100, label: 'Max bitrate (kbps)', help: '1000 kbps = 1 Mbps. 8-20 Mbps looks great at 1080p; use 1-3 Mbps on mobile data.' },
  'stream.codec': { ...enumOf(['H264', 'VP9', 'AV1', 'VP8'], ['H.264 (fastest, hardware)', 'VP9 (sharper text)', 'AV1 (best quality per bit)', 'VP8 (most compatible)']), label: 'Video codec' },
  'stream.audio': { ...enumOf(['loopback', 'loopbackWithMute', 'off'], ['On', 'On, and mute this PC\'s speakers', 'Off']), label: 'Sound' },
  'stream.contentHint': { ...enumOf(['motion', 'detail', 'text'], ['Smooth motion (games, video)', 'Sharp detail', 'Text (documents, code)']), label: 'Optimise for' },
  'stream.degradation': { ...enumOf(['balanced', 'maintain-framerate', 'maintain-resolution'], ['Balanced', 'Keep frame rate', 'Keep resolution']), label: 'When the connection is slow' },
  'stream.transport': { ...enumOf(['auto', 'webrtc', 'websocket'], ['Auto (best available)', 'WebRTC only (peer-to-peer)', 'WebSocket only (through tunnels)']), label: 'Connection type', help: 'Auto tries a direct peer-to-peer connection first and falls back to streaming through the tunnel.' },
  'stream.keyframeSeconds': { type: 'int', min: 1, max: 30, label: 'Keyframe every (seconds)', help: 'WebSocket mode only. Lower recovers faster from glitches; higher uses less data.' },
  'stream.hardwareEncoding': { ...enumOf(['prefer-hardware', 'no-preference', 'prefer-software'], ['Prefer graphics card', 'Automatic', 'Prefer processor']), label: 'Encoder', help: 'WebSocket mode only. WebRTC always picks automatically.' },

  'network.tunnel': { ...enumOf(['cloudflare', 'cloudflare-domain', 'custom', 'none'], ['Cloudflare quick tunnel (free, no account)', 'My own domain (Cloudflare)', 'My own command (ngrok...)', 'None (Tailscale / port forwarding)']), label: 'Remote access method' },
  'network.domain': { type: 'text', max: 253, label: 'Your address', help: 'The web address for your PC, on a domain you have added to Cloudflare, e.g. pc.yourname.com.', placeholder: 'pc.yourdomain.com' },
  'network.tunnelAutoStart': { type: 'bool', label: 'Start remote access when the app opens' },
  'network.tunnelCommand': { type: 'text', label: 'Custom tunnel command', help: 'Runs when you press Start. Use {port} for the port. The first https:// address it prints is shown as your link.', placeholder: 'ngrok http {port}' },
  'network.publicUrl': { type: 'text', label: 'My fixed public address (optional)', help: 'If you have your own domain, port forwarding or Tailscale name, put the address here so it is shown with a QR code.', placeholder: 'https://pc.example.com' },
  'network.iceServers': { type: 'json', label: 'STUN / TURN servers (JSON)', help: 'Used to find a direct path between your device and this PC. Add a TURN server here if peer-to-peer never connects.' },

  'client.stats': { ...enumOf(['compact', 'full', 'off'], ['Compact', 'Detailed with graphs', 'Hidden']), label: 'Stats overlay' },
  'client.statsPosition': { ...enumOf(['top-left', 'top-right', 'bottom-left', 'bottom-right'], ['Top left', 'Top right', 'Bottom left', 'Bottom right']), label: 'Stats position' },
  'client.mouseMode': { ...enumOf(['absolute', 'relative'], ['Normal (desktop)', 'Locked (games)']), label: 'Mouse mode', help: 'Locked captures your mouse for 3D games. Press Esc to release it.' },
  'client.touchMode': { ...enumOf(['touchpad', 'direct'], ['Touchpad (drag to move the cursor)', 'Direct (tap where you want to click)']), label: 'Touch screens' },
  'client.localCursor': { ...enumOf(['dot', 'arrow', 'hidden'], ['Small dot', 'Normal arrow', 'Hidden']), label: 'Your own cursor over the stream' },
  'client.scrollSpeed': { type: 'num', min: 0.1, max: 5, step: 0.1, label: 'Scroll speed' },
  'client.invertScroll': { type: 'bool', label: 'Invert scrolling' },
  'client.scaleMode': { ...enumOf(['fit', 'fill', 'native'], ['Fit to window', 'Fill window (crop)', 'Actual pixels']), label: 'Picture size' },
  'client.smoothing': { type: 'bool', label: 'Smooth scaling' },
  'client.latency': { ...enumOf(['lowest', 'balanced', 'smooth'], ['Lowest latency', 'Balanced', 'Smoothest']), label: 'Latency mode', help: 'Lowest latency shows each frame the moment it arrives and keeps sound buffers tiny: best for games and quick mouse work. Balanced and Smoothest add a small buffer that hides stutter on unsteady connections (school or mobile networks).' },
  'client.clipboardSync': { type: 'bool', label: 'Share clipboard text' },
  'client.toolbar': { ...enumOf(['top', 'bottom', 'hidden'], ['Top', 'Bottom', 'Hidden (hotkey only)']), label: 'Toolbar position', help: 'Ctrl + Alt + Shift + M always opens the menu.' },
  'client.sound': { type: 'bool', label: 'Play sound' },

  'appearance.appName': { type: 'text', max: 40, label: 'App name', help: 'Shown on the sign-in page and this window.' },
  'appearance.welcomeText': { type: 'text', max: 120, label: 'Sign-in page message' },
  'appearance.accent': { type: 'color', label: 'Accent colour', help: 'Buttons, switches, selections and the ping graph.' },
  'appearance.accent2': { type: 'color', label: 'Graph colour', help: 'The latency line in the stats graphs.' },
  'appearance.theme': { ...enumOf(['dark', 'light', 'system'], ['Dark', 'Light', 'Match the device']), label: 'Theme' },
  'appearance.background': { ...enumOf(['solid', 'grid', 'aurora'], ['Plain', 'Dot grid', 'Soft glow']), label: 'Sign-in page background' },
  'appearance.radius': { type: 'int', min: 0, max: 16, label: 'Corner radius (px)' },
  'appearance.font': { type: 'text', max: 200, label: 'Font' },

  'app.startWithWindows': { type: 'bool', label: 'Start when I sign in to Windows' },
  'app.startMinimized': { type: 'bool', label: 'Start hidden in the tray' },
  'app.closeToTray': { type: 'bool', label: 'Closing the window keeps it running in the tray' },
  'app.keepAwake': { type: 'bool', label: 'Keep this PC awake while a device is connected' },
  'app.streamPriority': { ...enumOf(['high', 'normal'], ['High (smooth even while gaming)', 'Normal']), label: 'Stream priority', help: 'High runs the stream above other programs while a device is connected, so a heavy game can\'t make it stutter.' },
  'app.updates': { ...enumOf(['auto', 'download', 'notify', 'off'], ['Install automatically', 'Download, then ask me', 'Just tell me', 'Off']), label: 'When a new version is out', help: 'Automatic updates install only after nobody has been connected for a few minutes. The app then starts again by itself, with remote access back on if it was on.' },
};

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function set(obj, p, value) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}
const clone = v => JSON.parse(JSON.stringify(v));

// Returns a cleaned value for one setting, or undefined when it is unusable.
function check(rule, v) {
  switch (rule.type) {
    case 'bool': return typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : undefined);
    case 'int': case 'num': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
      const r = rule.type === 'int' ? Math.round(n) : n;
      return Math.max(rule.min ?? -Infinity, Math.min(rule.max ?? Infinity, r));
    }
    case 'enum': return rule.values.includes(v) ? v : undefined;
    case 'enumInt': { const n = Number(v); return rule.values.includes(n) ? n : undefined; }
    case 'text': return typeof v === 'string' ? v.slice(0, rule.max || 2000) : undefined;
    case 'color': return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
    case 'display': return typeof v === 'string' && v.length < 64 ? v : (typeof v === 'number' ? String(v) : undefined);
    case 'json': return v;
    default: return undefined;
  }
}

function cleanIce(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const s of list.slice(0, 10)) {
    if (!s || (typeof s.urls !== 'string' && !Array.isArray(s.urls))) continue;
    const urls = [].concat(s.urls).filter(u => typeof u === 'string' && /^(stun|stuns|turn|turns):/i.test(u));
    if (!urls.length) continue;
    const e = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof s.username === 'string') e.username = s.username;
    if (typeof s.credential === 'string') e.credential = s.credential;
    out.push(e);
  }
  return out;
}

function cleanPresets(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const p of list.slice(0, 12)) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
    const res = check(SCHEMA['stream.resolution'], p.resolution);
    const fps = check(SCHEMA['stream.fps'], p.fps);
    const kbps = check(SCHEMA['stream.bitrateKbps'], p.bitrateKbps);
    if (res === undefined || fps === undefined || kbps === undefined) continue;
    out.push({ name: p.name.trim().slice(0, 24), resolution: res, fps, bitrateKbps: kbps });
  }
  return out;
}

// Builds a full, valid config from whatever was in the file. Problems are listed, not thrown.
function normalize(raw) {
  const problems = [];
  const cfg = clone(DEFAULTS);
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [p, rule] of Object.entries(SCHEMA)) {
    const v = get(src, p);
    if (v === undefined) continue;
    let c;
    if (p === 'network.iceServers') c = cleanIce(v);
    else c = check(rule, v);
    if (c === undefined) problems.push(`"${p}" had an unusable value and was reset to the default.`);
    else set(cfg, p, c);
  }
  if (src.presets !== undefined) {
    const pr = cleanPresets(src.presets);
    if (pr && pr.length) cfg.presets = pr;
    else problems.push('"presets" had no usable entries; the default presets are used.');
  }
  return { cfg, problems };
}

class ConfigStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.listeners = new Set();
    this.problems = [];
    this.selfWriteAt = 0;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    let raw = null, missing = false;
    this.problems = [];
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')); // some editors add a byte-order mark
    } catch (e) {
      if (e.code === 'ENOENT') missing = true;
      // A typo must never wipe someone's settings: keep their file, run on defaults, say so.
      else this.problems = [`config.json could not be read (${e.message}). Defaults are in use until it is fixed; the file was left as it is.`];
    }
    const { cfg, problems } = normalize(raw);
    if (raw) this.problems = problems;
    this.cfg = cfg;
    this.readOnly = !raw && !missing; // don't overwrite a file we couldn't read
    if (missing) this.save();
    return cfg;
  }

  save() {
    this.selfWriteAt = Date.now();
    if (this.readOnly) {
      // The user's file is broken; keep a copy before replacing it with working settings.
      try { fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* ignore */ }
      this.readOnly = false;
      this.problems = [];
    }
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2));
  }

  get(p) { return p ? get(this.cfg, p) : this.cfg; }

  // Apply a set of {path: value} changes. Returns the list of paths that changed.
  update(changes) {
    const changed = [];
    for (const [p, v] of Object.entries(changes || {})) {
      if (p === 'presets') {
        const pr = cleanPresets(v);
        if (pr && pr.length) { this.cfg.presets = pr; changed.push(p); }
        continue;
      }
      const rule = SCHEMA[p];
      if (!rule) continue;
      const c = p === 'network.iceServers' ? cleanIce(typeof v === 'string' ? safeJson(v) : v) : check(rule, v);
      if (c === undefined) continue;
      if (JSON.stringify(get(this.cfg, p)) !== JSON.stringify(c)) { set(this.cfg, p, c); changed.push(p); }
    }
    if (changed.length) { this.save(); this.emit(changed); }
    return changed;
  }

  reset() { this.cfg = clone(DEFAULTS); this.save(); this.emit(Object.keys(SCHEMA).concat('presets')); }

  // Picks up hand edits to config.json while the app runs.
  watch() {
    let timer = null;
    try {
      fs.watch(this.dir, (ev, name) => {
        if (name !== 'config.json' || Date.now() - this.selfWriteAt < 1500) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')); } catch (e) {
            if (e.code === 'ENOENT') { this.save(); return; }
            // Half-typed edit: keep running on the current settings and report the mistake.
            this.problems = [`config.json has a mistake (${e.message}). The app keeps its current settings until the file is fixed.`];
            this.emit([], true);
            return;
          }
          const before = JSON.stringify(this.cfg);
          const prev = this.cfg;
          this.load();
          if (JSON.stringify(this.cfg) !== before) {
            const changed = Object.keys(SCHEMA).filter(p => JSON.stringify(get(prev, p)) !== JSON.stringify(get(this.cfg, p)));
            if (JSON.stringify(prev.presets) !== JSON.stringify(this.cfg.presets)) changed.push('presets');
            this.emit(changed, true);
          }
        }, 300);
      });
    } catch { /* watching is a convenience */ }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(changed, fromFile = false) { for (const fn of this.listeners) { try { fn(changed, fromFile); } catch (e) { console.error(e); } } }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return undefined; } }

// Height limit for a resolution name (0 = native).
function maxHeight(res) { return res === 'native' ? 0 : parseInt(res, 10) || 0; }

module.exports = { ConfigStore, DEFAULTS, SCHEMA, RESOLUTIONS, FPS, normalize, maxHeight, get, set };
