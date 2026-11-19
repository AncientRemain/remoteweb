// Beam Remote: the desktop app. Owns the settings, the web server, the hidden capture
// window, keyboard/mouse injection, the tunnel, the tray icon and the dashboard window.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, screen, shell,
  powerSaveBlocker, Notification, clipboard, nativeImage, dialog, nativeTheme,
} = require('electron');

// Let Windows' graphics-card H.264 encoders handle WebRTC's baseline profile too.
app.commandLine.appendSwitch('enable-features', 'MediaFoundationH264CbpEncoding');
// The capture window is hidden: never let Chromium slow it down as a "background" page.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Offer this PC's real address to WebRTC instead of a random ".local" name: phones on the
// same Wi-Fi can then connect directly even if their browser can't look .local names up.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Lowest-latency mode: video frames are marked "show immediately" (zero playout delay), like
// cloud-gaming services do. Only viewers whose session negotiates it are affected (capture.js).
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/');

// Optional separate data folder (handy for testing): --data-dir=C:\somewhere
const dataArg = process.argv.find(a => a.startsWith('--data-dir='));
if (dataArg) app.setPath('userData', path.resolve(dataArg.slice('--data-dir='.length)));

const { ConfigStore, SCHEMA, DEFAULTS } = require('./config');
const { Auth } = require('./auth');
const { StreamServer } = require('./server');
const { Tunnel } = require('./tunnel');
const input = require('./input');
const { SystemAudio } = require('./audio');
const cloudflare = require('./cloudflare');
const { Updater } = require('./updater');
const QRCode = require('qrcode');

