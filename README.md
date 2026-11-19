# Beam Remote

Stream your whole Windows PC to any web browser (phone, tablet, laptop, another PC) and control it with mouse, keyboard or touch, at home or from anywhere. Only people with your password (and two-step code, if you turn it on) can connect.

## Install

Run **`Beam-Remote-Setup-1.3.0.exe`** (from the [releases page](https://github.com/AncientRemain/remoteweb/releases) or `dist/`). It installs for your Windows account only (no admin needed) and adds Desktop and Start-menu shortcuts. After that it keeps itself up to date (see "Updates").

Windows may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.

## First run (about 5 minutes)

1. **Choose a password.** The setup wizard asks for one. Nothing can connect until it's set.
2. **Pick a quality.** "High" (1080p, 60 fps) is a good start. You can change it any time, even mid-stream.
3. **Decide how to connect from outside your home:**
   - **One-click link (easiest).** A free Cloudflare quick tunnel gives you an `https://….trycloudflare.com` link that works anywhere. No router changes, no account. The app downloads Cloudflare's `cloudflared` tool the first time. The link changes each time it starts; the app always shows the current one, and the tray icon has "Copy remote link".
   - **Your own domain (permanent link).** See "Using your own domain" below.
   - **Tailscale (most private).** Install Tailscale on the PC and on your phone, signed in to the same account. Use the `http://100.x.x.x:8420` link shown on Home. Nobody else can reach it.
   - **Port forwarding (advanced).** Forward the port on your router and turn on HTTPS in App & network.
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

The app checks [github.com/AncientRemain/remoteweb](https://github.com/AncientRemain/remoteweb/releases) every few hours. Choose what happens in **App & network → Updates**:
- **Install automatically** (default): downloads the new version, then installs it once nobody has been connected for a few minutes. The app closes, updates silently and starts again by itself. If remote access was on, it comes back on.
- **Download, then ask me**: the Home page and the tray show "Restart and update" when it's ready.
- **Just tell me** / **Off**.

Nothing is downloaded or installed while someone is streaming. A page that is open during an update says so and reconnects by itself.

## Sound

The app captures whatever the PC is playing with a small helper, `beam-audio.exe` (standard Windows WASAPI loopback, the same method OBS and Discord use). It works with stereo, 5.1/7.1 and "virtual surround" headsets, and folds everything to stereo. Choose "On, and mute this PC's speakers" if people at home shouldn't hear it. The Home page and the browser's stats show whether sound is flowing and how loud it is.

Picture and sound are sent as separate streams, so the browser never delays the picture to keep lip-sync. For remote control a responsive picture matters more.

## Using it in the browser

- **Toolbar**: move the mouse to the top edge (or press `Ctrl + Alt + Shift + M`; on touch screens tap the small handle at the top or three-finger tap). It has:
  - quality presets and screen switching
  - special keys (Windows key, Alt+Tab, Task Manager, arrow pad)
  - clipboard and "type this text"
  - mouse lock for games
  - sound, the stats overlay, full screen, settings and disconnect
- **Stats overlay** (`Ctrl + Alt + Shift + S`) shows **ping** (network round trip), **latency** (from the PC's screen to yours), fps, bitrate, packet loss, encode/decode time and the connection route. Choose "Detailed" for graphs.
- **Phones**: touchpad mode (drag to move the cursor, tap to click, two-finger tap for right-click, two fingers to scroll, pinch to zoom) or direct mode (tap where you want to click). Tap the keyboard button to type. Add the page to your home screen for a full-screen app.
- **Ctrl + V** pastes the text from your device's clipboard into the PC (when clipboard sharing is on).
- **Latency** (toolbar → Quality, or Settings → Stream), per device:
  - **Lowest latency** (default): every frame is shown the moment it arrives, like cloud-gaming services do. Best for games and quick mouse work.
  - **Balanced**: a small buffer that hides stutter on unsteady Wi-Fi.
  - **Smoothest**: a bigger buffer for slow or mobile connections.

## Embedding it in your own website

1. **Security → Embedding**: enter your site's address (for example `https://mysite.com`), or `*` to allow any site.
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

**Auto** (the default) tries WebRTC first and switches to WebSocket after about 6 seconds if no direct path is found. Video uses the graphics card's H.264 encoder when it can (NVIDIA, AMD and Intel all have one). Many graphics cards only hardware-encode up to 1080p, so above that the processor does the work.

**Connections that hold up**
- If the page's connection drops (Wi-Fi hiccup, phone switching networks, tunnel blip), it reconnects within a second and picks up the same session. A WebRTC picture keeps playing meanwhile; a WebSocket stream continues at the next keyframe.
- Dead connections are noticed in seconds (heartbeats both ways), not minutes.
- If the PC's screen has gone to sleep, the app wakes it before streaming, and says so clearly if the monitor is switched off.
- Phones on the same Wi-Fi connect directly: the PC offers its real network address to WebRTC.
- **App & network → Diagnostics** checks that Windows Firewall lets devices on your network in, with a one-click fix.

**Built for speed**
- **Stream priority.** While someone is connected, the streaming processes run at above-normal priority (App & network → Stream priority), so a heavy game can't make the stream stutter.
- **No throttling.** The hidden capture window is never slowed down as a "background" page.
- **Faster mouse.** Mouse movement is sent as soon as it happens (raw pointer updates on https pages), not once per screen refresh.
- **Small sound buffer.** Sound is buffered as little as possible (12–45 ms in Lowest latency mode).

Measured on an RTX 5070 PC (1080p60, local network, browser on the same PC):
- **Latency:** about 17 ms over WebRTC in Lowest latency mode (55 ms in Balanced), screen to screen.
- **Under load:** 52 fps with every CPU core busy.
- **App CPU use:** about 2%.

## Change anything without code

- Every setting is on the app's pages and lives in **`config.json`** (App & network → Edit config.json). Edit it by hand if you like: the app reloads it as soon as you save. If there's a mistake, the app keeps running on its current settings and tells you what's wrong.
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
- To control **programs running as administrator**, use App & network → Restart as administrator.
- If no speakers or headphones are set as the default playback device, there's no sound to capture.

## For developers

```
npm install
npm start               # run from source
npm test                # unit tests
npm run icons           # redraw assets/icon.png / icon.ico
npm run build:audio     # rebuild assets/beam-audio.exe (uses the C# compiler built into Windows)
npm run dist            # build the installer into dist/
npm run release         # build and publish a GitHub release (needs GH_TOKEN or Git signed in to GitHub)
```

Developer switches (environment variables):
- `BEAM_DEBUG=1` writes step markers to `debug.log`.
- `BEAM_INPUT_DRYRUN=1` logs input instead of sending it to Windows.
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
