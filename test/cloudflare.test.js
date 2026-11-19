const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the home folder at a temp dir so nothing touches the real ~/.cloudflared.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const cf = require('../src/main/cloudflare');

const UUID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beam-cf-'));

// A fake cloudflared that records calls and behaves like the real one.
function fakeCloudflared({ routeOut = { code: 0, out: 'INF Added CNAME pc.example.com which will route to this tunnel' }, existing = false } = {}) {
  const calls = [];
  const run = async (bin, args, opts = {}) => {
    calls.push({ args, env: opts.env });
    const [, cmd] = args;
    if (cmd === 'login') {
      opts.onLine && opts.onLine('Please open the following URL: https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fx');
      fs.mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
      fs.writeFileSync(cf.originCert(), 'NEW-CERT');
      return { code: 0, out: 'You have successfully logged in.' };
    }
    if (cmd === 'create') {
      if (existing) return { code: 1, out: 'ERR failed to create tunnel: tunnel with name already exists' };
      fs.writeFileSync(args[3], JSON.stringify({ TunnelID: UUID }));
      return { code: 0, out: `Created tunnel ${args[4]} with id ${UUID}` };
    }
    if (cmd === 'token') { fs.writeFileSync(args[3], JSON.stringify({ TunnelID: UUID })); return { code: 0, out: '' }; }
    if (cmd === 'route') return routeOut;
    return { code: 1, out: 'unknown' };
  };
  return { run, calls };
}

test('cleans hostnames and rejects junk', () => {
  assert.strictEqual(cf.cleanHostname('https://PC.Example.com/path?x'), 'pc.example.com');
  assert.strictEqual(cf.cleanHostname('pc.example.co.uk:443'), 'pc.example.co.uk');
  assert.strictEqual(cf.cleanHostname('localhost'), null);
  assert.strictEqual(cf.cleanHostname('not a host.com'), null);
  assert.strictEqual(cf.tunnelName('pc.example.com'), 'beam-remote-pc-example-com');
});

test('recognises tunnel tokens, even pasted with the install command', () => {
  const token = Buffer.from(JSON.stringify({ a: 'acct', t: UUID, s: 'secret' })).toString('base64');
  assert.deepStrictEqual(cf.parseToken(`cloudflared.exe service install ${token}`), { token, tunnelId: UUID });
  assert.deepStrictEqual(cf.parseToken(`cloudflared tunnel run --token ${token}`), { token, tunnelId: UUID });
  assert.deepStrictEqual(cf.parseToken(` ${token} `), { token, tunnelId: UUID });
  assert.strictEqual(cf.parseToken('hello'), null);
  assert.strictEqual(cf.parseToken(`ey${'A'.repeat(50)}`), null);
});

test('first setup: signs in, creates the tunnel, adds the DNS record', async () => {
  const dir = tmp();
  const { run, calls } = fakeCloudflared();
  const steps = [];
  const r = await cf.setupDomain({ bin: 'cloudflared', hostname: 'pc.example.com', dir, run, onStep: s => steps.push(s) });
  assert.deepStrictEqual(r, { ok: true, id: UUID, name: 'beam-remote-pc-example-com', credFile: path.join(dir, 'beam-remote-pc-example-com.json') });
  assert.deepStrictEqual(calls.map(c => c.args.slice(0, 3).join(' ')), ['tunnel login', 'tunnel create --credentials-file', 'tunnel route dns']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), 'NEW-CERT', 'keeps its own copy of the certificate');
  assert.ok(calls.slice(1).every(c => c.env && c.env.TUNNEL_ORIGIN_CERT === path.join(dir, 'cert.pem')));
  assert.ok(steps.some(s => s.loginUrl && s.loginUrl.startsWith('https://dash.cloudflare.com/argotunnel')));
});

test('second setup reuses the tunnel; existing DNS record asks before replacing', async () => {
  const dir = tmp();
  const first = fakeCloudflared();
  await cf.setupDomain({ bin: 'x', hostname: 'pc.example.com', dir, run: first.run });
  const second = fakeCloudflared({ routeOut: { code: 1, out: 'ERR Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.' } });
  const r = await cf.setupDomain({ bin: 'x', hostname: 'pc.example.com', dir, run: second.run });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needOverwrite, true);
  assert.deepStrictEqual(second.calls.map(c => c.args[1]), ['route'], 'no new login or tunnel');
  const third = fakeCloudflared();
  const ok = await cf.setupDomain({ bin: 'x', hostname: 'pc.example.com', dir, run: third.run, overwrite: true });
  assert.strictEqual(ok.ok, true);
  assert.ok(third.calls[0].args.includes('--overwrite-dns'));
});

test('tunnel made elsewhere: fetches its credentials instead of failing', async () => {
  const dir = tmp();
  const { run, calls } = fakeCloudflared({ existing: true });
  const r = await cf.setupDomain({ bin: 'x', hostname: 'pc2.example.com', dir, run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, UUID);
  assert.ok(calls.some(c => c.args[1] === 'token' && c.args.includes('--cred-file')));
});

test('switching Cloudflare domain puts an existing ~/.cloudflared certificate back afterwards', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  fs.writeFileSync(cf.originCert(), 'USERS-OWN-CERT');
  const { run } = fakeCloudflared();
  await cf.setupDomain({ bin: 'x', hostname: 'pc.example.com', dir, run, forceLogin: true });
  assert.strictEqual(fs.readFileSync(cf.originCert(), 'utf8'), 'USERS-OWN-CERT', 'user\'s certificate restored');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), 'NEW-CERT', 'app got the new one');
});

test('writes a cloudflared config that survives paths with spaces and quotes', () => {
  const dir = tmp();
  const credFile = "C:\\Users\\Jo's PC\\AppData\\Roaming\\Beam Remote\\cloudflare\\t.json";
  const file = cf.writeConfig({ dir, id: UUID, credFile, hostname: 'pc.example.com', port: 8420 });
  const yaml = fs.readFileSync(file, 'utf8');
  assert.ok(yaml.includes(`tunnel: ${UUID}`));
  assert.ok(yaml.includes(`credentials-file: ${JSON.stringify(credFile)}`));
  assert.ok(yaml.includes('service: http://127.0.0.1:8420'));
  assert.ok(yaml.trim().endsWith('- service: http_status:404'));
});