const APP_DIR = path.join(__dirname, '..', '..');
const WEB_DIR = path.join(APP_DIR, 'src', 'web');
const ASSETS = path.join(APP_DIR, 'assets');
const VERSION = require(path.join(APP_DIR, 'package.json')).version;
// --updated: started again by the installer after an automatic update (nobody may be at the PC).
const justUpdated = process.argv.includes('--updated');
const startHidden = process.argv.includes('--hidden') || justUpdated;
// BEAM_DEBUG=1 writes step-by-step markers to debug.log in the data folder (always written, even if the app hangs).
const dbg = (...a) => { if (process.env.BEAM_DEBUG) try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}\n`); } catch { /* ignore */ } };

let config, auth, server, tunnel, tray, win, capWin, sysAudio, updater;
let firewall = { state: 'unknown' };
let live = null;              // stream settings in use right now (config + browser changes)
let capInfo = {};
let lastWsConfig = null, lastAudioConfig = null;
let powerId = null;
let lastClipboard = '';
let wsScale = 1, cleanRuns = 0;
let quitting = false;
let trayHintShown = false;
const hostStats = new Map();  // client id -> capture-side stats
const capLog = [];

// An unexpected error must never pop up Electron's blocking error box: that would freeze
// the stream for whoever is connected. Log it to error.log in the data folder instead.
function logError(kind, err) {
  const text = `${new Date().toISOString()} ${kind}: ${err && err.stack || err}\n`;
  console.error(text);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), text); } catch { /* ignore */ }
}
process.on('uncaughtException', e => logError('uncaughtException', e));
process.on('unhandledRejection', e => logError('unhandledRejection', e));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('app.beamremote.desktop');
  app.whenReady().then(boot).catch(e => {
    dialog.showErrorBox('Beam Remote could not start', String(e && e.stack || e));
    app.exit(1);
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  const USER_DIR = app.getPath('userData');
  config = new ConfigStore(USER_DIR);
  config.watch();
  auth = new Auth(USER_DIR, p => config.get(p));
  ensureCustomCss();
  resetLive();

  setupCaptureHandler();
  createCaptureWindow();

  // Packaged apps can't run programs from inside app.asar, so the helper is unpacked next to it.
  sysAudio = new SystemAudio(path.join(ASSETS, 'beam-audio.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  sysAudio.on('pcm', m => capSend('cap:pcm', m));
  sysAudio.on('log', line => dbg('[audio]', line));

  server = new StreamServer({
    config, auth, webDir: WEB_DIR, assetsDir: ASSETS, userDir: USER_DIR, version: VERSION, getWelcome: welcomeFor,
  });
  wireServer();
  await startServer();

  tunnel = new Tunnel(path.join(USER_DIR, 'bin'));
  tunnel.on('status', s => {
    dbg('tunnel', s.state, s.url || '');
    try { server.tunnelHost = s.url ? new URL(s.url).host.toLowerCase() : null; } catch { server.tunnelHost = null; }
    updateTray();
    sendToWindow('beam:status', status());
  });

  updater = new Updater({
    app, version: VERSION, log: dbg,
    getMode: () => config.get('app.updates'),
    // Someone streaming, or you working in this window right now: don't restart under them.
    isBusy: () => server.clients.size > 0 || !!(win && !win.isDestroyed() && win.isVisible() && win.isFocused()),
    // Pages show "updating" and keep retrying until the new version is up. Quitting itself
    // (tunnel, sound) is handled by before-quit, so a failed install leaves the app running.
    beforeInstall: () => {
      server.broadcast({ t: 'notice', kind: 'updating', message: 'The PC is installing an update and will be back in a moment.' });
      try { input.releaseAll(); } catch { /* ignore */ }
      // Remember whether remote access was on, so the new version turns it back on by itself
      // (otherwise an update while you're away would lock you out).
      const on = ['online', 'starting', 'downloading'].includes(tunnel.status.state);
      try { fs.writeFileSync(path.join(USER_DIR, 'update-resume.json'), JSON.stringify({ tunnel: on, at: Date.now() })); } catch { /* ignore */ }
    },
  });
  updater.on('status', () => { updateTray(); sendToWindow('beam:status', status()); });
  updater.start();
  if (justUpdated && Notification.isSupported()) {
    new Notification({ title: config.get('appearance.appName'), body: `Updated to version ${VERSION}.`, icon: path.join(ASSETS, 'icon.png') }).show();
  }
  setTimeout(checkFirewall, 4000);

  config.onChange(onConfigChanged);
  auth.onRecord(e => sendToWindow('beam:log', e));
  screen.on('display-added', () => {
    sendToWindow('beam:state', state());
    // A monitor that woke up again: pick the picture back up for anyone waiting.
    if (server.clients.size) capSend('cap:reacquire');
  });
  screen.on('display-removed', () => { sendToWindow('beam:state', state()); input.refreshVirtual(); });
  screen.on('display-metrics-changed', () => input.refreshVirtual());

  createTray();
  if (!(startHidden || config.get('app.startMinimized'))) showWindow();
  applyLoginItem();
  input.setOptions({ blockWinKey: config.get('security.blockWinKey') });
  if (!input.available()) console.error('Input injection unavailable:', input.loadError());

  // Back from an automatic update: put remote access back the way it was.
  let resumed = null;
  const resumeFile = path.join(USER_DIR, 'update-resume.json');
  try { resumed = JSON.parse(fs.readFileSync(resumeFile, 'utf8')); fs.unlinkSync(resumeFile); } catch { /* not after an update */ }
  const tunnelWasOn = !!(resumed && resumed.tunnel && Date.now() - resumed.at < 30 * 60000);
  if ((config.get('network.tunnelAutoStart') || tunnelWasOn) && config.get('network.tunnel') !== 'none' && auth.passwordSet) startTunnel();

  setInterval(tick, 1000);
  setInterval(adaptBitrate, 2000);
  setInterval(sampleCpu, 2000);
}

function ensureCustomCss() {
  const f = path.join(app.getPath('userData'), 'custom.css');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, [
      '/* Beam Remote custom style. Anything here is added to both the browser page and the app.',
      '   Save the file and refresh the page to see changes. Examples:',
      '',
      '   :root { --accent: #ff4f81; --radius: 20px; }',
      '   .login-card h1 { letter-spacing: 0.08em; }',
      '   #stats { font-size: 13px; }',
      '*/',
      '',
    ].join('\n'));
  }
}

async function httpsCreds() {
  if (!config.get('server.https')) return null;
  const dir = path.join(app.getPath('userData'), 'cert');
  const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
  const ips = lanAddresses().map(a => a.address);
  const metaFile = path.join(dir, 'names.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* none */ }
  const fresh = meta && JSON.stringify(meta.ips) === JSON.stringify(ips) && fs.existsSync(keyFile) && fs.existsSync(certFile);
  if (!fresh) {
    const selfsigned = require('selfsigned');
    const notAfter = new Date(); notAfter.setFullYear(notAfter.getFullYear() + 10);
    const pems = await selfsigned.generate([{ name: 'commonName', value: os.hostname() }], {
      keySize: 2048, algorithm: 'sha256', notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: os.hostname() }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))] },
      ],
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(metaFile, JSON.stringify({ ips }));
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

async function startServer() {
  let creds = null;
  dbg('startServer: https', config.get('server.https'));
  try { creds = await httpsCreds(); } catch (e) { logError('HTTPS certificate', e); }
  dbg('startServer: creds', !!creds);
  let st = await server.start(creds);
  dbg('startServer: started', JSON.stringify(st));
  // Right after "Restart as administrator" the old copy may still hold the port briefly.
  for (let i = 0; i < 6 && st.error && /already in use/.test(st.error); i++) {
    await new Promise(r => setTimeout(r, 1000));
    st = await server.start(creds);
  }
  if (st.error) console.error(st.error);
  sendToWindow('beam:status', status());
}

// ------------------------------------------------------------------ displays & capture
function displayList() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    name: d.label || `Screen ${i + 1}`,
    primary: d.id === primary.id,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    refresh: Math.round(d.displayFrequency || 60),
  }));
}

function currentDisplay() {
  const all = screen.getAllDisplays();
  const want = live && live.display;
  return all.find(d => String(d.id) === String(want)) || screen.getPrimaryDisplay();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const screenSources = () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);

// Wakes a sleeping monitor with a one-pixel mouse wiggle (counts as activity for Windows).
function wakeDisplay() {
  if (process.env.BEAM_INPUT_DRYRUN) { console.log('[input] wake display'); return; }
  input.nudge();
}

function setupCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Electron throws if this is answered twice, or answered with no screen, so answer once, safely.
    let answered = false;
    const reply = streams => {
      if (answered) return;
      answered = true;
      try { callback(streams); } catch (e) { if (!/no video stream was provided/i.test(e.message)) logError('capture reply', e); }
    };
    try {
      const d = currentDisplay();
      let sources = await screenSources();
      if (!sources.length) {
        // No screen at all: the monitor is asleep or off (many disappear from Windows when they
        // sleep). Wake it and give it a few seconds to come back.
        server.broadcast({ t: 'notice', kind: 'waking', message: 'Your PC\'s screen is asleep. Waking it up…' });
        for (let i = 0; i < 8 && !sources.length; i++) {
          wakeDisplay();
          await sleep(1000);
          sources = await screenSources();
        }
        dbg('handler: after waking, sources', sources.length);
      }
      const all = screen.getAllDisplays();
      const src = sources.find(s => String(s.display_id) === String(d.id))
        || sources[all.findIndex(x => String(x.id) === String(d.id))] || sources[0];
      if (!src) {
        server.broadcast({ t: 'error', code: 'no-screen', message: 'Your PC\'s screen is off and couldn\'t be woken up. It may be switched off at the monitor.' });
        return reply({});
      }
      try { input.setTarget(screen.dipToScreenRect(null, d.bounds)); } catch { input.setTarget(null); }
      reply({ video: src }); // sound comes from the beam-audio helper instead
    } catch (e) {
      logError('capture handler', e);
      reply({});
    }
  }, { useSystemPicker: false });
}

function createCaptureWindow() {
  capWin = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-capture.js'), contextIsolation: true, sandbox: true,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  capWin.loadFile(path.join(APP_DIR, 'src', 'capture', 'capture.html'));
  capWin.webContents.on('render-process-gone', (_e, d) => {
    console.error('capture window crashed', d.reason);
    if (!quitting) setTimeout(() => {
      try { capWin.destroy(); } catch { /* ignore */ }
      createCaptureWindow();
      server.broadcast({ t: 'restart', message: 'The streamer restarted.' });
    }, 1000);
  });
  capWin.on('close', e => { if (!quitting) e.preventDefault(); });
}

function capSend(ch, data) { if (capWin && !capWin.isDestroyed()) capWin.webContents.send(ch, data); }
function pushCaptureConfig() { capSend('cap:config', { settings: live, ice: config.get('network.iceServers') }); updateAudio(); }

// System sound runs only while someone is actually streaming with sound on.
function updateAudio() {
  if (!sysAudio || !server) return;
  const streaming = [...server.clients.values()].some(c => c.transport);
  if (streaming && live.audio !== 'off') sysAudio.start({ mute: live.audio === 'loopbackWithMute' });
  else sysAudio.stop();
  updatePriority(); // the helper may have a new process
}
function resetLive() { live = { ...config.get('stream') }; wsScale = 1; }

ipcMain.on('cap:ready', (e, info) => { if (e.sender !== capWin?.webContents) return; capInfo = info; pushCaptureConfig(); });
ipcMain.on('cap:signal', (e, { id, data }) => { if (e.sender === capWin?.webContents) server.send(id, { t: 'signal', data }); });
let mediaCount = 0;
ipcMain.on('cap:media', (e, m) => {
  if (e.sender !== capWin?.webContents) return;
  if (++mediaCount <= 3 || mediaCount % 300 === 0) dbg('media', mediaCount, m.kind, m.key, m.data && m.data.byteLength, m.data && m.data.constructor && m.data.constructor.name);
  server.media(m.kind, m.key, m.ts, m.data, m.fps);
  if (mediaCount <= 3) dbg('media sent', mediaCount);
});
ipcMain.on('cap:wsconfig', (e, cfg) => {
  if (e.sender !== capWin?.webContents) return;
  lastWsConfig = cfg;
  for (const c of server.clients.values()) if (c.transport === 'websocket') server.send(c.id, { t: 'wsconfig', ...cfg });
});
ipcMain.on('cap:audioconfig', (e, cfg) => {
  if (e.sender !== capWin?.webContents) return;
  lastAudioConfig = cfg;
  for (const c of server.clients.values()) if (c.transport === 'websocket') server.send(c.id, { t: 'audioconfig', ...cfg });
});
ipcMain.on('cap:input', (e, { id, e: ev }) => { if (e.sender === capWin?.webContents) handleInput(server.clients.get(id), ev); });
ipcMain.on('cap:stats', (e, { id, stats }) => {
  if (e.sender !== capWin?.webContents) return;
  hostStats.set(id, stats);
  server.send(id, { t: 'hoststats', s: stats });
});
ipcMain.on('cap:state', (e, { id, state: st }) => {
  if (e.sender !== capWin?.webContents) return;
  // The page's socket already dropped and now its video link died too: it's really gone.
  if (st === 'failed' || st === 'closed') server.endIfDetached(id);
});
ipcMain.on('cap:error', (e, { id, code, message }) => {
  if (e.sender !== capWin?.webContents) return;
  dbg('[capture error]', code || '', message);
  const msg = { t: 'error', code: code || 'stream', message };
  if (id) server.send(id, msg); else server.broadcast(msg);
  if (code !== 'capture') sendToWindow('beam:toast', { kind: 'error', text: message });
});
ipcMain.on('cap:log', (e, line) => {
  if (e.sender !== capWin?.webContents) return;
  capLog.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (capLog.length > 200) capLog.shift();
  dbg('[capture]', line);
});

function handleInput(c, ev) {
  if (!c || !server.clients.has(c.id) || !config.get('security.allowControl')) return;
  if (process.env.BEAM_INPUT_DRYRUN) { console.log('[input]', JSON.stringify(ev)); return; } // testing without touching the real PC
  input.handle(ev);
}

// ------------------------------------------------------------------ browser connections
function clientSchema() {
  const out = {};
  for (const [k, v] of Object.entries(SCHEMA)) if (k.startsWith('client.') || k.startsWith('stream.')) out[k] = v;
  return out;
}

function welcomeFor(c) {
  return {
    appName: config.get('appearance.appName'),
    appearance: config.get('appearance'),
    client: config.get('client'),
    presets: config.get('presets'),
    stream: live,
    displays: displayList(),
    display: String(currentDisplay().id),
    ice: config.get('network.iceServers'),
    control: config.get('security.allowControl') && input.available(),
    device: c.device,
    version: VERSION,
    schema: clientSchema(),
    secureTunnel: c.tunnel,
  };
}

const QUALITY_KEYS = ['resolution', 'fps', 'bitrateKbps', 'codec', 'audio', 'contentHint', 'degradation', 'transport', 'keyframeSeconds', 'hardwareEncoding'];

function wireServer() {
  server.on('signin', ({ ip, device }) => {
    auth.s.signedInOnce = true; auth.save();
    if (config.get('security.notifyOnSignIn') && Notification.isSupported()) {
      new Notification({ title: `${config.get('appearance.appName')}: new sign-in`, body: `${device} signed in from ${ip}. Not you? Open the app and change your password.`, icon: path.join(ASSETS, 'icon.png') }).show();
    }
  });

  server.on('client-join', (c, info = {}) => {
    const drop = info.drop && info.drop.code ? ` Its previous connection dropped (code ${info.drop.code}).` : '';
    auth.record('connect', `${c.device} connected from ${c.ip}${c.tunnel ? ' (through the tunnel)' : ''}.${drop}`, c.ip);
    if (server.clients.size === 1) readClipboard().then(t => { lastClipboard = t; });
    setLatency(c.latency);
    updatePower();
    updateTray();
  });

  const WHY = { lost: 'connection lost', kicked: 'disconnected from here or replaced', 'signed out': 'signed out', replaced: 'reopened the page', left: 'closed the page' };
  server.on('client-leave', (c, why = 'left') => {
    capSend('cap:leave', { id: c.id });
    hostStats.delete(c.id);
    input.releaseAll();
    auth.record('leave', `${c.device} disconnected after ${duration(Date.now() - c.connectedAt)} (${WHY[why] || why}).`, c.ip);
    if (!server.clients.size) { resetLive(); pushCaptureConfig(); }
    updatePower();
    updateTray();
  });

  // The page's socket dropped: keep its stream going for a moment so it can resume.
  server.on('client-detach', (c, info) => {
    dbg('detach', c.id, info && info.code);
    if (c.transport === 'websocket') input.releaseAll(); // its key-ups may never arrive
  });
  server.on('client-resume', (c, info = {}) => {
    auth.record('network', `${c.device}'s connection dropped and came back after ${((info.away || 0) / 1000).toFixed(1)} s, without restarting the stream.`, c.ip);
    if (c.transport === 'websocket') {
      // Settings sent while it was away were lost: send them again, then a fresh keyframe.
      if (lastWsConfig) server.send(c.id, { t: 'wsconfig', ...lastWsConfig });
      if (lastAudioConfig) server.send(c.id, { t: 'audioconfig', ...lastAudioConfig });
      capSend('cap:keyframe');
    }
    setLatency(c.latency);
  });
  server.on('latency', c => {
    capSend('cap:latency', { id: c.id, latency: c.latency });
    setLatency(c.latency);
  });

  server.on('start', (c, m) => {
    dbg('start', c.id, m.transport, c.latency);
    hostStats.delete(c.id);
    setLatency(c.latency);
    if (m.transport === 'websocket') {
      const codecs = Array.isArray(m.codecs) ? m.codecs.filter(x => ['H264', 'VP9', 'AV1', 'VP8'].includes(x)) : [];
      capSend('cap:start-ws', { id: c.id, codecs, latency: c.latency });
      if (lastAudioConfig) server.send(c.id, { t: 'audioconfig', ...lastAudioConfig });
    } else {
      capSend('cap:start-webrtc', { id: c.id, latency: c.latency });
    }
    updateAudio();
  });

  server.on('signal', (c, data) => capSend('cap:signal', { id: c.id, data }));
  server.on('input', (c, ev) => handleInput(c, ev));
  server.on('keyframe', () => capSend('cap:keyframe'));
  server.on('stats', () => {});

  server.on('quality', (c, m) => {
    const changes = {};
    const src = m.changes && typeof m.changes === 'object' ? m.changes : {};
    for (const k of QUALITY_KEYS) {
      if (!(k in src)) continue;
      const v = checkValue(`stream.${k}`, src[k]);
      if (v !== undefined) changes[k] = v;
    }
    if (!Object.keys(changes).length) return;
    const codecChanged = changes.codec && changes.codec !== live.codec;
    live = { ...live, ...changes };
    if (m.save) {
      const toSave = {};
      for (const [k, v] of Object.entries(changes)) toSave[`stream.${k}`] = v;
      config.update(toSave);
    }
    pushCaptureConfig();
    server.broadcast({ t: 'live', stream: live });
    if (codecChanged) for (const x of server.clients.values()) if (x.transport === 'webrtc') server.send(x.id, { t: 'restart', message: 'Switching codec...' });
    sendToWindow('beam:status', status());
  });

  server.on('display', (c, id) => {
    if (!screen.getAllDisplays().some(d => String(d.id) === String(id))) return;
    live.display = String(id);
    capSend('cap:reacquire');
    server.broadcast({ t: 'live', stream: live, display: String(id) });
  });

  server.on('clipboard', (c, text) => {
    if (!config.get('client.clipboardSync')) return;
    lastClipboard = text;
    writeClipboard(text);
  });
}

