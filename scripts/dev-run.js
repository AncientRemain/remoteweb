// Developer launcher: runs the app with its console output shown here, with timestamps.
//   node scripts/dev-run.js [--data-dir=...] [other electron args]
const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron'); // path to electron.exe when required from Node
const args = [path.join(__dirname, '..'), ...process.argv.slice(2)];
const child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
const stamp = () => new Date().toISOString().slice(11, 23);
const pipe = (stream, tag) => {
  let buf = '';
  stream.on('data', d => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) {
      if (!l.trim() || /GetVSyncParametersIfAvailable|gpu_init|Autofill\.|DXGI/.test(l)) continue;
      console.log(`${stamp()} ${tag} ${l}`);
    }
  });
};
pipe(child.stdout, 'out');
pipe(child.stderr, 'err');
child.on('exit', code => { console.log(`${stamp()} exited with code ${code}`); process.exit(code || 0); });
process.on('SIGINT', () => child.kill());
