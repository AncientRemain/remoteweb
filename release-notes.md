## Beam Remote 1.3.0

**Updates by themselves.** The app now checks this page for new versions and installs them while nobody is connected (App & network → Updates). After an update it starts again on its own, with remote access back on if it was on.

**Lowest-latency mode.** New per-device setting (toolbar → Quality → Latency). Lowest latency shows every frame the moment it arrives: about 17 ms screen to screen on a local network, down from about 55 ms. Balanced and Smoothest keep a buffer for unsteady connections.

**Connections that hold up.**
- A dropped connection reconnects within a second and resumes the same session; a WebRTC picture keeps playing meanwhile.
- Dead connections are detected in seconds.
- A sleeping monitor is woken before streaming, with a clear message if it's switched off.
- Phones on the same Wi-Fi connect directly.
- Diagnostics checks Windows Firewall, with a one-click fix.

**Embedding works everywhere.** Framed pages sign in with their own token, so embedding works in Safari, on school and work Chromebooks and in sandboxed frames. Security → Embedding shows the code to paste and has a "Test on this PC" button.

Install: download `Beam-Remote-Setup-1.3.0.exe` below. Windows may warn that the app isn't signed: More info → Run anyway.
