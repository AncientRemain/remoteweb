// Your own domain through Cloudflare (a "named tunnel"): https://pc.yourdomain.com that never
// changes, with a real certificate. Two ways to set it up:
//   1. Automatic: `cloudflared tunnel login` opens Cloudflare in the browser (you pick the
//      domain and approve), then the app creates the tunnel and the DNS record itself.
//   2. Token: you create the tunnel in Cloudflare's dashboard and paste its token.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// "https://PC.Example.com/" -> "pc.example.com"; null if it isn't a hostname.
function cleanHostname(input) {
  const h = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return HOST_RE.test(h) ? h : null;
}

function tunnelName(hostname) {
  return `beam-remote-${hostname.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60);
}

// A tunnel token is base64 JSON with the account tag (a), tunnel id (t) and secret (s), so it
// starts with "ey". People paste it bare or inside Cloudflare's install command
// ("cloudflared.exe service install eyJ..." or "... run --token eyJ..."), so find it anywhere.
function parseToken(text) {
  const candidates = String(text || '').match(/ey[A-Za-z0-9+/_=-]{40,}/g) || [];
  for (const t of candidates) {
    try {
      const j = JSON.parse(Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (j && j.a && j.t && j.s) return { token: t, tunnelId: j.t };
    } catch { /* not this one */ }
  }
  return null;
}

function originCert() { return path.join(os.homedir(), '.cloudflared', 'cert.pem'); }

const lastLines = out => String(out || '').split(/\r?\n/).map(l => l.replace(/^\S+\s+(ERR|INF|WRN)\s+/, '').trim()).filter(Boolean).slice(-2).join(' ');

function runCmd(bin, args, { timeoutMs = 90000, onLine, env } = {}) {
  return new Promise(resolve => {
    let out = '';
    let p;
    try { p = spawn(bin, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env }); } catch (e) { resolve({ code: -1, out: e.message }); return; }
    const on = d => {
      const s = d.toString();
      out += s;
      if (onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l);
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve({ code: -1, out, timedOut: true }); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${e.message}` }); });
    p.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function readTunnelId(credFile) {
  try { return JSON.parse(fs.readFileSync(credFile, 'utf8')).TunnelID || null; } catch { return null; }
}

// Signs in to Cloudflare in the browser. cloudflared always writes its certificate to
// ~/.cloudflared/cert.pem, so an existing one is set aside for the moment and put back after;
// the app keeps its own copy in its data folder.
async function login({ bin, run, onStep, ourCert }) {
  const def = originCert();
  let backup = null;
  if (fs.existsSync(def)) { backup = `${def}.beam-backup-${Date.now()}`; fs.renameSync(def, backup); }
  try {
    onStep({ step: 'login', message: 'Cloudflare is opening in your browser. Sign in, pick your domain and click Authorize.' });
    const r = await run(bin, ['tunnel', 'login'], {
      timeoutMs: 10 * 60000,
      onLine: l => {
        const m = l.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\S+/);
        if (m) onStep({ step: 'login', message: 'Waiting for you to approve in the browser…', loginUrl: m[0] });
      },
    });
    if (!fs.existsSync(def)) throw new Error(r.timedOut ? 'Cloudflare sign-in timed out. Press Connect to try again.' : `Cloudflare sign-in didn't finish. ${lastLines(r.out)}`);
    fs.copyFileSync(def, ourCert);
  } finally {
    if (backup) { try { if (fs.existsSync(def)) fs.unlinkSync(def); fs.renameSync(backup, def); } catch { /* leave both */ } }
  }
}

// Returns { ok: true, id, name, credFile } or { ok: false, needOverwrite: true, message }.
// Throws with a readable message when something else goes wrong.
async function setupDomain({ bin, hostname, dir, overwrite = false, forceLogin = false, run = runCmd, onStep = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const ourCert = path.join(dir, 'cert.pem');
  if (forceLogin) { try { fs.unlinkSync(ourCert); } catch { /* none */ } }
  if (!fs.existsSync(ourCert)) {
    // Already signed in to Cloudflare with cloudflared on this PC? Reuse that.
    if (!forceLogin && fs.existsSync(originCert())) fs.copyFileSync(originCert(), ourCert);
    else await login({ bin, run, onStep, ourCert });
  }
  const env = { TUNNEL_ORIGIN_CERT: ourCert };

  const name = tunnelName(hostname);
  const credFile = path.join(dir, `${name}.json`);
  let id = readTunnelId(credFile);
  if (!id) {
    onStep({ step: 'tunnel', message: 'Creating your tunnel…' });
    let r = await run(bin, ['tunnel', 'create', '--credentials-file', credFile, name], { env });
    const m = r.out.match(/with id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) id = m[1];
    else if (/already exists/i.test(r.out)) {
      // Made earlier (another install, or credentials lost): fetch its credentials instead.
      r = await run(bin, ['tunnel', 'token', '--cred-file', credFile, name], { env });
    }
    id = id || readTunnelId(credFile);
    if (!id) throw new Error(`Couldn't create the tunnel. ${lastLines(r.out)}`);
  }

  onStep({ step: 'dns', message: `Pointing ${hostname} at this PC…` });
  const args = ['tunnel', 'route', 'dns'];
  if (overwrite) args.push('--overwrite-dns');
  args.push(id, hostname);
  const r = await run(bin, args, { env });
  const already = /already configured to route to (your|this) tunnel/i.test(r.out);
  if (r.code !== 0 && !already) {
    if (/already exists/i.test(r.out)) {
      return { ok: false, needOverwrite: true, message: `${hostname} already has a DNS record in Cloudflare. Replace it so it points to this PC?` };
    }
    if (/zone|not found|could not find/i.test(r.out)) {
      throw new Error(`${hostname} isn't part of the domain you approved in Cloudflare. Use an address on that domain, or press "Use a different Cloudflare domain".`);
    }
    throw new Error(`Couldn't set up ${hostname}. ${lastLines(r.out)}`);
  }
  return { ok: true, id, name, credFile };
}

// cloudflared's settings for a named tunnel: send this hostname to the local web server.
function writeConfig({ dir, id, credFile, hostname, port }) {
  const file = path.join(dir, 'config.yml');
  const yaml = [
    '# Written by Beam Remote. Changes are overwritten each time remote access starts.',
    `tunnel: ${id}`,
    `credentials-file: ${JSON.stringify(credFile)}`,
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${port}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, yaml);
  return file;
}

module.exports = { cleanHostname, tunnelName, parseToken, setupDomain, writeConfig, originCert, runCmd };
