const test = require('node:test');
const assert = require('node:assert');
const { SystemAudio, MAGIC } = require('../src/main/audio');

function packet(rate, frames, value) {
  const b = Buffer.alloc(16 + frames * 8);
  b.writeUInt32LE(MAGIC, 0); b.writeUInt32LE(rate, 4); b.writeUInt32LE(2, 8); b.writeUInt32LE(frames, 12);
  for (let i = 0; i < frames * 2; i++) b.writeFloatLE(value, 16 + i * 4);
  return b;
}

test('sound packets split across reads become 10 ms PCM chunks', () => {
  const a = new SystemAudio('none.exe');
  const out = [];
  a.on('pcm', m => out.push(m));
  const stream = Buffer.concat([packet(48000, 480, 0.25), packet(48000, 480, -0.5)]);
  // deliver in awkward pieces, plus a stray byte before the first packet
  const pieces = [Buffer.from([7]), stream.subarray(0, 5), stream.subarray(5, 1000), stream.subarray(1000)];
  for (const p of pieces) a.onData(p);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].rate, 48000);
  assert.strictEqual(out[0].data.length, 960);
  assert.strictEqual(out[0].data[0], 0.25);
  assert.strictEqual(out[1].data[959], -0.5);
});

test('a missing helper reports an error instead of crashing', () => {
  const a = new SystemAudio('C:\\nope\\beam-audio.exe');
  a.start();
  assert.strictEqual(a.status.state, 'error');
  a.stop();
  assert.strictEqual(a.status.state, 'off');
});
