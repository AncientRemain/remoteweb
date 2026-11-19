const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize, DEFAULTS, ConfigStore } = require('../src/main/config');
const { Auth, totpAt, verifyTotp, base32Encode, base32Decode } = require('../src/main/auth');
const { findUrl } = require('../src/main/tunnel');
const { deviceName, clientIp } = require('../src/main/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));

test('config: bad values fall back to defaults and are reported', () => {
  const { cfg, problems } = normalize({ stream: { fps: 61, bitrateKbps: 'lots', codec: 'H264' }, server: { port: 99999 }, appearance: { accent: 'red' } });
  assert.strictEqual(cfg.stream.fps, DEFAULTS.stream.fps);
  assert.strictEqual(cfg.stream.bitrateKbps, DEFAULTS.stream.bitrateKbps);
  assert.strictEqual(cfg.server.port, 65535); // clamped
  assert.strictEqual(cfg.appearance.accent, DEFAULTS.appearance.accent);
  assert.ok(problems.length >= 3);
});

test('config: presets and ICE servers are cleaned', () => {
  const { cfg } = normalize({
    presets: [{ name: 'Mine', resolution: '720p', fps: 30, bitrateKbps: 2500 }, { name: '', resolution: 'x' }],
    network: { iceServers: [{ urls: 'stun:a.b:3478' }, { urls: 'http://nope' }, { urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }] },
  });
  assert.deepStrictEqual(cfg.presets, [{ name: 'Mine', resolution: '720p', fps: 30, bitrateKbps: 2500 }]);
  assert.strictEqual(cfg.network.iceServers.length, 2);
  assert.strictEqual(cfg.network.iceServers[1].username, 'u');
});

test('config store: writes defaults, applies updates, keeps file valid', () => {
  const dir = tmp();
  const store = new ConfigStore(dir);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  const changed = store.update({ 'stream.fps': 30, 'stream.codec': 'nope', 'appearance.appName': 'My PC' });
  assert.deepStrictEqual(changed.sort(), ['appearance.appName', 'stream.fps']);
  const again = new ConfigStore(dir);
  assert.strictEqual(again.get('stream.fps'), 30);
  assert.strictEqual(again.get('appearance.appName'), 'My PC');
});

test('config store: reads files with a byte-order mark, never wipes a broken file', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '﻿{ "server": { "port": 8430 } }');
  assert.strictEqual(new ConfigStore(dir).get('server.port'), 8430);
  fs.writeFileSync(file, '{ "server": { "port": 8430, } oops');
  const store = new ConfigStore(dir);
  assert.strictEqual(store.get('server.port'), DEFAULTS.server.port);
  assert.ok(store.problems.length === 1);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "server": { "port": 8430, } oops', 'broken file left untouched');
  store.update({ 'stream.fps': 30 });
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('config.json.broken-')), 'a backup is kept before replacing it');
});

test('totp: matches the RFC 6238 test vector', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.strictEqual(base32Decode(secret).toString(), '12345678901234567890');
  assert.strictEqual(totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.ok(verifyTotp(secret, '287082', 59 * 1000));
  assert.ok(!verifyTotp(secret, '000000', 59 * 1000));
});

test('auth: password, sessions, lockout', () => {
  const dir = tmp();
  const cfg = { 'security.maxFailedAttempts': 3, 'security.lockoutMinutes': 15, 'security.sessionDays': 30, 'security.allowedIps': '' };
  const auth = new Auth(dir, k => cfg[k]);
  assert.throws(() => auth.setPassword('short'));
  assert.strictEqual(auth.login('1.2.3.4', { password: 'x' }).ok, false); // not set up
  auth.setPassword('correct horse battery');
  const ok = auth.login('1.2.3.4', { password: 'correct horse battery', remember: true });
  assert.ok(ok.ok && ok.token);
  assert.ok(auth.sessionFor(ok.token));
  assert.strictEqual(auth.sessionFor('nope'), null);
  for (let i = 0; i < 3; i++) assert.strictEqual(auth.login('5.6.7.8', { password: 'wrong' }).ok, false);
  const locked = auth.login('5.6.7.8', { password: 'correct horse battery' });
  assert.strictEqual(locked.ok, false);
  assert.ok(locked.lockedSeconds > 0);
  assert.ok(auth.login('9.9.9.9', { password: 'correct horse battery' }).ok, 'other addresses are not locked');
  auth.logout(ok.token);
  assert.strictEqual(auth.sessionFor(ok.token), null);
  // secrets file never stores the raw token
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes(ok.token));
});

test('auth: two-step code required when enabled', () => {
  const dir = tmp();
  const cfg = { 'security.maxFailedAttempts': 5, 'security.lockoutMinutes': 1, 'security.sessionDays': 1, 'security.allowedIps': '' };
  const auth = new Auth(dir, k => cfg[k]);
  auth.setPassword('another good password');
  const { secret } = auth.startTotp('Test');
  const step = Math.floor(Date.now() / 30000);
  assert.ok(auth.confirmTotp(totpAt(secret, step)));
  const need = auth.login('1.1.1.1', { password: 'another good password' });
  assert.ok(need.needTotp && !need.ok);
  assert.ok(auth.login('1.1.1.1', { password: 'another good password', totp: totpAt(secret, step) }).ok);
  assert.ok(!auth.login('1.1.1.1', { password: 'another good password', totp: '123456' }).ok || totpAt(secret, step) === '123456');
});

