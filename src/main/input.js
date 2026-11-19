// Turns the browser's keyboard, mouse and touch events into real Windows input
// (SendInput through koffi, no compiling needed). Keys are sent as scan codes, so games
// and every keyboard layout read them like a real keyboard. Messages from the browser:
//   ['a', x, y]           move to x,y (0..1 across the streamed screen)
//   ['m', dx, dy]         relative move (locked mouse / games)
//   ['b', button, down, x?, y?]  mouse button (0 left, 1 middle, 2 right, 3 back, 4 forward)
//   ['w', delta] / ['h', delta]  wheel / horizontal wheel (120 = one notch)
//   ['k', code, down]     key by KeyboardEvent.code
//   ['t', text]           type text as characters (phones, paste)
//   ['c', [codes]]        press a key combination, then release it
//   ['r']                 release everything held
let koffi = null, SendInput = null, GetSystemMetrics = null, SetThreadExecutionState = null, SIZE = 0, loadError = null;
try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U });
  SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
  GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);
  SIZE = koffi.sizeof(INPUT);
  try { SetThreadExecutionState = koffi.load('kernel32.dll').func('__stdcall', 'SetThreadExecutionState', 'uint32', ['uint32']); } catch { /* optional */ }
} catch (e) {
  loadError = e.message;
}

const M = { MOVE: 0x1, LDOWN: 0x2, LUP: 0x4, RDOWN: 0x8, RUP: 0x10, MDOWN: 0x20, MUP: 0x40, XDOWN: 0x80, XUP: 0x100, WHEEL: 0x800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000 };
const K = { EXTENDED: 0x1, KEYUP: 0x2, UNICODE: 0x4, SCANCODE: 0x8 };

// KeyboardEvent.code -> [scan code, extended?]
const SCAN = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06], Digit6: [0x07],
  Digit7: [0x08], Digit8: [0x09], Digit9: [0x0A], Digit0: [0x0B], Minus: [0x0C], Equal: [0x0D], Backspace: [0x0E],
  Tab: [0x0F], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16],
  KeyI: [0x17], KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1A], BracketRight: [0x1B], Enter: [0x1C],
  ControlLeft: [0x1D], KeyA: [0x1E], KeyS: [0x1F], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22], KeyH: [0x23],
  KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2A],
  Backslash: [0x2B], KeyZ: [0x2C], KeyX: [0x2D], KeyC: [0x2E], KeyV: [0x2F], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32],
  Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37], AltLeft: [0x38],
  Space: [0x39], CapsLock: [0x3A], F1: [0x3B], F2: [0x3C], F3: [0x3D], F4: [0x3E], F5: [0x3F], F6: [0x40],
  F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44], NumLock: [0x45, 1], ScrollLock: [0x46], Numpad7: [0x47],
  Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4A], Numpad4: [0x4B], Numpad5: [0x4C], Numpad6: [0x4D],
  NumpadAdd: [0x4E], Numpad1: [0x4F], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56], F11: [0x57], F12: [0x58], F13: [0x64], F14: [0x65], F15: [0x66], F16: [0x67],
  F17: [0x68], F18: [0x69], F19: [0x6A], F20: [0x6B], F21: [0x6C], F22: [0x6D], F23: [0x6E], F24: [0x76],
  IntlRo: [0x73], IntlYen: [0x7D], NumpadEqual: [0x59], NumpadComma: [0x7E],
  NumpadEnter: [0x1C, 1], ControlRight: [0x1D, 1], NumpadDivide: [0x35, 1], AltRight: [0x38, 1], PrintScreen: [0x37, 1],
  Pause: [0x45], Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4B, 1], ArrowRight: [0x4D, 1],
  End: [0x4F, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1],
  MetaLeft: [0x5B, 1], MetaRight: [0x5C, 1], OSLeft: [0x5B, 1], OSRight: [0x5C, 1], ContextMenu: [0x5D, 1],
  AudioVolumeMute: [0x20, 1], AudioVolumeDown: [0x2E, 1], AudioVolumeUp: [0x30, 1],
  MediaTrackNext: [0x19, 1], MediaTrackPrevious: [0x10, 1], MediaStop: [0x24, 1], MediaPlayPause: [0x22, 1],
  BrowserBack: [0x6A, 1], BrowserForward: [0x69, 1], BrowserRefresh: [0x67, 1], BrowserHome: [0x32, 1],
};
const WIN_KEYS = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);
const BUTTONS = { 0: [M.LDOWN, M.LUP, 0], 1: [M.MDOWN, M.MUP, 0], 2: [M.RDOWN, M.RUP, 0], 3: [M.XDOWN, M.XUP, 1], 4: [M.XDOWN, M.XUP, 2] };

const held = new Set();
const heldButtons = new Set();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let target = null;       // physical pixel rect of the streamed screen
let virtual = null;      // physical pixel rect of all screens together
let options = { blockWinKey: false };

