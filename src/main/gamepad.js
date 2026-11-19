// Game controllers. A controller held at the viewing device (any browser with the Gamepad
// API: Chromebooks, phones, tablets, Macs, other PCs), or the stream page's on-screen
// controller, becomes a virtual Xbox 360 controller on this PC through beam-pad.exe and the
// ViGEmBus driver. Up to 4 at once; games see them as real controllers, with vibration.
//
// The driver is installed once on this PC (installDriver, run from the app; Windows asks
// for administrator approval). The viewing devices need nothing installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const readline = require('readline');

const MAX_PADS = 4;
const DRIVER_URL = 'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe';
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

class Gamepads extends EventEmitter {
  constructor({ exe, log = () => {}, spawnFn = spawn }) {
    super();
    this.exe = exe;
    this.log = log;
    this.spawnFn = spawnFn;
    this.proc = null;
    this.driver = 'unknown';   // ready | missing | error | unknown
    this.pads = new Map();     // slot (0-3) -> { clientId, index, name, seq, player, plugged }
    this.queue = [];           // lines waiting for the helper to be ready
    this.restartTimer = null;
  }

  status() {
    return {
      driver: this.driver,
      pads: [...this.pads.entries()].map(([slot, p]) => ({ slot, player: p.player, name: p.name, clientId: p.clientId, index: p.index, plugged: p.plugged })),
    };
  }

  setDriver(d) {
    if (this.driver === d) return;
    this.driver = d;
    this.emit('status', this.status());
  }

