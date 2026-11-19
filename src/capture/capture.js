// Hidden window that captures the screen (and sound) and sends it to each connected
// browser, in one of two ways:
//   WebRTC     peer-to-peer, UDP, lowest latency. One RTCPeerConnection per browser.
//   WebSocket  frames encoded here with WebCodecs and relayed by the app over the same
//              connection as the web page, so it works through any tunnel.
/* global host */ // the bridge to the app, from preload-capture.js

let settings = { resolution: 'native', fps: 60, bitrateKbps: 20000, codec: 'H264', audio: 'loopback', contentHint: 'motion', degradation: 'balanced', keyframeSeconds: 3, hardwareEncoding: 'prefer-hardware' };
let ice = [];
let media = null;
let mediaPromise = null;
const peers = new Map();     // client id -> { pc, ctl, mv, prev }
const wsClients = new Map(); // client id -> decodable codec list
const latencyOf = new Map(); // client id -> 'lowest' | 'balanced' | 'smooth'
const PLAYOUT_DELAY = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

const log = (...a) => { console.log('[capture]', ...a); host.send('cap:log', a.map(String).join(' ')); };
const maxHeight = r => (r === 'native' ? 0 : parseInt(r, 10) || 0);
const now = () => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------- capture
function videoConstraints() {
  const v = { frameRate: { ideal: settings.fps, max: settings.fps } };
  const h = maxHeight(settings.resolution);
  if (h) { v.height = { max: h }; v.width = { max: h * 4 }; }
  return v;
}

async function getMedia() {
  if (media && media.getVideoTracks()[0]?.readyState === 'live') return media;
  if (mediaPromise) return mediaPromise;
  mediaPromise = (async () => {
    // Picture only: sound comes from the beam-audio helper (see the sound section below).
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints(), audio: false });
    const vt = stream.getVideoTracks()[0];
    vt.contentHint = settings.contentHint;
    vt.addEventListener('ended', () => {
      if (media !== stream) return;
      log('screen capture ended; restarting');
      media = null;
      if (peers.size || wsClients.size) reacquire();
    });
    const s = vt.getSettings();
    log(`capturing ${s.width}x${s.height} @ ${s.frameRate} fps`);
    media = stream;
    return stream;
  })();
  try { return await mediaPromise; } finally { mediaPromise = null; }
}

function stopMedia() {
  if (media) media.getTracks().forEach(t => t.stop());
  media = null;
}

// New screen or new capture settings: grab again and swap the tracks everywhere.
async function reacquire() {
  const old = media;
  media = null;
  stopWsReaders();
  try {
    const stream = await getMedia();
    if (old && old !== stream) old.getTracks().forEach(t => t.stop());
    for (const peer of peers.values()) {
      for (const t of peer.pc.getTransceivers()) {
        if (t.currentDirection === 'stopped' || !t.sender || t.receiver.track.kind !== 'video') continue;
        await t.sender.replaceTrack(stream.getVideoTracks()[0] || null).catch(e => log('replaceTrack', e.message));
      }
      applySenderParams(peer);
    }
    if (wsClients.size) { wsv.needKey = true; startWsReaders(stream); }
  } catch (e) {
    host.send('cap:error', { code: 'capture', message: `Screen capture failed: ${e.message}` });
  }
}

async function applyCaptureSettings(prev) {
  if (prev.audio !== settings.audio) attachAudio();
  if (!media) return;
  const vt = media.getVideoTracks()[0];
  if (vt && (prev.fps !== settings.fps || prev.resolution !== settings.resolution)) {
    try {
      const c = videoConstraints();
      if (!c.height) { c.width = { max: 16384 }; c.height = { max: 16384 }; }
      await vt.applyConstraints(c);
    } catch (e) { log('applyConstraints failed, re-capturing:', e.message); return reacquire(); }
  }
  if (vt) vt.contentHint = settings.contentHint;
}

// ---------------------------------------------------------------- sound
// PCM from the beam-audio helper (via the app) becomes:
//   WebRTC     an audio track, played into a MediaStreamDestination by an AudioWorklet
//   WebSocket  Opus chunks, encoded directly with WebCodecs
const snd = { ctx: null, node: null, track: null, rate: 0, ready: null, peak: 0, lastPcm: 0 };