function send(input) { if (SendInput) SendInput(1, input, SIZE); }
function mouse(flags, dx = 0, dy = 0, data = 0) {
  send({ type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
}
function keyboard(scan, flags) {
  send({ type: 1, u: { ki: { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
}

function refreshVirtual() {
  if (!GetSystemMetrics) return;
  virtual = { x: GetSystemMetrics(76), y: GetSystemMetrics(77), width: GetSystemMetrics(78), height: GetSystemMetrics(79) };
}

// rect: the streamed screen in physical pixels { x, y, width, height }
function setTarget(rect) { target = rect; refreshVirtual(); }
function setOptions(o) { options = { ...options, ...o }; }

function moveAbs(nx, ny) {
  if (!target || !virtual || virtual.width < 2) {
    mouse(M.MOVE | M.ABSOLUTE, Math.round(clamp(nx, 0, 1) * 65535), Math.round(clamp(ny, 0, 1) * 65535));
    return;
  }
  const px = target.x + clamp(nx, 0, 1) * (target.width - 1);
  const py = target.y + clamp(ny, 0, 1) * (target.height - 1);
  const ax = Math.round(((px - virtual.x) * 65535) / (virtual.width - 1));
  const ay = Math.round(((py - virtual.y) * 65535) / (virtual.height - 1));
  mouse(M.MOVE | M.ABSOLUTE | M.VIRTUALDESK, ax, ay);
}

function key(code, down) {
  const s = SCAN[code];
  if (!s) return;
  if (options.blockWinKey && WIN_KEYS.has(code)) return;
  if (!down && !held.has(code)) return;
  down ? held.add(code) : held.delete(code);
  keyboard(s[0], K.SCANCODE | (s[1] ? K.EXTENDED : 0) | (down ? 0 : K.KEYUP));
}

function type(text) {
  for (const ch of String(text).slice(0, 4000)) {
    if (ch === '\n') { keyboard(0x1C, K.SCANCODE); keyboard(0x1C, K.SCANCODE | K.KEYUP); continue; }
    if (ch === '\r') continue;
    if (ch === '\t') { keyboard(0x0F, K.SCANCODE); keyboard(0x0F, K.SCANCODE | K.KEYUP); continue; }
    if (ch === '\b') { keyboard(0x0E, K.SCANCODE); keyboard(0x0E, K.SCANCODE | K.KEYUP); continue; }
    for (let i = 0; i < ch.length; i++) {
      const unit = ch.charCodeAt(i);
      keyboard(unit, K.UNICODE);
      keyboard(unit, K.UNICODE | K.KEYUP);
    }
  }
}

function handle(msg) {
  if (!Array.isArray(msg) || !SendInput) return;
  switch (msg[0]) {
    case 'a': moveAbs(+msg[1] || 0, +msg[2] || 0); break;
    case 'm': mouse(M.MOVE, clamp(msg[1] | 0, -2000, 2000), clamp(msg[2] | 0, -2000, 2000)); break;
    case 'b': {
      const b = BUTTONS[msg[1]];
      if (!b) break;
      if (msg.length >= 5 && Number.isFinite(+msg[3])) moveAbs(+msg[3], +msg[4]);
      if (!msg[2] && !heldButtons.has(msg[1])) break;
      msg[2] ? heldButtons.add(msg[1]) : heldButtons.delete(msg[1]);
      mouse(msg[2] ? b[0] : b[1], 0, 0, b[2]);
      break;
    }
    case 'w': mouse(M.WHEEL, 0, 0, clamp(msg[1] | 0, -2400, 2400)); break;
    case 'h': mouse(M.HWHEEL, 0, 0, clamp(msg[1] | 0, -2400, 2400)); break;
    case 'k': if (typeof msg[1] === 'string') key(msg[1], !!msg[2]); break;
    case 't': if (typeof msg[1] === 'string') type(msg[1]); break;
    case 'c': {
      if (!Array.isArray(msg[1])) break;
      const codes = msg[1].filter(c => typeof c === 'string' && SCAN[c]).slice(0, 6);
      for (const c of codes) key(c, true);
      for (const c of codes.reverse()) key(c, false);
      break;
    }
    case 'r': releaseAll(); break;
    default: break;
  }
}

// A one-pixel wiggle and an "I'm active" signal: Windows treats both as activity, which
// turns a sleeping monitor back on.
function nudge() {
  if (SetThreadExecutionState) { try { SetThreadExecutionState(0x2 | 0x1); } catch { /* ignore */ } } // display + system required
  if (!SendInput) return false;
  mouse(M.MOVE, 1, 0);
  mouse(M.MOVE, -1, 0);
  return true;
}

function releaseAll() {
  for (const code of [...held]) key(code, false);
  for (const button of [...heldButtons]) handle(['b', button, 0]);
}

module.exports = { handle, releaseAll, nudge, setTarget, setOptions, refreshVirtual, available: () => !!SendInput, loadError: () => loadError, SCAN };
