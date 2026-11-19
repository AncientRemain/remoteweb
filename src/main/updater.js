// Updates from GitHub releases (github.com/AncientRemain/remoteweb) via electron-updater.
// Each release carries latest.yml + the installer; the app checks every few hours.
//
// Remote-access rules: never download while someone is streaming (it would eat their
// bandwidth), and in "auto" mode only install after nobody has been connected for a few
// minutes. The installer runs silently and starts the app again by itself (with --updated).
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELEASES = 'https://github.com/AncientRemain/remoteweb/releases';
const CHECK_EVERY = 4 * 60 * 60 * 1000;
const QUIET_BEFORE_INSTALL = 3 * 60 * 1000;

class Updater extends EventEmitter {
  constructor({ app, version, getMode, isBusy, beforeInstall, log = () => {} }) {
    super();
    this.app = app;
    this.getMode = getMode;
    this.isBusy = isBusy;
    this.beforeInstall = beforeInstall;
    this.log = log;
    this.lastBusyAt = 0;
    this.status = { state: 'idle', current: version, latest: null, progress: 0, message: '', checkedAt: 0, url: RELEASES };
    this.au = null;
    this.downloading = false;
    this.installing = false;
  }

  set(patch) { this.status = { ...this.status, ...patch }; this.emit('status', this.status); }

  // Updates only work in the installed app (not when running from source).
  get available() { return !!this.au; }

  start() {
    const feed = process.env.BEAM_UPDATE_URL; // testing: a folder served over http with latest.yml
    if (!this.app.isPackaged && !feed) {
      this.set({ state: 'disabled', message: 'Updates are checked only in the installed app.' });
      return;
    }
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch (e) {
      this.set({ state: 'disabled', message: `Updater unavailable: ${e.message}` });
      return;
    }
    this.au = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true; // a downloaded update also installs whenever the app quits
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = { info: m => this.log('[update]', m), warn: m => this.log('[update] warn', m), error: m => this.log('[update] error', m), debug: () => {} };
    if (feed) {
      // Testing only: a local folder with latest.yml, and a separate download cache.
      const file = path.join(os.tmpdir(), 'beam-remote-test-update.yml');
      fs.writeFileSync(file, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: beam-remote-updater-test\n`);
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.updateConfigPath = file;
    }

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: '' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'uptodate', latest: this.status.current, checkedAt: Date.now(), message: '' }));
    autoUpdater.on('update-available', info => {
      this.set({ state: 'available', latest: info.version, checkedAt: Date.now(), message: '' });
      this.proceed();
    });
    autoUpdater.on('download-progress', p => this.set({ state: 'downloading', progress: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', info => {
      this.downloading = false;
      this.set({ state: 'ready', latest: info.version, progress: 100, message: '' });
      this.proceed();
    });
    autoUpdater.on('error', e => {
      this.downloading = false;
      this.installing = false; // e.g. the installer couldn't start: the app just keeps running
      const msg = String(e && e.message || e);
      // No releases yet / offline aren't worth alarming anyone about.
      const quiet = /404|No published versions|net::ERR_|ENOTFOUND|ETIMEDOUT|ECONNRESET|getaddrinfo/i.test(msg);
      this.set({ state: quiet ? 'uptodate' : 'error', checkedAt: Date.now(), message: quiet ? '' : msg.split('\n')[0].slice(0, 200) });
    });

    setTimeout(() => this.check(), 20000);
    setInterval(() => this.check(), CHECK_EVERY);
    setInterval(() => this.proceed(), 30000);
  }

  async check(manual = false) {
    if (!this.au || this.installing) return this.status;
    if (this.getMode() === 'off' && !manual) return this.status;
    if (this.status.state === 'downloading' || this.status.state === 'ready') return this.status;
    try { await this.au.checkForUpdates(); } catch { /* reported through the error event */ }
    return this.status;
  }

  // Moves an available update along, depending on the setting and whether anyone is connected.
  proceed() {
    if (!this.au || this.installing) return;
    const busy = this.isBusy();
    if (busy) this.lastBusyAt = Date.now();
    const mode = this.getMode();
    if (this.status.state === 'available' && !this.downloading && !busy && (mode === 'auto' || mode === 'download')) this.download();
    if (this.status.state === 'ready' && mode === 'auto' && !busy && Date.now() - this.lastBusyAt > QUIET_BEFORE_INSTALL) this.installNow();
  }

  async download() {
    if (!this.au || this.downloading) return;
    this.downloading = true;
    this.set({ state: 'downloading', progress: 0 });
    try { await this.au.downloadUpdate(); } catch { this.downloading = false; }
  }

  installNow() {
    if (!this.au || this.status.state !== 'ready' || this.installing) return false;
    this.installing = true;
    this.set({ state: 'installing', message: '' });
    if (process.env.BEAM_UPDATE_DRYRUN) { this.log('[update] dry run: would install now'); return true; }
    try { this.beforeInstall(); } catch { /* ignore */ }
    // Silent install, then the installer starts the app again (with --updated).
    setTimeout(() => this.au.quitAndInstall(true, true), 500);
    return true;
  }
}

module.exports = { Updater, RELEASES };