// The capture side follows the latency mode of whoever connected or changed it last.
function setLatency(mode) {
  if (!mode || !live || live.latency === mode) return;
  live.latency = mode;
  pushCaptureConfig();
}

// ------------------------------------------------------------------ Windows Firewall
// Other devices on the network can only connect if Windows Firewall lets this app accept
// connections on the kind of network the PC is on (Private / Public). Windows asks once;
// answering "Cancel" or only ticking one kind silently blocks phones on the Wi-Fi.
function runPowerShell(script) {
  return new Promise(resolve => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('exit', () => resolve(out.trim()));
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(null); }, 30000);
  });
}

const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;

async function checkFirewall() {
  if (process.platform !== 'win32') return firewall;
  if (config.get('server.bindAddress') === '127.0.0.1') { firewall = { state: 'ok', detail: 'Only this PC can connect, so the firewall doesn\'t matter.' }; return firewall; }
  const exe = process.execPath.toLowerCase();
  // Rules for this program, or for the web server's port; filters are read in bulk (fast).
  const out = await runPowerShell(`
    $exe = ${psQuote(exe)}
    $port = ${psQuote(String(config.get('server.port')))}
    $nets = @(Get-NetConnectionProfile | ForEach-Object { [string]$_.NetworkCategory })
    $byId = @{}
    Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | ForEach-Object { $byId[$_.InstanceID] = $_ }
    $rules = @()
    Get-NetFirewallApplicationFilter -All -ErrorAction SilentlyContinue | Where-Object { $_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program)).ToLower() -eq $exe } | ForEach-Object {
      $r = $byId[$_.InstanceID]; if ($r) { $rules += ([string]$r.Action + '|' + [string]$r.Profile) }
    }
    Get-NetFirewallPortFilter -All -ErrorAction SilentlyContinue | Where-Object { $_.Protocol -eq 'TCP' -and (@($_.LocalPort) -contains $port) } | ForEach-Object {
      $r = $byId[$_.InstanceID]; if ($r) { $rules += ([string]$r.Action + '|' + [string]$r.Profile) }
    }
    @{ nets = $nets; rules = $rules } | ConvertTo-Json -Compress`);
  let data = null;
  try { data = JSON.parse(out); } catch { firewall = { state: 'unknown' }; return firewall; }
  const nets = [...new Set([].concat(data.nets || []).filter(Boolean).map(n => (n === 'DomainAuthenticated' ? 'Domain' : n)))];
  const rules = [].concat(data.rules || []).map(r => { const [action, profile] = String(r).split('|'); return { action, profile } });
  const covers = (rule, net) => /Any/i.test(rule.profile) || new RegExp(net, 'i').test(rule.profile);
  const blocked = nets.filter(n => rules.some(r => /Block/i.test(r.action) && covers(r, n)) || !rules.some(r => /Allow/i.test(r.action) && covers(r, n)));
  firewall = blocked.length
    ? { state: 'blocked', nets: blocked, detail: `Windows Firewall stops other devices on your ${blocked.join('/').toLowerCase()} network from connecting to this PC.` }
    : { state: 'ok', nets, detail: 'Other devices on your network are allowed to connect.' };
  sendToWindow('beam:status', status());
  return firewall;
}

