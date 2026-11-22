// Paid copies: activation codes, seller copies and the activation server (the "hub").
//
// Every copy is one of:
//   hub      the owner's PC. It holds the signing key, makes every code and activates copies.
//   founder  set up before copies were paid for: free for good, and allowed to sell.
//   seller   activated with a seller code, or a founder the hub has accepted.
//   user     activated with a normal code.
//   none     needs a code before it can be set up or used.
// A license is a short statement signed with the hub's private key and tied to one PC. Copies
// check it with the public key below, so an activated copy never needs the hub again. Codes
// are one-time: the hub records which PC used each one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

// The hub's public key (Ed25519, SPKI DER, base64). Its private key exists only on the hub.
const PUBLIC_KEY = 'MCowBQYDK2VwAyEA2EU2974hxbbUxzTYmAhi3oDmMtRPMqmotVF8MPO4jBc=';
// Where copies reach the hub.
const HUB_URL = 'https://remote.darthsmp.online';
// Copies whose settings folder is older than this were set up before copies were paid for.
const FOUNDER_CUTOFF = Date.parse('2026-11-22T01:44:00Z');
// The link sellers give to buyers.
const DOWNLOAD_URL = 'https://github.com/AncientRemain/remoteweb/releases/latest';

const KEY_FILE = 'license-hub-key.pem';
const HUB_FILE = 'license-hub.json';
const STATE_FILE = 'license.json';
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O or 1/I: easy to read out
const MAX_UNUSED = 30;   // a seller's unsold codes at any time
const MAX_BATCH = 10;    // codes made in one go
const MAX_WAITING = 200; // open access requests at any time
const MAX_KEPT = 600;    // access requests remembered (open ones are never dropped)

// Text someone typed, made safe to keep and show: one line, no control characters, capped.
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// "Windows 11" / "Windows 10", from the build number.
function windowsName() {
  const build = Number(String(os.release()).split('.')[2]) || 0;
  return build >= 22000 ? 'Windows 11' : build ? 'Windows 10' : os.type();
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const cleanCode = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const validCode = c => typeof c === 'string' && c.length === 8 && [...c].every(ch => CODE_CHARS.includes(ch));
const showCode = c => `${c.slice(0, 4)}-${c.slice(4)}`;
const validPc = pc => typeof pc === 'string' && /^[0-9a-f]{24}$/.test(pc);
const pcFromGuid = guid => (guid ? sha256(`beam-remote-pc:${guid}`).slice(0, 24) : null);
const founderTag = (pc, since) => crypto.createHmac('sha256', `beam-founder:${pc}`).update(String(since)).digest('hex').slice(0, 32);

function makeCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += CODE_CHARS[b & 31];
  return s;
}

