// Makes the activation server's signing key (once, on the owner's PC).
//   node scripts/license-keys.js <private-key-file> [<backup-file>]
// Writes the private key (never share it, never commit it) and prints the public key, which
// goes into PUBLIC_KEY in src/main/license.js. Refuses to overwrite an existing key: every
// copy ever activated depends on it.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [file, backup] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/license-keys.js <private-key-file> [<backup-file>]'); process.exit(1); }
for (const f of [file, backup].filter(Boolean)) {
  if (fs.existsSync(f)) { console.error(`${f} already exists; not overwriting it.`); process.exit(1); }
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
for (const f of [file, backup].filter(Boolean)) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, pem, { mode: 0o600 });
  console.log(`private key written: ${f}`);
}
console.log(`PUBLIC_KEY = '${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}'`);