function ensureAudioGraph(rate) {
  if (snd.ctx && snd.rate === rate) return snd.ready;
  if (snd.ctx) { try { snd.ctx.close(); } catch { /* ignore */ } }
  snd.rate = rate;
  snd.node = null;
  const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  snd.ctx = ctx;
  snd.ready = (async () => {
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest); // not connected to the speakers, so nothing plays on this PC
    await ctx.resume().catch(() => {});
    if (snd.ctx !== ctx) return;
    snd.node = node;
    setWorkletLatency();
    snd.track = dest.stream.getAudioTracks()[0];
    attachAudio();
  })().catch(e => log('sound graph failed:', e.message));
  return snd.ready;
}

// How much sound the worklet keeps queued before it goes into the WebRTC track: this only
// has to absorb the hop from the sound helper to this window, so it can be very small.
const WORKLET_BUFFER = { lowest: { start: 0.012, max: 0.045 }, balanced: { start: 0.015, max: 0.07 }, smooth: { start: 0.03, max: 0.12 } };
function setWorkletLatency() {
  if (snd.node) snd.node.port.postMessage({ config: WORKLET_BUFFER[settings.latency] || WORKLET_BUFFER.balanced });
}

function audioTrack() { return settings.audio !== 'off' ? snd.track : null; }

function attachAudio() {
  for (const peer of peers.values()) {
    for (const t of peer.pc.getTransceivers()) {
      if (t.sender && t.receiver.track.kind === 'audio' && t.currentDirection !== 'stopped') {
        t.sender.replaceTrack(audioTrack()).catch(e => log('audio replaceTrack', e.message));
      }
    }
    applySenderParams(peer);
  }
}

// Opus works at 48 kHz; the odd 44.1 kHz device is converted on the fly.
function to48k(rate, data) {
  if (rate === 48000) return data;
  const frames = data.length / 2;
  const outFrames = Math.round(frames * 48000 / rate);
  const out = new Float32Array(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const pos = i * rate / 48000, j = Math.floor(pos), f = pos - j, k = Math.min(j + 1, frames - 1);
    out[i * 2] = data[j * 2] * (1 - f) + data[k * 2] * f;
    out[i * 2 + 1] = data[j * 2 + 1] * (1 - f) + data[k * 2 + 1] * f;
  }
  return out;
}

function encodeWsAudio(rate, data) {
  if (typeof AudioEncoder !== 'function' || settings.audio === 'off') return;
  try {
    if (!wsa.encoder || wsa.encoder.state === 'closed') {
      const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
      wsa.encoder = new AudioEncoder({
        output: chunk => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          host.send('cap:media', { kind: 'audio', key: true, ts: now(), data: buf });
        },
        error: e => { log('audio encoder error', e.message); wsa.encoder = null; },
      });
      wsa.encoder.configure(cfg);
      wsa.config = cfg;
      wsa.ts = 0;
      host.send('cap:audioconfig', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
    }
    if (wsa.encoder.encodeQueueSize > 20) return;
    const pcm = to48k(rate, data);
    const frames = pcm.length / 2;
    const ad = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: frames, numberOfChannels: 2, timestamp: wsa.ts, data: pcm });
    wsa.ts += Math.round(frames * 1e6 / 48000);
    wsa.encoder.encode(ad);
    ad.close();
  } catch (e) { log('audio encode', e.message); }
}

host.on('cap:pcm', ({ rate, data }) => {
  snd.lastPcm = performance.now();
  for (let i = 0; i < data.length; i += 16) { const v = Math.abs(data[i]); if (v > snd.peak) snd.peak = v; }
  if (peers.size) {
    if (!snd.ctx || snd.rate !== rate) ensureAudioGraph(rate);
    if (snd.node) snd.node.port.postMessage(data);
  }
  if (wsClients.size) encodeWsAudio(rate, data);
});

function audioStats() {
  const on = snd.lastPcm && performance.now() - snd.lastPcm < 1500;
  const s = { audio: settings.audio === 'off' ? 'off' : on ? 'on' : 'waiting', audioLevel: Math.round(snd.peak * 100) / 100 };
  return s;
}