// Adds an allow rule for this app (the user approves the Windows administrator prompt).
function fixFirewall() {
  const exe = process.execPath;
  const inner = `
    $exe = ${psQuote(exe)}
    Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Block' } | Where-Object {
      $f = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue; $f -and $f.Program -and $f.Program.ToLower() -eq $exe.ToLower()
    } | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName ${psQuote(`${config.get('appearance.appName')} (stream page)`)} -Direction Inbound -Program $exe -Action Allow -Profile Any | Out-Null`;
  const enc = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`;
  return runPowerShell(outer).then(() => checkFirewall());
}

function checkValue(p, v) {
  const { normalize, set } = require('./config');
  const raw = {};
  set(raw, p, v);
  const { cfg, problems } = normalize(raw);
  if (problems.length) return undefined;
  return p.split('.').reduce((o, k) => o[k], cfg);
}

// Electron 45 made the clipboard asynchronous; older versions return the text directly.
async function readClipboard() {
  try { const r = clipboard.readText(); const t = typeof r === 'string' ? r : await r; return typeof t === 'string' ? t : ''; } catch { return ''; }
}
function writeClipboard(text) {
  try { Promise.resolve(clipboard.writeText(String(text))).catch(() => {}); } catch { /* ignore */ }
}

let clipBusy = false;
async function pollClipboard() {
  if (clipBusy) return;
  clipBusy = true;
  try {
    const t = await readClipboard();
    if (t && t !== lastClipboard) {
      lastClipboard = t;
      server.broadcast({ t: 'clipboard', text: t.slice(0, 100000) });
    }
  } finally { clipBusy = false; }
}

function tick() {
  if (server.clients.size && config.get('client.clipboardSync')) pollClipboard();
  if (win && !win.isDestroyed() && win.isVisible()) sendToWindow('beam:status', status());
}

// WebSocket mode only: lower the bitrate when frames have to be skipped, raise it back
// slowly when the connection keeps up. (WebRTC does this by itself.)
function adaptBitrate() {
  const ws = [...server.clients.values()].filter(c => c.transport === 'websocket');
  if (!ws.length) return;
  let dropped = 0;
  for (const c of ws) { dropped += c.dropped - (c.lastDropped || 0); c.lastDropped = c.dropped; }
  const before = wsScale;
  if (dropped > 3) { wsScale = Math.max(0.15, wsScale * 0.7); cleanRuns = 0; } else if (++cleanRuns >= 3 && wsScale < 1) { wsScale = Math.min(1, wsScale * 1.15); cleanRuns = 0; }
  if (wsScale !== before) capSend('cap:bitrate-scale', { scale: wsScale });
}

// CPU used by all of the app's processes (shown in Diagnostics; logged with BEAM_DEBUG).
let cpuNow = null;
function sampleCpu() {
  try {
    const m = app.getAppMetrics();
    const capPid = capWin && !capWin.isDestroyed() ? capWin.webContents.getOSProcessId() : -1;
    const by = {};
    let total = 0;
    for (const p of m) {
      const name = p.pid === capPid ? 'capture' : p.type;
      by[name] = Math.round(((by[name] || 0) + p.cpu.percentCPUUsage) * 10) / 10;
      total += p.cpu.percentCPUUsage;
    }
    cpuNow = { total: Math.round(total * 10) / 10, by };
    if (server && server.clients.size) dbg('cpu', JSON.stringify(cpuNow));
  } catch { /* ignore */ }
}

function updatePower() {
  const want = server.clients.size > 0 && config.get('app.keepAwake');
  if (want && powerId === null) powerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!want && powerId !== null) { powerSaveBlocker.stop(powerId); powerId = null; }
  updatePriority();
}

// While someone is connected, the processes that capture, encode and send the stream
// (and the sound helper) run "above normal", so a heavy game can't starve the stream.
let boosted = false;
function updatePriority() {
  const want = !!server && server.clients.size > 0 && config.get('app.streamPriority') === 'high';
  const level = want ? os.constants.priority.PRIORITY_ABOVE_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  if (want === boosted && !want) return;
  boosted = want;
  const pids = new Set([process.pid]);
  try {
    for (const m of app.getAppMetrics()) if (m.type === 'GPU' || m.type === 'Utility') pids.add(m.pid);
    if (capWin && !capWin.isDestroyed()) pids.add(capWin.webContents.getOSProcessId());
    if (sysAudio && sysAudio.proc && sysAudio.proc.pid) pids.add(sysAudio.proc.pid);
  } catch { /* ignore */ }
  for (const pid of pids) { try { os.setPriority(pid, level); } catch { /* ignore */ } }
}

function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ------------------------------------------------------------------ settings changes
function onConfigChanged(changed, fromFile) {
  if (changed.some(p => p.startsWith('server.'))) startServer();
  if (changed.some(p => p.startsWith('stream.'))) {
    if (!server.clients.size) resetLive();
    else for (const p of changed) if (p.startsWith('stream.')) live[p.slice(7)] = config.get(p);
    pushCaptureConfig();
    server.broadcast({ t: 'live', stream: live });
  }
  if (changed.includes('network.iceServers')) pushCaptureConfig();
  if (changed.includes('security.blockWinKey')) input.setOptions({ blockWinKey: config.get('security.blockWinKey') });
  if (changed.includes('app.startWithWindows')) applyLoginItem();
  if (changed.includes('app.keepAwake') || changed.includes('app.streamPriority')) updatePower();
  if (changed.some(p => p.startsWith('client.') || p.startsWith('appearance.') || p === 'presets' || p === 'security.allowControl')) {
    for (const c of server.clients.values()) server.send(c.id, { t: 'config', ...welcomeFor(c) });
  }
  if (changed.includes('appearance.theme') || changed.includes('appearance.accent')) applyTitleBar();
  sendToWindow('beam:state', state());
  if (fromFile) {
    sendToWindow('beam:toast', config.problems.length
      ? { kind: 'error', text: config.problems[0] }
      : { kind: 'ok', text: 'Settings reloaded from config.json.' });
  }
}

function applyLoginItem() {
  const open = config.get('app.startWithWindows');
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: open, args: ['--hidden'] });
    else app.setLoginItemSettings({ openAtLogin: open, path: process.execPath, args: [APP_DIR, '--hidden'] });
  } catch (e) { console.error('login item', e); }
}

// ------------------------------------------------------------------ tunnel
function startTunnel() {
  if (!auth.passwordSet) {
    sendToWindow('beam:toast', { kind: 'error', text: 'Choose a password first. Remote access stays off until the PC is protected.' });
    return;
  }
  const provider = config.get('network.tunnel');
  const opts = { provider, port: config.get('server.port'), command: config.get('network.tunnelCommand') };
  if (provider === 'cloudflare-domain') {
    const cf = auth.getSecret('cloudflare') || {};
    opts.hostname = cf.hostname || config.get('network.domain');
    if (cf.token) opts.token = cf.token;
    else if (cf.id && cf.credFile && fs.existsSync(cf.credFile)) {
      // Rewritten every start, so a changed port is picked up.
      opts.configFile = cloudflare.writeConfig({ dir: cfDir(), id: cf.id, credFile: cf.credFile, hostname: opts.hostname, port: opts.port });
    }
  }
  tunnel.start(opts);
}

const cfDir = () => path.join(app.getPath('userData'), 'cloudflare');

function domainState() {
  const cf = auth.getSecret('cloudflare');
  return { hostname: (cf && cf.hostname) || config.get('network.domain'), mode: cf ? (cf.token ? 'token' : cf.id ? 'named' : 'none') : 'none', tunnelId: cf ? (cf.id || cf.tunnelId || '') : '' };
}

let domainBusy = false;
async function setupDomain({ hostname, overwrite = false, forceLogin = false }) {
  const host = cloudflare.cleanHostname(hostname);
  if (!host) return { ok: false, error: 'That doesn\'t look like a web address. Use something like pc.yourdomain.com.' };
  if (!auth.passwordSet) return { ok: false, error: 'Choose a password first.' };
  if (domainBusy) return { ok: false, error: 'Setup is already running.' };
  domainBusy = true;
  const step = s => sendToWindow('beam:domain', s);
  try {
    tunnel.stop();
    step({ step: 'tool', message: 'Getting Cloudflare\'s tunnel tool ready…' });
    const bin = await tunnel.ensureCloudflared();
    tunnel.set({ state: 'stopped', message: '', progress: 0 });
    const r = await cloudflare.setupDomain({ bin, hostname: host, dir: cfDir(), overwrite, forceLogin, onStep: step });
    if (!r.ok) { step({ step: 'ask', message: r.message, needOverwrite: r.needOverwrite }); return r; }
    auth.setSecret('cloudflare', { hostname: host, id: r.id, name: r.name, credFile: r.credFile });
    config.update({ 'network.domain': host, 'network.tunnel': 'cloudflare-domain' });
    step({ step: 'done', message: `Done. ${host} now points to this PC.` });
    startTunnel();
    return { ok: true, hostname: host };
  } catch (e) {
    step({ step: 'error', message: e.message });
    return { ok: false, error: e.message };
  } finally {
    domainBusy = false;
    sendToWindow('beam:state', state());
  }
}

// ------------------------------------------------------------------ addresses
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = /tailscale/i.test(name) || (x === 100 && y >= 64 && y <= 127);
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker/i.test(name) && !tailscale) continue;
      out.push({ name, address: a.address, tailscale });
    }
  }
  return out;
}

function urls() {
  const port = config.get('server.port');
  const list = [{ kind: 'local', label: 'This PC', url: `http://localhost:${port}` }];
  if (config.get('server.bindAddress') !== '127.0.0.1') {
    for (const a of lanAddresses()) {
      list.push({ kind: a.tailscale ? 'tailscale' : 'lan', label: a.tailscale ? 'Tailscale' : `Home network (${a.name})`, url: `http://${a.address}:${port}` });
      if (server.status.https) list.push({ kind: a.tailscale ? 'tailscale' : 'lan', label: `${a.tailscale ? 'Tailscale' : 'Home network'} (HTTPS)`, url: `https://${a.address}:${config.get('server.httpsPort')}` });
    }
  }
  if (tunnel && tunnel.status.url) list.push({ kind: 'remote', label: config.get('network.tunnel') === 'cloudflare-domain' ? 'Anywhere (your domain)' : 'Anywhere (tunnel)', url: tunnel.status.url });
  const pub = config.get('network.publicUrl');
  if (pub) list.push({ kind: 'remote', label: 'Anywhere (your address)', url: pub });
  return list;
}

