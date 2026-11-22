// Paid copies: signed licenses, one-time codes, seller copies, founders and the hub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { License, Hub, signLicense, readLicense, publicKeyFrom, cleanCode, validCode, KEY_FILE, STATE_FILE } = require('../src/main/license');

const keys = crypto.generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const pubKey = publicKeyFrom(PUB);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beam-lic-'));
const pcA = 'a'.repeat(24), pcB = 'b'.repeat(24), pcC = 'c'.repeat(24);
const PAST = Date.now() - 86400000;      // a cut-off before this test's folders were made
const FUTURE = Date.now() + 86400000;    // a cut-off after: the folder counts as "set up before"

function newHub(over = {}) { return new Hub({ dir: tmp(), privateKey: keys.privateKey, publicKey: pubKey, cutoff: FUTURE, ...over }); }
// A fake network: copies' requests go straight to the hub.
const viaHub = (hub, ip = '203.0.113.9') => async (url, opts) => {
  const r = hub.handle(url.split('/api/license/')[1], JSON.parse(opts.body), ip);
  return { status: 200, text: async () => JSON.stringify(r) };
};
const offline = async () => { throw new Error('offline'); };
function copy({ hub, pc = pcA, cutoff = PAST, dir = tmp(), fetchImpl } = {}) {
  const l = new License({ dir, publicKey: PUB, cutoff, pc, fetchImpl: fetchImpl || (hub ? viaHub(hub) : offline), hubUrl: 'http://hub.test' });
  l.load();
  return l;
}

test('licenses: signed, tied to their contents, checked with the public key only', () => {
  const token = signLicense(keys.privateKey, { v: 1, kind: 'user', pc: pcA });
  assert.strictEqual(readLicense(token, pubKey).pc, pcA);
  const [a, b] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, kind: 'seller', pc: pcA })).toString('base64url');
  assert.strictEqual(readLicense(`${forged}.${b}`, pubKey), null, 'changed contents');
  const other = crypto.generateKeyPairSync('ed25519');
  assert.strictEqual(readLicense(signLicense(other.privateKey, { v: 1, kind: 'user', pc: pcA }), pubKey), null, 'someone else\'s key');
  assert.strictEqual(readLicense(`${a}.`, pubKey), null);
  assert.strictEqual(readLicense('junk', pubKey), null);
});

test('codes: 8 easy-to-read characters, typed any way', () => {
  const hub = newHub();
  const r = hub.act('hub', 'make', { count: 3 });
  assert.strictEqual(r.made.length, 3);
  for (const c of r.made) {
    assert.match(c, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.ok(validCode(cleanCode(c.toLowerCase().replace('-', ' '))));
  }
});

test('a new copy needs a code; a code works once, on one PC', async () => {
  const hub = newHub();
  const [code] = hub.act('hub', 'make').made;
  const a = copy({ hub, pc: pcA });
  assert.strictEqual(a.kind, 'none');
  assert.strictEqual(a.activated, false);
  assert.strictEqual((await a.activate('nope')).ok, false);
  assert.strictEqual((await a.activate(code.toLowerCase())).ok, true);
  assert.strictEqual(a.kind, 'user');
  assert.strictEqual(a.canSell, false);
  // Starting again: still activated, without the hub.
  const again = new License({ dir: a.dir, publicKey: PUB, cutoff: PAST, pc: pcA, fetchImpl: offline });
  assert.strictEqual(again.load(), 'user');
  // Same PC again (reinstalled): fine. Another PC: refused.
  assert.strictEqual((await copy({ hub, pc: pcA }).activate(code)).ok, true);
  const b = copy({ hub, pc: pcB });
  const r = await b.activate(code);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /another PC/);
  assert.strictEqual(b.kind, 'none');
  assert.strictEqual(hub.view('hub').sold, 1);
});

test('a license copied to another PC does nothing there', () => {
  const dir = tmp();
  const token = signLicense(keys.privateKey, { v: 1, kind: 'seller', pc: pcA, sid: 'SX' });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ seen: 1, license: token }));
  assert.strictEqual(copy({ dir, pc: pcB }).kind, 'none');
  assert.strictEqual(copy({ dir, pc: pcA }).kind, 'seller');
});

test('cancelled codes stop working; wrong guesses are slowed down', async () => {
  const hub = newHub();
  const [code] = hub.act('hub', 'make').made;
  assert.strictEqual(hub.act('hub', 'cancel', { code }).ok, true);
  assert.strictEqual((await copy({ hub }).activate(code)).ok, false);
  const guesser = copy({ hub, fetchImpl: viaHub(hub, '198.51.100.7') });
  for (let i = 0; i < 10; i++) await guesser.activate('ZZZZ-ZZZZ');
  const [good] = hub.act('hub', 'make').made;
  const r = await guesser.activate(good);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Too many wrong codes/);
  assert.strictEqual((await copy({ hub, pc: pcC }).activate(good)).ok, true, 'other addresses are not affected');
});

