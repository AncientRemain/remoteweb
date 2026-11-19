// Builds the installer and publishes it as a GitHub release, which is where installed copies
// of the app look for updates (see "build.publish" in package.json).
//
//   npm run release                       build, then publish v<version from package.json>
//   npm run release -- --no-build         publish what is already in dist/
//   npm run release -- --notes-file=CHANGES.md
//   npm run release -- --dry-run          show what would happen, change nothing
//
// Needs a GitHub token with permission to create releases on the repository: GH_TOKEN or
// GITHUB_TOKEN, or the one Git already uses for github.com (Git Credential Manager).
// The token is never printed.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const pub = (pkg.build.publish || []).find(p => p.provider === 'github');
if (!pub) fail('package.json has no GitHub entry in build.publish.');
const { owner, repo } = pub;
const version = pkg.version;
const tag = `v${version}`;
const args = process.argv.slice(2);
const has = f => args.includes(f);
const arg = k => (args.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const DRY = has('--dry-run');

function fail(msg) { console.error(`\n${msg}`); process.exit(1); }
const log = msg => console.log(msg);

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Ask Git for the github.com credential without ever showing a sign-in window.
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  const m = /^password=(.+)$/m.exec(r.stdout || '');
  return m ? m[1].trim() : '';
}

function request(method, url, { body, headers = {}, file } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = {
      'User-Agent': 'beam-remote-release', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${TOKEN}`, ...headers,
    };
    let data = null;
    if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    if (file) { h['Content-Type'] = 'application/octet-stream'; h['Content-Length'] = fs.statSync(file).size; }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.end(data);
    else if (file) {
      const size = fs.statSync(file).size;
      let sent = 0, shown = 0;
      const rs = fs.createReadStream(file);
      rs.on('data', c => {
        sent += c.length;
        const pct = Math.floor((sent / size) * 100);
        if (pct >= shown + 10) { shown = pct; process.stdout.write(` ${pct}%`); }
      });
      rs.on('end', () => process.stdout.write('\n'));
      rs.pipe(req);
    } else req.end();
  });
}

let TOKEN = '';

async function main() {
  log(`Beam Remote ${version} -> github.com/${owner}/${repo} (${tag})`);

  if (!has('--no-build')) {
    log('\nBuilding the installer...');
    if (!DRY) {
      const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) fail('The build failed.');
    }
  }

  const dist = path.join(ROOT, 'dist');
  const exe = `Beam-Remote-Setup-${version}.exe`;
  const files = [exe, `${exe}.blockmap`, 'latest.yml'].map(n => path.join(dist, n));
  for (const f of files) if (!fs.existsSync(f) && !DRY) fail(`Missing ${path.relative(ROOT, f)}. Build first (npm run release without --no-build).`);
  if (!DRY) {
    const yml = fs.readFileSync(files[2], 'utf8');
    if (!yml.includes(`version: ${version}`) || !yml.includes(exe)) fail('dist/latest.yml does not match this version. Build again.');
  }

  TOKEN = token();
  if (!TOKEN) fail('No GitHub token. Set GH_TOKEN, or sign in to GitHub with Git on this PC first.');

  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const repoInfo = await request('GET', api);
  if (repoInfo.status !== 200) fail(`Can't reach the repository (${repoInfo.status}). Check the name and that the token can access it.`);

  let notes = `Beam Remote ${version}`;
  const nf = arg('notes-file');
  if (nf) notes = fs.readFileSync(path.resolve(nf), 'utf8');

  let rel = await request('GET', `${api}/releases/tags/${tag}`);
  if (rel.status === 404) {
    log(`\nCreating release ${tag}...`);
    if (DRY) { log('(dry run: stopping here)'); return; }
    rel = await request('POST', `${api}/releases`, {
      body: { tag_name: tag, target_commitish: repoInfo.json.default_branch, name: `Beam Remote ${version}`, body: notes, draft: false, prerelease: false, make_latest: 'true' },
    });
    if (rel.status === 422 && /empty/i.test(rel.text)) fail('The repository is empty. Push at least one commit first; GitHub attaches releases to a commit.');
    if (rel.status !== 201) fail(`Creating the release failed (${rel.status}): ${(rel.json && rel.json.message) || rel.text.slice(0, 200)}`);
  } else if (rel.status === 200) {
    log(`\nRelease ${tag} exists; replacing its files.`);
    if (DRY) { log('(dry run: stopping here)'); return; }
  } else fail(`Looking up the release failed (${rel.status}).`);

  const release = rel.json;
  for (const f of files) {
    const name = path.basename(f);
    const old = (release.assets || []).find(a => a.name === name);
    if (old) await request('DELETE', `${api}/releases/assets/${old.id}`);
    process.stdout.write(`Uploading ${name} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    const up = await request('POST', `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { file: f });
    if (up.status !== 201) fail(`Upload of ${name} failed (${up.status}): ${(up.json && up.json.message) || up.text.slice(0, 200)}`);
  }
  log(`\nPublished: ${release.html_url}`);
  log('Installed copies pick it up within a few hours (or at once with "Check now").');
}

main().catch(e => fail(e.stack || String(e)));