// ------------------------------------------------------------------ dashboard
function status() {
  return {
    server: server ? server.status : {},
    tunnel: tunnel ? tunnel.status : { state: 'stopped' },
    urls: server ? urls() : [],
    clients: server ? [...server.clients.values()].map(c => ({
      id: c.id, device: c.device, ip: c.ip, tunnel: c.tunnel, connectedAt: c.connectedAt, transport: c.transport,
      stats: c.stats, host: hostStats.get(c.id) || null, dropped: c.dropped,
      detached: !!c.detachedAt, latency: c.latency, resumes: c.resumes || 0,
    })) : [],
    live,
    wsScale,
    input: input.available(),
    audio: sysAudio ? sysAudio.status : { state: 'off' },
    cpu: cpuNow,
    update: updater ? updater.status : { state: 'disabled' },
    firewall,
  };
}

function state() {
  return {
    version: VERSION,
    config: config.get(),
    schema: SCHEMA,
    problems: config.problems,
    displays: displayList(),
    auth: { passwordSet: auth.passwordSet, totpEnabled: auth.totpEnabled, signedInOnce: !!auth.s.signedInOnce, sessions: auth.s.sessions.map(s => ({ id: s.id, device: s.device, ip: s.ip, created: s.created, expires: s.expires })) },
    userDir: app.getPath('userData'),
    domain: domainState(),
    defaults: DEFAULTS,
    customCss: readCustomCss(),
    capInfo,
    inputError: input.available() ? null : input.loadError(),
    packaged: app.isPackaged,
  };
}