test('existing copies are founders: free, and they become sellers through the hub', async () => {
  const hub = newHub();
  const f = copy({ hub, pc: pcA, cutoff: FUTURE });
  assert.strictEqual(f.kind, 'founder');
  assert.strictEqual(f.activated, true);
  assert.strictEqual(f.canSell, true);
  const made = await f.seller('make', { count: 2 });
  assert.strictEqual(made.ok, true, made.error);
  assert.strictEqual(f.kind, 'seller');
  assert.strictEqual(f.public().founder, true);
  assert.strictEqual(made.made.length, 2);
  const buyer = copy({ hub, pc: pcB });
  assert.strictEqual((await buyer.activate(made.made[0])).ok, true);
  assert.strictEqual(buyer.kind, 'user');
  const info = await f.seller('info');
  assert.strictEqual(info.sold, 1);
  assert.strictEqual(info.ready, 1);
  assert.strictEqual(info.price, '$20');
  // Founder status survives a restart, and hand-made founder records don't work.
  assert.strictEqual(copy({ dir: f.dir, pc: pcA, cutoff: FUTURE }).kind, 'seller');
  const fake = tmp();
  fs.writeFileSync(path.join(fake, STATE_FILE), JSON.stringify({ seen: 1, founder: { pc: pcC, since: 1, tag: 'x' } }));
  assert.strictEqual(copy({ dir: fake, pc: pcC }).kind, 'none');
});

test('a copy set up after the cut-off is not a founder', () => {
  assert.strictEqual(copy({ cutoff: PAST }).kind, 'none');
});

test('founders wait for the owner when automatic approval is off', async () => {
  const hub = newHub();
  hub.setSettings({ autoFounders: false });
  const f = copy({ hub, pc: pcA, cutoff: FUTURE });
  const r = await f.seller('make');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(f.kind, 'founder', 'still free to use');
  assert.strictEqual(hub.overview().pending.length, 1);
  assert.strictEqual(hub.allowPending(pcA), true);
  assert.strictEqual((await f.seller('make')).ok, true);
  assert.strictEqual(f.kind, 'seller');
});

