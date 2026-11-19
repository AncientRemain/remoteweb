// While someone streams, keep the streaming processes at full speed (on top of the CPU
// priority that main.js sets):
//  - no Windows power throttling ("Efficiency mode" / EcoQoS) and no timer throttling, which
//    Windows may otherwise apply to processes without a visible window, like the capture window;
//  - higher priority on the graphics card for the processes that capture and encode, so a game
//    that keeps the GPU busy can't make the stream stutter (the same idea Sunshine uses).
// Everything goes back to normal when the last viewer leaves.
let OpenProcess = null, CloseHandle, SetProcessInformation, SetGpuPriority, GetGpuPriority, loadError = null;
try {
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const POWER = koffi.struct('PROCESS_POWER_THROTTLING_STATE', { Version: 'uint32', ControlMask: 'uint32', StateMask: 'uint32' });
  OpenProcess = k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
  CloseHandle = k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
  SetProcessInformation = k32.func('__stdcall', 'SetProcessInformation', 'bool', ['void *', 'int', koffi.pointer(POWER), 'uint32']);
  const gdi = koffi.load('gdi32.dll');
  SetGpuPriority = gdi.func('__stdcall', 'D3DKMTSetProcessSchedulingPriorityClass', 'int32', ['void *', 'int']);
  GetGpuPriority = gdi.func('__stdcall', 'D3DKMTGetProcessSchedulingPriorityClass', 'int32', ['void *', koffi.out(koffi.pointer('int'))]);
} catch (e) { loadError = e.message; }

const PROCESS_SET_INFORMATION = 0x0200;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ProcessPowerThrottling = 4;
const THROTTLE_EXECUTION_SPEED = 0x1;
const THROTTLE_IGNORE_TIMER_RESOLUTION = 0x4;
const GPU_NORMAL = 2, GPU_HIGH = 4;

// pids: every streaming process; gpuPids: the ones doing capture/encoding on the graphics card.
function apply({ pids = [], gpuPids = [] }, on) {
  const done = { power: 0, gpu: 0, failed: 0 };
  if (!OpenProcess) return { ...done, error: loadError };
  for (const pid of new Set(pids)) {
    let h = null;
    try {
      h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!h) { done.failed++; continue; }
      // On: we decide (never throttle, honour timer requests). Off: Windows decides again.
      const state = on
        ? { Version: 1, ControlMask: THROTTLE_EXECUTION_SPEED | THROTTLE_IGNORE_TIMER_RESOLUTION, StateMask: 0 }
        : { Version: 1, ControlMask: 0, StateMask: 0 };
      if (SetProcessInformation(h, ProcessPowerThrottling, state, 12)) done.power++;
      if (gpuPids.includes(pid) && SetGpuPriority(h, on ? GPU_HIGH : GPU_NORMAL) === 0) done.gpu++;
    } catch { done.failed++; } finally { if (h) { try { CloseHandle(h); } catch { /* ignore */ } } }
  }
  return done;
}

// For diagnostics: the GPU priority class of a process (2 = normal, 4 = high), or null.
function gpuPriority(pid) {
  if (!OpenProcess) return null;
  let h = null;
  try {
    h = OpenProcess(PROCESS_SET_INFORMATION | 0x0400 /* QUERY_INFORMATION */ | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return null;
    const out = [0];
    return GetGpuPriority(h, out) === 0 ? out[0] : null;
  } catch { return null; } finally { if (h) { try { CloseHandle(h); } catch { /* ignore */ } } }
}

module.exports = { apply, gpuPriority, available: () => !!OpenProcess };
