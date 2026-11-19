## Beam Remote 1.5.0

Faster streaming away from home, especially on school and work networks.

- **HEVC when your device can play it.** The codec is now Automatic: HEVC (H.265) on devices that decode it in hardware (Chrome and Edge on most PCs and Chromebooks, Safari), the same picture with noticeably less data; H.264 everywhere else. It's encoded on the graphics card in both connection modes.
- **Quicker start on strict networks.** Where direct connections are blocked, the page switches to the web stream within about 2.5 seconds (it used to wait 6) and remembers that network, so the next connection starts at once.
- **Smoother through tunnels.** In WebSocket mode keyframes are sent only when needed instead of every 3 seconds, and the graphics card is always used: bigger screens are sent at 1080p rather than encoded on the processor.
- **Full speed while streaming.** The streaming processes are kept out of Windows' Efficiency mode and timer throttling, and capture and encoding get priority on the graphics card, so a game running on the PC can't make the stream stutter.

Existing settings move to the new defaults (Automatic codec, keyframes on demand) unless you had changed them. Install: download `Beam-Remote-Setup-1.5.0.exe` below, or let the app update itself.
