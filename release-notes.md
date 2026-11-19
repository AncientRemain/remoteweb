## Beam Remote 1.7.1

**No more frozen pictures in WebSocket mode.** On slow or busy connections (school networks, tunnels) the picture could stop updating until you switched the quality or the mode. The cause: when the stream skipped frames to catch up, it asked the PC for a fresh keyframe once, and if that request was lost the picture stayed frozen for up to 30 seconds. Requests are no longer lost, and the PC and the page keep asking until a keyframe gets through.

**A frozen picture fixes itself.** If your PC is sending but the picture stops changing, the page recovers by itself: a fresh keyframe and a new decoder after about 2.5 seconds, a full restart of the stream after about 6 seconds (what switching modes did), and a fresh capture of the PC's screen if it keeps happening. Works in WebRTC mode too. Each restart is noted in the activity log.

**Smoother on slow connections.** A short burst of late frames is played instead of being skipped, a big keyframe gets room to arrive, bitrate changes no longer send a keyframe, a stuck video encoder on the PC is replaced, and a dropped connection is noticed sooner (7 s instead of 12 s while the page is open).

If a device keeps failing to play H.265 video, the page switches that device to H.264 by itself.

Install: download `Beam-Remote-Setup-1.7.1.exe` below, or let the app update itself.
