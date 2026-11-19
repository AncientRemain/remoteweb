// The controller manager, with a stand-in for beam-pad.exe.
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const EventEmitter = require('events');
const { Gamepads } = require('../src/main/gamepad');

function fakeHelper() {
  const lines = [];
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stdin = { write: l => { lines.push(...String(l).trim().split('\n')); return true; }, end: l => { if (l) lines.push(String(l).trim()); }, on: () => {} };
  proc.kill = () => {};
  const say = l => proc.stdout.write(`${l}\n`);
  return { proc, lines, say };
}
const tick = () => new Promise(r => setTimeout(r, 20));

function setup() {
  const h = fakeHelper();
  let spawned = 0;
  const pads = new Gamepads({ exe: 'beam-pad.exe', spawnFn: () => { spawned++; return h.proc; } });
  const events = [];
  pads.on('pad', p => events.push(['pad', p]));
  pads.on('rumble', r => events.push(['rumble', r]));
  return { pads, h, events, spawned: () => spawned };
}

test('controllers: plugged in order, state passed on, player numbers reported', async () => {
  const { pads, h, events } = setup();
  pads.connect('c1', 0, 'Xbox Wireless Controller');
  pads.connect('c1', 1, 'DualSense');
  pads.update('c1', 0, 1, [0x1000, 255, 0, 32767, -32768, 0, 100]);
  assert.deepStrictEqual(h.lines, [], 'nothing is sent before the helper is ready');
  h.say('ready');
  await tick();
  assert.deepStrictEqual(h.lines, ['plug 0', 'plug 1', 'state 0 4096 255 0 32767 -32768 0 100']);
  h.say('plugged 0 1');
  h.say('plugged 1 2');
  await tick();
  assert.deepStrictEqual(events.map(e => e[1].player), [1, 2]);
  assert.strictEqual(pads.status().pads.length, 2);
});

test('controllers: older messages never overwrite newer ones; values are clamped', async () => {
  const { pads, h } = setup();
  pads.connect('c1', 0, 'Pad');
  h.say('ready');
  await tick();
  h.lines.length = 0;
  pads.update('c1', 0, 5, [1, 0, 0, 0, 0, 0, 0]);
  pads.update('c1', 0, 4, [2, 0, 0, 0, 0, 0, 0]); // arrived late
  pads.update('c1', 0, 6, [99999, 300, -5, 50000, -50000, 0, 0]);
  assert.deepStrictEqual(h.lines, ['state 0 1 0 0 0 0 0 0', 'state 0 65535 255 0 32767 -32768 0 0']);
  // A reconnecting page starts counting from 1 again.
  pads.connect('c1', 0, 'Pad');
  pads.update('c1', 0, 1, [3, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(h.lines.at(-1), 'state 0 3 0 0 0 0 0 0');
});

test('controllers: at most four; a fifth is refused', async () => {
  const { pads, h, events } = setup();
  h.say('ready');
  for (let i = 0; i < 5; i++) pads.connect('c1', i, `Pad ${i}`);
  await tick();
  assert.deepStrictEqual(events.filter(e => e[1].error).map(e => [e[1].index, e[1].error]), [[4, 'full']]);
  assert.strictEqual(pads.status().pads.length, 4);
});

test('controllers: missing driver is reported to the page', async () => {
  const { pads, h, events } = setup();
  pads.connect('c1', 0, 'Pad');
  h.say('nodriver not-installed');
  await tick();
  h.proc.emit('exit', 2);
  assert.strictEqual(pads.driver, 'missing');
  assert.deepStrictEqual(events.map(e => e[1].error), ['nodriver']);
  pads.connect('c1', 1, 'Pad 2'); // later attempts get the same answer at once
  assert.strictEqual(events.at(-1)[1].error, 'nodriver');
});

test('controllers: vibration goes to the right device; drops release buttons; leaving unplugs', async () => {
  const { pads, h, events } = setup();
  h.say('ready');
  pads.connect('a', 0, 'Pad A');
  pads.connect('b', 0, 'Pad B');
  await tick();
  h.say('rumble 1 200 40');
  await tick();
  assert.deepStrictEqual(events.find(e => e[0] === 'rumble')[1], { clientId: 'b', index: 0, large: 200, small: 40 });
  h.lines.length = 0;
  pads.neutral('a');
  assert.deepStrictEqual(h.lines, ['state 0 0 0 0 0 0 0 0']);
  pads.releaseClient('a');
  assert.strictEqual(h.lines.at(-1), 'unplug 0');
  assert.deepStrictEqual(pads.status().pads.map(p => p.clientId), ['b']);
  pads.disconnect('b', 0);
  assert.strictEqual(h.lines.at(-1), 'unplug 1');
});