function readCustomCss() {
  try { return fs.readFileSync(path.join(app.getPath('userData'), 'custom.css'), 'utf8').slice(0, 200000); } catch { return ''; }
}

function sendToWindow(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function themeColors() {
  const t = config.get('appearance.theme');
  const dark = t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? { bg: '#0b0c0e', fg: '#e7e8ea' } : { bg: '#efeff1', fg: '#17181b' };
}
function applyTitleBar() {
  if (!win || win.isDestroyed()) return;
  const c = themeColors();
  try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: c.fg, height: 40 }); } catch { /* ignore */ }
  win.setBackgroundColor(c.bg);
}

function showWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  const c = themeColors();
  win = new BrowserWindow({
    width: 1220, height: 820, minWidth: 900, minHeight: 600, show: false,
    title: config.get('appearance.appName'), icon: path.join(ASSETS, 'icon.png'), backgroundColor: c.bg,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: c.fg, height: 40 },
    // BEAM_SHOT_OFFSCREEN renders the dashboard off-screen (screenshots without a window popping up).
    webPreferences: { preload: path.join(__dirname, 'preload-app.js'), contextIsolation: true, sandbox: true, offscreen: !!process.env.BEAM_SHOT_OFFSCREEN },
  });
  win.loadFile(path.join(APP_DIR, 'src', 'app', 'index.html'));
  win.once('ready-to-show', async () => {
    if (!process.env.BEAM_SHOT_OFFSCREEN) win.show();
    // Developer aids: BEAM_DEV_SCRIPT runs a script in the dashboard, BEAM_SHOT_DIR saves pictures of it.
    if (process.env.BEAM_DEV_SCRIPT) {
      await new Promise(r => setTimeout(r, 1500));
      try { console.log('[dev-script]', JSON.stringify(await win.webContents.executeJavaScript(fs.readFileSync(process.env.BEAM_DEV_SCRIPT, 'utf8')))); } catch (e) { console.log('[dev-script] error', e.message); }
    }
    if (process.env.BEAM_SHOT_DIR) screenshotPages(process.env.BEAM_SHOT_DIR);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); openExternal(url); } });
  win.on('close', e => {
    if (quitting || !config.get('app.closeToTray')) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: config.get('appearance.appName'), body: 'Still running in the tray, so you can connect any time. Right-click the tray icon to quit.', icon: path.join(ASSETS, 'icon.png') }).show();
    }
  });
  win.on('closed', () => { win = null; if (!config.get('app.closeToTray') && !quitting) quit(); });
}