test('seller codes from the owner make seller copies', async () => {
  const hub = newHub();
  const [code] = hub.act('hub', 'make', { kind: 'seller' }).made;
  const s = copy({ hub, pc: pcB });
  assert.strictEqual((await s.activate(code)).ok, true);
  assert.strictEqual(s.kind, 'seller');
  const r = await s.seller('make', { count: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.codes[0].kind, 'user', 'sellers only make normal codes');
  // A normal copy can be upgraded with a seller code.
  const u = copy({ hub, pc: pcC });
  await u.activate(hub.act('hub', 'make').made[0]);
  assert.strictEqual(u.kind, 'user');
  await u.activate(hub.act('hub', 'make', { kind: 'seller' }).made[0]);
  assert.strictEqual(u.kind, 'seller');
});

test('turning a seller off stops their codes; sellers can\'t act for others', async () => {
  const hub = newHub();
  const s = copy({ hub, pc: pcA, cutoff: FUTURE });
  const { made } = await s.seller('make', { count: 2 });
  assert.strictEqual((await copy({ hub, pc: pcB }).activate(made[0])).ok, true);
  hub.setSeller(s.info.sid, { blocked: true });
  assert.strictEqual((await s.seller('make')).blocked, true);
  assert.strictEqual((await copy({ hub, pc: pcC }).activate(made[1])).ok, false, 'unsold code stops working');
  // A stolen license without its secret is useless.
  const r = hub.handle('seller', { license: s.state.license, secret: 'wrong', action: 'make' }, '192.0.2.1');
  assert.strictEqual(r.ok, false);
  // The buyer who already activated keeps working.
  const buyer = new License({ dir: tmp(), publicKey: PUB, cutoff: PAST, pc: pcB, fetchImpl: viaHub(hub) });
  buyer.load();
  assert.strictEqual((await buyer.activate(made[0])).ok, true);
});

test('sellers have a limit on unsold codes', async () => {
  const hub = newHub();
  const s = copy({ hub, pc: pcA, cutoff: FUTURE });
  for (let i = 0; i < 3; i++) assert.strictEqual((await s.seller('make', { count: 10 })).ok, true);
  const r = await s.seller('make', { count: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /30 unsold codes/);
});

test('the owner\'s PC is the hub only with the matching signing key', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, KEY_FILE), keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const owner = copy({ dir, cutoff: PAST });
  assert.strictEqual(owner.kind, 'hub');
  assert.strictEqual(owner.canSell, true);
  const other = tmp();
  fs.writeFileSync(path.join(other, KEY_FILE), crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
  assert.strictEqual(copy({ dir: other, cutoff: PAST }).kind, 'none');
});

test('no hub reachable: activation says so and nothing changes', async () => {
  const c = copy({ fetchImpl: offline });
  const r = await c.activate('K7Q2-M9XD');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Couldn't reach/);
  const f = copy({ fetchImpl: offline, cutoff: FUTURE });
  await f.registerFounder();
  assert.strictEqual(f.kind, 'founder');
  assert.strictEqual(f.sellerStatus, 'offline');
});

test('no code: ask with a name; a seller unlocks it as paid or free, and the copy activates by itself', async () => {
  const hub = newHub();
  const seller = copy({ hub, pc: pcA, cutoff: FUTURE });
  await seller.seller('info'); // becomes a seller
  const asker = copy({ hub, pc: pcB });
  assert.strictEqual((await asker.requestAccess({ name: '   ' })).ok, false, 'a name is needed');
  const sent = await asker.requestAccess({ name: 'Jake', message: 'Alex sent me' });
  assert.strictEqual(sent.ok, true, sent.error);
  assert.strictEqual(asker.public().request.status, 'pending');
  // Every seller and the owner see who's waiting and what they typed (not the PC id).
  const seen = await seller.seller('info');
  assert.strictEqual(seen.requests.length, 1);
  assert.strictEqual(seen.requests[0].name, 'Jake');
  assert.strictEqual(seen.requests[0].message, 'Alex sent me');
  assert.ok(seen.requests[0].pcName && seen.requests[0].os);
  assert.strictEqual(seen.requests[0].pc, undefined);
  assert.strictEqual(seller.public().waiting, 1);
  assert.strictEqual(hub.view('hub').requests.length, 1);
  await asker.checkRequest();
  assert.strictEqual(asker.kind, 'none', 'still waiting');
  const r = await seller.seller('unlock', { id: seen.requests[0].id, reason: 'free' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.unlocked.free, 1);
  assert.strictEqual(r.handled[0].byYou, true);
  await asker.checkRequest();
  assert.strictEqual(asker.kind, 'user');
  assert.strictEqual(asker.info.reason, 'free');
  // The owner sees who unlocked it and why; it can only be handled once.
  const h = hub.view('hub').handled[0];
  assert.strictEqual(h.reason, 'free');
  assert.strictEqual(h.by, seller.info.sid);
  assert.strictEqual(hub.overview().totals.free, 1);
  assert.strictEqual(hub.overview().sellers[0].free, 1);
  assert.strictEqual((await seller.seller('unlock', { id: seen.requests[0].id, reason: 'paid' })).ok, false);
});

test('requests: declined, replaced, cancelled, withdrawn by a code, and limited', async () => {
  const hub = newHub();
  const a = copy({ hub, pc: pcB });
  await a.requestAccess({ name: 'Sam' });
  hub.act('hub', 'decline', { id: hub.view('hub').requests[0].id });
  await a.checkRequest();
  assert.strictEqual(a.public().request.status, 'declined');
  assert.strictEqual(a.kind, 'none');
  await a.requestAccess({ name: 'Sam', message: 'please' });
  await a.requestAccess({ name: 'Sam again' });
  assert.strictEqual(hub.view('hub').requests.length, 1, 'one open request per PC');
  assert.strictEqual(hub.view('hub').requests[0].name, 'Sam again');
  await a.cancelRequest();
  assert.strictEqual(hub.view('hub').requests.length, 0);
  assert.strictEqual(a.public().request, null);
  await a.requestAccess({ name: 'Sam' });
  await a.activate(hub.act('hub', 'make').made[0]);
  assert.strictEqual(a.kind, 'user');
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(hub.view('hub').requests.length, 0, 'activating with a code withdraws the request');
  const spam = copy({ hub, pc: pcC, fetchImpl: viaHub(hub, '192.0.2.50') });
  let last;
  for (let i = 0; i < 6; i++) last = await spam.requestAccess({ name: `x${i}` });
  assert.strictEqual(last.ok, false);
  assert.match(last.error, /Too many requests/);
});

test('requests: odd or long text is cut down; the owner unlocks one as paid', async () => {
  const hub = newHub();
  const a = copy({ hub, pc: pcB });
  await a.requestAccess({ name: `J\u0007ake${'x'.repeat(100)}`, message: `line1\nline2${'y'.repeat(500)}` });
  const q = hub.view('hub').requests[0];
  assert.ok(q.name.length <= 40 && !q.name.includes('\u0007'));
  assert.ok(q.message.length <= 200 && !q.message.includes('\n'));
  assert.strictEqual(hub.act('hub', 'unlock', { id: q.id, reason: 'paid' }).ok, true);
  await a.checkRequest();
  assert.strictEqual(a.kind, 'user');
  assert.strictEqual(a.info.reason, 'paid');
  assert.strictEqual(hub.overview().totals.sold, 1);
  // Someone else can't fetch this request's license.
  assert.strictEqual(hub.handle('request-status', { id: q.id, secret: 'guess' }, '192.0.2.9').ok, false);
});