// ---------------------------------------------------------------- WebRTC
// Chrome starts a new video stream around 300 kbps and climbs slowly, which looks awful
// for a desktop. Give it a sensible start and floor, and ask for stereo, full-band sound.
function tuneOffer(sdp, startKbps, minKbps) {
  const params = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${settings.bitrateKbps}`;
  const lines = sdp.split('\r\n');
  const video = new Set(); const opus = new Set();
  for (const line of lines) {
    let m = line.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1|H265)\/90000/i);
    if (m) video.add(m[1]);
    m = line.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) opus.add(m[1]);
  }
  const out = [];
  for (const line of lines) {
    const fmtp = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (fmtp && video.has(fmtp[1])) { out.push(`${line};${params}`); continue; }
    if (fmtp && opus.has(fmtp[1])) { out.push(`${line};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`); continue; }
    out.push(line);
    const rtpmap = line.match(/^a=rtpmap:(\d+) /);
    if (rtpmap && video.has(rtpmap[1]) && !lines.some(l => l.startsWith(`a=fmtp:${rtpmap[1]} `))) out.push(`a=fmtp:${rtpmap[1]} ${params}`);
  }
  return out.join('\r\n');
}

// The app turns on "zero playout delay" for every video stream (main.js): the viewer's browser
// then shows each frame the moment it is decoded instead of holding a few frames back to
// smooth out network jitter. That is what lowest-latency mode wants; for the other modes the
// header that carries it is left out of the answer, so those viewers keep normal buffering.
function dropPlayoutDelay(sdp) {
  return sdp.split('\r\n').filter(l => !(l.startsWith('a=extmap:') && l.includes(PLAYOUT_DELAY))).join('\r\n');
}

// Puts the chosen codec first in the browser's offer. The order in the offer decides what
// gets sent, so this is what actually makes H.264 (graphics-card encoding) win over VP8.
function preferCodec(sdp) {
  const lines = sdp.split('\r\n');
  const name = {}, fmtp = {};
  for (const l of lines) {
    let m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//);
    if (m) name[m[1]] = m[2].toUpperCase();
    m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (m) fmtp[m[1]] = m[2];
  }
  const order = [settings.codec, 'H264', 'VP9', 'VP8', 'AV1'].filter((v, i, a) => a.indexOf(v) === i);
  const rank = pt => {
    const n = name[pt] || '';
    if (/RTX|RED|ULPFEC|FLEXFEC/.test(n)) return 1000;
    const i = order.indexOf(n);
    let r = (i < 0 ? 50 : i) * 10;
    if (n === 'H264') {
      // High profile first: graphics-card encoders on Windows take it; baseline often falls back to software.
      const f = fmtp[pt] || '';
      const prof = (f.match(/profile-level-id=([0-9a-f]{2})/i) || [])[1] || '';
      r += { 64: 0, '4d': 1, 42: 2 }[prof.toLowerCase()] ?? 4;
      if (/profile-level-id=42e0/i.test(f)) r -= 0.5;
      if (!/packetization-mode=1/.test(f)) r += 5;
    }
    return r;
  };
  return lines.map(l => {
    const m = l.match(/^(m=video \d+ \S+ )(.*)$/);
    if (!m) return l;
    const pts = m[2].trim().split(/\s+/);
    return m[1] + pts.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]).join(' ');
  }).join('\r\n');
}

function codecOrder() {
  const caps = RTCRtpSender.getCapabilities('video')?.codecs || [];
  const want = { H264: 'video/H264', VP9: 'video/VP9', AV1: 'video/AV1', VP8: 'video/VP8' };
  const order = [settings.codec, 'H264', 'VP9', 'VP8', 'AV1'].map(k => want[k]).filter((v, i, a) => v && a.indexOf(v) === i);
  const rank = c => {
    const i = order.indexOf(c.mimeType);
    let r = i < 0 ? 50 : i * 10;
    if (c.mimeType === 'video/H264') {
      if (!/packetization-mode=1/.test(c.sdpFmtpLine || '')) r += 3;
      if (!/profile-level-id=42e0/.test(c.sdpFmtpLine || '')) r += 1;
    }
    if (/rtx|red|ulpfec|flexfec/i.test(c.mimeType)) r = 100;
    return r;
  };
  return [...caps].sort((a, b) => rank(a) - rank(b));
}

async function applySenderParams(peer) {
  const lowest = (latencyOf.get(peer.id) || settings.latency) === 'lowest';
  for (const sender of peer.pc.getSenders()) {
    if (!sender.track) continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      if (sender.track.kind === 'video') {
        p.encodings[0].maxBitrate = settings.bitrateKbps * 1000;
        p.encodings[0].maxFramerate = settings.fps;
        p.encodings[0].priority = 'high';
        p.encodings[0].networkPriority = 'high';
        // Lowest latency keeps the frame rate up when the network or encoder struggles
        // (sharpness gives way first), unless a specific choice was made in the settings.
        p.degradationPreference = lowest && settings.degradation === 'balanced' ? 'maintain-framerate' : settings.degradation;
      } else {
        p.encodings[0].maxBitrate = 192000;
        p.encodings[0].priority = 'high';
      }
      await sender.setParameters(p);
    } catch (e) { log('setParameters', e.message); }
  }
}

function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  try { p.pc.close(); } catch { /* ignore */ }
  host.send('cap:input', { id, e: ['r'] });
}

async function onOffer(id, sdp) {
  closePeer(id);
  let stream;
  try { stream = await getMedia(); } catch (e) {
    host.send('cap:error', { id, code: 'capture', message: `Screen capture failed: ${e.message}` });
    return;
  }
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  const peer = { id, pc, ctl: null, mv: null, prev: null };
  peers.set(id, peer);
  pc.onicecandidate = e => host.send('cap:signal', { id, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
  pc.ondatachannel = e => {
    const ch = e.channel;
    if (ch.label === 'ctl') peer.ctl = ch; else peer.mv = ch;
    ch.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (Array.isArray(m)) host.send('cap:input', { id, e: m });
      else if (m && m.t === 'ping') { try { ch.send(JSON.stringify({ t: 'pong', id: m.id, c: m.c, h: now() })); } catch { /* ignore */ } }
    };
    ch.onclose = () => host.send('cap:input', { id, e: ['r'] });
  };
  pc.onconnectionstatechange = () => {
    host.send('cap:state', { id, state: pc.connectionState });
    if (pc.connectionState === 'failed') host.send('cap:input', { id, e: ['r'] });
  };
  const k = settings.bitrateKbps;
  if (settings.audio !== 'off') await ensureAudioGraph(snd.rate || 48000);
  let offer = preferCodec(tuneOffer(sdp, Math.round(Math.min(k * 0.6, 25000)), Math.round(Math.min(k * 0.15, 4000))));
  const latency = latencyOf.get(id) || settings.latency || 'lowest';
  if (latency !== 'lowest') offer = dropPlayoutDelay(offer);
  await pc.setRemoteDescription({ type: 'offer', sdp: offer });
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track.kind;
    t.direction = 'sendonly';
    await t.sender.replaceTrack(kind === 'video' ? stream.getVideoTracks()[0] : audioTrack());
    // Separate streams = no lip-sync: the browser shows each picture the moment it arrives
    // instead of holding video back to line up with the (more buffered) sound.
    try { t.sender.setStreams(new MediaStream()); } catch { /* older engines */ }
    if (kind === 'video' && t.setCodecPreferences) { try { t.setCodecPreferences(codecOrder()); } catch (e) { log('codec prefs', e.message); } }
  }
  await pc.setLocalDescription(await pc.createAnswer());
  host.send('cap:signal', { id, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
  applySenderParams(peer);
  log(`WebRTC viewer ${id}: ${latency} latency${pc.localDescription.sdp.includes(PLAYOUT_DELAY) ? ' (zero playout delay)' : ''}`);
}

async function onSignal(id, data) {
  if (!data) return;
  if (data.sdp && data.sdp.type === 'offer') {
    try { await onOffer(id, data.sdp.sdp); } catch (e) {
      log('offer failed', e.message);
      host.send('cap:error', { id, code: 'webrtc', message: `Could not start WebRTC: ${e.message}` });
    }
  } else if ('candidate' in data) {
    const p = peers.get(id);
    if (p && data.candidate) await p.pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

async function peerStats(peer) {
  const r = await peer.pc.getStats();
  let out = null, pair = null, transport = null;
  const byId = new Map();
  r.forEach(s => {
    byId.set(s.id, s);
    if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    if (s.type === 'transport') transport = s;
  });
  if (transport && transport.selectedCandidatePairId) pair = byId.get(transport.selectedCandidatePairId);
  if (!pair) r.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  if (!out) return null;
  const t = performance.now();
  const prev = peer.prev;
  peer.prev = { t, bytes: out.bytesSent, frames: out.framesEncoded, encode: out.totalEncodeTime };
  const dt = prev ? (t - prev.t) / 1000 : 0;
  const local = pair && byId.get(pair.localCandidateId);
  const remote = pair && byId.get(pair.remoteCandidateId);
  let route = 'Connecting';
  if (local && remote) {
    if (local.candidateType === 'relay' || remote.candidateType === 'relay') route = 'Relayed (TURN)';
    else if (local.candidateType === 'host' && remote.candidateType === 'host') route = 'Direct (local network)';
    else route = 'Direct (internet)';
  }
  const df = prev ? out.framesEncoded - prev.frames : 0;
  return {
    transport: 'webrtc',
    fps: out.framesPerSecond || (dt ? df / dt : 0),
    w: out.frameWidth, h: out.frameHeight,
    kbps: dt ? ((out.bytesSent - prev.bytes) * 8) / dt / 1000 : 0,
    encodeMs: df > 0 ? ((out.totalEncodeTime - prev.encode) / df) * 1000 : 0,
    encoder: out.encoderImplementation || '',
    hw: out.powerEfficientEncoder === true,
    limit: out.qualityLimitationReason || 'none',
    codec: (byId.get(out.codecId)?.mimeType || '').replace('video/', ''),
    route,
    rtt: pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
  };
}

// ---------------------------------------------------------------- WebSocket (WebCodecs)
const CODEC_STRINGS = {
  H264: ['avc1.640034', 'avc1.4d0034', 'avc1.42e034', 'avc1.640033', 'avc1.42e01f'],
  VP9: ['vp09.00.51.08', 'vp09.00.41.08'],
  AV1: ['av01.0.13M.08', 'av01.0.12M.08', 'av01.0.08M.08'],
  VP8: ['vp8'],
};
const wsv = {
  encoder: null, key: null, width: 0, height: 0, codec: null, codecString: null, configuring: null,
  needKey: true, lastKeyAt: 0, lastFrameAt: 0, readers: [], scale: 1, inTimes: new Map(),
  frames: 0, bytes: 0, encodeSum: 0, encodeN: 0, dropped: 0,
};
const wsa = { encoder: null, config: null, sent: null };

function encoderConfig(codecString, w, h, hw) {
  const c = {
    codec: codecString, width: w, height: h,
    bitrate: Math.round(settings.bitrateKbps * 1000 * wsv.scale),
    framerate: settings.fps, latencyMode: 'realtime', bitrateMode: 'variable',
    hardwareAcceleration: hw, contentHint: settings.contentHint,
  };
  if (codecString.startsWith('avc1')) c.avc = { format: 'annexb' };
  return c;
}

async function pickEncoder(w, h) {
  const accepted = new Set();
  for (const list of wsClients.values()) for (const k of list) accepted.add(k);
  const order = [settings.codec, 'H264', 'VP9', 'VP8', 'AV1'].filter((v, i, a) => a.indexOf(v) === i && (accepted.size === 0 || accepted.has(v)));
  const hwOrder = [settings.hardwareEncoding, 'no-preference'].filter((v, i, a) => a.indexOf(v) === i);
  for (const codec of order) {
    for (const s of CODEC_STRINGS[codec] || []) {
      for (const hw of hwOrder) {
        const cfg = encoderConfig(s, w, h, hw);
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return { codec, config: cfg };
        } catch { /* try next */ }
      }
    }
  }
  return null;
}

async function configureEncoder(w, h) {
  const pick = await pickEncoder(w, h);
  if (!pick) { host.send('cap:error', { code: 'encoder', message: 'No video encoder on this PC can make a stream your browser can play. Try WebRTC mode.' }); return false; }
  if (!wsv.encoder || wsv.encoder.state === 'closed') {
    wsv.encoder = new VideoEncoder({ output: onEncoded, error: e => { log('encoder error', e.message); wsv.encoder = null; wsv.key = null; wsv.needKey = true; } });
  }
  wsv.encoder.configure(pick.config);
  wsv.width = w; wsv.height = h; wsv.codec = pick.codec; wsv.codecString = pick.config.codec;
  wsv.key = `${pick.config.codec}|${w}x${h}|${pick.config.bitrate}|${settings.fps}|${settings.contentHint}|${pick.config.hardwareAcceleration}`;
  wsv.needKey = true;
  host.send('cap:wsconfig', { codec: pick.codec, codecString: pick.config.codec, width: w, height: h, hw: pick.config.hardwareAcceleration });
  log(`WebSocket encoder: ${pick.config.codec} ${w}x${h} ${Math.round(pick.config.bitrate / 1000)} kbps (${pick.config.hardwareAcceleration})`);
  return true;
}

function onEncoded(chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const t0 = wsv.inTimes.get(chunk.timestamp);
  wsv.inTimes.delete(chunk.timestamp);
  if (wsv.inTimes.size > 300) wsv.inTimes.clear();
  const ts = t0 ? t0.capture : now();
  if (t0) { wsv.encodeSum += performance.now() - t0.start; wsv.encodeN++; }
  wsv.frames++; wsv.bytes += data.byteLength;
  host.send('cap:media', { kind: 'video', key: chunk.type === 'key', ts, data, fps: settings.fps });
}

async function onFrame(frame) {
  const capture = now();
  try {
    if (!wsClients.size) return;
    if (capture - wsv.lastFrameAt < (1000 / settings.fps) * 0.7) return; // keep to the chosen fps
    const w = frame.displayWidth & ~1, h = frame.displayHeight & ~1;
    if (w < 16 || h < 16) return;
    const wantKey = `${w}x${h}`;
    if (!wsv.encoder || wsv.encoder.state !== 'configured' || wsv.width !== w || wsv.height !== h || wsv.dirty) {
      if (wsv.configuring) return;
      wsv.dirty = false;
      wsv.configuring = configureEncoder(w, h).finally(() => { wsv.configuring = null; });
      await wsv.configuring;
      if (!wsv.encoder || wsv.encoder.state !== 'configured' || !wsv.key || !wsv.key.includes(wantKey)) return;
    }
    if (wsv.encoder.encodeQueueSize > 2) { wsv.dropped++; return; }
    const keyFrame = wsv.needKey || capture - wsv.lastKeyAt > settings.keyframeSeconds * 1000;
    const input = (w !== frame.displayWidth || h !== frame.displayHeight)
      ? new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: w, height: h } })
      : frame;
    wsv.inTimes.set(input.timestamp, { capture, start: performance.now() });
    wsv.encoder.encode(input, { keyFrame });
    if (input !== frame) input.close();
    wsv.lastFrameAt = capture;
    if (keyFrame) { wsv.lastKeyAt = capture; wsv.needKey = false; }
  } catch (e) {
    log('frame error', e.message);
  } finally {
    frame.close();
  }
}

function startWsReaders(stream) {
  stopWsReaders();
  const vt = stream.getVideoTracks()[0];
  if (!vt) return;
  if (typeof MediaStreamTrackProcessor === 'function') {
    const proc = new MediaStreamTrackProcessor({ track: vt, maxBufferSize: 1 });
    const reader = proc.readable.getReader();
    wsv.readers.push(reader);
    (async () => {
      for (;;) {
        let r;
        try { r = await reader.read(); } catch { break; }
        if (r.done) break;
        await onFrame(r.value);
      }
    })();
  } else {
    // Older engines: pull frames from a <video> element instead.
    const v = document.getElementById('v');
    v.srcObject = new MediaStream([vt]);
    v.play().catch(() => {});
    let alive = true;
    const step = () => {
      if (!alive) return;
      try { if (v.videoWidth) onFrame(new VideoFrame(v, { timestamp: Math.round(performance.now() * 1000) })); } catch { /* not ready */ }
      v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
    wsv.readers.push({ cancel: () => { alive = false; v.srcObject = null; } });
  }
}

function stopWsReaders() {
  for (const r of wsv.readers) { try { r.cancel(); } catch { /* ignore */ } }
  wsv.readers = [];
}

function stopWsAudio() {
  try { if (wsa.encoder && wsa.encoder.state !== 'closed') wsa.encoder.close(); } catch { /* ignore */ }
  wsa.encoder = null; wsa.config = null;
}

async function startWs(id, codecs) {
  wsClients.set(id, Array.isArray(codecs) ? codecs : []);
  wsv.needKey = true;
  wsv.dirty = true; // pick a codec this browser can play
  try {
    const stream = await getMedia();
    if (!wsv.readers.length) startWsReaders(stream);
    else if (wsa.config) host.send('cap:audioconfig', { codec: 'opus', sampleRate: wsa.config.sampleRate, numberOfChannels: wsa.config.numberOfChannels });
  } catch (e) {
    host.send('cap:error', { id, code: 'capture', message: `Screen capture failed: ${e.message}` });
  }
}

function stopWsClient(id) {
  if (!wsClients.delete(id)) return;
  if (!wsClients.size) {
    stopWsReaders();
    stopWsAudio();
    try { wsv.encoder?.close(); } catch { /* ignore */ }
    wsv.encoder = null; wsv.key = null;
  }
}

// ---------------------------------------------------------------- messages from the app
host.on('cap:config', async data => {
  const prev = settings;
  settings = { ...settings, ...data.settings };
  if (data.ice) ice = data.ice;
  if (prev.bitrateKbps !== settings.bitrateKbps || prev.fps !== settings.fps || prev.contentHint !== settings.contentHint
      || prev.codec !== settings.codec || prev.hardwareEncoding !== settings.hardwareEncoding) wsv.dirty = true;
  if (prev.bitrateKbps !== settings.bitrateKbps) wsv.scale = 1;
  await applyCaptureSettings(prev);
  if (prev.latency !== settings.latency) setWorkletLatency();
  for (const p of peers.values()) applySenderParams(p);
});
host.on('cap:signal', ({ id, data }) => onSignal(id, data));
host.on('cap:start-ws', ({ id, codecs, latency }) => { if (latency) latencyOf.set(id, latency); closePeer(id); startWs(id, codecs); });
host.on('cap:start-webrtc', ({ id, latency }) => { if (latency) latencyOf.set(id, latency); stopWsClient(id); });
// A change of mode takes full effect when the page reconnects its stream (it does so right
// away); until then only the sender settings follow.
host.on('cap:latency', ({ id, latency }) => {
  if (latency) latencyOf.set(id, latency);
  const p = peers.get(id);
  if (p) applySenderParams(p);
});
host.on('cap:leave', ({ id }) => {
  closePeer(id);
  stopWsClient(id);
  latencyOf.delete(id);
  if (!peers.size && !wsClients.size) {
    stopMedia(); stopWsReaders();
    if (snd.ctx) { try { snd.ctx.close(); } catch { /* ignore */ } snd.ctx = null; snd.node = null; snd.track = null; snd.rate = 0; }
  }
});
host.on('cap:keyframe', () => { wsv.needKey = true; });
host.on('cap:reacquire', () => { if (peers.size || wsClients.size) reacquire(); });
host.on('cap:bitrate-scale', ({ scale }) => {
  const s = Math.max(0.15, Math.min(1, scale));
  if (Math.abs(s - wsv.scale) / wsv.scale > 0.08) { wsv.scale = s; wsv.dirty = true; }
});

setInterval(async () => {
  const a = audioStats();
  snd.peak = 0;
  for (const peer of peers.values()) {
    try {
      const s = await peerStats(peer);
      if (s) host.send('cap:stats', { id: peer.id, stats: { ...s, ...a } });
    } catch { /* closed */ }
  }
  if (wsClients.size) {
    const s = {
      ...a,
      transport: 'websocket', fps: wsv.frames, w: wsv.width, h: wsv.height, kbps: (wsv.bytes * 8) / 1000,
      encodeMs: wsv.encodeN ? wsv.encodeSum / wsv.encodeN : 0, encoder: `${wsv.codecString || ''} ${wsv.encoder ? '' : '(starting)'}`.trim(),
      hw: settings.hardwareEncoding === 'prefer-hardware', limit: wsv.scale < 0.99 ? 'bandwidth' : 'none', codec: wsv.codec || '',
      route: 'Through the web connection', rtt: null, scale: wsv.scale,
    };
    wsv.frames = 0; wsv.bytes = 0; wsv.encodeSum = 0; wsv.encodeN = 0;
    for (const id of wsClients.keys()) host.send('cap:stats', { id, stats: s });
  }
}, 1000);

host.send('cap:ready', {
  mstp: typeof MediaStreamTrackProcessor === 'function',
  webcodecs: typeof VideoEncoder === 'function',
  audioEncoder: typeof AudioEncoder === 'function',
});