function openExternal(url) {
  if (process.env.BEAM_NO_BROWSER) { console.log('[open]', url); return; }
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

// Developer aid: BEAM_SHOT_DIR=<folder> saves a picture of every dashboard page.
async function screenshotPages(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(Number(process.env.BEAM_SHOT_DELAY) || 1500);
  const shot = async name => fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  if (!auth.passwordSet) { await shot('wizard'); return; }
  // An entry like "security#embed-box" also scrolls that element into view.
  for (const entry of (process.env.BEAM_SHOT_PAGES || 'home,remote,quality,security,browser,appearance,app,guide').split(',')) {
    const [id, sel] = entry.split('#');
    await win.webContents.executeJavaScript(`document.querySelector('[data-page="${id}"]').click()`);
    await wait(700);
    if (sel) { await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`); await wait(300); }
    await shot(sel ? `${id}-${sel}` : id);
  }
  console.log('[shots] saved to', dir);
}

function trayImage() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16, quality: 'best' });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const n = server ? server.clients.size : 0;
  const t = tunnel ? tunnel.status : { state: 'stopped' };
  const name = config.get('appearance.appName');
  const line = n ? `Streaming to ${n} device${n > 1 ? 's' : ''}` : auth.passwordSet ? 'Ready' : 'Not set up yet';
  tray.setToolTip(`${name}: ${line}${t.state === 'online' ? ' · remote access on' : ''}`);
  const items = [
    { label: `${name}: ${line}`, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: showWindow },
    { label: 'Open stream page in browser', click: () => openExternal(`http://localhost:${config.get('server.port')}`) },
  ];
  if (t.url) items.push({ label: 'Copy remote link', click: () => writeClipboard(t.url) });
  if (config.get('network.tunnel') !== 'none') {
    items.push(t.state === 'stopped' || t.state === 'error'
      ? { label: 'Turn on remote access', click: startTunnel }
      : { label: 'Turn off remote access', click: () => tunnel.stop() });
  }
  if (n) items.push({ label: 'Disconnect all devices', click: () => server.kickAll('The PC owner ended the session.') });
  const u = updater ? updater.status : {};
  if (u.state === 'ready') items.push({ type: 'separator' }, { label: `Restart to update to ${u.latest}`, click: () => updater.installNow() });
  items.push({ type: 'separator' }, { label: 'Quit', click: quit });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function quit() {
  quitting = true;
  try { sysAudio && sysAudio.stop(); } catch { /* ignore */ }
  try { tunnel && tunnel.stop(true); } catch { /* ignore */ }
  try { input.releaseAll(); } catch { /* ignore */ }
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  try { sysAudio && sysAudio.stop(); } catch { /* ignore */ }
  try { tunnel && tunnel.stop(true); } catch { /* ignore */ }
});
app.on('window-all-closed', () => { /* keep running in the tray */ });

// ------------------------------------------------------------------ dashboard API
const fromApp = e => win && e.sender === win.webContents;
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...args) => {
    if (!fromApp(e)) throw new Error('not allowed');
    return fn(...args);
  });
}