  // Starts the helper (also how the app learns whether the driver is installed).
  ensure() {
    if (this.proc) return;
    let p;
    try { p = this.spawnFn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) {
      this.log('[pads] could not start helper', e.message);
      this.setDriver('error');
      return;
    }
    this.proc = p;
    p.on('error', e => { this.log('[pads] helper error', e.message); if (this.proc === p) this.proc = null; this.setDriver('error'); });
    p.on('exit', code => {
      if (this.proc !== p) return;
      this.proc = null;
      if (code === 2) { this.failAll('nodriver'); this.setDriver('missing'); return; }
      // Crashed with controllers in use: start again and plug them back in.
      for (const pad of this.pads.values()) pad.plugged = false;
      if (this.pads.size && !this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.ensure();
          for (const slot of this.pads.keys()) this.send(`plug ${slot}`);
        }, 1000);
      }
    });
    if (p.stdin) p.stdin.on('error', () => {});
    readline.createInterface({ input: p.stdout }).on('line', line => this.onLine(line));
  }

  send(line) {
    if (this.proc && this.driver === 'ready') { try { this.proc.stdin.write(`${line}\n`); } catch { /* restarting */ } return; }
    // Before "ready", keep only what matters: plug/unplug commands and the latest state per slot.
    if (line.startsWith('state ')) { const slot = line.split(' ')[1]; this.queue = this.queue.filter(l => !l.startsWith(`state ${slot} `)); }
    this.queue.push(line);
    if (this.queue.length > 64) this.queue.shift();
    this.ensure();
  }

  onLine(line) {
    const [cmd, a, b, c] = String(line).trim().split(' ');
    if (cmd === 'ready') {
      this.setDriver('ready');
      const q = this.queue; this.queue = [];
      for (const l of q) this.send(l);
    } else if (cmd === 'nodriver') {
      this.failAll('nodriver');
      this.setDriver('missing');
    } else if (cmd === 'plugged') {
      const pad = this.pads.get(+a);
      if (!pad) return;
      pad.plugged = true;
      pad.player = +b || 0;
      this.emit('pad', { clientId: pad.clientId, index: pad.index, player: pad.player });
      this.emit('status', this.status());
    } else if (cmd === 'error') {
      const pad = this.pads.get(+a);
      if (!pad) return;
      this.pads.delete(+a);
      this.emit('pad', { clientId: pad.clientId, index: pad.index, error: b || 'failed' });
      this.emit('status', this.status());
    } else if (cmd === 'rumble') {
      const pad = this.pads.get(+a);
      if (pad) this.emit('rumble', { clientId: pad.clientId, index: pad.index, large: +b || 0, small: +c || 0 });
    }
  }

  failAll(error) {
    const pads = [...this.pads.values()];
    this.pads.clear();
    this.queue = [];
    for (const p of pads) this.emit('pad', { clientId: p.clientId, index: p.index, error });
  }

  slotOf(clientId, index) {
    for (const [slot, p] of this.pads) if (p.clientId === clientId && p.index === index) return slot;
    return -1;
  }

  // A controller showed up on a viewing device.
  connect(clientId, index, name) {
    index = clampInt(index, 0, 255);
    const have = this.slotOf(clientId, index);
    if (have >= 0) {
      const pad = this.pads.get(have);
      pad.seq = -1; // the page starts counting again after a reconnect
      if (pad.plugged) this.emit('pad', { clientId, index, player: pad.player });
      return;
    }
    if (this.driver === 'missing') { this.emit('pad', { clientId, index, error: 'nodriver' }); return; }
    const slot = [0, 1, 2, 3].find(s => !this.pads.has(s));
    if (slot === undefined) { this.emit('pad', { clientId, index, error: 'full' }); return; }
    this.pads.set(slot, { clientId, index, name: String(name || 'Controller').slice(0, 60), seq: -1, player: 0, plugged: false });
    this.send(`plug ${slot}`);
    this.emit('status', this.status());
  }

  // Full controller state: buttons (XInput bits), triggers 0-255, sticks -32768..32767.
  update(clientId, index, seq, st) {
    const slot = this.slotOf(clientId, clampInt(index, 0, 255));
    if (slot < 0 || !Array.isArray(st) || st.length < 7) return;
    const pad = this.pads.get(slot);
    seq = Number(seq);
    // Fast messages can arrive out of order; an older state must never overwrite a newer one.
    if (Number.isFinite(seq) && seq <= pad.seq && pad.seq - seq < 100000) return;
    if (Number.isFinite(seq)) pad.seq = seq;
    const [buttons, lt, rt, lx, ly, rx, ry] = st;
    this.send(`state ${slot} ${clampInt(buttons, 0, 0xFFFF)} ${clampInt(lt, 0, 255)} ${clampInt(rt, 0, 255)} ${clampInt(lx, -32768, 32767)} ${clampInt(ly, -32768, 32767)} ${clampInt(rx, -32768, 32767)} ${clampInt(ry, -32768, 32767)}`);
  }

  disconnect(clientId, index) {
    const slot = this.slotOf(clientId, clampInt(index, 0, 255));
    if (slot < 0) return;
    this.pads.delete(slot);
    this.send(`unplug ${slot}`);
    this.emit('status', this.status());
  }

  // Connection hiccup: let go of everything this device was holding, keep the controllers.
  neutral(clientId) {
    for (const [slot, p] of this.pads) if (p.clientId === clientId) this.send(`state ${slot} 0 0 0 0 0 0 0`);
  }

  // The device left: unplug its controllers.
  releaseClient(clientId) {
    for (const [slot, p] of [...this.pads]) {
      if (p.clientId !== clientId) continue;
      this.pads.delete(slot);
      this.send(`unplug ${slot}`);
    }
    this.emit('status', this.status());
  }

  // After the driver was installed (or to check again).
  recheck() {
    if (this.proc) return;
    this.driver = 'unknown';
    this.ensure();
  }

  stop() {
    clearTimeout(this.restartTimer);
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.stdin.end('quit\n'); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500); }
  }
}

function runPowerShell(script, timeout = 120000) {
  return new Promise(resolve => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout }, (err, stdout) => resolve(String(stdout || '').trim()));
  });
}

// Downloads the official ViGEmBus installer, checks it is signed by its maker, and runs it
// (Windows shows its administrator prompt; the installer has its own short wizard).
async function installDriver({ download, onStep = () => {} }) {
  const file = path.join(os.tmpdir(), 'BeamRemote-ViGEmBus-Setup.exe');
  onStep('Downloading the controller driver...');
  await download(DRIVER_URL, file, () => {});
  onStep('Checking the download...');
  const sig = await runPowerShell(`$s = Get-AuthenticodeSignature -FilePath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
  const [status, subject] = sig.split('|');
  if (status !== 'Valid' || !/Nefarius/i.test(subject || '')) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw new Error(`The download isn't signed by the driver's maker (${status || 'unknown'}). Nothing was installed.`);
  }
  onStep('Waiting for you to approve and finish the installer...');
  const out = await runPowerShell(`try { $p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; "exit:$($p.ExitCode)" } catch { "cancelled" }`, 15 * 60000);
  try { fs.unlinkSync(file); } catch { /* still in use */ }
  if (/cancelled/.test(out)) throw new Error('The installer was cancelled.');
  return out;
}

module.exports = { Gamepads, installDriver, MAX_PADS, DRIVER_URL };