function publicKeyFrom(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

function signLicense(privateKey, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return `${body.toString('base64url')}.${crypto.sign(null, body, privateKey).toString('base64url')}`;
}

// The license's contents if the signature is good, else null.
function readLicense(token, publicKey) {
  if (typeof token !== 'string' || token.length > 4000) return null;
  const [a, b] = token.split('.');
  if (!a || !b) return null;
  try {
    const body = Buffer.from(a, 'base64url');
    if (!crypto.verify(null, body, publicKey, Buffer.from(b, 'base64url'))) return null;
    const p = JSON.parse(body.toString('utf8'));
    return p && p.v === 1 && (p.kind === 'user' || p.kind === 'seller') && validPc(p.pc) ? p : null;
  } catch { return null; }
}

// This PC's id: a hash of Windows' machine id (the same after reinstalling the app).
function machineGuid() {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// When this copy was first set up: the oldest of the settings folder and its first files.
function setupTime(dir) {
  let t = Infinity;
  for (const f of ['', 'config.json', 'secrets.json', 'security-log.txt']) {
    try {
      const s = fs.statSync(path.join(dir, f));
      const b = s.birthtimeMs || s.ctimeMs;
      if (b > 0) t = Math.min(t, b);
    } catch { /* not there */ }
  }
  return Number.isFinite(t) ? Math.round(t) : Date.now();
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- the hub (owner's PC only)
class Hub {
  constructor({ dir, privateKey, publicKey, cutoff = FOUNDER_CUTOFF, log = () => {}, notify = () => {}, onRequest = () => {} }) {
    this.file = path.join(dir, HUB_FILE);
    this.key = privateKey;
    this.publicKey = publicKey;
    this.cutoff = cutoff;
    this.log = log;
    this.notify = notify;       // one line for the owner's activity log
    this.onRequest = onRequest; // someone asked for access
    const db = readJson(this.file) || {};
    this.db = {
      v: 1,
      settings: { price: '$20', note: '', autoFounders: true, ...(db.settings || {}) },
      sellers: db.sellers || {},
      codes: db.codes || {},
      pending: db.pending || {},
      requests: db.requests || {},
    };
    this.hits = new Map();   // ip -> request times (everything)
    this.fails = new Map();  // ip -> wrong-code times
    this.asks = new Map();   // ip -> access-request times
  }

  sellerName(by) {
    if (by === 'hub') return 'you';
    const s = this.db.sellers[by];
    return s ? s.label || s.sid : 'a seller';
  }

  waiting() { return Object.values(this.db.requests).filter(r => r.status === 'pending').length; }

  // ---- access requests: someone without a code asks, with their name and a short message
  request({ pc, name, message, pcName, os: osName }, ip) {
    if (!validPc(pc)) return { ok: false, error: 'This copy sent a bad request. Update it and try again.' };
    const who = clip(name, 40);
    if (!who) return { ok: false, error: 'Type your name first.' };
    const now = Date.now();
    const recent = (this.asks.get(ip) || []).filter(t => now - t < 3600000);
    if (recent.length >= 5) return { ok: false, error: 'Too many requests from this network. Try again in an hour.' };
    // One open request per PC: a new one replaces the old.
    for (const r of Object.values(this.db.requests)) if (r.pc === pc && r.status === 'pending') { r.status = 'replaced'; r.doneAt = now; }
    if (this.waiting() >= MAX_WAITING) return { ok: false, error: 'Too many people are waiting right now. Try again later.' };
    recent.push(now);
    this.asks.set(ip, recent);
    if (this.asks.size > 5000) this.asks.clear();
    let id;
    do { id = crypto.randomBytes(4).toString('hex'); } while (this.db.requests[id]);
    const secret = crypto.randomBytes(24).toString('hex');
    const r = {
      id, pc, secret: sha256(secret), name: who, message: clip(message, 200), pcName: clip(pcName, 40), os: clip(osName, 30),
      at: now, status: 'pending', by: null, reason: null, doneAt: null, license: null,
    };
    this.db.requests[id] = r;
    this.trimRequests();
    this.save();
    this.notify(`${who} asked for access${r.message ? `: "${r.message}"` : ''}.`);
    this.onRequest(this.publicRequest(r));
    return { ok: true, id, secret };
  }

  // The asking copy checks on its request; once unlocked it gets its license here.
  requestStatus({ id, secret }) {
    const r = this.db.requests[String(id)];
    if (!r || !secret || sha256(secret) !== r.secret) return { ok: false, gone: true, error: 'That request no longer exists.' };
    return { ok: true, status: r.status, license: r.status === 'unlocked' ? r.license : undefined };
  }

  cancelRequest({ id, secret }) {
    const r = this.db.requests[String(id)];
    if (!r || !secret || sha256(secret) !== r.secret) return { ok: false };
    if (r.status === 'pending') { r.status = 'cancelled'; r.doneAt = Date.now(); this.save(); }
    return { ok: true };
  }

  publicRequest(r) { return { id: r.id, name: r.name, message: r.message, pcName: r.pcName, os: r.os, at: r.at }; }

  trimRequests() {
    const all = Object.values(this.db.requests);
    if (all.length <= MAX_KEPT) return;
    for (const r of all.filter(x => x.status !== 'pending').sort((a, b) => (a.doneAt || a.at) - (b.doneAt || b.at)).slice(0, all.length - MAX_KEPT)) delete this.db.requests[r.id];
  }

  save() { writeJson(this.file, this.db); }

  sign(payload) {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    return signLicense(this.key, { v: 1, id: crypto.randomBytes(6).toString('hex'), at: Date.now(), ...clean });
  }

  newCode(kind, by) {
    let c;
    do { c = makeCode(); } while (this.db.codes[c]);
    this.db.codes[c] = { code: c, kind, by, at: Date.now(), used: null, cancelled: false };
    return c;
  }

  newSeller(kind, pc) {
    let sid;
    do { sid = `S${makeCode().slice(0, 6)}`; } while (this.db.sellers[sid]);
    this.db.sellers[sid] = { sid, kind, pc, secret: null, label: '', blocked: false, at: Date.now(), seen: Date.now() };
    return this.db.sellers[sid];
  }

  // A fresh secret for a seller copy: it proves the copy when it asks for codes.
  rekey(seller) {
    const secret = crypto.randomBytes(24).toString('hex');
    seller.secret = sha256(secret);
    seller.seen = Date.now();
    return secret;
  }

  allow(ip) {
    const now = Date.now();
    const list = (this.hits.get(ip) || []).filter(t => now - t < 600000);
    list.push(now);
    this.hits.set(ip, list);
    if (this.hits.size > 5000) this.hits.clear();
    return list.length <= 60;
  }
  wrongCodes(ip) { const now = Date.now(); return (this.fails.get(ip) || []).filter(t => now - t < 3600000); }
  wrong(ip) {
    const list = this.wrongCodes(ip);
    list.push(Date.now());
    this.fails.set(ip, list);
    if (this.fails.size > 5000) this.fails.clear();
  }

  // Requests from other copies, over the internet (POST /api/license/<what>).
  handle(what, body, ip = '?') {
    if (!this.allow(ip)) return { ok: false, error: 'Too many tries. Wait a few minutes and try again.' };
    try {
      if (what === 'redeem') return this.redeem(body || {}, ip);
      if (what === 'founder') return this.founder(body || {});
      if (what === 'seller') return this.sellerRequest(body || {});
      if (what === 'request') return this.request(body || {}, ip);
      if (what === 'request-status') return this.requestStatus(body || {});
      if (what === 'request-cancel') return this.cancelRequest(body || {});
    } catch (e) {
      this.log(`license hub: ${e.message}`);
      return { ok: false, error: 'The activation server had a problem. Try again in a minute.' };
    }
    return { ok: false, error: 'Unknown request.' };
  }

  redeem({ code, pc }, ip) {
    if (this.wrongCodes(ip).length >= 10) return { ok: false, error: 'Too many wrong codes. Wait an hour, then try again.' };
    if (!validPc(pc)) return { ok: false, error: 'This copy sent a bad request. Update it and try again.' };
    const c = cleanCode(code);
    const rec = validCode(c) ? this.db.codes[c] : null;
    if (!rec || rec.cancelled) { this.wrong(ip); return { ok: false, error: 'That code doesn\'t exist or was cancelled. Check it with the person you got it from.' }; }
    const seller = rec.by !== 'hub' ? this.db.sellers[rec.by] : null;
    if (seller && seller.blocked && !rec.used) return { ok: false, error: 'That code can\'t be used any more. Ask the person you got it from for a new one.' };
    if (rec.used && rec.used.pc !== pc) { this.wrong(ip); return { ok: false, error: 'That code was already used on another PC. Each code works on one PC only.' }; }
    // First use, or the same PC again (reinstalled): hand out its license.
    const first = !rec.used;
    let secret, sid;
    if (rec.kind === 'seller') {
      let s = rec.used && rec.used.sid ? this.db.sellers[rec.used.sid] : null;
      if (!s) s = this.newSeller('granted', pc);
      secret = this.rekey(s);
      sid = s.sid;
    }
    rec.used = { pc, at: rec.used ? rec.used.at : Date.now(), sid };
    const license = this.sign({ kind: rec.kind, pc, by: rec.by, code: c, sid });
    this.save();
    if (first) this.notify(`A copy was activated with code ${showCode(c)}${rec.kind === 'seller' ? ' as a seller copy' : ''}${seller ? ` (sold by ${seller.label || seller.sid})` : ''}.`);
    return { ok: true, kind: rec.kind, license, secret };
  }

  // A copy that was set up before copies were paid for asks to sell.
  founder({ pc, since }) {
    if (!validPc(pc)) return { ok: false, error: 'This copy sent a bad request.' };
    let s = Object.values(this.db.sellers).find(x => x.pc === pc && x.kind === 'founder');
    if (s && s.blocked) return { ok: false, blocked: true, error: 'Selling is turned off for this copy.' };
    if (!s) {
      const early = Number(since) > 0 && Number(since) < this.cutoff;
      if (!early || !this.db.settings.autoFounders) {
        this.db.pending[pc] = { pc, since: Number(since) || 0, at: Date.now() };
        this.save();
        return { ok: false, pending: true, error: 'Selling isn\'t turned on for this copy yet.' };
      }
      s = this.newSeller('founder', pc);
      this.notify(`A copy that had Beam Remote before it was paid for can now sell (seller ${s.sid}).`);
    }
    delete this.db.pending[pc];
    const secret = this.rekey(s);
    const license = this.sign({ kind: 'seller', pc, by: 'hub', code: 'founder', sid: s.sid, founder: true });
    this.save();
    return { ok: true, kind: 'seller', license, secret };
  }

  sellerRequest({ license, secret, action, count, code, id, reason }) {
    const lic = readLicense(license, this.publicKey);
    if (!lic || lic.kind !== 'seller' || !lic.sid) return { ok: false, error: 'This isn\'t a seller copy.' };
    const s = this.db.sellers[lic.sid];
    if (!s || s.pc !== lic.pc || !s.secret || sha256(secret) !== s.secret) return { ok: false, unknown: true, error: 'The activation server doesn\'t recognise this seller copy any more.' };
    if (s.blocked) return { ok: false, blocked: true, error: 'Selling is turned off for this copy.' };
    s.seen = Date.now();
    return this.act(s.sid, action, { count, code, id, reason });
  }

  // Make, cancel or list codes, and unlock or decline access requests, for one seller
  // ('hub' = the owner). Every unlock records why: paid or free.
  act(by, action, { count, code, kind, id, reason } = {}) {
    if (action === 'unlock' || action === 'decline') {
      const r = this.db.requests[String(id)];
      if (!r || r.status !== 'pending') return { ok: false, error: 'That request was already handled or withdrawn.', ...this.view(by) };
      r.status = action === 'unlock' ? 'unlocked' : 'declined';
      r.by = by;
      r.doneAt = Date.now();
      if (action === 'unlock') {
        r.reason = reason === 'free' ? 'free' : 'paid';
        r.license = this.sign({ kind: 'user', pc: r.pc, by, code: `request:${r.id}`, reason: r.reason });
        this.notify(`${r.name}'s copy was unlocked (${r.reason}) by ${this.sellerName(by)}.`);
      } else this.notify(`${r.name}'s request was declined by ${this.sellerName(by)}.`);
      this.save();
      return { ok: true, ...this.view(by) };
    }
    if (action === 'make') {
      const unused = Object.values(this.db.codes).filter(c => c.by === by && !c.used && !c.cancelled).length;
      const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(count) || 1)));
      if (by !== 'hub' && unused + n > MAX_UNUSED) return { ok: false, error: `You already have ${unused} unsold codes. Sell or cancel some first.`, ...this.view(by) };
      const k = by === 'hub' && kind === 'seller' ? 'seller' : 'user';
      const made = Array.from({ length: n }, () => showCode(this.newCode(k, by)));
      this.save();
      return { ok: true, made, ...this.view(by) };
    }
    if (action === 'cancel') {
      const rec = this.db.codes[cleanCode(code)];
      if (!rec || rec.by !== by || rec.cancelled) return { ok: false, error: 'That code isn\'t one of yours.', ...this.view(by) };
      if (rec.used) return { ok: false, error: 'That code was already used, so it can\'t be cancelled.', ...this.view(by) };
      rec.cancelled = true;
      this.save();
      return { ok: true, ...this.view(by) };
    }
    return { ok: true, ...this.view(by) };
  }

  view(by) {
    const codes = Object.values(this.db.codes).filter(c => c.by === by && !c.cancelled).sort((a, b) => b.at - a.at);
    const reqs = Object.values(this.db.requests);
    // Every seller sees who is waiting; past decisions only their own (the owner sees all).
    const done = reqs.filter(r => (r.status === 'unlocked' || r.status === 'declined') && (by === 'hub' || r.by === by))
      .sort((a, b) => b.doneAt - a.doneAt);
    return {
      price: this.db.settings.price, note: this.db.settings.note,
      codes: codes.slice(0, 300).map(c => ({ code: showCode(c.code), kind: c.kind, at: c.at, used: c.used ? c.used.at : null })),
      ready: codes.filter(c => !c.used).length, sold: codes.filter(c => c.used).length,
      requests: reqs.filter(r => r.status === 'pending').sort((a, b) => a.at - b.at).map(r => this.publicRequest(r)),
      handled: done.slice(0, 40).map(r => ({
        ...this.publicRequest(r), status: r.status, reason: r.reason, doneAt: r.doneAt, byYou: r.by === by,
        by: by === 'hub' ? this.sellerName(r.by) : undefined,
      })),
      unlocked: { paid: done.filter(r => r.by === by && r.reason === 'paid').length, free: done.filter(r => r.by === by && r.reason === 'free').length },
    };
  }

  // ---- owner only (from the dashboard on this PC)
  overview() {
    const counts = {};
    const k = by => counts[by] || (counts[by] = { made: 0, sold: 0, paid: 0, free: 0 });
    for (const c of Object.values(this.db.codes)) {
      if (!c.cancelled) k(c.by).made++;
      if (c.used) k(c.by).sold++;
    }
    const unlocks = Object.values(this.db.requests).filter(r => r.status === 'unlocked');
    for (const r of unlocks) k(r.by)[r.reason === 'free' ? 'free' : 'paid']++;
    const all = Object.values(this.db.codes);
    return {
      settings: { ...this.db.settings },
      sellers: Object.values(this.db.sellers).sort((a, b) => a.at - b.at).map(s => ({
        sid: s.sid, kind: s.kind, label: s.label, blocked: s.blocked, at: s.at, seen: s.seen, ...k(s.sid),
      })),
      pending: Object.values(this.db.pending).sort((a, b) => b.at - a.at),
      totals: {
        sold: all.filter(c => c.used).length + unlocks.filter(r => r.reason !== 'free').length,
        free: unlocks.filter(r => r.reason === 'free').length,
        ready: all.filter(c => !c.used && !c.cancelled).length,
        sellers: Object.keys(this.db.sellers).length,
        waiting: this.waiting() + Object.keys(this.db.pending).length,
      },
    };
  }

  setSeller(sid, { label, blocked } = {}) {
    const s = this.db.sellers[sid];
    if (!s) return false;
    if (typeof label === 'string') s.label = label.slice(0, 40);
    if (typeof blocked === 'boolean') s.blocked = blocked;
    this.save();
    return true;
  }

  setSettings({ price, note, autoFounders } = {}) {
    const st = this.db.settings;
    if (typeof price === 'string') st.price = price.trim().slice(0, 20) || '$20';
    if (typeof note === 'string') st.note = note.slice(0, 600);
    if (typeof autoFounders === 'boolean') st.autoFounders = autoFounders;
    this.save();
    return { ...st };
  }

  // Lets a copy that asked (it was set up before paid copies, but too late or by hand) sell.
  allowPending(pc) {
    if (!this.db.pending[pc]) return false;
    if (!Object.values(this.db.sellers).some(x => x.pc === pc && x.kind === 'founder')) this.newSeller('founder', pc);
    delete this.db.pending[pc];
    this.save();
    return true;
  }
  dismissPending(pc) { delete this.db.pending[pc]; this.save(); return true; }
}

// ---------------------------------------------------------------- this copy's license
class License extends EventEmitter {
  constructor({ dir, log = () => {}, hubUrl = HUB_URL, publicKey = PUBLIC_KEY, cutoff = FOUNDER_CUTOFF, pc = null, fetchImpl = null, onHubEvent = () => {} } = {}) {
    super();
    this.dir = dir;
    this.log = log;
    this.onHubEvent = onHubEvent;
    this.hubUrl = String(hubUrl).replace(/\/+$/, '');
    this.publicKey = publicKeyFrom(publicKey);
    this.cutoff = cutoff;
    this.pc = pc;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.kind = 'none';
    this.info = null;       // the license's contents, when there is one
    this.founder = false;
    this.hub = null;
    this.state = {};
    this.sellerStatus = 'idle';  // founders: idle | ok | pending | blocked | offline
    this.sellerError = '';
  }

  get activated() { return this.kind !== 'none'; }
  get canSell() { return this.kind === 'hub' || this.kind === 'seller' || this.kind === 'founder'; }

  save() { try { writeJson(path.join(this.dir, STATE_FILE), this.state); } catch (e) { this.log(`license: can't save: ${e.message}`); } }

  load() {
    this.state = readJson(path.join(this.dir, STATE_FILE)) || {};
    if (!this.pc) this.pc = pcFromGuid(machineGuid()) || this.state.fallbackPc || (this.state.fallbackPc = crypto.randomBytes(12).toString('hex'));
    // The owner's PC holds the signing key that matches the public key every copy checks.
    const keyFile = path.join(this.dir, KEY_FILE);
    if (fs.existsSync(keyFile)) {
      try {
        const priv = crypto.createPrivateKey(fs.readFileSync(keyFile));
        const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
        if (pub.equals(this.publicKey.export({ format: 'der', type: 'spki' }))) {
          this.hub = new Hub({
            dir: this.dir, privateKey: priv, publicKey: this.publicKey, cutoff: this.cutoff, log: this.log, notify: this.onHubEvent,
            onRequest: r => { this.emit('request', r); this.emit('change'); },
          });
          this.kind = 'hub';
          this.state.seen = this.state.seen || Date.now();
          this.save();
          return this.kind;
        }
        this.log('license: the signing key in the settings folder belongs to a different version');
      } catch (e) { this.log(`license: the signing key can't be read: ${e.message}`); }
    }
    // First start of a version with paid copies: was this copy set up before they existed?
    if (!this.state.seen) {
      this.state.seen = Date.now();
      const since = setupTime(this.dir);
      if (since < this.cutoff) this.state.founder = { pc: this.pc, since, tag: founderTag(this.pc, since) };
    }
    const f = this.state.founder;
    this.founder = !!(f && f.pc === this.pc && f.tag === founderTag(this.pc, f.since));
    const lic = readLicense(this.state.license, this.publicKey);
    this.info = lic && lic.pc === this.pc ? lic : null;
    this.resolve();
    this.save();
    return this.kind;
  }

  resolve() {
    this.kind = this.info && this.info.kind === 'seller' ? 'seller' : this.founder ? 'founder' : this.info ? 'user' : 'none';
  }

  async call(what, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await this.fetch(`${this.hubUrl}/api/license/${what}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
      });
      let j = null;
      try { j = JSON.parse(await res.text()); } catch { /* not json */ }
      if (!j || typeof j !== 'object') throw new Error(`the activation server answered ${res.status}`);
      return j;
    } finally { clearTimeout(timer); }
  }

  // Stores a license the hub sent, after checking it.
  accept(r, fromRequest = false) {
    const lic = readLicense(r && r.license, this.publicKey);
    if (!lic || lic.pc !== this.pc) return { ok: false, error: 'The activation server sent something this copy can\'t use. Update the app and try again.' };
    this.state.license = r.license;
    if (r.secret) this.state.secret = r.secret;
    this.info = lic;
    this.resolve();
    if (this.kind === 'seller') { this.sellerStatus = 'ok'; this.sellerError = ''; }
    // Activated with a code while a request was still waiting: withdraw the request.
    const q = this.state.request;
    if (!fromRequest && q && q.status === 'pending') {
      this.call('request-cancel', { id: q.id, secret: q.secret }).catch(() => {});
      delete this.state.request;
    }
    this.save();
    this.emit('change');
    return { ok: true, kind: this.kind };
  }

  // No code: ask the people who sell it to unlock this copy. Only what the person typed, this
  // PC's name and the Windows version are sent; the form shows exactly that before sending.
  async requestAccess({ name, message } = {}) {
    if (this.kind !== 'none') return { ok: false, error: 'This copy is already activated.' };
    const who = clip(name, 40);
    if (!who) return { ok: false, error: 'Type your name first.' };
    let r;
    try { r = await this.call('request', { pc: this.pc, name: who, message: clip(message, 200), pcName: clip(os.hostname(), 40), os: windowsName() }); } catch (e) {
      this.log(`license: request failed: ${e.message}`);
      return { ok: false, error: 'Couldn\'t reach the activation server. Check this PC\'s internet connection and try again in a minute.' };
    }
    if (!r.ok || !r.id) return { ok: false, error: r.error || 'The request wasn\'t sent. Try again.' };
    this.state.request = { id: r.id, secret: r.secret, name: who, at: Date.now(), status: 'pending' };
    this.save();
    this.emit('change');
    return { ok: true };
  }

  // Checked by the app every so often while a request waits; unlocking activates this copy.
  async checkRequest() {
    const q = this.state.request;
    if (!q || q.status !== 'pending' || this.kind !== 'none' || this.checking) return;
    this.checking = true;
    try {
      const r = await this.call('request-status', { id: q.id, secret: q.secret });
      if (r.ok && r.status === 'unlocked' && r.license) {
        const a = this.accept(r, true);
        if (a.ok) { this.state.request = { ...q, status: 'unlocked' }; this.save(); this.emit('unlocked'); }
      } else if ((r.ok && r.status !== 'pending') || r.gone) {
        q.status = r.status === 'declined' ? 'declined' : 'gone';
        this.save();
        this.emit('change');
      }
    } catch { /* offline: the next check tries again */ } finally { this.checking = false; }
  }

  async cancelRequest() {
    const q = this.state.request;
    if (q && q.status === 'pending') { try { await this.call('request-cancel', { id: q.id, secret: q.secret }); } catch { /* it simply stays unanswered */ } }
    delete this.state.request;
    this.save();
    this.emit('change');
    return { ok: true };
  }

  // Sellers: remember who's waiting, so the app can tell them about new requests.
  noteRequests(list) {
    if (!Array.isArray(list)) return;
    this.seenRequests = this.seenRequests || new Set();
    const fresh = list.filter(r => !this.seenRequests.has(r.id));
    for (const r of list) this.seenRequests.add(r.id);
    const before = this.waitingCount;
    this.waitingCount = list.length;
    if (fresh.length) this.emit('requests', fresh);
    if (before !== this.waitingCount) this.emit('change');
  }

  async activate(code) {
    const c = cleanCode(code);
    if (this.kind === 'hub') return { ok: false, error: 'This PC runs the activation server, so it never needs a code.' };
    if (!validCode(c)) return { ok: false, error: 'That doesn\'t look like a code. Codes have 8 letters and numbers, like K7Q2-M9XD.' };
    let r;
    try { r = await this.call('redeem', { code: c, pc: this.pc }); } catch (e) {
      this.log(`license: activation failed: ${e.message}`);
      return { ok: false, error: 'Couldn\'t reach the activation server. Check this PC\'s internet connection and try again in a minute.' };
    }
    if (!r.ok) return { ok: false, error: r.error || 'That code didn\'t work.' };
    return this.accept(r);
  }

  // Founders ask the hub for seller access in the background (retried by the app).
  async registerFounder() {
    if (this.kind !== 'founder' || this.registering) return;
    this.registering = true;
    try {
      const r = await this.call('founder', { pc: this.pc, since: this.state.founder.since });
      if (r.ok && r.license) this.accept(r);
      else { this.sellerStatus = r.blocked ? 'blocked' : 'pending'; this.sellerError = r.error || ''; this.emit('change'); }
    } catch (e) {
      this.sellerStatus = 'offline';
      this.sellerError = '';
      this.emit('change');
    } finally { this.registering = false; }
  }

  // 'info' | 'make' | 'cancel' (codes) and 'unlock' | 'decline' (access requests). The hub
  // answers for itself; sellers ask it over the internet.
  async seller(action, extra = {}) {
    if (this.kind === 'hub') {
      const r = this.hub.act('hub', action, extra);
      if (action === 'unlock' || action === 'decline') this.emit('change');
      return r;
    }
    if (this.kind === 'founder') {
      await this.registerFounder();
      if (this.kind !== 'seller') return { ok: false, status: this.sellerStatus, error: this.sellerStatus === 'offline' ? 'Couldn\'t reach the activation server. Try again in a minute.' : this.sellerError || 'Selling isn\'t turned on for this copy yet.' };
    }
    if (this.kind !== 'seller' || !this.state.secret) return { ok: false, error: 'This copy can\'t sell.' };
    try {
      const r = await this.call('seller', {
        license: this.state.license, secret: this.state.secret, action, count: extra.count, code: extra.code, id: extra.id, reason: extra.reason,
      });
      if (r.blocked) { this.sellerStatus = 'blocked'; this.emit('change'); }
      this.noteRequests(r.requests);
      return r;
    } catch (e) {
      return { ok: false, status: 'offline', error: 'Couldn\'t reach the activation server. Try again in a minute.' };
    }
  }

  public() {
    return {
      kind: this.kind, activated: this.activated, canSell: this.canSell, founder: this.founder || !!(this.info && this.info.founder),
      sellerId: (this.info && this.info.sid) || null, sellerStatus: this.kind === 'hub' ? 'ok' : this.sellerStatus,
      activatedAt: (this.info && this.info.at) || null, downloadUrl: DOWNLOAD_URL, keyFile: KEY_FILE,
      // Access requests: this copy's own (when it isn't activated) and, for sellers, how many wait.
      request: this.state.request ? { name: this.state.request.name, at: this.state.request.at, status: this.state.request.status } : null,
      pcName: clip(os.hostname(), 40), osName: windowsName(),
      waiting: this.kind === 'hub' ? this.hub.waiting() : this.waitingCount || 0,
    };
  }
}

module.exports = {
  License, Hub, signLicense, readLicense, publicKeyFrom, makeCode, cleanCode, validCode, showCode, setupTime,
  PUBLIC_KEY, HUB_URL, FOUNDER_CUTOFF, DOWNLOAD_URL, KEY_FILE, HUB_FILE, STATE_FILE, CODE_CHARS,
};
