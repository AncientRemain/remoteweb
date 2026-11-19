// Privacy screen: while someone streams, this PC's own monitors can show a cover (black,
// dimmed, a message, a clock, a picture or a floating logo) instead of what's happening.
//
// How it stays out of the stream: each cover window is marked "exclude from capture"
// (SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+), so screen capture,
// and therefore the stream, sees the real screen underneath. The window ignores the mouse
// and never takes focus, so clicks and keys (from the stream or the PC) reach the apps below.
// Someone at the PC can press Ctrl+Alt+Shift+H to see the screen again for this session.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, screen, globalShortcut } = require('electron');

const MODES = ['normal', 'black', 'dim', 'message', 'clock', 'picture', 'logo'];
const LABELS = { normal: 'Normal', black: 'Black', dim: 'Dimmed', message: 'A message', clock: 'A clock', picture: 'A picture', logo: 'Floating logo' };
const PEEK_KEY = 'Control+Alt+Shift+H';
const DEFAULT_MESSAGE = 'This PC is being used remotely.';

// Leaving a window out of capture needs Windows 10 version 2004 (build 19041) or newer;
// older versions would show the cover as a black box in the stream instead.
function isSupported() {
  if (process.platform !== 'win32') return false;
  const build = Number(String(process.getSystemVersion ? process.getSystemVersion() : '').split('.')[2] || 0);
  return build >= 19041;
}

class PrivacyScreen {
  constructor({ appDir, userDir, getConfig, getSession, getStreamedDisplay, onPeek = () => {}, log = () => {} }) {
    this.appDir = appDir;
    this.userDir = userDir;
    this.getConfig = getConfig;
    this.getSession = getSession;           // -> { device, since } while a device is streaming, else null
    this.getStreamedDisplay = getStreamedDisplay;
    this.onPeek = onPeek;
    this.log = log;
    this.supported = isSupported();
    this.wins = new Map();                  // display id -> BrowserWindow
    this.override = null;                   // the streaming device's choice, for this session only
    this.peek = false;
    this.test = null;                       // { mode, until } while "Try it" runs
    this.keyOn = false;
    this.topTimer = null;
  }

  chosen() { return this.override || this.getConfig('privacy.screen'); }

  pictureFile() {
    const p = this.getConfig('privacy.picture');
    if (!p) return null;
    const file = path.isAbsolute(p) ? p : path.join(this.userDir, p);
    return fs.existsSync(file) ? file : null;
  }

  mode() {
    if (!this.supported) return 'normal';
    if (this.test && Date.now() < this.test.until) return this.test.mode;
    if (!this.getSession() || this.peek) return 'normal';
    const m = this.chosen();
    return m === 'picture' && !this.pictureFile() ? 'black' : m;
  }

  // What the stream page needs to draw its menu.
  publicState() {
    return {
      mode: this.chosen(), peek: this.peek, picture: !!this.pictureFile(),
      allow: this.supported && !!this.getConfig('privacy.browserCanChange'),
      choices: MODES.filter(m => m !== 'picture' || this.pictureFile()).map(m => ({ id: m, label: LABELS[m] })),
    };
  }

  setOverride(mode) {
    if (!MODES.includes(mode)) return false;
    if (mode === 'picture' && !this.pictureFile()) return false;
    this.override = mode;
    this.peek = false;
    this.update();
    return true;
  }

  endSession() { this.override = null; this.peek = false; this.update(); }

  tryMode(mode, ms = 6000) {
    if (!this.supported || !MODES.includes(mode) || mode === 'normal') return false;
    this.test = { mode, until: Date.now() + ms };
    clearTimeout(this.testTimer);
    this.testTimer = setTimeout(() => { this.test = null; this.update(); }, ms + 50);
    this.update();
    return true;
  }

  // Ctrl+Alt+Shift+H at the PC: uncover (or cover again) until this session ends.
  togglePeek() {
    if (this.test) { this.test = null; this.update(); return; }
    this.peek = !this.peek;
    this.update();
    this.onPeek(this.peek);
  }

  setKey(on) {
    if (on === this.keyOn) return;
    this.keyOn = on;
    try {
      if (on) { if (!globalShortcut.register(PEEK_KEY, () => this.togglePeek())) this.log('privacy screen: shortcut is taken by another app'); }
      else globalShortcut.unregister(PEEK_KEY);
    } catch (e) { this.log(`privacy screen shortcut: ${e.message}`); }
  }

  stateFor(mode) {
    const s = this.getSession();
    const pic = mode === 'picture' ? this.pictureFile() : null;
    let picture = '';
    if (pic) { try { picture = `${pathToFileURL(pic).href}?v=${Math.round(fs.statSync(pic).mtimeMs)}`; } catch { /* gone */ } }
    return {
      mode,
      message: this.getConfig('privacy.message') || DEFAULT_MESSAGE,
      device: s && this.getConfig('privacy.showDevice') ? s.device : '',
      since: s ? s.since : 0,
      appName: this.getConfig('appearance.appName'),
      picture,
      hint: 'Ctrl + Alt + Shift + H shows the screen on this monitor',
    };
  }

  update() {
    const mode = this.mode();
    const covering = !!this.getSession() && this.chosen() !== 'normal';
    this.setKey(covering || !!this.test);
    if (mode === 'normal') { this.closeAll(); return; }

    const displays = this.getConfig('privacy.screens') === 'streamed' ? [this.getStreamedDisplay()] : screen.getAllDisplays();
    const want = new Set(displays.map(d => String(d.id)));
    for (const [id, w] of this.wins) if (!want.has(id)) { this.wins.delete(id); if (!w.isDestroyed()) w.destroy(); }

    const transparent = mode === 'dim';
    const state = this.stateFor(mode);
    for (const d of displays) {
      const id = String(d.id);
      let w = this.wins.get(id);
      if (w && (w.isDestroyed() || w.coverTransparent !== transparent)) { if (!w.isDestroyed()) w.destroy(); w = null; }
      if (!w) { w = this.open(d, transparent); this.wins.set(id, w); }
      w.setBounds(d.bounds);
      w.coverState = state;
      if (w.coverLoaded) w.webContents.send('cover:state', state);
    }
    // Some programs push themselves to the front now and then: stay on top.
    if (!this.topTimer) {
      this.topTimer = setInterval(() => {
        for (const w of this.wins.values()) if (!w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver');
      }, 4000);
    }
  }

  open(d, transparent) {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      show: false, frame: false, transparent, backgroundColor: transparent ? '#00000000' : '#000000',
      focusable: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, hasShadow: false, alwaysOnTop: true, enableLargerThanScreen: true, title: 'Privacy screen',
      webPreferences: { preload: path.join(__dirname, 'preload-cover.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    w.coverTransparent = transparent;
    w.setContentProtection(true);         // left out of every screen capture, so never in the stream
    w.setIgnoreMouseEvents(true);         // clicks go through to the apps underneath
    w.setAlwaysOnTop(true, 'screen-saver');
    w.webContents.on('did-finish-load', () => {
      w.coverLoaded = true;
      if (w.coverState) w.webContents.send('cover:state', w.coverState);
    });
    w.once('ready-to-show', () => { if (!w.isDestroyed()) { w.setBounds(d.bounds); w.showInactive(); } });
    w.loadFile(path.join(this.appDir, 'src', 'cover', 'cover.html'));
    return w;
  }

  closeAll() {
    clearInterval(this.topTimer);
    this.topTimer = null;
    for (const w of this.wins.values()) if (!w.isDestroyed()) w.destroy();
    this.wins.clear();
  }
}

module.exports = { PrivacyScreen, MODES, LABELS, isSupported };
