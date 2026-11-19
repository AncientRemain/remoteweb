// System sound: runs beam-audio.exe (WASAPI loopback of the default speakers) and turns
// its stdout packets into 20 ms chunks of float stereo PCM for the capture window.
// Chromium's built-in loopback fails on some devices (e.g. 7.1 "virtual surround" headsets);
// this helper reads the speakers' own format directly and folds it down to stereo.
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const MAGIC = 0x44554142; // "BAUD"

class SystemAudio extends EventEmitter {
  constructor(exe) {
    super();
    this.exe = exe;
    this.proc = null;
    this.wanted = false;
    this.mute = false;
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.pendingFrames = 0;
    this.status = { state: 'off', format: '', message: '' };
    this.failures = 0;
  }

  set(patch) { this.status = { ...this.status, ...patch }; this.emit('status', this.status); }

  start({ mute = false } = {}) {
    if (this.wanted && this.proc && this.mute === mute) return;
    this.wanted = true;
    if (this.proc && this.mute !== mute) { this.restartAfterExit = true; this.mute = mute; this.halt(); return; }
    this.mute = mute;
    if (!this.proc) this.spawn();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    this.halt();
    this.set({ state: 'off', message: '' });
  }

  // Closing stdin asks the helper to stop and restore the speakers; kill only as a last resort.
  halt() {
    const p = this.proc;
    if (!p) return;
    try { p.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { if (p.exitCode === null) { try { p.kill(); } catch { /* ignore */ } } }, 1500);
  }

  spawn() {
    if (!fs.existsSync(this.exe)) { this.set({ state: 'error', message: 'Sound helper (beam-audio.exe) is missing.' }); return; }
    this.buf = Buffer.alloc(0);
    this.pending = []; this.pendingFrames = 0;
    const p = spawn(this.exe, this.mute ? ['--mute'] : [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.set({ state: 'starting', message: '' });
    p.stdout.on('data', d => this.onData(d));
    p.stderr.on('data', d => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line.startsWith('format ')) this.set({ format: line.slice(7) });
        else if (line === 'capturing') { this.failures = 0; this.set({ state: 'on', message: '' }); }
        else this.set({ message: line });
        this.emit('log', line);
      }
    });
    p.on('error', e => this.set({ state: 'error', message: e.message }));
    p.on('exit', code => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.restartAfterExit) { this.restartAfterExit = false; if (this.wanted) this.spawn(); return; }
      if (!this.wanted) return;
      this.failures++;
      this.set({ state: 'error', message: `Sound capture stopped (code ${code}). Retrying...` });
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { if (this.wanted && !this.proc) this.spawn(); }, Math.min(30000, 1000 * 2 ** this.failures));
    });
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let off = 0;
    while (this.buf.length - off >= 16) {
      if (this.buf.readUInt32LE(off) !== MAGIC) { off++; continue; }
      const rate = this.buf.readUInt32LE(off + 4);
      const frames = this.buf.readUInt32LE(off + 12);
      const size = 16 + frames * 8;
      if (this.buf.length - off < size) break;
      const pcm = new Float32Array(frames * 2);
      Buffer.from(pcm.buffer).set(this.buf.subarray(off + 16, off + size));
      off += size;
      if (this.rate && rate !== this.rate) this.flush();
      this.rate = rate;
      this.pending.push(pcm);
      this.pendingFrames += frames;
      if (this.pendingFrames >= rate / 100) this.flush(); // 10 ms chunks: low delay, ~100 messages a second
    }
    this.buf = off ? this.buf.subarray(off) : this.buf;
  }

  flush() {
    if (!this.pendingFrames) return;
    const out = new Float32Array(this.pendingFrames * 2);
    let o = 0;
    for (const p of this.pending) { out.set(p, o); o += p.length; }
    this.pending = []; this.pendingFrames = 0;
    this.emit('pcm', { rate: this.rate, data: out });
  }
}

module.exports = { SystemAudio, MAGIC };