handle('beam:getState', () => ({ ...state(), status: status(), log: auth.log.slice(0, 100) }));
handle('beam:updateConfig', changes => ({ changed: config.update(changes) }));
handle('beam:resetConfig', () => { config.reset(); return true; });
handle('beam:setPassword', pw => {
  try { auth.setPassword(pw); server.kickAll('The password was changed. Sign in again.'); sendToWindow('beam:state', state()); updateTray(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
handle('beam:totpStart', async () => {
  const t = auth.startTotp(config.get('appearance.appName'));
  return { ...t, qr: await QRCode.toDataURL(t.uri, { margin: 1, width: 220 }) };
});
handle('beam:totpConfirm', code => { const ok = auth.confirmTotp(code); sendToWindow('beam:state', state()); return ok; });
handle('beam:totpDisable', () => { auth.disableTotp(); sendToWindow('beam:state', state()); return true; });
handle('beam:signOutAll', () => { auth.signOutAll(); server.kickAll('You were signed out from the PC.'); sendToWindow('beam:state', state()); return true; });
handle('beam:kick', id => { server.kick(id, 'The PC owner disconnected you.'); return true; });
handle('beam:tunnelStart', () => { startTunnel(); return true; });
handle('beam:tunnelStop', () => { tunnel.stop(); return true; });
handle('beam:tunnelLog', () => tunnel.lines.slice(-60));
handle('beam:domainSetup', opts => setupDomain(opts || {}));
handle('beam:domainToken', ({ token, hostname } = {}) => {
  const host = cloudflare.cleanHostname(hostname);
  if (!host) return { ok: false, error: 'Enter the address you set up in Cloudflare, e.g. pc.yourdomain.com.' };
  const t = cloudflare.parseToken(token);
  if (!t) return { ok: false, error: 'No tunnel token found. Paste Cloudflare\'s install command, or just the long code in it that starts with "ey".' };
  auth.setSecret('cloudflare', { hostname: host, token: t.token, tunnelId: t.tunnelId });
  config.update({ 'network.domain': host, 'network.tunnel': 'cloudflare-domain' });
  startTunnel();
  sendToWindow('beam:state', state());
  return { ok: true };
});
handle('beam:domainForget', () => {
  tunnel.stop();
  auth.setSecret('cloudflare', null);
  config.update({ 'network.tunnel': 'cloudflare' });
  sendToWindow('beam:state', state());
  return true;
});
handle('beam:qr', text => QRCode.toDataURL(String(text).slice(0, 500), { margin: 1, width: 240, color: { dark: '#0b0d13', light: '#ffffff' } }));
handle('beam:openExternal', url => { openExternal(url); return true; });
handle('beam:copy', text => { writeClipboard(text); return true; });
handle('beam:capLog', () => capLog.slice(-120));
handle('beam:openPath', which => {
  const dir = app.getPath('userData');
  const map = { folder: dir, config: path.join(dir, 'config.json'), css: path.join(dir, 'custom.css'), log: path.join(dir, 'security-log.txt') };
  const p = map[which];
  if (!p) return false;
  if (!fs.existsSync(p) && which === 'log') fs.writeFileSync(p, '');
  if (which === 'folder') shell.openPath(p); else shell.openPath(p).then(err => { if (err) shell.showItemInFolder(p); });
  return true;
});
handle('beam:exportConfig', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Export settings', defaultPath: 'beam-remote-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(config.get(), null, 2));
  return true;
});
handle('beam:importConfig', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import settings', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  try {
    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const { normalize } = require('./config');
    const { cfg, problems } = normalize(raw);
    config.cfg = cfg; config.save(); config.emit(Object.keys(SCHEMA).concat('presets'));
    return { ok: true, problems };
  } catch (e) { return { ok: false, error: e.message }; }
});
handle('beam:restartAdmin', () => {
  const args = app.isPackaged ? [] : [APP_DIR];
  if (dataArg) args.push(dataArg);
  const list = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
  const cmd = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' ${list ? `-ArgumentList ${list}` : ''} -Verb RunAs`;
  app.releaseSingleInstanceLock();
  const p = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], { windowsHide: true, detached: true, stdio: 'ignore' });
  p.on('exit', code => { if (code === 0) quit(); else app.requestSingleInstanceLock(); });
  return true;
});
handle('beam:testInBrowser', () => { openExternal(`http://localhost:${config.get('server.port')}`); return true; });
// Opens a page on 127.0.0.1 that frames the given address (a different site from "localhost"),
// so embedding can be tried exactly like another website would do it.
handle('beam:embedTest', url => {
  const port = config.get('server.port');
  const src = /^https?:\/\//i.test(String(url || '')) ? String(url) : `http://localhost:${port}/`;
  openExternal(`http://127.0.0.1:${port}/embed-test?src=${encodeURIComponent(src)}`);
  return true;
});
handle('beam:updateCheck', () => updater.check(true));
handle('beam:updateDownload', () => { updater.download(); return true; });
handle('beam:updateInstall', () => updater.installNow());
handle('beam:firewallCheck', () => checkFirewall());
handle('beam:firewallFix', () => fixFirewall());
handle('beam:quit', () => { quit(); return true; });
