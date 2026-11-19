// Remote access from outside the home network.
//  - Cloudflare quick tunnel: free, no account, one click. Runs cloudflared (downloaded on
//    first use from Cloudflare's official GitHub releases) and shows the https link it gets.
//  - Custom command: any tunnel tool (ngrok, a named Cloudflare tunnel, ...). The first
//    https:// address it prints becomes the link.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const QUICK_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const ANY_RE = /https:\/\/[^\s"'<>`|]+/gi;
const NOISE = /(github\.com|cloudflare\.com\/|developers\.cloudflare|ngrok\.com\/(docs|download|signup)|dashboard\.ngrok|tailscale\.com\/kb|go\.dev|golang\.org)/i;

function findUrl(text, quickOnly) {
  if (quickOnly) { const m = text.match(QUICK_RE); return m ? m[0] : null; }
  const q = text.match(QUICK_RE);
  if (q) return q[0];
  for (const m of text.matchAll(ANY_RE)) {
    const url = m[0].replace(/[).,;\]]+$/, '');
    if (!NOISE.test(url)) return url;
  }
  return null;
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'BeamRemote' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.on('data', c => { got += c.length; if (total) onProgress(got / total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try {
          if (got < 1_000_000) throw new Error('Downloaded file is too small');
          fs.renameSync(tmp, dest); resolve(dest);
        } catch (e) { reject(e); }
      }));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Download timed out')));
  });
}

function which(name) {
  return new Promise(resolve => {
    execFile('where.exe', [name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).find(l => l.trim());
      resolve(first ? first.trim() : null);
    });
  });
}

class Tunnel extends EventEmitter {
  constructor(binDir) {
    super();
    this.binDir = binDir;
    this.proc = null;
    this.wanted = false;
    this.status = { state: 'stopped', url: null, message: '', progress: 0 };
    this.lines = [];
    this.restartDelay = 3000;
  }

  set(patch) { this.status = { ...this.status, ...patch }; this.emit('status', this.status); }

  async findCloudflared() {
    const candidates = [
      path.join(this.binDir, 'cloudflared.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    return which('cloudflared');
  }

  async ensureCloudflared() {
    const found = await this.findCloudflared();
    if (found) return found;
    fs.mkdirSync(this.binDir, { recursive: true });
    this.set({ state: 'downloading', message: 'Downloading Cloudflare tunnel tool (about 40 MB, first time only)...', progress: 0 });
    const dest = path.join(this.binDir, 'cloudflared.exe');
    let last = 0;
    await download(CLOUDFLARED_URL, dest, p => {
      if (p - last > 0.02 || p === 1) { last = p; this.set({ progress: p }); }
    });
    return dest;
  }

  // opts: { provider: 'cloudflare'|'cloudflare-domain'|'custom', port, command,
  //         hostname, token, configFile }   (the last three for your own domain)
  async start(opts) {
    this.stop(true);
    this.wanted = true;
    this.opts = opts;
    this.lines = [];
    try {
      let cmd, args, shell = false, quickOnly = false, env = process.env, domainUrl = null;
      if (opts.provider === 'cloudflare') {
        cmd = await this.ensureCloudflared();
        if (!this.wanted) return;
        args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${opts.port}`];
        quickOnly = true;
      } else if (opts.provider === 'cloudflare-domain') {
        if (!opts.hostname || (!opts.token && !opts.configFile)) throw new Error('Your domain isn\'t set up yet. Enter your address and press Connect.');
        cmd = await this.ensureCloudflared();
        if (!this.wanted) return;
        domainUrl = `https://${opts.hostname}`;
        if (opts.token) {
          // The token goes in the environment, not the command line, so other programs can't read it.
          env = { ...process.env, TUNNEL_TOKEN: opts.token };
          args = ['tunnel', '--no-autoupdate', 'run'];
        } else {
          args = ['tunnel', '--no-autoupdate', '--config', opts.configFile, 'run'];
        }
      } else if (opts.provider === 'custom') {
        if (!opts.command || !opts.command.trim()) throw new Error('No custom tunnel command is set. Add one in Remote access.');
        cmd = opts.command.replace(/\{port\}/g, String(opts.port));
        args = [];
        shell = true;
      } else {
        throw new Error('Remote access method is set to "None".');
      }
      this.set({ state: 'starting', url: null, message: 'Starting the tunnel...', progress: 0 });
      const proc = spawn(cmd, args, { shell, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      const onData = buf => {
        const text = buf.toString();
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.lines.push(line.replace(/\x1b\[[0-9;]*m/g, ''));
        if (this.lines.length > 80) this.lines.splice(0, this.lines.length - 80);
        if (domainUrl) {
          if (!this.status.url && /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(text)) {
            this.restartDelay = 3000;
            this.set({ state: 'online', url: domainUrl, message: `Remote access is on at ${opts.hostname}.` });
          } else if (/Unauthorized|invalid (tunnel )?token|credentials file .* (doesn't|does not) exist|tunnel not found|Cannot determine default origin certificate/i.test(text)) {
            this.set({ state: 'error', url: null, message: 'Cloudflare rejected this tunnel. Set your domain up again (press Connect) or paste a fresh token.' });
          }
          return;
        }
        if (!this.status.url) {
          const url = findUrl(text.replace(/\x1b\[[0-9;]*m/g, ''), quickOnly);
          if (url) { this.restartDelay = 3000; this.set({ state: 'online', url, message: 'Remote access is on.' }); }
        }
        if (/failed to request quick Tunnel|error=.*(unauthorized|429|Too Many)/i.test(text) && !this.status.url) {
          this.set({ state: 'error', message: 'Cloudflare refused a quick tunnel right now. Wait a minute and press Start again.' });
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', e => this.set({ state: 'error', message: `Could not start the tunnel: ${e.message}` }));
      proc.on('exit', code => {
        if (this.proc !== proc) return;
        this.proc = null;
        if (!this.wanted) return;
        if (this.status.state === 'error') { this.wanted = false; return; } // a setup problem: retrying won't help
        this.set({ state: 'starting', url: null, message: `Tunnel stopped (code ${code}). Restarting in ${Math.round(this.restartDelay / 1000)} s...` });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { if (this.wanted) this.start(this.opts); }, this.restartDelay);
        this.restartDelay = Math.min(this.restartDelay * 2, 60000);
      });
      // Custom tools that never print a link (e.g. a named tunnel) still count as running.
      setTimeout(() => {
        if (this.proc === proc && !this.status.url && this.status.state === 'starting' && opts.provider === 'custom') {
          this.set({ state: 'online', url: null, message: 'Your command is running. Its address was not printed; set "My fixed public address" to show it here.' });
        }
      }, 15000);
    } catch (e) {
      this.wanted = false;
      this.set({ state: 'error', message: e.message, url: null });
    }
  }

  stop(silent = false) {
    this.wanted = false;
    clearTimeout(this.timer);
    const p = this.proc;
    this.proc = null;
    if (p && p.pid) {
      try { execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
      try { p.kill(); } catch { /* ignore */ }
    }
    if (!silent) this.set({ state: 'stopped', url: null, message: '', progress: 0 });
  }
}

module.exports = { Tunnel, findUrl };