test('auth: allowed address list', () => {
  const dir = tmp();
  const cfg = { 'security.maxFailedAttempts': 5, 'security.lockoutMinutes': 1, 'security.sessionDays': 1, 'security.allowedIps': '192.168.1., 100.' };
  const auth = new Auth(dir, k => cfg[k]);
  assert.ok(auth.ipAllowed('192.168.1.20'));
  assert.ok(auth.ipAllowed('100.101.1.2'));
  assert.ok(auth.ipAllowed('127.0.0.1'));
  assert.ok(!auth.ipAllowed('8.8.8.8'));
});

test('tunnel: finds the quick-tunnel link in cloudflared output', () => {
  const out = `2026-11-17T10:00:00Z INF Thank you for trying Cloudflare Tunnel. See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
2026-11-17T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-11-17T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-17T10:00:01Z INF |  https://silly-words-here-1234.trycloudflare.com                                          |`;
  assert.strictEqual(findUrl(out, true), 'https://silly-words-here-1234.trycloudflare.com');
  assert.strictEqual(findUrl('see https://github.com/x then url=https://ab12.ngrok-free.app', false), 'https://ab12.ngrok-free.app');
  assert.strictEqual(findUrl('nothing here', false), null);
});

test('embed origins: tidy list, junk dropped', () => {
  const { parseEmbedOrigins } = require('../src/main/server');
  assert.deepStrictEqual(parseEmbedOrigins('https://My.Site.com/page, dash.example.org  http://localhost:3000, javascript:alert(1), ,'),
    ['https://my.site.com', 'https://dash.example.org', 'http://localhost:3000']);
  assert.deepStrictEqual(parseEmbedOrigins(''), []);
  assert.deepStrictEqual(parseEmbedOrigins('https://a.com, *'), ['*']);
});

test('server helpers: device names and tunnel-aware addresses', () => {
  assert.strictEqual(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.strictEqual(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36 Edg/142.0'), 'Edge on Windows');
  const viaTunnel = clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.deepStrictEqual(viaTunnel, { ip: '203.0.113.9', tunnel: true });
  const spoof = clientIp({ socket: { remoteAddress: '192.168.1.50' }, headers: { 'cf-connecting-ip': '1.1.1.1' } });
  assert.deepStrictEqual(spoof, { ip: '192.168.1.50', tunnel: false });
});

test('privacy screen settings: normal by default, junk falls back', () => {
  const { cfg, problems } = normalize({ privacy: { screen: 'rainbow', screens: 'streamed', message: 'Back soon' } });
  assert.strictEqual(cfg.privacy.screen, 'normal');
  assert.strictEqual(cfg.privacy.screens, 'streamed');
  assert.strictEqual(cfg.privacy.message, 'Back soon');
  assert.strictEqual(cfg.privacy.browserCanChange, true);
  assert.ok(problems.some(p => p.includes('privacy.screen')));
  assert.strictEqual(normalize({ privacy: { screen: 'clock' } }).cfg.privacy.screen, 'clock');
});

test('settings from 1.4 and older move to the new defaults; custom choices stay', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, stream: { codec: 'H264', keyframeSeconds: 3, fps: 30 } }));
  const store = new ConfigStore(dir);
  assert.strictEqual(store.get('stream.codec'), 'auto');
  assert.strictEqual(store.get('stream.keyframeSeconds'), 30);
  assert.strictEqual(store.get('stream.fps'), 30, 'other settings untouched');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).version, 3, 'saved as the newest version');
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ version: 1, stream: { codec: 'VP9', keyframeSeconds: 5 } }));
  const kept = new ConfigStore(dir2);
  assert.strictEqual(kept.get('stream.codec'), 'VP9');
  assert.strictEqual(kept.get('stream.keyframeSeconds'), 5);
  const dir3 = tmp();
  fs.writeFileSync(path.join(dir3, 'config.json'), JSON.stringify({ version: 2, stream: { codec: 'H264' } }));
  assert.strictEqual(new ConfigStore(dir3).get('stream.codec'), 'H264', 'a choice made in 1.5 is left alone');
});

test('1.7 settings upgrade: embedding switched on unless sites were listed', () => {
  const off = tmp();
  fs.writeFileSync(path.join(off, 'config.json'), JSON.stringify({ version: 2, security: { embedOrigins: '' } }));
  assert.strictEqual(new ConfigStore(off).get('security.embedOrigins'), '*');
  const listed = tmp();
  fs.writeFileSync(path.join(listed, 'config.json'), JSON.stringify({ version: 2, security: { embedOrigins: 'https://my.site' } }));
  assert.strictEqual(new ConfigStore(listed).get('security.embedOrigins'), 'https://my.site');
  const fresh = new ConfigStore(tmp());
  assert.strictEqual(fresh.get('security.embedOrigins'), '*', 'new installs start with embedding on');
  const later = tmp();
  fs.writeFileSync(path.join(later, 'config.json'), JSON.stringify({ version: 3, security: { embedOrigins: '' } }));
  assert.strictEqual(new ConfigStore(later).get('security.embedOrigins'), '', 'turning it off after the upgrade sticks');
});
