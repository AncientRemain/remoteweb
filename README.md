# Beam Remote

Stream your whole Windows PC to any web browser (phone, tablet, laptop, another PC) and control it with mouse, keyboard or touch, at home or from anywhere. Only people with your password (and two-step code, if you turn it on) can connect.

## Install

Run **`Beam-Remote-Setup-1.9.0.exe`** (from the [releases page](https://github.com/AncientRemain/remoteweb/releases) or `dist/`). It installs for your Windows account only (no admin needed) and adds Desktop and Start-menu shortcuts. After that it keeps itself up to date (see "Updates").

Windows may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.

## First run (about 5 minutes)

1. **Choose a password.** The setup wizard asks for one. Nothing can connect until it's set.
2. **Pick a quality.** "High" (1080p, 60 fps) is a good start. You can change it any time, even mid-stream.
3. **Decide how to connect from outside your home:**
   - **One-click link (easiest).** A free Cloudflare quick tunnel gives you an `https://….trycloudflare.com` link that works anywhere. No router changes, no account. The app downloads Cloudflare's `cloudflared` tool the first time. The link changes each time it starts; the app always shows the current one, and the tray icon has "Copy remote link".
   - **Your own domain (permanent link).** See "Using your own domain" below.
   - **Tailscale (most private).** Install Tailscale on the PC and on your phone, signed in to the same account. Use the `http://100.x.x.x:8420` link shown on Home. Nobody else can reach it.
   - **Port forwarding (advanced).** Forward the port on your router and turn on HTTPS in App & updates.
4. **Connect.** Open a link from Home (or scan its QR code with your phone) and sign in.

The **Setup guide** page in the app has a checklist that ticks itself off, plus fixes for common problems.

## Using your own domain

Get an address like `https://pc.yourname.com` that never changes and has a real HTTPS padlock. It goes through Cloudflare's free tunnel, so there's nothing to change on your router.

1. Add your domain to a free Cloudflare account and point its nameservers to Cloudflare (Cloudflare walks you through it).
2. In the app: **Remote access → Your own domain**. Type the address you want (for example `pc.yourname.com`) and press **Connect with Cloudflare**.
3. Cloudflare opens in your browser once: pick your domain and click **Authorize**. The app then:
   - creates a tunnel named `beam-remote-…`
   - adds the DNS record
   - starts it

   Turn on "Start remote access when the app opens" to keep it always on.

If the address already has a DNS record, the app asks before replacing it.

**Prefer Cloudflare's dashboard?**
1. Create a tunnel there (Zero Trust → Networks → Tunnels).
2. Add a public hostname pointing to `HTTP localhost:8420`.
3. Paste the tunnel token (or the whole install command) into "Paste a tunnel token instead".

The token is kept in `secrets.json`, never in `config.json`.

## Updates

The app checks [github.com/AncientRemain/remoteweb](https://github.com/AncientRemain/remoteweb/releases) every few hours. Choose what happens in **App & updates → Updates**:
- **Install automatically** (default): downloads the new version, then installs it once nobody has been connected for a few minutes. The app closes, updates silently and starts again by itself. If remote access was on, it comes back on.
- **Download, then ask me**: the Home page and the tray show "Restart and update" when it's ready.
- **Just tell me** / **Off**.

Nothing is downloaded or installed while someone is streaming. A page that is open during an update says so and reconnects by itself, then reloads itself once into the new version (staying signed in), so open pages always run the newest page code. Pages opened before 1.7.2 need one reload by hand.

When a new version is out you hear about it, whatever the mode: a Windows notification (once per version), a banner on Home, an item in the tray menu, and a notice for anyone connected to the stream page, who can install it from Settings → About.

## Activation and selling

A new copy asks for an activation code the first time it starts. A code works once, on one PC; after that the copy keeps working, offline too, for good. Copies set up before 1.8.0 never need a code.

No code? **Ask for access** sends a name and an optional message (plus the PC's name and Windows version, shown before sending). Sellers see the request and unlock it as paid or free, or decline it, and the copy activates by itself.

Seller copies have a **Seller** tab (in red) to make codes, see which ones were used and unlock access requests. Every copy that existed before 1.8.0 is a seller copy.

## Sound

The app captures whatever the PC is playing with a small helper, `beam-audio.exe` (standard Windows WASAPI loopback, the same method OBS and Discord use). It works with stereo, 5.1/7.1 and "virtual surround" headsets, and folds everything to stereo. Choose "On, and mute this PC's speakers" if people at home shouldn't hear it. The Home page and the browser's stats show whether sound is flowing and how loud it is.

Picture and sound are sent as separate streams, so the browser never delays the picture to keep lip-sync. For remote control a responsive picture matters more.

## Using it in the browser

- **Toolbar**: move the mouse to the top edge (or press `Ctrl + Alt + Shift + M`; on touch screens tap the small handle at the top or three-finger tap). It has:
  - quality presets and screen switching
  - special keys (Windows key, Alt+Tab, Task Manager, arrow pad)
  - clipboard and "type this text"
  - mouse lock for games
  - sound with a volume slider, the stats overlay, full screen, settings and disconnect
  - capture: screenshot, record a clip, picture-in-picture
- **Capture** (toolbar → camera button): **Screenshot** (`Ctrl + Alt + Shift + P`) saves the full-resolution picture; **Record a clip** (`Ctrl + Alt + Shift + R`) saves video with sound, up to 10 minutes, as MP4 (WebM where the browser can't make MP4); **Picture-in-picture** keeps the stream playing in a small floating window. Everything is saved to the viewing device's Downloads; the PC doesn't notice.
- **Pausing**: when the stream's tab is hidden, or nothing has been touched for a while (15 minutes by default; Settings → Display), the PC stops sending the picture and stops encoding it if nobody else is watching. Sound keeps playing; the picture is back at once.
- **Connection test** (toolbar → Quality → Test my connection): measures the speed of your connection to the PC and suggests the best preset, with "Use it".
- **Stats overlay** (`Ctrl + Alt + Shift + S`) shows **ping** (network round trip), **latency** (from the PC's screen to yours), fps, bitrate, packet loss, encode/decode time, the connection route and how much data this visit has used. Choose "Detailed" for graphs.
- **Phones**: touchpad mode (drag to move the cursor, tap to click, two-finger tap for right-click, two fingers to scroll, pinch to zoom) or direct mode (tap where you want to click). Tap the keyboard button to type. Add the page to your home screen for a full-screen app.
- **Ctrl + V** pastes the text from your device's clipboard into the PC (when clipboard sharing is on).
- **Picture adjustments** (Settings → Picture): brightness, contrast, saturation, hue, warmth and sharpness, with presets (Vivid, Cinema, Night, High contrast, Crisp text, Grayscale). The viewing browser does this, so it costs the PC and the stream nothing, and each device keeps its own.
- **Latency** (toolbar → Quality, or Settings → Stream), per device:
  - **Lowest latency** (default): every frame is shown the moment it arrives, like cloud-gaming services do. Best for games and quick mouse work.
  - **Balanced**: a small buffer that hides stutter on unsteady Wi-Fi.
  - **Smoothest**: a bigger buffer for slow or mobile connections.

## Game controllers

Plug a controller into the device you're watching on (USB or Bluetooth: school Chromebooks, phones, tablets, Macs and other PCs all work), open the stream page and press any button. Games on your PC see it as a real **Xbox controller**, with **vibration** sent back to the controller in your hand. Up to 4 controllers at once, for local multiplayer. Xbox, PlayStation, Switch Pro and most other controllers work; buttons are matched by position.

- **One-time setup on the PC:** **Controllers → Install controller driver**. It installs ViGEmBus, the same signed driver Sunshine and DS4Windows use; Windows asks for your approval. The viewing devices need nothing installed.
- **No controller?** On touch screens (phones, tablets, touchscreen Chromebooks) turn on the **on-screen controller** from the controller button in the toolbar: two sticks, A/B/X/Y, D-pad, bumpers, triggers, View and Menu. Tap a stick to click it.
- The controller button in the toolbar shows which player each controller is and turns vibration on or off.
- Security → Rules → "Allow game controllers" turns it off for everyone; view-only mode also blocks controllers.

## Privacy screen

Choose what this PC's own monitor shows while someone is streaming, so people near the PC can't watch (**Security → Privacy screen**):

- **Normal** (default): the monitor shows what's happening, as usual.
- **Black**: looks switched off.
- **Dimmed**: a dark layer; a little of the screen shows through.
- **A message**: your own text, plus who is connected and for how long.
- **A clock**: the time and date.
- **A picture**: any image you choose.
- **Floating logo**: a slow-moving logo, like a screensaver.

The stream always shows the real screen: the cover is left out of screen capture (needs Windows 10 version 2004 or newer). Clicks and keys still reach the apps underneath. The streaming device can change it from the toolbar (the crossed-out eye) unless you turn that off. Someone at the PC can press **Ctrl + Alt + Shift + H** to see the screen again until the stream ends. **Try it for 6 seconds** shows you what it looks like.

The mouse pointer still shows on the monitor, and games in exclusive full screen can draw over the cover.

## Embedding it in your own website

1. Embedding is **on by default** (any site may show the page; signing in is still needed). To limit it, enter your sites in **Remote access → Embedding** (for example `https://mysite.com`), or leave it empty to block embedding.
2. Copy the code shown there and paste it into your page. It looks like this:
   ```html
   <iframe src="https://pc.yourname.com/" allow="fullscreen; autoplay; clipboard-read; clipboard-write; keyboard-map" allowfullscreen style="width:100%;height:600px;border:0"></iframe>
   ```
3. **Test on this PC** opens a page that frames the stream exactly like another website would.

Use an `https://` address (your own domain or a quick link): https websites can't show `http://` pages. Inside a frame the page signs in with its own token, so it works even where the browser blocks cookies in frames (Safari, school and work Chromebooks, sandboxed frames).

## How it streams

| | WebRTC | WebSocket |
|---|---|---|
| Path | Direct peer-to-peer (UDP) | Through the web page's own connection |
| Latency | Lowest | A little higher |
| Works through tunnels | Usually: it connects directly even when you opened a tunnel link | Always |
| Needs | Any modern browser | An https link (tunnel/HTTPS) or this PC |

**Auto** (the default) tries WebRTC first and switches to WebSocket if no direct path is found. On networks that block direct connections (many schools and workplaces) the page notices within about 2.5 seconds and remembers it for that network for 12 hours, so the next connection starts on the web stream straight away.

Video is encoded on the graphics card. The codec is **Automatic** by default: **HEVC (H.265)** when the viewing device can decode it in hardware (Chrome and Edge on most PCs and Chromebooks, Safari), which gives the same picture with noticeably less data, and **H.264** everywhere else. Over WebRTC the graphics card handles full resolution. In WebSocket mode the browser's encoder only uses the graphics card up to 1080p, so a bigger screen is sent at 1080p instead of being encoded on the processor. In WebSocket mode a keyframe is sent only when the stream needs one (plus every 30 seconds at most), which avoids bursts of data through tunnels.

Chromium's screen capture tops out at about 50–60 frames per second on most PCs, so settings above 60 fps rarely help.

**Connections that hold up**
- If the page's connection drops (Wi-Fi hiccup, phone switching networks, tunnel blip), it reconnects within a second and picks up the same session. A WebRTC picture keeps playing meanwhile; a WebSocket stream continues at the next keyframe.
- Dead connections are noticed in seconds (heartbeats both ways), not minutes.
- **A frozen picture fixes itself.** If the PC is sending but the picture stops changing, the page first asks for a fresh keyframe with a new decoder (about 2.5 s), then restarts the stream by itself as switching modes would (about 6 s), and if it keeps happening, the PC captures its screen afresh too. Each restart is noted in the activity log. A still screen never counts as frozen.
- In WebSocket mode, a slow connection never leaves the picture waiting: the PC pauses until the backlog has cleared, then sends a fresh keyframe, and keeps asking until one gets through. Bitrate changes (the stream adapting to the connection) no longer cost a keyframe.
- If the PC's screen has gone to sleep, the app wakes it before streaming, and says so clearly if the monitor is switched off.
- Phones on the same Wi-Fi connect directly: the PC offers its real network address to WebRTC.
- **App & updates → Diagnostics** checks that Windows Firewall lets devices on your network in, with a one-click fix.

**Built for speed**
- **Stream priority.** While someone is connected, the streaming processes get more CPU time, are never put in Windows' Efficiency mode or timer throttling, and get priority on the graphics card (App & updates → Stream priority), so a heavy game can't make the stream stutter.
- **No throttling.** The hidden capture window is never slowed down as a "background" page.
- **Faster mouse.** Mouse movement is sent as soon as it happens (raw pointer updates on https pages), not once per screen refresh.
- **Small sound buffer.** Sound is buffered as little as possible (12–45 ms in Lowest latency mode).

Measured on an RTX 5070 PC (1080p60, local network, browser on the same PC):
- **Latency:** about 17 ms over WebRTC in Lowest latency mode (55 ms in Balanced), screen to screen.
- **Under load:** 52 fps with every CPU core busy.
- **App CPU use:** about 2%.

## Change anything without code

- **Search** (Ctrl + K in the app) finds any setting, button or help topic and takes you straight to it. The stream page's settings have their own search box too.

- Every setting is on the app's pages and lives in **`config.json`** (App & updates → Edit config.json). Edit it by hand if you like: the app reloads it as soon as you save. If there's a mistake, the app keeps running on its current settings and tells you what's wrong.
- **Quality presets** (names, resolution, fps, bitrate) can be edited on the Stream quality page or in `config.json`.
- **Look**: app name, sign-in message, colours, theme, background, corner roundness and font are on the Appearance page.
- **`custom.css`** (Appearance → Edit custom.css) restyles anything on the browser page and in the app.
- **Export / Import settings** to copy your setup to another PC. The settings file never contains your password; that lives separately in `secrets.json`.

Settings folder: `%APPDATA%\Beam Remote\`.

## Security

- The password is stored as a scrypt hash. Signed-in devices get random session tokens (only their hashes are stored).
- Wrong passwords lock out that address after 5 tries for 15 minutes (adjustable).
- Optional two-step sign-in works with any authenticator app.
- Optional allowed-address list, view-only mode, and a Windows notification on every new sign-in.
- Other websites can't use your signed-in browser to reach the PC: same-site cookies plus an origin check. Embedded pages sign in with their own token instead, and only the sites you list may frame the page.
- A security log records sign-ins, failures, lockouts and connections.

## Limits (Windows rules, same for every remote-desktop app)

- The **lock screen** and **UAC prompts** can't be captured or clicked. Don't lock the PC (Win+L) while away; turn on "Keep this PC awake".
- **Ctrl+Alt+Del** can't be sent; use the Task Manager key instead.
- To control **programs running as administrator**, use App & updates → Restart as administrator.
- If no speakers or headphones are set as the default playback device, there's no sound to capture.

## For developers

```
npm install
npm start               # run from source
npm test                # unit tests
npm run icons           # redraw assets/icon.png / icon.ico
npm run build:audio     # rebuild assets/beam-audio.exe (uses the C# compiler built into Windows)
npm run build:pad       # rebuild assets/beam-pad.exe (virtual controllers, same compiler)
npm run dist            # build the installer into dist/
npm run release         # build and publish a GitHub release (needs GH_TOKEN or Git signed in to GitHub)
```

Developer switches (environment variables):
- `BEAM_DEBUG=1` writes step markers to `debug.log`.
- `BEAM_INPUT_DRYRUN=1` logs input instead of sending it to Windows; `BEAM_PAD_DRYRUN=1` does the same for controllers.
- `BEAM_SHOT_DIR=<folder>` saves screenshots of every dashboard page.
- `BEAM_DEV_SCRIPT=<file>` runs a script in the dashboard after it opens.
- `BEAM_UPDATE_URL=<url>` checks a local folder for updates instead of GitHub (with `latest.yml` in it); `BEAM_UPDATE_DRYRUN=1` stops before installing.

`--data-dir=<folder>` runs with a separate settings folder.

Layout:
- `src/main`: Electron main. Settings, sign-in, web server, tunnels and your own domain (`cloudflare.js`), input, and sound (`audio.js`).
- `src/capture`: the hidden window that captures and encodes.
- `src/web`: the browser page.
- `src/app`: the dashboard.
- `tools/beam-audio`: the sound helper's source.
- `tools/beam-pad`: the virtual-controller helper's source (talks to the ViGEmBus driver).
