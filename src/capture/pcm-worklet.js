// Plays PCM chunks posted from the capture window into a WebAudio graph, so they become a
// normal audio track for WebRTC. Keeps a small buffer (set by the latency mode, 12-120 ms):
// enough to ride out jitter between the sound helper and this window, little enough that
// sound stays close to the picture.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;     // frames already used from queue[0]
    this.buffered = 0;   // frames waiting
    this.playing = false;
    this.start = 0.015;  // seconds to collect before playing (again)
    this.max = 0.07;     // never hold more than this; the oldest sound is dropped
    this.port.onmessage = e => {
      const d = e.data;
      if (d && d.config) {
        this.start = d.config.start;
        this.max = d.config.max;
        return;
      }
      this.queue.push(d);
      this.buffered += d.length / 2;
      const max = sampleRate * this.max;
      while (this.buffered > max && this.queue.length > 1) {
        const old = this.queue.shift();
        this.buffered -= old.length / 2 - this.offset;
        this.offset = 0;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.playing) {
      if (this.buffered < sampleRate * this.start) return true; // build up a little first
      this.playing = true;
    }
    let i = 0;
    while (i < n && this.queue.length) {
      const d = this.queue[0];
      const take = Math.min(d.length / 2 - this.offset, n - i);
      for (let k = 0; k < take; k++) {
        L[i + k] = d[(this.offset + k) * 2];
        R[i + k] = d[(this.offset + k) * 2 + 1];
      }
      i += take; this.offset += take; this.buffered -= take;
      if (this.offset >= d.length / 2) { this.queue.shift(); this.offset = 0; }
    }
    if (i < n) this.playing = false; // ran dry: wait for the buffer to refill
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
