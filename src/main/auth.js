// Who may connect: the password (scrypt hash), optional two-step codes (TOTP, any
// authenticator app), signed-in device sessions, lockouts after wrong guesses, and a
// security log. Secrets live in secrets.json, apart from config.json, so a config can be
// shared without leaking anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(now / 30000);
  for (let d = -1; d <= 1; d++) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step + d)), Buffer.from(c))) return true;
  }
  return false;
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

class Auth {
  constructor(dir, getConfig) {
    this.file = path.join(dir, 'secrets.json');
    this.logFile = path.join(dir, 'security-log.txt');
    this.getConfig = getConfig;
    this.failures = new Map(); // ip -> { count, first, lockedUntil }
    this.log = [];
    this.listeners = new Set();
    this.load();
  }

  load() {
    try { this.s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.s = {}; }
    this.s.sessions = Array.isArray(this.s.sessions) ? this.s.sessions : [];
    this.pruneSessions();
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.s, null, 2)); }

  // Other secrets (e.g. the Cloudflare tunnel token) live here too, never in config.json.
  getSecret(key) { return this.s.extra && this.s.extra[key] ? { ...this.s.extra[key] } : null; }
  setSecret(key, value) {
    this.s.extra = this.s.extra || {};
    if (value == null) delete this.s.extra[key]; else this.s.extra[key] = value;
    this.save();
  }

  get passwordSet() { return !!(this.s.password && this.s.password.hash); }
  get totpEnabled() { return !!this.s.totp; }

  setPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw new Error('Use at least 8 characters.');
    if (pw.length > 256) throw new Error('That password is too long.');
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    this.s.password = { salt: salt.toString('hex'), hash: hash.toString('hex'), ...SCRYPT };
    this.s.sessions = []; // a new password signs every device out
    this.save();
    this.record('password', 'Password changed. All devices were signed out.');
  }

  checkPassword(pw) {
    const p = this.s.password;
    if (!p || typeof pw !== 'string') return false;
    const hash = crypto.scryptSync(pw.slice(0, 256), Buffer.from(p.salt, 'hex'), p.keylen || 64, { N: p.N || SCRYPT.N, r: p.r || 8, p: p.p || 1 });
    return crypto.timingSafeEqual(hash, Buffer.from(p.hash, 'hex'));
  }

  // Two-step codes: start() makes a pending secret, confirm() turns it on once a code matches.
  startTotp(label) {
    const secret = base32Encode(crypto.randomBytes(20));
    this.pendingTotp = secret;
    const name = encodeURIComponent(label || 'Beam Remote');
    return { secret, uri: `otpauth://totp/${name}:PC?secret=${secret}&issuer=${name}&algorithm=SHA1&digits=6&period=30` };
  }
  confirmTotp(code) {
    if (!this.pendingTotp || !verifyTotp(this.pendingTotp, code)) return false;
    this.s.totp = this.pendingTotp; this.pendingTotp = null; this.save();
    this.record('2fa', 'Two-step sign-in turned on.');
    return true;
  }
  disableTotp() { delete this.s.totp; this.save(); this.record('2fa', 'Two-step sign-in turned off.'); }

  // Lockouts are per address, so one attacker can't lock you out from everywhere.
  lockedFor(ip) {
    const f = this.failures.get(ip);
    if (!f || !f.lockedUntil) return 0;
    const left = f.lockedUntil - Date.now();
    if (left <= 0) { this.failures.delete(ip); return 0; }
    return left;
  }

  ipAllowed(ip) {
    const list = String(this.getConfig('security.allowedIps') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return true;
    const plain = ip.replace(/^::ffff:/, '');
    if (plain === '127.0.0.1' || plain === '::1') return true;
    return list.some(prefix => plain.startsWith(prefix));
  }

  // Returns { ok, token, error, needTotp, lockedSeconds }.
  login(ip, { password, totp, remember }, meta = {}) {
    if (!this.passwordSet) return { ok: false, error: 'This PC has not been set up yet. Open the app on the PC and choose a password.' };
    if (!this.ipAllowed(ip)) { this.record('blocked', `Sign-in blocked: ${ip} is not on the allowed list.`, ip); return { ok: false, error: 'This address is not allowed to sign in.' }; }
    const locked = this.lockedFor(ip);
    if (locked) return { ok: false, lockedSeconds: Math.ceil(locked / 1000), error: `Too many wrong attempts. Try again in ${Math.ceil(locked / 60000)} minute(s).` };

    const passOk = this.checkPassword(password);
    if (passOk && this.totpEnabled && !totp) return { ok: false, needTotp: true };
    const totpOk = !this.totpEnabled || verifyTotp(this.s.totp, totp);
    if (!passOk || !totpOk) {
      const now = Date.now();
      const f = this.failures.get(ip) || { count: 0, first: now };
      if (now - f.first > 60 * 60 * 1000) { f.count = 0; f.first = now; }
      f.count++;
      const max = this.getConfig('security.maxFailedAttempts');
      let msg = passOk ? 'That code is wrong or expired.' : 'Wrong password.';
      if (f.count >= max) {
        f.lockedUntil = now + this.getConfig('security.lockoutMinutes') * 60000;
        this.record('lockout', `Locked out ${ip} after ${f.count} wrong attempts.`, ip);
        msg = `Too many wrong attempts. Try again in ${this.getConfig('security.lockoutMinutes')} minute(s).`;
      } else {
        this.record('fail', `Wrong ${passOk ? 'two-step code' : 'password'} from ${ip}.`, ip);
        msg += ` ${max - f.count} attempt(s) left.`;
      }
      this.failures.set(ip, f);
      return { ok: false, error: msg, needTotp: passOk && this.totpEnabled };
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const days = this.getConfig('security.sessionDays');
    const session = {
      id: crypto.randomBytes(6).toString('hex'),
      hash: sha256(token),
      created: Date.now(),
      expires: Date.now() + (remember ? days : 1) * 86400000,
      remember: !!remember,
      ip, device: String(meta.device || '').slice(0, 120),
    };
    this.s.sessions.push(session);
    this.s.sessions = this.s.sessions.slice(-30);
    this.save();
    this.record('signin', `Signed in from ${ip}${session.device ? ` (${session.device})` : ''}.`, ip);
    return { ok: true, token, session };
  }

  sessionFor(token) {
    if (!token || typeof token !== 'string') return null;
    const h = sha256(token);
    const s = this.s.sessions.find(x => x.hash === h);
    if (!s || s.expires < Date.now()) return null;
    return s;
  }

  logout(token) {
    const h = sha256(String(token || ''));
    const before = this.s.sessions.length;
    this.s.sessions = this.s.sessions.filter(x => x.hash !== h);
    if (this.s.sessions.length !== before) this.save();
  }

  signOutAll() { this.s.sessions = []; this.save(); this.record('signout', 'All devices were signed out.'); }

  pruneSessions() {
    const now = Date.now();
    const keep = this.s.sessions.filter(x => x.expires > now);
    if (keep.length !== this.s.sessions.length) { this.s.sessions = keep; this.save(); }
  }

  record(kind, text, ip = '') {
    const e = { t: Date.now(), kind, text, ip };
    this.log.unshift(e);
    this.log.length = Math.min(this.log.length, 300);
    try { fs.appendFileSync(this.logFile, `${new Date(e.t).toISOString()}  ${kind.padEnd(8)} ${text}\n`); } catch { /* ignore */ }
    for (const fn of this.listeners) { try { fn(e); } catch { /* ignore */ } }
  }
  onRecord(fn) { this.listeners.add(fn); }
}

module.exports = { Auth, verifyTotp, totpAt, base32Encode, base32Decode };
