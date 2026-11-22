// Beam Remote dashboard: status, links, live stats, every setting, and the setup guide.
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : Number(v).toFixed(d));
  const mbps = k => (k == null ? '–' : (k / 1000).toFixed(k >= 10000 ? 0 : 1));
  const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

  const ICONS = {
    home: '<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    laptop: '<rect x="4" y="4" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="10" r="1"/><path d="M12 21a3 3 0 0 1 0-6h2a3 3 0 0 0 3-3"/>',
    cog: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    external: '<path d="M14 4h6v6M10 14L20 4M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4M12 17h.01"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>',
    gamepad: '<path d="M6 12h4M8 10v4"/><path d="M15 13h.01M18 11h.01"/><path d="M17.3 6H6.7a4 4 0 0 0-4 3.6l-.9 7.1a2.5 2.5 0 0 0 4.6 1.6L7.5 17h9l1.1 1.3a2.5 2.5 0 0 0 4.6-1.6l-.9-7.1a4 4 0 0 0-4-3.6z"/>',
    tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16.5 6.5l3 3M14.5 8.5l2 2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  };
  const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  // small markup helpers
  const section = (title, desc, body, actions = '') => `<section class="section"><div class="section-head"><div><h2>${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>${body}</section>`;
  const note = (kind, html) => `<div class="note ${kind}">${icon(kind === 'ok' ? 'check' : kind === 'warn' || kind === 'bad' ? 'alert' : 'info')}<div class="body">${html}</div></div>`;

  let ST = null;      // settings, auth, displays...
  let STATUS = null;  // server, tunnel, clients (pushed every second)
  let page = 'home';
  const hist = new Map(); // client id -> { ping: [], lat: [], last }
  let remoteGuide = localStorage.getItem('remoteGuide') || 'tailscale';

  // id, name, icon, sidebar group
  const PAGES = [
    ['home', 'Home', 'home', 'Overview'], ['seller', 'Seller', 'tag', 'Overview'], ['guide', 'Setup guide', 'book', 'Overview'],
    ['remote', 'Remote access', 'globe', 'Connect'], ['security', 'Security & privacy', 'shield', 'Connect'],
    ['quality', 'Stream quality', 'gauge', 'Stream'], ['controllers', 'Controllers', 'gamepad', 'Stream'], ['browser', 'Browser controls', 'laptop', 'Stream'],
    ['appearance', 'Appearance', 'palette', 'App'], ['app', 'App & updates', 'cog', 'App'],
  ];
  const pageName = id => (PAGES.find(p => p[0] === id) || [])[1] || '';
  // The Seller tab only exists on copies that can sell.
  const visiblePages = () => PAGES.filter(([id]) => id !== 'seller' || (ST && ST.license && ST.license.canSell));

  function toast(text, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2600);
  }

  // ------------------------------------------------------------ look
  function applyTheme() {
    const a = ST.config.appearance;
    const st = document.documentElement.style;
    st.setProperty('--accent', a.accent);
    st.setProperty('--accent-2', a.accent2);
    st.setProperty('--radius', `${a.radius}px`);
    st.setProperty('--font', a.font);
    const theme = a.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : a.theme;
    document.documentElement.dataset.theme = theme;
    $('#tb-name').textContent = a.appName;
    document.title = a.appName;
    let style = document.getElementById('custom-style');
    if (!style) { style = document.createElement('style'); style.id = 'custom-style'; document.head.appendChild(style); }
    style.textContent = ST.customCss || '';
  }

  // ------------------------------------------------------------ start
  async function init() {
    ST = await beam.getState();
    STATUS = ST.status;
    applyTheme();
    renderNav();
    render();
    beam.onStatus(s => { STATUS = s; onStatus(); });
    beam.onState(s => {
      ST = { ...ST, ...s };
      applyTheme();
      renderNav();
      if (!editing()) render();
      // The activation window follows: unlocked by someone, or the request was turned down.
      if (ACT.open && ST.license) {
        if (ST.license.activated) activatedNow('Unlocked. Your copy is ready.');
        else if (ACT.mode === 'wait' && ST.license.request && ST.license.request.status !== 'pending') drawActivate('declined');
      }
    });
    beam.onLog(e => {
      ST.log = [e, ...(ST.log || [])].slice(0, 100);
      if (page === 'security') { const box = $('#seclog'); if (box) box.innerHTML = logHtml(); }
    });
    beam.onToast(t => toast(t.text, t.kind));
    if (ST.license && !ST.license.activated) openActivate();
    else if (!ST.auth.passwordSet) openWizard();
  }

  function editing() {
    const a = document.activeElement;
    if (!a || !$('#main').contains(a)) return false;
    return a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /text|password|number|search/.test(a.type));
  }

  function navHtml() {
    const n = STATUS ? STATUS.clients.length : 0;
    const left = setupLeft();
    const t = STATUS ? STATUS.tunnel : { state: 'stopped' };
    const tunnelLine = ST.config.network.tunnel === 'none' ? 'Remote access: none'
      : t.state === 'online' ? 'Remote access on' : t.state === 'error' ? 'Remote access problem' : t.state === 'stopped' ? 'Remote access off' : 'Remote access starting';
    const tdot = t.state === 'online' ? 'good' : t.state === 'error' ? 'bad' : t.state === 'stopped' ? '' : 'warn';
    const upd = STATUS && STATUS.update && ['available', 'downloading', 'ready'].includes(STATUS.update.state);
    let group = '';
    return visiblePages().map(([id, label, ic, g]) => `${g !== group ? `<div class="nav-group">${(group = g)}</div>` : ''}<button class="nav-item ${id === 'seller' ? 'seller' : ''} ${id === page && !searchQuery() ? 'active' : ''}" data-page="${id}">${icon(ic)}<span>${esc(label)}</span>${id === 'home' && n ? `<span class="count live">${n}</span>` : ''}${id === 'guide' && left ? `<span class="count">${left}</span>` : ''}${id === 'app' && upd ? '<span class="count live" title="Update available">1</span>' : ''}${id === 'seller' && ST.license && ST.license.waiting ? `<span class="count" title="People asking for access">${ST.license.waiting}</span>` : ''}</button>`).join('')
      + `<div class="spacer"></div><div class="side-foot">
        <div class="line"><span class="dot ${STATUS && STATUS.server.http ? 'good' : 'bad'}"></span>${STATUS && STATUS.server.http ? `Serving on port ${STATUS.server.http}` : 'Web server stopped'}</div>
        <div class="line"><span class="dot ${tdot}"></span>${tunnelLine}</div>
        <div style="margin-top:6px">Version ${esc(ST.version)} · <button data-quit="1">Quit</button></div></div>`;
  }
  function renderNav() {
    const html = navHtml();
    const nav = $('#nav');
    if (nav.dataset.sig !== html) { nav.innerHTML = html; nav.dataset.sig = html; }
  }

  $('#nav').addEventListener('click', e => {
    if (e.target.closest('[data-quit]')) { if (confirm('Quit Beam Remote? Nobody will be able to connect until you open it again.')) beam.quit(); return; }
    const b = e.target.closest('[data-page]');
    if (!b) return;
    clearSearch();
    page = b.dataset.page;
    renderNav();
    render();
    $('#main').scrollTop = 0;
  });

  function render() {
    if (searchQuery()) { renderSearch(); return; }
    if (!visiblePages().some(p => p[0] === page)) page = 'home';
    const fn = PAGE_FNS()[page];
    $('#main').innerHTML = `<div class="page ${page === 'seller' ? 'seller' : ''}">${fn()}</div>`;
    afterRender();
  }

  function afterRender() {
    if (page === 'home') drawSparks();
    if (page === 'appearance') updatePreview();
    if (page === 'seller') loadSell();
  }

  function onStatus() {
    const n = STATUS.clients.length;
    $('#tb-status').innerHTML = n ? `<span class="dot live"></span>Streaming to ${n} device${n > 1 ? 's' : ''}` : '';
    for (const c of STATUS.clients) {
      const h = hist.get(c.id) || { ping: [], lat: [], last: '' };
      const key = JSON.stringify(c.stats || {});
      if (c.stats && key !== h.last) {
        h.last = key;
        h.ping.push(c.stats.ping ?? null); h.lat.push(c.stats.latency ?? null);
        if (h.ping.length > 60) { h.ping.shift(); h.lat.shift(); }
      }
      hist.set(c.id, h);
    }
    renderNav();
    // Parts that change with the live status; only redrawn when their content changed.
    const swap = (sel, html) => { const el = $(sel); if (el && el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; } };
    if (page === 'home') swap('#alerts', alertsHtml());
    if (page === 'app') { swap('#update-box', updateHtml()); swap('#fw-value', firewallHtml()); }
    if (page === 'controllers') swap('#pads-box', padsHtml());
    if (page === 'remote') swap('#embed-box', embedHtml());
    if (page === 'home') {
      const live = $('#live'); if (live) live.innerHTML = liveHtml();
      const st = $('#status'); if (st) st.innerHTML = statusHtml();
      const addr = $('#addr-list'); if (addr) { const html = addrHtml(); if (addr.dataset.sig !== html) { addr.innerHTML = html; addr.dataset.sig = html; } }
      drawSparks();
    }
    if (page === 'remote') { const t = $('#tunnel-box'); if (t) t.innerHTML = tunnelHtml(); }
  }

  // ------------------------------------------------------------ generic setting rows
  const BMIN = 300, BMAX = 150000;
  const toSlider = k => Math.round((Math.log(k / BMIN) / Math.log(BMAX / BMIN)) * 1000);
  const fromSlider = v => { const k = BMIN * (BMAX / BMIN) ** (v / 1000); const step = k < 2000 ? 100 : k < 20000 ? 500 : 1000; return Math.round(k / step) * step; };

  function fieldHtml(key, extra = {}) {
    const r = ST.schema[key];
    if (!r) return '';
    const v = get(ST.config, key);
    const lab = `<div class="lab"><b>${esc(extra.label || r.label)}</b>${r.help ? `<p>${esc(r.help)}</p>` : ''}${r.restart ? '<span class="restart">Restarts the web server. Connected devices reconnect.</span>' : ''}</div>`;
    let ctl = '';
    let wide = false;
    if (r.type === 'bool') ctl = `<input type="checkbox" class="switch" data-key="${key}" ${v ? 'checked' : ''}>`;
    else if (r.type === 'enum' || r.type === 'enumInt') {
      ctl = `<select data-key="${key}">${r.values.map((x, i) => `<option value="${esc(x)}" ${String(x) === String(v) ? 'selected' : ''}>${esc(r.labels ? r.labels[i] : `${x}${key === 'stream.fps' ? ' fps' : ''}`)}</option>`).join('')}</select>`;
    } else if (r.type === 'display') {
      const opts = [['primary', 'Main screen'], ...ST.displays.map(d => [d.id, `${d.name}${d.primary ? ' (main)' : ''} · ${d.width}×${d.height} ${d.refresh} Hz`])];
      ctl = `<select data-key="${key}">${opts.map(([id, l]) => `<option value="${esc(id)}" ${String(id) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else if (key === 'stream.bitrateKbps') {
      ctl = `<div class="rangewrap"><input type="range" min="0" max="1000" value="${toSlider(v)}" data-key="${key}" data-log="1"><output>${mbps(v)} Mbps</output></div>`;
    } else if (r.type === 'num' && r.max <= 10) {
      ctl = `<div class="rangewrap"><input type="range" min="${r.min}" max="${r.max}" step="${r.step || 0.1}" value="${v}" data-key="${key}"><output>${v}×</output></div>`;
    } else if (r.type === 'int' || r.type === 'num') {
      ctl = `<input type="number" data-key="${key}" value="${esc(v)}" min="${r.min}" max="${r.max}" step="${r.step || 1}" style="max-width:140px">`;
    } else if (r.type === 'text') {
      ctl = `<input type="text" data-key="${key}" value="${esc(v)}" placeholder="${esc(r.placeholder || '')}" spellcheck="false">`;
    } else if (r.type === 'color') {
      ctl = `<div class="colorwrap"><code>${esc(v)}</code><input type="color" data-key="${key}" value="${esc(v)}"></div>`;
    } else if (r.type === 'json') {
      wide = true;
      ctl = `<textarea data-key="${key}" data-json="1" spellcheck="false">${esc(JSON.stringify(v, null, 2))}</textarea><div class="row end" style="margin-top:8px"><button class="btn small" data-action="save-json" data-for="${key}">Save</button></div>`;
    }
    return `<div class="field ${wide ? 'wide' : ''}">${lab}<div class="ctl">${ctl}</div></div>`;
  }
  const fields = keys => `<div class="card">${keys.map(k => fieldHtml(k)).join('')}</div>`;

  async function save(changes, quiet) {
    const r = await beam.updateConfig(changes);
    if (r.changed.length) {
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'presets') ST.config.presets = v;
        else { const parts = k.split('.'); let o = ST.config; for (const p of parts.slice(0, -1)) o = o[p]; o[parts[parts.length - 1]] = v; }
      }
      if (!quiet) toast(r.changed.some(c => c.startsWith('server.')) ? 'Saved. Restarting the web server…' : 'Saved', 'ok');
    } else if (!quiet) toast('That value was not accepted.', 'error');
    return r;
  }

  $('#main').addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.log) t.nextElementSibling.textContent = `${mbps(fromSlider(+t.value))} Mbps`;
    else if (t.type === 'range' && t.dataset.key) t.nextElementSibling.textContent = `${t.value}×`;
    if (t.type === 'color') t.previousElementSibling.textContent = t.value;
    if (t.id === 'pw-new') strength(t.value, '#pw-strength');
    if (page === 'appearance') updatePreview();
  });

  $('#main').addEventListener('change', async e => {
    const t = e.target;
    // Seller tab, owner's PC: activation server settings and sellers' names.
    if (t.dataset.hub) {
      await beam.hubSettings({ [t.dataset.hub]: t.type === 'checkbox' ? t.checked : t.value });
      SELL.hub = await beam.hubOverview();
      toast('Saved', 'ok');
      return;
    }
    if (t.dataset.hubLabel) {
      await beam.hubSeller(t.dataset.hubLabel, { label: t.value.trim() });
      toast('Saved', 'ok');
      return;
    }
    const key = t.dataset.key;
    if (!key || t.dataset.json) return;
    const r = ST.schema[key];
    let v;
    if (t.type === 'checkbox') v = t.checked;
    else if (t.dataset.log) v = fromSlider(+t.value);
    else if (r.type === 'int' || r.type === 'num' || r.type === 'enumInt') v = Number(t.value);
    else v = t.value;
    await save({ [key]: v });
    if (key === 'network.tunnel' || key.startsWith('stream.') || key.startsWith('appearance.')) render();
  });

  // ------------------------------------------------------------ Home
  function statusHtml() {
    const clients = STATUS.clients;
    let dot, title, text, actions = '';
    if (!ST.auth.passwordSet) {
      dot = 'warn'; title = 'Set a password to start'; text = 'Nobody can connect until this PC has a password.';
      actions = '<button class="btn primary" data-action="wizard">Set up</button>';
    } else if (STATUS.server.error) {
      dot = 'bad'; title = 'The web server isn\'t running'; text = esc(STATUS.server.error);
    } else if (clients.length) {
      const c = clients[0];
      dot = 'live';
      title = `Streaming to ${esc(c.device)}${clients.length > 1 ? ` and ${clients.length - 1} more` : ''}`;
      text = `Connected for ${since(c.connectedAt)} from ${esc(c.ip)}${c.tunnel ? ', through the tunnel' : ''}.`;
      if (clients.length > 1) actions = '<button class="btn danger" data-action="kick-all">Disconnect all</button>';
    } else {
      const remote = STATUS.urls.find(u => u.kind === 'remote');
      const t = STATUS.tunnel;
      dot = 'good'; title = 'Ready';
      text = remote ? 'Reachable on your home network and from anywhere.' : 'Reachable on your home network. Turn on remote access to connect from anywhere else.';
      actions = `<button class="btn" data-action="open-local">${icon('external')}Open in browser</button>`
        + (remote ? `<button class="btn primary" data-action="qr" data-url="${esc(remote.url)}">${icon('qr')}QR code for phone</button>`
          : ST.config.network.tunnel !== 'none' && t.state !== 'starting' && t.state !== 'downloading' ? '<button class="btn primary" data-action="tunnel-start">Turn on remote access</button>'
            : '<button class="btn primary" data-page-go="remote">Remote access</button>');
    }
    return `<span class="dot ${dot}"></span><div><h2>${title}</h2><p>${text}</p></div><div class="actions">${actions}</div>`;
  }

  const KIND = { local: 'This PC', lan: 'Home network', tailscale: 'Tailscale', remote: 'Anywhere' };
  function addrHtml() {
    return STATUS.urls.map(u => {
      const sub = (u.label.match(/\(([^)]+)\)/) || [])[1] || '';
      return `<div class="link"><span class="kind ${u.kind === 'remote' ? 'remote' : ''}">${KIND[u.kind] || ''}</span>
        <div class="url">${esc(u.url)}${sub ? `<span class="sub">${esc(sub[0].toUpperCase() + sub.slice(1))}</span>` : ''}</div>
        <div class="acts"><button class="icon-btn" title="Copy link" data-action="copy" data-url="${esc(u.url)}">${icon('copy')}</button>
        <button class="icon-btn" title="QR code for your phone" data-action="qr" data-url="${esc(u.url)}">${icon('qr')}</button>
        <button class="icon-btn" title="Open" data-action="open" data-url="${esc(u.url)}">${icon('external')}</button></div></div>`;
    }).join('');
  }

  // "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)" -> "NVIDIA GPU"
  function encoderName(h) {
    const e = h.encoder || '';
    if (/NVIDIA/i.test(e)) return 'NVIDIA GPU';
    if (/AMD|AMF/i.test(e)) return 'AMD GPU';
    if (/Intel|QSV|Quick ?Sync/i.test(e)) return 'Intel GPU';
    if (/MediaFoundation|External/i.test(e)) return 'GPU';
    if (/OpenH264|libvpx|libaom|SVT|dav1d/i.test(e)) return 'Processor';
    if (/^avc1|^vp0|^av01|^vp8/.test(e)) return h.hw ? 'GPU' : 'Auto';
    return e || '–';
  }

  const stat = (label, value, unit = '', cls = '') => `<div class="stat"><span class="l">${label}</span><span class="v ${cls}">${value}${unit ? `<small>${unit}</small>` : ''}</span></div>`;

  function soundStat(h) {
    const a = STATUS.audio || {};
    if (h.audio === 'off') return stat('Sound', 'Off', '', 'text');
    if (a.state === 'error') return stat('Sound', `<span class="bad" title="${esc(a.message || '')}">Problem</span>`, '', 'text');
    if (h.audio !== 'on') return stat('Sound', 'Starting', '', 'text');
    const pct = Math.round(Math.min(1, (h.audioLevel || 0) * 1.4) * 100);
    return stat('Sound', `<span title="${esc(a.format || '')}">On<span class="meter"><i style="width:${pct}%"></i></span></span>`, '', 'text');
  }

  function liveHtml() {
    const clients = STATUS.clients;
    if (!clients.length) return '<div class="card empty">No device is connected. Ping, latency, frame rate and connection details show up here while someone is streaming.</div>';
    return clients.map(c => {
      const s = c.stats || {}, h = c.host || {};
      const mobile = /iPhone|iPad|Android/.test(c.device);
      const route = s.route || h.route || '';
      const notes = [h.limit && h.limit !== 'none' ? `Limited by ${esc(h.limit)}` : '', s.loss ? `${fmt(s.loss, 1)}% packet loss` : ''].filter(Boolean).join(' · ') || 'Last 2 minutes';
      return `<div class="card">
        <div class="session-head"><div class="ico">${icon(mobile ? 'phone' : 'monitor')}</div>
          <div style="flex:1;min-width:0"><b>${esc(c.device)}</b><div class="meta">${c.detached ? '<span class="warn">Reconnecting…</span> · ' : ''}${padCount(c.id) ? `${padCount(c.id)} controller${padCount(c.id) > 1 ? 's' : ''} · ` : ''}${esc(c.ip)} · ${c.transport === 'webrtc' ? 'WebRTC' : c.transport === 'websocket' ? 'WebSocket' : 'Starting'}${route ? ` · ${esc(route)}` : ''} · ${LATENCY_NAMES[c.latency] || ''} · ${since(c.connectedAt)}</div></div>
          <button class="btn small danger" data-action="kick" data-id="${c.id}">Disconnect</button></div>
        <div class="stats">
          ${stat('Ping', fmt(s.ping), 'ms', grade(s.ping, 40, 100))}
          ${stat(s.latencyEst ? 'Latency (est.)' : 'Latency', fmt(s.latency), 'ms', grade(s.latency, 60, 130))}
          ${stat('Frame rate', fmt(s.fps ?? h.fps), 'fps')}
          ${stat('Bitrate', mbps(s.kbps ?? h.kbps), 'Mbps')}
          ${stat('Resolution', h.w ? `${h.w}×${h.h}` : s.w ? `${s.w}×${s.h}` : '–', '', 'text')}
          ${stat('Encoder', `${esc(h.codec || s.codec || '–')} · ${esc(encoderName(h))}`, '', 'text')}
          ${stat('Encode time', fmt(h.encodeMs, 1), 'ms')}
          ${soundStat(h)}
        </div>
        <div class="chart"><div class="legend"><span><i style="background:var(--accent)"></i>Ping</span><span><i style="background:var(--accent-2)"></i>Latency</span><span class="right">${notes}</span></div>
          <canvas class="spark" data-spark="${c.id}"></canvas></div>
      </div>`;
    }).join('');
  }

  function drawSparks() {
    for (const cv of document.querySelectorAll('canvas[data-spark]')) {
      const h = hist.get(cv.dataset.spark);
      const dpr = devicePixelRatio || 1;
      const W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      g.strokeStyle = css.getPropertyValue('--border').trim(); g.lineWidth = 1;
      for (let i = 0; i <= 2; i++) { const y = Math.round((H - 1) * i / 2) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      if (!h) continue;
      const all = [...h.ping, ...h.lat].filter(v => v != null);
      const max = Math.max(20, ...all) * 1.2;
      const line = (arr, color) => {
        g.beginPath(); let started = false;
        arr.forEach((v, i) => { if (v == null) return; const x = (i / 59) * W, y = H - 2 - (v / max) * (H - 4); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); });
        g.strokeStyle = color; g.lineWidth = 1.5 * dpr; g.lineJoin = 'round'; g.stroke();
      };
      line(h.lat, css.getPropertyValue('--accent-2').trim());
      line(h.ping, css.getPropertyValue('--accent').trim());
      g.fillStyle = css.getPropertyValue('--text-3').trim(); g.font = `${10.5 * dpr}px ${css.getPropertyValue('--font')}`;
      g.fillText(`${Math.round(max)} ms`, 3 * dpr, 12 * dpr);
    }
  }

  const padCount = id => ((STATUS.controllers && STATUS.controllers.pads) || []).filter(p => p.clientId === id).length;
  const LATENCY_NAMES = { lowest: 'Lowest latency', balanced: 'Balanced', smooth: 'Smoothest' };
  const grade = (v, good, ok) => (v == null ? '' : v <= good ? 'good' : v <= ok ? 'warn' : 'bad');
  function since(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function alertsHtml() {
    let out = '';
    for (const p of ST.problems || []) out += note('warn', esc(p));
    if (ST.inputError) out += note('bad', `<b>Mouse and keyboard control is unavailable.</b> ${esc(ST.inputError)}`);
    if (ST.capInfo && ST.capInfo.webcodecs === false) out += note('warn', 'This PC can\'t encode WebSocket streams, so only WebRTC will work.');
    const fw = (STATUS && STATUS.firewall) || {};
    if (fw.state === 'blocked') {
      out += note('warn', `<b>Devices on your Wi-Fi can't reach this PC.</b> ${esc(fw.detail || '')} Remote access through the tunnel isn't affected.
        <div class="row" style="margin-top:8px"><button class="btn small" data-action="firewall-fix">Allow through Windows Firewall</button></div>`);
    }
    const u = (STATUS && STATUS.update) || {};
    if (u.latest && u.state === 'available') {
      out += note('info', `<b>Version ${esc(u.latest)} is available.</b> ${ST.config.app.updates === 'auto' ? 'It downloads and installs by itself once nobody is connected.' : 'Download it now, then restart the app to finish.'}
        <div class="row" style="margin-top:8px"><button class="btn small primary" data-action="update-download">Download now</button><button class="btn small ghost" data-page-go="app">Update settings</button></div>`);
    } else if (u.latest && u.state === 'downloading') {
      out += note('info', `<b>Downloading version ${esc(u.latest)}</b> (${u.progress || 0}%).`);
    }
    if (u.state === 'ready') {
      out += note('info', `<b>Version ${esc(u.latest)} is ready to install.</b> ${ST.config.app.updates === 'auto' ? 'It installs by itself once nobody has been connected for a few minutes.' : 'Restart the app to finish.'}
        <div class="row" style="margin-top:8px"><button class="btn small primary" data-action="update-install">Restart and update</button></div>`);
    }
    return out ? `<div style="margin:-8px 0 16px">${out}</div>` : '';
  }

  function pageHome() {
    return `<div class="page-head"><div><h1>Home</h1><p>This PC's status and the links that reach it.</p></div></div>
      <div id="alerts">${alertsHtml()}</div>
      <div class="card status" id="status" style="margin-bottom:28px">${statusHtml()}</div>
      ${section('Links', 'Open one in any browser, or scan its QR code with your phone.', `<div class="card rows" id="addr-list">${addrHtml()}</div>`, `<button class="btn ghost small" data-page-go="remote">Remote access settings</button>`)}
      ${section('Live session', '', `<div id="live">${liveHtml()}</div>`)}`;
  }

  // ------------------------------------------------------------ Remote access
  function tunnelHtml() {
    const t = STATUS.tunnel;
    const label = { stopped: 'Off', downloading: 'Downloading', starting: 'Starting', online: 'On', error: 'Problem' }[t.state] || t.state;
    const dot = { online: 'good', error: 'bad', starting: 'warn', downloading: 'warn' }[t.state] || '';
    let html = `<div class="statusline"><span class="dot ${dot}"></span><span class="label">${label}</span><span class="msg">${esc(t.message || (t.state === 'stopped' ? 'Remote access is off.' : ''))}</span>
      ${t.state === 'downloading' ? `<div class="progress"><i style="width:${Math.round((t.progress || 0) * 100)}%"></i></div>` : ''}
      ${t.state === 'stopped' || t.state === 'error' ? `<button class="btn primary small" data-action="tunnel-start">${icon('play')}Start</button>` : `<button class="btn small" data-action="tunnel-stop">${icon('stop')}Stop</button>`}</div>`;
    if (t.url) {
      html += `<div class="link"><span class="kind remote">Link</span><div class="url">${esc(t.url)}</div>
        <div class="acts"><button class="icon-btn" data-action="copy" data-url="${esc(t.url)}" title="Copy link">${icon('copy')}</button>
        <button class="icon-btn" data-action="qr" data-url="${esc(t.url)}" title="QR code">${icon('qr')}</button>
        <button class="icon-btn" data-action="open" data-url="${esc(t.url)}" title="Open">${icon('external')}</button></div></div>`;
    }
    return html;
  }
  const tunnelCard = () => `<div class="card rows" id="tunnel-box">${tunnelHtml()}</div>`;

  function pageRemote() {
    const tun = ST.config.network.tunnel;
    const sel = tun === 'cloudflare' ? 'cloudflare' : tun === 'cloudflare-domain' ? 'domain' : tun === 'custom' ? 'custom' : remoteGuide;
    const ts = STATUS.urls.find(u => u.kind === 'tailscale');
    const choice = (id, title, desc, hint) => `<button class="choice ${sel === id ? 'active' : ''}" data-method="${id}"><span class="radio"></span><b>${title}</b><span>${desc}</span><div class="hint">${hint}</div></button>`;
    let body = '';
    if (sel === 'cloudflare') {
      body = section('Quick link', 'A private https:// link that works from anywhere: mobile data, work, a friend\'s Wi-Fi. No router changes, no account. Cloudflare\'s free <code>cloudflared</code> tool is downloaded the first time.',
        `${tunnelCard()}<div style="height:12px"></div>${fields(['network.tunnelAutoStart'])}
        ${note('info', 'The link changes every time the tunnel starts, so check here (or use "Copy remote link" in the tray menu) after a restart. For a link that never changes, use your own domain or Tailscale.')}
        <div class="row" style="margin-top:12px"><button class="btn ghost small" data-action="tunnel-log">Show tunnel log</button></div>`);
    } else if (sel === 'domain') {
      const d = ST.domain || { mode: 'none' };
      const ready = d.mode !== 'none';
      const port = ST.config.server.port;
      body = section('Your own domain', 'Reach this PC at an address you own, like <code>https://pc.yourname.com</code>. It never changes, has a real HTTPS certificate, and runs through Cloudflare\'s free tunnel, so no router changes are needed.',
        `<div class="card pad"><ol class="steps">
          <li class="${ready ? 'done' : ''}"><b>Add your domain to Cloudflare</b><p>The free plan is enough. Point your domain's nameservers to Cloudflare; it shows you how. No domain yet? You can buy one from Cloudflare or any registrar.</p>
            <button class="btn small" data-action="open" data-url="https://dash.cloudflare.com/">${icon('external')}Open Cloudflare</button></li>
          <li class="${ready ? 'done' : ''}"><b>Choose this PC's address and connect</b><p>Any name on your domain. Cloudflare opens in your browser once: choose the domain and click <b>Authorize</b>. The app then creates the tunnel and the DNS record.</p>
            <div class="row"><input class="input" id="domain-host" placeholder="pc.yourdomain.com" value="${esc(d.hostname || '')}" spellcheck="false" style="flex:1;min-width:220px">
            <button class="btn primary" data-action="domain-setup">${ready ? 'Set up again' : 'Connect with Cloudflare'}</button></div>
            <div id="domain-box">${domainStepHtml()}</div></li>
          <li class="${STATUS.tunnel.state === 'online' && ready ? 'done' : ''}"><b>Keep it on</b><p>It starts on its own after setup. Turn on "Start remote access when the app opens" below to keep it running.</p></li>
        </ol></div>
        <div style="height:12px"></div>${tunnelCard()}<div style="height:12px"></div>${fields(['network.tunnelAutoStart'])}
        ${ready ? `<p class="muted" style="margin:12px 0 0">Connected as <b>${esc(d.hostname)}</b> using ${d.mode === 'token' ? 'a tunnel token' : 'a tunnel made by this app'}. <a href="#" data-action="domain-forget">Disconnect domain</a> · <a href="#" data-action="domain-relogin">Use a different Cloudflare domain</a></p>` : ''}`)
        + section('Set it up in Cloudflare yourself', 'If you\'d rather create the tunnel in Cloudflare\'s dashboard.',
          `<div class="card faq"><details><summary>Paste a tunnel token</summary>
            <ol>
              <li>In Cloudflare, open <b>Zero Trust → Networks → Tunnels → Create a tunnel</b>, choose <b>Cloudflared</b> and name it.</li>
              <li>On the install step, copy the command shown (or just the long code in it that starts with <code>ey</code>). You don't need to run it.</li>
              <li>Add a <b>public hostname</b>: your address, service <b>HTTP</b>, URL <code>localhost:${port}</code>.</li>
              <li>Paste the token and enter your address in step 2 above.</li>
            </ol>
            <div class="row"><input class="input" id="domain-token" placeholder="eyJhIjoi…" spellcheck="false" style="flex:1;min-width:220px"><button class="btn" data-action="domain-token">Save and start</button></div>
          </details></div>`);
    } else if (sel === 'tailscale') {
      body = section('Tailscale', 'Puts this PC and your devices on a private network of their own. Nobody else can even see the page, and the address never changes. Free for personal use.',
        `${ts ? `<div style="margin:-4px 0 12px">${note('ok', `Tailscale is running on this PC. Your link: <code>${esc(ts.url)}</code>`)}</div>` : ''}
        <div class="card pad"><ol class="steps">
          <li class="${ts ? 'done' : ''}"><b>Install Tailscale on this PC</b><p>Download it, install it and sign in with a Google, Microsoft, GitHub or Apple account.</p><button class="btn small" data-action="open" data-url="https://tailscale.com/download">${icon('external')}tailscale.com/download</button></li>
          <li><b>Install it on your phone or laptop</b><p>Same app, signed in to the same account, switched on.</p></li>
          <li class="${ts ? 'done' : ''}"><b>Open your Tailscale link</b><p>It appears on Home as soon as Tailscale is running here${ts ? `: <code>${esc(ts.url)}</code>` : ''}. Bookmark it or add it to your home screen.</p></li>
        </ol></div>
        <p class="muted" style="margin:12px 0 0">WebRTC connects directly over Tailscale, so latency stays as low as it can be.</p>`);
    } else if (sel === 'portforward') {
      body = section('Port forwarding', 'Your router sends outside connections straight to this PC. Fast, but it\'s the most exposed option: use a long password and two-step sign-in.',
        `<div class="card pad"><ol class="steps">
          <li><b>Give this PC a fixed address on your network</b><p>In your router's settings, reserve this PC's current address (DHCP reservation).</p></li>
          <li><b>Forward the port</b><p>Forward TCP port <code>${ST.config.server.port}</code>${ST.config.server.https ? ` and <code>${ST.config.server.httpsPort}</code>` : ''} to this PC. Turn on "Also serve HTTPS" below and use the https address so your password is encrypted.</p></li>
          <li><b>Find your public address</b><p>Search "what is my IP" on this PC. Your link is <code>https://YOUR-IP:${ST.config.server.httpsPort}</code>. A free dynamic DNS name keeps it working when the IP changes.</p></li>
          <li><b>Save it below</b><p>So it shows on Home with a QR code.</p></li>
        </ol></div><div style="height:12px"></div>${fields(['server.https', 'network.publicUrl'])}`);
    } else {
      body = section('Your own tunnel tool', 'Run any tunnel program from here, such as ngrok. The app starts and stops it and shows the first https:// link it prints.',
        `${tunnelCard()}<div style="height:12px"></div>${fields(['network.tunnelCommand', 'network.publicUrl', 'network.tunnelAutoStart'])}
        ${note('info', 'Example: <code>ngrok http {port} --log stdout</code>')}`);
    }
    return `<div class="page-head"><div><h1>Remote access</h1><p>Reach this PC from outside your home. Every option is protected by your password.</p></div></div>
      ${!ST.auth.passwordSet ? `<div style="margin:-8px 0 16px">${note('warn', 'Choose a password first. Remote access won\'t start without one.')}</div>` : ''}
      <div class="choices methods">
        ${choice('cloudflare', 'Quick link', 'Free Cloudflare tunnel, works anywhere.', 'No account needed')}
        ${choice('domain', 'Your own domain', 'pc.yourname.com through Cloudflare.', 'Permanent address')}
        ${choice('tailscale', 'Tailscale', 'A private network for your devices.', 'Most private')}
        ${choice('portforward', 'Port forwarding', 'A rule on your router.', 'Advanced')}
        ${choice('custom', 'Other tool', 'ngrok or any tunnel program.', 'Advanced')}
      </div>
      ${body}
      ${section('Direct connections', 'WebRTC tries to connect your device straight to this PC, even when you opened a tunnel link, for the lowest latency. These servers help it find a path. If direct connections never work on your networks, add a TURN server; the stream otherwise falls back to the tunnel.', fields(['network.iceServers']))}
      ${section('Embedding', 'Show the stream page inside a website with an iframe. On by default: any site may show it, and signing in is still needed.', `${fields(['security.embedOrigins'])}<div id="embed-box">${embedHtml()}</div>`)}`;
  }

  // Progress of "Connect with Cloudflare", pushed from the app while it works.
  let domainStep = null;
  function domainStepHtml() {
    const s = domainStep;
    if (!s) return '';
    const busy = ['tool', 'login', 'tunnel', 'dns'].includes(s.step);
    const kind = s.step === 'error' ? 'bad' : s.step === 'done' ? 'ok' : s.step === 'ask' ? 'warn' : '';
    const extra = (s.loginUrl ? `<div class="row" style="margin-top:8px"><button class="btn small" data-action="open" data-url="${esc(s.loginUrl)}">${icon('external')}Open the Cloudflare page</button><span class="faint">if it didn't open by itself</span></div>` : '')
      + (s.needOverwrite ? '<div class="row" style="margin-top:8px"><button class="btn small primary" data-action="domain-overwrite">Replace it</button><button class="btn small" data-action="domain-cancel">Keep the old record</button></div>' : '');
    if (busy) return `<div class="note"><span class="spin"></span><div class="body">${esc(s.message)}${extra}</div></div>`;
    return note(kind, esc(s.message) + extra);
  }
  beam.onDomain(s => {
    domainStep = s;
    const box = $('#domain-box');
    if (box) box.innerHTML = domainStepHtml();
    if (s.step === 'done') toast(s.message, 'ok');
  });

  // ------------------------------------------------------------ Quality
  function pageQuality() {
    const s = ST.config.stream;
    const presets = ST.config.presets;
    return `<div class="page-head"><div><h1>Stream quality</h1><p>This PC's defaults. Each browser can also choose its own quality from the toolbar.</p></div></div>
      ${section('Preset', 'Sets resolution, frame rate and bitrate in one go.',
        `<div class="choices">${presets.map((p, i) => `<button class="choice ${p.resolution === s.resolution && p.fps === s.fps && p.bitrateKbps === s.bitrateKbps ? 'active' : ''}" data-preset="${i}"><span class="radio"></span><b>${esc(p.name)}</b><span class="num">${p.resolution === 'native' ? 'Native' : p.resolution} · ${p.fps} fps · ${mbps(p.bitrateKbps)} Mbps</span></button>`).join('')}</div>`)}
      ${section('Picture', '', fields(['stream.display', 'stream.resolution', 'stream.fps', 'stream.bitrateKbps', 'stream.codec', 'stream.contentHint', 'stream.degradation']))}
      ${section('Sound and connection', '', fields(['stream.audio', 'stream.transport', 'stream.keyframeSeconds', 'stream.hardwareEncoding']))}
      ${section('Edit presets', 'These appear in every browser\'s quality menu.',
        `<div class="card"><table class="edit"><thead><tr><th>Name</th><th>Resolution</th><th>Frame rate</th><th>Bitrate (kbps)</th><th></th></tr></thead>
        <tbody id="preset-rows">${presets.map((p, i) => presetRow(p, i)).join('')}</tbody></table>
        <div class="row" style="padding:12px 16px;border-top:1px solid var(--border);margin-top:8px"><button class="btn small" data-action="preset-add">${icon('plus')}Add preset</button><span style="flex:1"></span><button class="btn ghost small" data-action="preset-reset">Restore defaults</button><button class="btn primary small" data-action="preset-save">Save presets</button></div></div>`)}`;
  }
  function presetRow(p, i) {
    const res = ST.schema['stream.resolution'], fps = ST.schema['stream.fps'];
    return `<tr data-row="${i}"><td><input value="${esc(p.name)}" data-p="name" maxlength="24"></td>
      <td><select data-p="resolution">${res.values.map((v, j) => `<option value="${v}" ${v === p.resolution ? 'selected' : ''}>${esc(res.labels[j])}</option>`).join('')}</select></td>
      <td><select data-p="fps">${fps.values.map(v => `<option value="${v}" ${v === p.fps ? 'selected' : ''}>${v} fps</option>`).join('')}</select></td>
      <td><input type="number" data-p="bitrateKbps" value="${p.bitrateKbps}" min="300" max="150000" step="100"></td>
      <td><button class="icon-btn" data-action="preset-del" title="Remove">${icon('trash')}</button></td></tr>`;
  }
  function readPresetRows() {
    return [...document.querySelectorAll('#preset-rows tr')].map(tr => ({
      name: tr.querySelector('[data-p=name]').value.trim(),
      resolution: tr.querySelector('[data-p=resolution]').value,
      fps: Number(tr.querySelector('[data-p=fps]').value),
      bitrateKbps: Number(tr.querySelector('[data-p=bitrateKbps]').value),
    })).filter(p => p.name);
  }

  // ------------------------------------------------------------ Security
  function strength(pw, sel) {
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (pw.length >= 16) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    const el = document.querySelector(sel);
    if (!el) return score;
    const pct = Math.min(100, (score / 6) * 100);
    const color = score <= 2 ? 'var(--bad)' : score <= 4 ? 'var(--warn)' : 'var(--good)';
    el.innerHTML = `<i style="width:${pw ? pct : 0}%;background:${color}"></i>`;
    return score;
  }

  function logHtml() {
    const log = ST.log || [];
    if (!log.length) return '<div class="empty">Nothing yet.</div>';
    return log.map(e => `<div><time>${new Date(e.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span class="k ${esc(e.kind)}">${esc(e.kind)}</span><span class="msg">${esc(e.text)}</span></div>`).join('');
  }

  function pageSecurity() {
    const a = ST.auth;
    return `<div class="page-head"><div><h1>Security &amp; privacy</h1><p>Only someone with your password, and your code if you turn it on, can see or control this PC.</p></div></div>
      ${section(a.passwordSet ? 'Password' : 'Choose a password', a.passwordSet ? 'Changing it signs every device out.' : 'At least 8 characters. Longer is better; a short sentence works well.',
        `<div class="card pad"><div class="grid2" style="gap:8px"><input class="input" type="password" id="pw-new" placeholder="New password" autocomplete="new-password"><input class="input" type="password" id="pw-confirm" placeholder="Type it again" autocomplete="new-password"></div>
          <div class="strength" id="pw-strength"><i></i></div>
          <div class="row end" style="margin-top:12px"><button class="btn primary" data-action="set-password">${a.passwordSet ? 'Change password' : 'Save password'}</button></div></div>`)}
      ${section('Two-step sign-in', 'Also asks for a 6-digit code from an authenticator app on your phone. Recommended if you use remote access.',
        `<div class="card">${a.totpEnabled
          ? '<div class="statusline"><span class="dot good"></span><span class="label">On</span><span class="msg">A code is required at sign-in.</span><button class="btn small danger" data-action="totp-off">Turn off</button></div>'
          : `<div class="statusline"><span class="dot"></span><span class="label">Off</span><span class="msg">Only the password is needed.</span><button class="btn small primary" data-action="totp-on" ${a.passwordSet ? '' : 'disabled'}>Turn on</button></div>`}</div>`)}
      ${section('Rules', '', fields(['security.allowControl', 'security.maxClients', 'security.newClientPolicy', 'security.sessionDays', 'security.maxFailedAttempts', 'security.lockoutMinutes', 'security.notifyOnSignIn', 'security.blockWinKey', 'security.allowedIps']))}
      ${section('Privacy screen', 'What this PC\'s own monitor shows while someone is streaming, so people near the PC can\'t watch. The stream always shows the real screen.', privacyHtml())}
      ${section('Signed-in devices', 'Browsers that are currently allowed in.',
        `<div class="card rows log">${a.sessions.length ? a.sessions.slice().reverse().map(s => `<div><time>${new Date(s.created).toLocaleDateString()}</time><span class="msg">${esc(s.device || 'Browser')} · ${esc(s.ip)}</span><span class="faint">until ${new Date(s.expires).toLocaleDateString()}</span></div>`).join('') : '<div class="empty">No devices are signed in.</div>'}</div>`,
        `<button class="btn small danger" data-action="signout-all" ${a.sessions.length ? '' : 'disabled'}>Sign out all</button>`)}
      ${section('Security log', 'Sign-ins, wrong passwords, lockouts and connections.', `<div class="card rows log" id="seclog">${logHtml()}</div>`,
        `<button class="btn ghost small" data-action="open-path" data-which="log">${icon('file')}Open log file</button>`)}`;
  }

  function privacyHtml() {
    if (!ST.coverSupported) return note('warn', 'The privacy screen needs Windows 10 version 2004 or newer. On older versions it would cover the stream too.');
    const pic = ST.config.privacy.picture;
    const picRow = `<div class="field"><div class="lab"><b>Picture</b><p>Shown with "A picture". It's copied into the settings folder.</p></div>
      <div class="ctl" style="gap:8px;align-items:center"><span class="faint">${pic ? esc(pic) : 'None chosen'}</span>
        <button class="btn small" data-action="cover-picture">Choose…</button>${pic ? '<button class="btn small ghost" data-action="cover-picture-clear">Remove</button>' : ''}</div></div>`;
    return `<div class="card">${['privacy.screen', 'privacy.message', 'privacy.showDevice'].map(k => fieldHtml(k)).join('')}${picRow}${['privacy.screens', 'privacy.browserCanChange'].map(k => fieldHtml(k)).join('')}</div>
      <div class="row" style="margin-top:12px"><button class="btn" data-action="cover-test">Try it for 6 seconds</button></div>
      ${note('info', 'Someone at this PC can press <b>Ctrl + Alt + Shift + H</b> to see the screen again until the stream ends. The mouse pointer still shows on the monitor, and games in exclusive full screen can draw over the cover.')}`;
  }

  // The address to put in the iframe: the remote one when there is one (https works on any site).
  function embedUrl() {
    const urls = STATUS.urls || [];
    const pick = urls.find(u => u.kind === 'remote') || urls.find(u => u.kind === 'tailscale') || urls.find(u => u.kind === 'lan') || urls[0];
    return pick ? pick.url : `http://localhost:${ST.config.server.port}/`;
  }

  function embedHtml() {
    if (!String(ST.config.security.embedOrigins || '').trim()) {
      return note('info', 'Embedding is off, so no other website can show this page. Enter your site above (or *) to turn it on.');
    }
    const url = embedUrl();
    const code = `<iframe src="${url}" allow="fullscreen; autoplay; clipboard-read; clipboard-write; keyboard-map" allowfullscreen style="width:100%;height:600px;border:0"></iframe>`;
    const warn = !/^https:/i.test(url)
      ? note('warn', 'This address isn\'t https://, so websites that use https can\'t show it. Turn on remote access (a quick link or your own domain) and use that address.')
      : ST.config.network.tunnel === 'cloudflare' ? note('info', 'Quick links change every time remote access starts. For a frame that keeps working, use your own domain.') : '';
    return `<div class="card pad" style="margin-top:12px"><h3>Code for your website</h3>
      <pre class="term">${esc(code)}</pre>${warn}
      <p class="faint" style="margin:10px 0 0">Inside a frame the page signs in with its own token, so it works even where the browser blocks cookies (school and work Chromebooks, Safari).</p>
      <div class="row" style="margin-top:12px"><button class="btn" data-action="copy-code" data-url="${esc(code)}">${icon('copy')}Copy code</button>
        <button class="btn" data-action="embed-test" data-url="${esc(url)}">${icon('external')}Test on this PC</button></div></div>`;
  }

  // ------------------------------------------------------------ Browser controls
  function pageBrowser() {
    const sc = [['Ctrl + Alt + Shift + M', 'Show the toolbar'], ['Ctrl + Alt + Shift + S', 'Cycle the stats overlay'], ['Ctrl + Alt + Shift + F', 'Full screen (also captures Windows-key shortcuts in Chrome and Edge)'], ['Esc', 'Release the mouse in game mode'], ['Ctrl + V', 'Paste text from your device into the PC (with clipboard sharing on)']];
    return `<div class="page-head"><div><h1>Browser controls</h1><p>Starting values for every browser. Each device can change these for itself in its own settings.</p></div></div>
      ${section('Mouse, touch and keyboard', '', fields(['client.mouseMode', 'client.touchMode', 'client.localCursor', 'client.scrollSpeed', 'client.invertScroll', 'client.clipboardSync']))}
      ${section('Picture adjustments', 'Starting values. Each device can change them in its own settings (Picture), with presets. The viewing browser does this, so it costs this PC and the stream nothing.', fields(['client.picBrightness', 'client.picContrast', 'client.picSaturation', 'client.picHue', 'client.picWarmth', 'client.picSharpen']))}
      ${section('Picture and sound', '', fields(['client.latency', 'client.scaleMode', 'client.smoothing', 'client.sound']))}
      ${section('Overlay and toolbar', '', fields(['client.stats', 'client.statsPosition', 'client.toolbar']))}
      ${section('Keyboard shortcuts', '', `<div class="card rows kv">${sc.map(([k, v]) => `<div><span class="key"><code>${k}</code></span><span>${v}</span></div>`).join('')}</div>`)}`;
  }

  // ------------------------------------------------------------ Appearance
  function pageAppearance() {
    return `<div class="page-head"><div><h1>Appearance</h1><p>Applies to this app and the page your devices see.</p></div></div>
      <div class="grid2" style="margin-bottom:28px;align-items:start">
        <div><div class="section-head"><div><h2>Sign-in page</h2></div></div>
          <div class="card" style="padding-top:16px"><div class="preview" id="preview"><div class="pv-card"><img src="../../assets/icon.png" alt=""><h4 id="pv-name"></h4><p id="pv-text"></p><div class="pv-in"></div><div class="pv-btn"></div></div></div></div></div>
        <div><div class="section-head"><div><h2>Brand</h2></div></div>${fields(['appearance.appName', 'appearance.welcomeText', 'appearance.accent', 'appearance.accent2'])}</div>
      </div>
      ${section('Style', '', fields(['appearance.theme', 'appearance.background', 'appearance.radius', 'appearance.font']))}
      ${section('Custom CSS', 'For anything else, edit <code>custom.css</code> in the settings folder. It\'s added to both the browser page and this app; save it and refresh.',
        `<div class="card pad row"><button class="btn" data-action="open-path" data-which="css">${icon('file')}Edit custom.css</button><button class="btn ghost" data-action="appearance-reset">Restore default look</button></div>`)}`;
  }
  function updatePreview() {
    const p = $('#preview');
    if (!p) return;
    const val = k => { const el = document.querySelector(`[data-key="${k}"]`); return el ? el.value : get(ST.config, k); };
    p.querySelector('.pv-btn').style.background = val('appearance.accent');
    $('#pv-name').textContent = val('appearance.appName');
    $('#pv-text').textContent = val('appearance.welcomeText');
  }

  // ------------------------------------------------------------ App & updates
  const RELEASES = 'https://github.com/AncientRemain/remoteweb/releases';
  function updateHtml() {
    const u = STATUS.update || { state: 'disabled' };
    const when = u.checkedAt ? ` · checked ${since(u.checkedAt)} ago` : '';
    let dot = '', label = '', msg = '', btn = '';
    switch (u.state) {
      case 'disabled': label = 'Off'; msg = esc(u.message || 'Updates are checked only in the installed app.'); break;
      case 'idle': label = 'Not checked yet'; msg = `Version ${esc(u.current || ST.version)}`; btn = '<button class="btn small" data-action="update-check">Check now</button>'; break;
      case 'checking': dot = 'warn'; label = 'Checking'; msg = 'Looking for a new version…'; break;
      case 'available': dot = 'warn'; label = 'Update available'; msg = `Version ${esc(u.latest)} is out (you have ${esc(u.current)}).`; btn = '<button class="btn small primary" data-action="update-download">Download</button>'; break;
      case 'downloading': dot = 'warn'; label = 'Downloading'; msg = `Version ${esc(u.latest)} · ${u.progress || 0}%`; btn = `<div class="progress"><i style="width:${u.progress || 0}%"></i></div>`; break;
      case 'ready': dot = 'good'; label = 'Ready to install'; msg = `Version ${esc(u.latest)} is downloaded.`; btn = '<button class="btn small primary" data-action="update-install">Restart and update</button>'; break;
      case 'installing': dot = 'warn'; label = 'Installing'; msg = 'The app closes, updates and opens again by itself.'; break;
      case 'error': dot = 'bad'; label = 'Problem'; msg = esc(u.message || 'The update check failed.'); btn = '<button class="btn small" data-action="update-check">Try again</button>'; break;
      default: dot = 'good'; label = 'Up to date'; msg = `Version ${esc(u.current || ST.version)}${when}`; btn = '<button class="btn small" data-action="update-check">Check now</button>';
    }
    return `<div class="statusline"><span class="dot ${dot}"></span><span class="label">${label}</span><span class="msg">${msg}</span>${btn}
      <button class="btn ghost small" data-action="open" data-url="${esc(u.url || RELEASES)}">${icon('external')}Releases</button></div>`;
  }

  function firewallHtml() {
    const fw = STATUS.firewall || {};
    if (fw.state === 'blocked') return `<span class="warn">${esc(fw.detail || 'Blocking other devices.')}</span> <button class="btn small" data-action="firewall-fix">Allow</button>`;
    if (fw.state === 'ok') return esc(fw.detail || 'Allows devices on your network.');
    return 'Not checked <button class="btn ghost small" data-action="firewall-check">Check</button>';
  }

  function padsHtml() {
    const c = STATUS.controllers || { driver: 'unknown', pads: [] };
    let line;
    if (c.driver === 'ready') line = '<div class="statusline"><span class="dot good"></span><span class="label">Driver installed</span><span class="msg">Controllers at the viewing device show up here as Xbox controllers.</span></div>';
    else if (c.driver === 'missing') line = '<div class="statusline"><span class="dot warn"></span><span class="label">Driver not installed</span><span class="msg">Needed once so games on this PC can see controllers. Windows asks for your approval.</span><button class="btn small primary" data-action="pad-install">Install controller driver</button></div>';
    else if (c.driver === 'error') line = '<div class="statusline"><span class="dot bad"></span><span class="label">Problem</span><span class="msg">The controller helper could not start.</span><button class="btn small" data-action="pad-recheck">Try again</button></div>';
    else line = '<div class="statusline"><span class="dot"></span><span class="label">Checking</span><span class="msg">Looking for the controller driver…</span></div>';
    const list = (c.pads || []).map(p => `<div class="statusline"><span class="dot ${p.plugged ? 'live' : ''}"></span><span class="label">${p.player ? `Player ${p.player}` : 'Connecting'}</span><span class="msg">${esc(p.name)}${p.device ? ` · ${esc(p.device)}` : ''}</span></div>`).join('');
    return line + list;
  }

  function pageControllers() {
    return `<div class="page-head"><div><h1>Controllers</h1><p>Game controllers held at the viewing device (USB or Bluetooth: school Chromebooks, phones, tablets, Macs, PCs) work on this PC as Xbox controllers, with vibration. The viewing device needs nothing installed.</p></div></div>
      ${section('This PC', 'The controller driver is installed once. Connected controllers show up here with their player number.', `<div class="card rows" id="pads-box">${padsHtml()}</div><div style="height:12px"></div>${fields(['security.allowControllers'])}`)}
      ${section('Each device', 'Starting values; each device can change them from the controller button in its toolbar.', fields(['client.controllerVibration', 'client.touchController']))}
      ${section('How to use', '', `<div class="card pad"><ol class="steps">
          <li><b>Connect a controller to the device you watch on</b><p>USB or Bluetooth. Xbox, PlayStation, Switch Pro and most others work; buttons are matched by position.</p></li>
          <li><b>Open the stream page and press any button</b><p>The controller appears on this PC as Player 1 to 4. Up to 4 controllers at once.</p></li>
          <li><b>No controller?</b><p>On touch screens, turn on the on-screen controller from the controller button in the toolbar.</p></li>
        </ol></div>`)}`;
  }

  function pageApp() {
    const ci = ST.capInfo || {};
    const au = STATUS.audio || {};
    const cpu = STATUS.cpu ? `${fmt(STATUS.cpu.total, 1)}%` : '–';
    const kv = (k, v) => `<div><span class="key">${k}</span><span>${v}</span></div>`;
    return `<div class="page-head"><div><h1>App &amp; updates</h1><p>How the app runs on this PC: startup, updates, the web server and diagnostics.</p></div></div>
      ${section('Activation', '', activationHtml())}
      ${section('App', '', fields(['app.startWithWindows', 'app.startMinimized', 'app.closeToTray', 'app.keepAwake', 'app.streamPriority']))}
      ${section('Updates', 'New versions come from github.com/AncientRemain/remoteweb. Nothing is downloaded while someone is streaming.',
        `<div class="card"><div id="update-box">${updateHtml()}</div>${fieldHtml('app.updates')}</div>`)}
      ${section('Web server', '', fields(['server.port', 'server.bindAddress', 'server.https', 'server.httpsPort']))}
      ${section('Administrator mode', 'Windows doesn\'t let normal apps click or type into programs running as administrator (Task Manager, installers, some games). Restart as administrator to control those too. The UAC prompt and lock screen can never be streamed.',
        '<div class="card pad"><button class="btn" data-action="restart-admin">Restart as administrator</button></div>')}
      ${section('Settings file', 'Everything here is stored in <code>config.json</code>. Edit it by hand if you like; the app reloads it when you save. It never contains your password, so it\'s safe to share.',
        `<div class="card pad"><div class="row">
          <button class="btn" data-action="open-path" data-which="folder">${icon('folder')}Open folder</button>
          <button class="btn" data-action="open-path" data-which="config">${icon('file')}Edit config.json</button>
          <button class="btn" data-action="export">Export</button>
          <button class="btn" data-action="import">Import</button>
          <span style="flex:1"></span>
          <button class="btn danger" data-action="reset-all">Reset all</button>
        </div><p class="faint mono" style="margin:12px 0 0;word-break:break-all">${esc(ST.userDir)}</p></div>`)}
      ${section('Diagnostics', '', `<div class="card rows kv">
          ${kv('Version', esc(ST.version))}
          ${kv('Keyboard and mouse', ST.inputError ? `<span class="bad">${esc(ST.inputError)}</span>` : 'Working')}
          <div><span class="key">Windows Firewall</span><span id="fw-value">${firewallHtml()}</span></div>
          ${kv('System sound', `${esc(au.state || 'off')}${au.format ? ` · ${esc(au.format)}` : ''}${au.message ? ` · ${esc(au.message)}` : ''}`)}
          ${kv('WebSocket encoder', ci.webcodecs ? 'Available' : '<span class="warn">Not available</span>')}
          ${kv('Opus sound encoder', ci.audioEncoder ? 'Available' : '<span class="warn">Not available</span>')}
          ${kv('App CPU use', cpu)}
          ${kv('Screens', ST.displays.map(d => `${esc(d.name)} ${d.width}×${d.height} @ ${d.refresh} Hz`).join(', '))}
        </div><div class="row" style="margin-top:12px"><button class="btn ghost small" data-action="cap-log">Streamer log</button><button class="btn ghost small" data-action="tunnel-log">Tunnel log</button></div>`)}`;
  }

  // ------------------------------------------------------------ Setup guide
  function checks() {
    const urls = STATUS.urls;
    return [
      { done: ST.auth.passwordSet, title: 'Choose a password', text: 'Protects the PC. Nothing works until it\'s set.', go: ['security', 'Security'] },
      { done: ST.auth.signedInOnce, title: 'Try it on this PC', text: 'Open the page in your browser and sign in.', action: ['open-local', 'Open in browser'] },
      { done: urls.some(u => u.kind === 'remote' || u.kind === 'tailscale'), title: 'Set up remote access', text: 'Quick link, your own domain, Tailscale or port forwarding.', go: ['remote', 'Remote access'] },
      { done: ST.auth.totpEnabled, title: 'Turn on two-step sign-in', text: 'Recommended. A code from your phone on top of the password.', go: ['security', 'Security'] },
      { done: ST.config.app.startWithWindows, title: 'Start with Windows', text: 'Optional. Keeps the PC reachable after a restart.', go: ['app', 'App settings'] },
    ];
  }
  const setupLeft = () => (ST && STATUS ? checks().slice(0, 3).filter(c => !c.done).length : 0);

  function pageGuide() {
    const list = checks();
    return `<div class="page-head"><div><h1>Setup guide</h1><p>From install to streaming this PC to your phone in about five minutes.</p></div>
        <button class="btn" data-action="wizard">Run setup again</button></div>
      ${section('Checklist', 'Updates itself as you go.', `<div class="card rows checklist">
        ${list.map(c => `<div class="${c.done ? 'done-text' : ''}"><span class="check ${c.done ? 'done' : ''}"></span><div class="txt"><b>${c.title}</b><p>${c.text}</p></div>
          ${c.done ? '' : c.go ? `<button class="btn small" data-page-go="${c.go[0]}">${c.go[1]}</button>` : `<button class="btn small" data-action="${c.action[0]}">${c.action[1]}</button>`}</div>`).join('')}
      </div>`)}
      ${section('How it works', '', `<div class="card pad"><ol class="steps">
          <li><b>This app runs on the PC you want to reach</b><p>It captures the screen and sound and serves a web page on port ${ST.config.server.port}. Keep it running; it lives in the tray.</p></li>
          <li><b>You open the page in any browser</b><p>Chrome, Edge, Safari or Firefox on a phone, tablet, laptop or another PC. Nothing to install there. Sign in with your password.</p></li>
          <li><b>The picture takes the fastest path</b><p><b>WebRTC</b> connects your device straight to the PC when it can, for the lowest latency, even through a tunnel. When it can't, the stream goes through the web connection itself (<b>WebSocket</b>), which works through any tunnel. Auto mode chooses for you.</p></li>
          <li><b>Your input goes back to the PC</b><p>Mouse, keyboard and touch arrive as real input, so games and every app respond. Lock the mouse for 3D games; on phones, drag like a touchpad.</p></li>
        </ol></div>`)}
      ${section('Connecting from outside your home', '', `<div class="card pad"><ol class="steps">
          <li><b>Quick link</b><p>Remote access → Quick link → Start. Open the https:// link it shows or scan its QR code. It changes each time it starts.</p></li>
          <li><b>Your own domain</b><p>Remote access → Your own domain. Enter an address like pc.yourname.com and press Connect with Cloudflare. It never changes.</p></li>
          <li><b>Tailscale</b><p>Install Tailscale on the PC and your phone with the same account, then use the 100.x.x.x link on Home.</p></li>
          <li><b>Port forwarding</b><p>Forward the port on your router and turn on HTTPS. Pair it with two-step sign-in.</p></li>
        </ol></div>`)}
      ${section('Questions and fixes', '', `<div class="card faq">
        <details><summary>The picture is black or frozen</summary><p>Windows hides the lock screen and administrator (UAC) prompts from every screen-capture app. Turn on "Keep this PC awake" and don't lock the PC (Win+L) while you're away. If a game runs in exclusive full screen, switch it to borderless window.</p></details>
        <details><summary>I can see the screen but can't click some windows</summary><p>Those programs run as administrator. Go to App &amp; updates → Restart as administrator.</p></details>
        <details><summary>It's laggy or blurry</summary><p>Open the toolbar (move the mouse to the top edge) → Quality, and try Balanced or Data saver. The stats overlay shows ping (the network round trip) and latency (from the PC's screen to yours). On Wi-Fi, a 5 GHz network helps.</p></details>
        <details><summary>It switched to "web stream"</summary><p>WebRTC couldn't find a direct path between your networks, which is common on mobile data and strict work networks, so the stream goes through the tunnel instead. It still works with slightly higher latency. A TURN server (Remote access → Direct connections) can fix it.</p></details>
        <details><summary>How do I type on my phone?</summary><p>Tap the keyboard button in the toolbar. For text that won't paste, use the clipboard button → Type on the PC. The keys button has the Windows key, Alt+Tab, Task Manager and arrow keys.</p></details>
        <details><summary>Sound echoes when I test on this PC</summary><p>The page plays the PC's sound back into itself. Mute the browser tab, or set Sound to "On, and mute this PC's speakers".</p></details>
        <details><summary>Can friends use it?</summary><p>Yes. Give them the installer. Each person installs it on their own PC and chooses their own password; nobody can reach anyone else's PC. Windows may say it's an unrecognised app the first time: More info → Run anyway.</p></details>
        <details><summary>Can I change things without editing code?</summary><p>Every setting is on these pages and in <code>config.json</code> (App &amp; updates → Edit config.json). Presets, colours, the name and the sign-in message can all be changed there, and <code>custom.css</code> restyles anything.</p></details>
      </div>`)}`;
  }

  // ------------------------------------------------------------ Seller
  // Selling copies. Codes come from the activation server (this PC, for the owner).
  // Copies that had the app before copies were paid for can sell, and so can anyone who was
  // given a seller code. Everything a seller needs to know is on this one page.
  const SELL = { data: null, hub: null, busy: false, error: '', status: '', at: 0, showSold: false };
  const day = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  async function loadSell(force) {
    if (SELL.busy || (!force && SELL.at && Date.now() - SELL.at < 8000)) return;
    SELL.busy = true;
    try {
      const hub = ST.license && ST.license.kind === 'hub';
      const [d, h] = await Promise.all([beam.sellerCodes('info'), hub ? beam.hubOverview() : Promise.resolve(null)]);
      takeSell(d);
      SELL.hub = h;
    } catch (e) {
      SELL.error = 'Something went wrong. Try again.';
    } finally { SELL.busy = false; SELL.at = Date.now(); }
    if (page === 'seller' && !editing() && !searchQuery()) render();
  }
  function takeSell(d) {
    if (d && Array.isArray(d.codes)) SELL.data = d;
    SELL.error = d && !d.ok ? d.error || 'Something went wrong.' : '';
    SELL.status = (d && d.status) || '';
  }

  function sellersHtml(H) {
    const pending = H.pending.map(p => `<div>
        <span class="name"><span class="faint">Waiting</span></span>
        <span class="what">A copy set up ${p.since ? day(p.since) : 'at an unknown time'} asked to sell on ${day(p.at)}</span>
        <span class="acts"><button class="btn small primary" data-action="hub-pending" data-pc="${esc(p.pc)}" data-allow="1">Allow</button><button class="btn small ghost" data-action="hub-pending" data-pc="${esc(p.pc)}" data-allow="0">Dismiss</button></span></div>`).join('');
    const rows = H.sellers.map(s => `<div class="${s.blocked ? 'off' : ''}">
        <span class="name"><input class="input" data-hub-label="${esc(s.sid)}" value="${esc(s.label)}" placeholder="${esc(s.sid)}" maxlength="40" aria-label="Name for ${esc(s.sid)}"></span>
        <span class="what">${s.kind === 'founder' ? 'Had it before it was paid for' : 'Seller code'} · since ${day(s.at)}${s.blocked ? ' · <b class="bad">turned off</b>' : ''}</span>
        <span class="nums">${s.sold + s.paid} sold · ${s.free} free · ${Math.max(0, s.made - s.sold)} ready</span>
        <span class="acts"><button class="btn small ${s.blocked ? '' : 'danger'}" data-action="hub-seller" data-sid="${esc(s.sid)}" data-blocked="${s.blocked ? '0' : '1'}">${s.blocked ? 'Turn back on' : 'Turn off'}</button></span></div>`).join('');
    if (!pending && !rows) return '<div class="card empty">No sellers yet. Copies that had Beam Remote before it was paid for show up here once they update, and so does anyone you give a seller code.</div>';
    return `<div class="card rows sellers">${pending}${rows}</div>`;
  }

  function pageSeller() {
    const L = ST.license || {};
    const hub = L.kind === 'hub';
    const d = SELL.data;
    const price = esc((d && d.price) || (SELL.hub && SELL.hub.settings.price) || '$20');
    const codes = d ? d.codes : [];
    const ready = codes.filter(c => !c.used), sold = codes.filter(c => c.used);

    const hero = hub
      ? ['This PC is the activation server', 'Every code is made and checked here, and every copy asks this PC once, when it\'s activated. Keep this PC on with remote access running so buyers can activate.']
      : L.founder
        ? ['Yours is free for good, and you can sell it', 'You had Beam Remote before copies cost money, so nothing changes for you. You can also sell copies to other people: make a code, get paid, hand it over.']
        : ['You have a seller copy', 'You can sell Beam Remote to other people: make a code, get paid, hand it over.'];

    let notes = '';
    if (hub && STATUS.tunnel.state !== 'online') notes += note('warn', 'Remote access is off, so nobody can activate a copy or make codes right now. Turn it on in <a href="#" data-page-go="remote">Remote access</a>.');
    if (!hub && SELL.error) notes += note(SELL.status === 'offline' ? 'warn' : 'bad', esc(SELL.error));
    if (!hub && d && d.note) notes += note('info', `<b>Message for sellers</b><br>${esc(d.note).replace(/\n/g, '<br>')}`);

    const row = c => `<div class="${c.used ? 'sold' : ''}">
        <span class="code">${esc(c.code)}</span>
        <span class="state"><span class="dot ${c.used ? 'good' : ''}"></span>${c.used ? 'Sold' : 'Ready'}</span>
        <span class="when">${c.used ? `Activated ${day(c.used)}` : `Made ${day(c.at)}`}${c.kind === 'seller' ? ' · seller code' : ''}</span>
        <span class="acts">${c.used ? '' : `<button class="icon-btn" title="Copy" aria-label="Copy ${esc(c.code)}" data-action="sell-copy" data-code="${esc(c.code)}">${icon('copy')}</button><button class="icon-btn" title="Cancel this code" aria-label="Cancel ${esc(c.code)}" data-action="sell-cancel" data-code="${esc(c.code)}">${icon('trash')}</button>`}</span></div>`;
    const shownSold = SELL.showSold ? sold : sold.slice(0, 5);
    const list = codes.length
      ? `<div class="card rows codes">${ready.map(row).join('')}${shownSold.map(row).join('')}${sold.length > 5 ? `<div class="more"><button class="btn ghost small" data-action="sell-more">${SELL.showSold ? 'Show fewer' : `Show all ${sold.length} sold`}</button></div>` : ''}</div>`
      : `<div class="card empty">${d ? 'No codes yet. Make one when someone wants a copy.' : SELL.busy || !SELL.at ? 'Asking the activation server…' : 'Your codes show up here once the activation server answers.'}</div>`;

    // Access requests: people without a code who asked with their name.
    const reqs = (d && d.requests) || [];
    const handled = (d && d.handled) || [];
    const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : day(t); };
    const reqRow = r => `<div class="req">
        <div class="who"><b>${esc(r.name)}</b>${r.message ? `<q>${esc(r.message)}</q>` : ''}<span class="meta">${esc(r.pcName || 'Unknown PC')} · ${esc(r.os || 'Windows')} · ${ago(r.at)}</span></div>
        <div class="acts"><button class="btn small primary" data-action="req-unlock" data-id="${esc(r.id)}" data-reason="paid">Unlock as paid</button><button class="btn small" data-action="req-unlock" data-id="${esc(r.id)}" data-reason="free">Unlock for free</button><button class="btn small ghost" data-action="req-decline" data-id="${esc(r.id)}">Decline</button></div></div>`;
    const doneRow = r => `<div class="req done">
        <div class="who"><b>${esc(r.name)}</b><span class="meta">${r.status === 'unlocked' ? `Unlocked · <b class="${r.reason === 'free' ? 'muted' : 'good'}">${r.reason}</b>` : 'Declined'} · by ${hub ? esc(r.by) : 'you'} · ${day(r.doneAt)}</span></div></div>`;
    const reqHelp = 'People without a code can ask from their Activate screen with their name. Unlock as paid once they\'ve paid you, or for free if you\'re giving it away.';
    const requestsHtml = `<div id="requests">${section('Requests', reqs.length ? `${reqs.length} waiting. ${reqHelp}` : reqHelp,
      `${reqs.length ? `<div class="card rows reqs">${reqs.map(reqRow).join('')}</div>` : '<div class="card empty">Nobody is waiting right now.</div>'}
      ${handled.length ? `<div class="req-history">${SELL.showHandled ? `<div class="card rows reqs">${handled.map(doneRow).join('')}</div>` : ''}<button class="btn ghost small" data-action="req-history">${SELL.showHandled ? 'Hide past requests' : `Past requests (${handled.length})`}</button></div>` : ''}`)}</div>`;

    const H = SELL.hub;
    const hubHtml = hub && H ? `
      ${section('At a glance', '', `<div class="card"><div class="stats">
        <div class="stat"><span class="l">Copies sold</span><span class="v">${H.totals.sold}</span></div>
        <div class="stat"><span class="l">Given free</span><span class="v">${H.totals.free}</span></div>
        <div class="stat"><span class="l">Codes ready</span><span class="v">${H.totals.ready}</span></div>
        <div class="stat"><span class="l">Waiting for you</span><span class="v">${H.totals.waiting}</span></div></div></div>`)}
      ${section('Sellers', 'Everyone who can make codes. The names are only for you; sellers never see them.', sellersHtml(H))}
      ${section('Seller settings', '', `<div class="card">
        <div class="field"><div class="lab"><b>Price</b><p>Shown to every seller.</p></div><div class="ctl"><input class="input" data-hub="price" value="${esc(H.settings.price)}" maxlength="20"></div></div>
        <div class="field wide"><div class="lab"><b>Message for sellers</b><p>Shown at the top of every seller's tab. Leave it empty for none.</p></div><div class="ctl"><textarea class="plain" data-hub="note" rows="3" maxlength="600" placeholder="e.g. Keep $5 of every sale.">${esc(H.settings.note)}</textarea></div></div>
        <div class="field"><div class="lab"><b>Let earlier copies sell by themselves</b><p>Copies set up before paid copies existed become sellers as soon as they update. Turn this off to approve each one here instead.</p></div><div class="ctl"><input type="checkbox" class="switch" data-hub="autoFounders" ${H.settings.autoFounders ? 'checked' : ''}></div></div>
      </div>`)}
      ${section('Signing key', '', `<div class="card pad">${note('warn', '<b>license-hub-key.pem</b> in the settings folder is what makes codes work. Keep a copy somewhere safe (there is one in <code>ok\\beam-remote-private</code>) and never share it: anyone who has it could make codes.')}
        <div class="row" style="margin-top:12px"><button class="btn" data-action="open-path" data-which="folder">${icon('folder')}Open settings folder</button></div></div>`)}` : '';

    const link = esc(L.downloadUrl || '');
    return `<div class="page-head"><div><h1>Seller</h1><p>Sell Beam Remote for ${price}. Each code unlocks one PC, once.</p></div>
        <div class="row"><button class="btn" data-action="sell-make" data-count="5">Make 5</button><button class="btn primary" data-action="sell-make" data-count="1">${icon('plus')}Make a code</button></div></div>
      <div class="card sell-hero"><div class="ico">${icon('tag')}</div><div><b>${hero[0]}</b><p>${hero[1]}</p></div></div>
      ${notes ? `<div class="sell-notes">${notes}</div>` : ''}
      ${reqs.length ? requestsHtml : ''}
      ${section('Your codes', d ? `${ready.length} ready to sell · ${sold.length} sold${d.unlocked && (d.unlocked.paid || d.unlocked.free) ? ` · ${d.unlocked.paid} unlocked as paid, ${d.unlocked.free} free` : ''}` : '', list,
        `${hub ? '<button class="btn ghost small" data-action="sell-make" data-count="1" data-kind="seller">Make a seller code</button>' : ''}<button class="btn ghost small" data-action="sell-refresh">Refresh</button>`)}
      ${reqs.length ? '' : requestsHtml}
      ${hubHtml}
      ${section('How selling works', '', `<div class="card pad"><ol class="steps">
          <li><b>Make a code</b><p>One per buyer, right here. Codes never expire, and each one works once, on one PC.</p></li>
          <li><b>Get paid first</b><p>${price}, before you hand over the code.</p></li>
          <li><b>Give them the link and the code</b><p>The download link is below, and the code is in your list.</p></li>
          <li><b>They install it and type the code</b><p>On their Windows PC, the first screen asks for it. Once it's used, it shows as Sold here.</p></li>
        </ol></div>`)}
      ${section('Download link', 'Give this to buyers, or let them scan the QR code.', `<div class="card"><div class="statusline"><span class="msg mono sell-link">${link}</span><button class="btn small" data-action="copy" data-url="${link}">${icon('copy')}Copy</button><button class="btn small" data-action="qr" data-url="${link}">${icon('qr')}QR code</button></div></div>
        <p class="sell-fine">Buyers download the installer there, run it on their Windows PC and type their code on the first screen. Windows may warn about an unrecognised app the first time: More info, then Run anyway.</p>`)}
      ${section('Questions', '', `<div class="card faq">
          <details><summary>A code doesn't work</summary><p>Codes never use 0, O, 1 or I, so check for those first. Still stuck? Cancel it here and make a new one.</p></details>
          <details><summary>It says the code was already used</summary><p>Each code works on one PC only. If it was typed on the wrong PC, there's no undo: they need a new code.</p></details>
          <details><summary>They reinstalled the app or Windows</summary><p>Reinstalling the app on the same PC: the same code works again. A new PC, or a fresh Windows install, counts as a new PC and needs a new code.</p></details>
          <details><summary>What do buyers get?</summary><p>The whole app: their PC's screen in any browser, with sound, mouse, keyboard and controllers, at home or away, plus every update.</p></details>
          <details><summary>Can buyers sell it too?</summary><p>No. Normal copies can't make codes; only seller copies can.</p></details>
          <details><summary>Someone wants it for free</summary><p>It doesn't run without a code, and every code is a sale. Saying no once is easier than explaining exceptions later.</p></details>
          <details><summary>The activation server can't be reached</summary><p>Nothing is lost. Codes you already made still work once it's back; try again a bit later.</p></details>
        </div>`)}`;
  }

  function showNewCodes(made, kind) {
    const many = made.length > 1;
    modal(`<h2>${many ? `${made.length} new codes` : kind === 'seller' ? 'New seller code' : 'New code'}</h2>
      <p>${kind === 'seller' ? 'Whoever types this code gets a seller copy and can sell too.' : 'Give it to the buyer once they\'ve paid. It works once, on one PC, and never expires.'}</p>
      <div class="bigcodes ${many ? 'many' : ''}">${made.map(c => `<div class="bigcode">${esc(c)}</div>`).join('')}</div>
      <div class="foot"><button class="btn" data-copy-codes="1">${icon('copy')}${many ? 'Copy all' : 'Copy'}</button><button class="btn primary" data-close="1">Done</button></div>`,
    e => { if (e.target.closest('[data-copy-codes]')) { beam.copy(made.join('\n')); toast(many ? 'Codes copied' : 'Code copied', 'ok'); } });
    $('#modal .modal-card').classList.add('seller');
  }

  // Activation: a new copy asks for its code before anything else (closable from App & updates).
  // No code? The person asks for access with their name instead and waits here; whoever
  // unlocks it (the owner or a seller) marks it paid or free.
  const ACT = { open: false, mode: 'code', closable: false, poll: null };
  const fmtCode = v => { const s = String(v).toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8); return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s; };
  const clock = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function openActivate(closable = false) {
    ACT.closable = closable;
    const q = ST.license.request;
    drawActivate(q && q.status === 'pending' ? 'wait' : q && (q.status === 'declined' || q.status === 'gone') ? 'declined' : 'code');
  }

  function drawActivate(mode) {
    const L = ST.license, q = L.request || {};
    ACT.open = true;
    ACT.mode = mode;
    clearInterval(ACT.poll);
    ACT.poll = null;
    const cancel = ACT.closable ? '<button class="btn" data-close="1">Cancel</button>' : '';
    let html;
    if (mode === 'ask') {
      html = `<div class="act-icon">${icon('users')}</div><h2>Ask for access</h2>
        <p>Your request goes to the people who sell Beam Remote. One of them can unlock this copy for you.</p>
        <label class="act-label" for="req-name">Your name</label>
        <input class="input" id="req-name" maxlength="40" placeholder="First name or nickname" autocomplete="off">
        <label class="act-label" for="req-msg">Message <span class="faint">(optional)</span></label>
        <input class="input" id="req-msg" maxlength="200" placeholder="Who sent you, or anything they should know" autocomplete="off">
        <p class="act-sent">Sent with your request: this PC's name (<b>${esc(L.pcName)}</b>) and ${esc(L.osName)}. Nothing else.</p>
        <p class="act-msg" id="act-msg" role="alert"></p>
        <div class="foot"><button class="btn" data-act-mode="code">Back</button><button class="btn primary" data-req-send="1">Send request</button></div>`;
    } else if (mode === 'wait') {
      html = `<div class="act-icon"><span class="spin"></span></div><h2>Request sent</h2>
        <p>Waiting for someone to unlock this copy. This updates by itself, and the app keeps checking from the tray if you close this window.</p>
        <div class="act-req"><div><span>Name</span><b>${esc(q.name)}</b></div><div><span>Sent</span><b>${q.at ? `${day(q.at)}, ${clock(q.at)}` : ''}</b></div></div>
        <div class="foot"><button class="btn ghost" data-req-cancel="1">Cancel request</button><span class="grow"></span><button class="btn" data-act-mode="code">I have a code</button></div>`;
    } else if (mode === 'declined') {
      html = `<div class="act-icon">${icon('alert')}</div><h2>Request not accepted</h2>
        <p>Nobody unlocked this copy. You can send a new request, or type a code if you have one.</p>
        <div class="foot">${cancel}<button class="btn" data-act-mode="code">I have a code</button><button class="btn primary" data-act-mode="ask">Send a new request</button></div>`;
    } else {
      const waiting = q.status === 'pending';
      html = `<div class="act-icon">${icon('key')}</div><h2>Activate Beam Remote</h2>
        <p>Type the activation code that came with your copy. Each code works on one PC.</p>
        <input class="input code-input" id="act-code" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" spellcheck="false" aria-label="Activation code">
        <p class="act-msg" id="act-msg" role="alert"></p>
        <div class="foot"><button class="btn ghost" data-act-mode="${waiting ? 'wait' : 'ask'}">${waiting ? 'Back to my request' : 'No code? Ask for access'}</button><span class="grow"></span>${cancel}<button class="btn primary" data-act-go="1">Activate</button></div>`;
    }
    modal(html, onActivateClick);
    $('#modal').dataset.locked = ACT.closable ? '' : '1';
    setTimeout(() => { const i = $('#act-code') || $('#req-name'); if (i) i.focus(); }, 50);
    if (mode === 'wait') { beam.licenseCheckRequest(); ACT.poll = setInterval(() => beam.licenseCheckRequest(), 15000); }
  }

  async function onActivateClick(e) {
    const t = e.target;
    const m = t.closest('[data-act-mode]');
    if (m) { drawActivate(m.dataset.actMode); return; }
    if (t.closest('[data-act-go]')) { activateWithCode(); return; }
    if (t.closest('[data-req-send]')) { sendRequest(); return; }
    if (t.closest('[data-req-cancel]')) {
      await beam.licenseCancelRequest();
      ST = { ...ST, ...(await beam.getState()) };
      drawActivate('code');
      toast('Request cancelled');
    }
  }

  async function activateWithCode() {
    const input = $('#act-code'), btn = $('[data-act-go]'), msg = $('#act-msg');
    if (!input || !btn || btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Activating…'; msg.textContent = '';
    const r = await beam.licenseActivate(input.value);
    if (!r.ok) {
      btn.disabled = false; btn.textContent = 'Activate'; msg.textContent = r.error || 'That code didn\'t work.';
      input.focus(); input.select();
      return;
    }
    ST = { ...ST, ...(await beam.getState()) };
    activatedNow(r.kind === 'seller' ? 'Activated. This is a seller copy: open the Seller tab to start.' : 'Activated. Enjoy!');
  }

  async function sendRequest() {
    const name = $('#req-name').value.trim(), message = $('#req-msg').value.trim();
    const btn = $('[data-req-send]'), msg = $('#act-msg');
    if (!name) { msg.textContent = 'Type your name first.'; $('#req-name').focus(); return; }
    btn.disabled = true; btn.textContent = 'Sending…'; msg.textContent = '';
    const r = await beam.licenseRequest({ name, message });
    if (!r.ok) { btn.disabled = false; btn.textContent = 'Send request'; msg.textContent = r.error || 'The request wasn\'t sent. Try again.'; return; }
    ST = { ...ST, ...(await beam.getState()) };
    drawActivate('wait');
  }

  // Activated by a code or unlocked by someone: on to the password.
  function activatedNow(text) {
    if (!ACT.open) return;
    ACT.open = false;
    clearInterval(ACT.poll);
    $('#modal').dataset.locked = '';
    closeModal();
    toast(text, 'ok');
    renderNav();
    render();
    if (!ST.auth.passwordSet) openWizard();
  }

  $('#modal').addEventListener('input', e => {
    if (e.target.id === 'act-code') e.target.value = fmtCode(e.target.value);
    if (/^(act-code|req-name|req-msg)$/.test(e.target.id) && $('#act-msg')) $('#act-msg').textContent = '';
  });
  $('#modal').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'act-code') activateWithCode();
    else if (e.target.id === 'req-name' || e.target.id === 'req-msg') sendRequest();
  });

  function activationHtml() {
    const L = ST.license || {};
    const free = 'You had Beam Remote before copies cost money, so it stays free. You can sell copies in the Seller tab.';
    const map = {
      hub: ['good', 'Activation server', 'This PC makes and checks every code.'],
      founder: ['good', 'Free for good', free],
      seller: ['good', L.founder ? 'Free for good' : 'Seller copy', L.founder ? free : 'You can sell copies in the Seller tab.'],
      user: ['good', 'Activated', 'Got a seller code? Enter it to sell copies too.'],
      none: ['bad', 'Not activated', 'Enter the code that came with your copy.'],
    };
    const [dot, label, msg] = map[L.kind] || map.none;
    return `<div class="card"><div class="statusline"><span class="dot ${dot}"></span><span class="label">${label}</span><span class="msg">${msg}</span>
      ${L.kind === 'user' || L.kind === 'none' ? '<button class="btn small" data-action="activate">Enter a code</button>' : ''}${L.canSell ? '<button class="btn small" data-page-go="seller">Seller tab</button>' : ''}</div></div>`;
  }

  const PAGE_FNS = () => ({ home: pageHome, seller: pageSeller, remote: pageRemote, quality: pageQuality, security: pageSecurity, controllers: pageControllers, browser: pageBrowser, appearance: pageAppearance, app: pageApp, guide: pageGuide });

  // ------------------------------------------------------------ search
  // Finds any setting, section, button or help topic on every page. Matches open their page
  // and point at the spot. Ctrl+K (or Ctrl+F, or /) jumps to the box.
  const SYNONYMS = {
    gamepad: ['controller'], joystick: ['controller'], xbox: ['controller'], playstation: ['controller'], ps5: ['controller'], rumble: ['vibration'], vibrate: ['vibration'],
    dark: ['theme'], light: ['theme'], colour: ['color', 'accent'], color: ['accent', 'colour'], logo: ['icon', 'app name'],
    '2fa': ['two-step'], mfa: ['two-step'], otp: ['two-step', 'authenticator'], login: ['sign-in', 'sign in', 'password'], logout: ['sign out'],
    lag: ['latency'], delay: ['latency'], laggy: ['latency', 'quality'], ping: ['latency', 'ping'],
    audio: ['sound'], volume: ['sound'], mute: ['sound'], speaker: ['sound'],
    embed: ['embedding', 'iframe'], iframe: ['embedding'], website: ['embedding', 'domain'],
    hevc: ['codec'], h265: ['codec'], h264: ['codec'], av1: ['codec'], vp9: ['codec'],
    fps: ['frame rate', 'fps'], framerate: ['frame rate'], resolution: ['resolution', 'quality'], bitrate: ['bitrate', 'quality'], blurry: ['quality', 'sharpness', 'bitrate'],
    blackscreen: ['privacy'], black: ['privacy', 'black'], cover: ['privacy'], monitor: ['monitor', 'privacy', 'screen'],
    startup: ['start when', 'windows'], boot: ['start when'], autostart: ['start when', 'start remote access'],
    admin: ['administrator'], uac: ['administrator'],
    update: ['update', 'version'], upgrade: ['update'], version: ['update', 'version'],
    tunnel: ['remote access', 'tunnel'], cloudflare: ['remote access', 'domain', 'quick link'], ngrok: ['tunnel tool', 'other tool'], vpn: ['tailscale'],
    brightness: ['brightness', 'picture adjustments'], contrast: ['contrast', 'picture adjustments'], filter: ['picture adjustments'], filters: ['picture adjustments'], saturation: ['saturation', 'picture adjustments'], sharpen: ['sharpness'],
    cursor: ['cursor', 'mouse'], keys: ['keyboard', 'key'], copy: ['clipboard'], paste: ['clipboard'],
    notification: ['notify'], notifications: ['notify'], log: ['log'], friends: ['domain', 'installer'],
    sell: ['seller', 'code'], selling: ['seller', 'code'], code: ['code', 'activation'], codes: ['code'], license: ['activation', 'code'], activate: ['activation', 'code'],
    money: ['price', 'paid'], price: ['price'], pay: ['paid', 'price'], buyer: ['buyer', 'seller'], request: ['request', 'access'], unlock: ['unlock', 'request'],
  };
  let searchIndex = null, searchAt = 0, searchSel = 0, searchHits = [];
  const searchQuery = () => (($('#search') && $('#search').value) || '').trim();

  function buildSearchIndex() {
    const items = [];
    const doc = html => new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    for (const [id, name] of visiblePages()) {
      let d;
      try { d = doc(PAGE_FNS()[id]()); } catch { continue; }
      items.push({ page: id, kind: 'Page', title: name, text: text(d.querySelector('.page-head p')), section: '', target: null });
      d.querySelectorAll('[data-method]').forEach(m => items.push({ page: id, kind: 'Option', title: text(m.querySelector('b')), text: text(m.querySelector('span:not(.radio)')), section: 'How to connect', target: { method: m.dataset.method } }));
      d.querySelectorAll('.section').forEach(sec => {
        const h = text(sec.querySelector('.section-head h2'));
        if (h) items.push({ page: id, kind: 'Section', title: h, text: text(sec.querySelector('.section-head p')), section: '', target: { section: h } });
        sec.querySelectorAll('.field').forEach(fld => {
          const label = text(fld.querySelector('.lab b'));
          if (!label) return;
          const keyEl = fld.querySelector('[data-key]');
          items.push({ page: id, kind: 'Setting', title: label, text: text(fld.querySelector('.lab p')), section: h, target: keyEl ? { key: keyEl.dataset.key } : { label } });
        });
        sec.querySelectorAll('button[data-action]').forEach(btn => {
          const t = text(btn);
          if (t.length > 2 && !items.some(x => x.page === id && x.kind === 'Action' && x.title === t)) items.push({ page: id, kind: 'Action', title: t, text: '', section: h, target: { action: btn.dataset.action, label: t } });
        });
        sec.querySelectorAll('details summary').forEach(sm => items.push({ page: id, kind: 'Help', title: text(sm), text: text(sm.parentElement.querySelector('p')), section: h, target: { summary: text(sm) } }));
        sec.querySelectorAll('ol.steps > li').forEach(li => items.push({ page: id, kind: 'Help', title: text(li.querySelector('b')), text: text(li.querySelector('p')), section: h, target: { section: h } }));
      });
    }
    searchIndex = items;
    searchAt = Date.now();
  }

  function runSearch(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    if (!searchIndex || Date.now() - searchAt > 4000) buildSearchIndex();
    const kindBonus = { Setting: 0.6, Action: 0.5, Option: 0.5, Section: 0.4, Page: 0.3, Help: 0 };
    const hits = [];
    for (const it of searchIndex) {
      const title = it.title.toLowerCase();
      const rest = `${it.text} ${it.section} ${pageName(it.page)}`.toLowerCase();
      let score = 0;
      let ok = true;
      for (const w of words) {
        const alts = [w, ...(SYNONYMS[w] || [])];
        if (title.startsWith(w)) score += 6;
        else if (alts.some(a => title.includes(a))) score += 4;
        else if (alts.some(a => rest.includes(a))) score += 1;
        else { ok = false; break; }
      }
      if (ok) hits.push([score + (kindBonus[it.kind] || 0), it]);
    }
    return hits.sort((a, b) => b[0] - a[0]).slice(0, 40).map(x => x[1]);
  }

  function markWords(str, q) {
    let out = esc(str);
    for (const w of q.toLowerCase().split(/\s+/).filter(x => x.length > 1)) {
      out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\  // ------------------------------------------------------------ actions')})`, 'ig'), '<mark>$1</mark>');
    }
    return out;
  }

  function renderSearch() {
    const q = searchQuery();
    searchHits = runSearch(q);
    searchSel = Math.min(searchSel, Math.max(0, searchHits.length - 1));
    const rows = searchHits.map((it, i) => `<button class="res ${i === searchSel ? 'sel' : ''}" data-res="${i}">
        <span class="txt"><b>${markWords(it.title, q)}</b>${it.text ? `<span class="snip">${markWords(it.text.length > 150 ? `${it.text.slice(0, 150)}…` : it.text, q)}</span>` : ''}</span>
        <span class="where">${esc(pageName(it.page))}${it.section ? ` › ${esc(it.section)}` : ''}<small>${it.kind}</small></span></button>`).join('');
    $('#main').innerHTML = `<div class="page"><div class="page-head"><div><h1>Search</h1><p>${searchHits.length ? `${searchHits.length} match${searchHits.length > 1 ? 'es' : ''}` : 'No matches'} for “${esc(q)}”. Enter opens the highlighted one.</p></div></div>
      ${searchHits.length ? `<div class="card results">${rows}</div>` : '<div class="card empty">Nothing matches. Try another word, like “controller”, “password”, “quality” or “update”.</div>'}</div>`;
  }

  function clearSearch() {
    const box = $('#search');
    if (box && box.value) { box.value = ''; searchSel = 0; }
  }

  function openResult(it) {
    clearSearch();
    page = it.page;
    renderNav();
    render();
    $('#main').scrollTop = 0;
    requestAnimationFrame(() => pointAt(it.target));
  }

  // Scrolls to a setting / button / section on the current page and makes it light up briefly.
  function pointAt(t) {
    if (!t) return;
    const all = sel => [...document.querySelectorAll(sel)];
    let el = null;
    if (t.key) el = document.querySelector(`[data-key="${CSS.escape(t.key)}"]`);
    if (!el && t.action) el = all(`[data-action="${CSS.escape(t.action)}"]`).find(b => !t.label || b.textContent.trim() === t.label) || document.querySelector(`[data-action="${CSS.escape(t.action)}"]`);
    if (!el && t.method) el = document.querySelector(`[data-method="${CSS.escape(t.method)}"]`);
    if (!el && t.summary) { const sm = all('details summary').find(x => x.textContent.trim() === t.summary); if (sm) { sm.parentElement.open = true; el = sm.parentElement; } }
    if (!el && t.section) el = all('.section-head h2').find(h => h.textContent.trim() === t.section);
    if (!el && t.id) el = document.getElementById(t.id);
    if (!el && t.label) el = all('.field .lab b').find(b => b.textContent.trim() === t.label);
    if (!el) return;
    const box = el.closest('.field, .statusline, details, .choice') || el.closest('.section') || el;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
    if (el.matches && el.matches('input, select, textarea')) setTimeout(() => el.focus({ preventScroll: true }), 350);
  }

  const searchBox = $('#search');
  searchBox.addEventListener('input', () => { searchSel = 0; renderNav(); render(); $('#main').scrollTop = 0; });
  searchBox.addEventListener('focus', () => { searchIndex = null; });
  searchBox.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!searchHits.length) return;
      searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
      renderSearch();
      const r = document.querySelector('.res.sel');
      if (r) r.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchHits[searchSel]) openResult(searchHits[searchSel]);
    } else if (e.key === 'Escape') {
      clearSearch(); renderNav(); render(); searchBox.blur();
    }
  });
  $('#main').addEventListener('click', e => {
    const r = e.target.closest('[data-res]');
    if (r && searchHits[+r.dataset.res]) openResult(searchHits[+r.dataset.res]);
  });
  addEventListener('keydown', e => {
    const typing = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if ((e.ctrlKey && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) || (e.key === '/' && !typing)) {
      e.preventDefault();
      searchBox.focus();
      searchBox.select();
    }
  });

  // A Windows notification (e.g. "update available") was clicked: show that spot.
  beam.onGoto(g => {
    clearSearch();
    if (g && g.page) page = g.page;
    renderNav();
    render();
    requestAnimationFrame(() => pointAt({ id: g && g.target }));
  });

  // ------------------------------------------------------------ actions
  $('#main').addEventListener('click', async e => {
    const go = e.target.closest('[data-page-go]');
    if (go) { e.preventDefault(); page = go.dataset.pageGo; renderNav(); render(); $('#main').scrollTop = 0; return; }
    const m = e.target.closest('[data-method]');
    if (m) {
      const id = m.dataset.method;
      const map = { cloudflare: 'cloudflare', custom: 'custom', domain: 'cloudflare-domain' };
      if (map[id]) { if (ST.config.network.tunnel !== map[id]) beam.tunnelStop(); await save({ 'network.tunnel': map[id] }, true); }
      else { remoteGuide = id; localStorage.setItem('remoteGuide', id); if (ST.config.network.tunnel !== 'none') { beam.tunnelStop(); await save({ 'network.tunnel': 'none' }, true); } }
      render();
      return;
    }
    const pr = e.target.closest('[data-preset]');
    if (pr) {
      const p = ST.config.presets[+pr.dataset.preset];
      await save({ 'stream.resolution': p.resolution, 'stream.fps': p.fps, 'stream.bitrateKbps': p.bitrateKbps });
      render();
      return;
    }
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const act = b.dataset.action;
    const url = b.dataset.url;
    if (b.tagName === 'A') e.preventDefault();
    switch (act) {
      case 'copy': await beam.copy(url); toast('Link copied', 'ok'); break;
      case 'copy-code': await beam.copy(url); toast('Code copied', 'ok'); break;
      case 'embed-test': beam.embedTest(url); break;
      case 'update-check': await beam.updateCheck(); break;
      case 'update-download': beam.updateDownload(); break;
      case 'update-install':
        if (!STATUS.clients.length || confirm('Restart now to install the update? Connected devices drop for a moment and reconnect by themselves.')) beam.updateInstall();
        break;
      case 'firewall-check': await beam.firewallCheck(); break;
      case 'pad-install': {
        b.disabled = true;
        b.textContent = 'Installing…';
        const r = await beam.padDriverInstall();
        if (r && r.ok) toast('Controller driver installed. Controllers work now.', 'ok');
        else toast((r && r.error) || 'The controller driver was not installed.', 'error');
        break;
      }
      case 'pad-recheck': await beam.padRecheck(); break;
      case 'cover-picture': {
        const r = await beam.coverPicture();
        if (r && r.error) toast(r.error, 'error');
        else if (r && r.name) { ST.config.privacy.picture = r.name; render(); toast('Picture saved', 'ok'); }
        break;
      }
      case 'cover-picture-clear': await beam.coverClearPicture(); ST.config.privacy.picture = ''; render(); break;
      case 'cover-test': {
        const mode = ($('[data-key="privacy.screen"]') || {}).value || ST.config.privacy.screen;
        if (mode === 'normal') toast('Choose something other than Normal first.');
        else beam.coverTest(mode);
        break;
      }
      case 'firewall-fix': {
        toast('Approve the Windows prompt to allow the app.');
        const fw = await beam.firewallFix();
        if (fw && fw.state === 'ok') toast('Devices on your network can connect now.', 'ok');
        else toast('The firewall rule wasn\'t added.', 'error');
        break;
      }
      case 'sell-make': {
        const kind = b.dataset.kind === 'seller' ? 'seller' : 'user';
        b.disabled = true;
        const r = await beam.sellerCodes('make', { count: Number(b.dataset.count) || 1, kind });
        b.disabled = false;
        if (r && Array.isArray(r.codes)) SELL.data = r;
        if (r && r.ok && r.made) {
          SELL.error = '';
          showNewCodes(r.made, kind);
          if (ST.license.kind === 'hub') SELL.hub = await beam.hubOverview();
        } else toast((r && r.error) || 'No code was made. Try again.', 'error');
        render();
        break;
      }
      case 'sell-copy': await beam.copy(b.dataset.code); toast('Code copied', 'ok'); break;
      case 'sell-cancel': {
        if (!confirm(`Cancel ${b.dataset.code}? It stops working for good.`)) break;
        const r = await beam.sellerCodes('cancel', { code: b.dataset.code });
        if (r && Array.isArray(r.codes)) SELL.data = r;
        if (!r || !r.ok) toast((r && r.error) || 'The code wasn\'t cancelled.', 'error');
        else toast('Code cancelled', 'ok');
        if (ST.license.kind === 'hub') SELL.hub = await beam.hubOverview();
        render();
        break;
      }
      case 'sell-refresh': await loadSell(true); if (!SELL.error) toast('Up to date', 'ok'); break;
      case 'sell-more': SELL.showSold = !SELL.showSold; render(); break;
      case 'req-unlock': case 'req-decline': {
        b.disabled = true;
        const unlock = act === 'req-unlock';
        const r = await beam.sellerCodes(unlock ? 'unlock' : 'decline', { id: b.dataset.id, reason: b.dataset.reason });
        if (r && Array.isArray(r.codes)) SELL.data = r;
        if (r && r.ok) toast(unlock ? `Unlocked as ${b.dataset.reason}. Their copy activates within a minute.` : 'Request declined', 'ok');
        else toast((r && r.error) || 'That didn\'t work. Try again.', 'error');
        if (ST.license.kind === 'hub') SELL.hub = await beam.hubOverview();
        render();
        break;
      }
      case 'req-history': SELL.showHandled = !SELL.showHandled; render(); break;
      case 'hub-seller': await beam.hubSeller(b.dataset.sid, { blocked: b.dataset.blocked === '1' }); SELL.hub = await beam.hubOverview(); render(); break;
      case 'hub-pending': await beam.hubPending(b.dataset.pc, b.dataset.allow === '1'); SELL.hub = await beam.hubOverview(); render(); break;
      case 'activate': openActivate(true); break;
      case 'open': beam.openExternal(url); break;
      case 'open-local': beam.testInBrowser(); break;
      case 'qr': showQr(url); break;
      case 'wizard': openWizard(); break;
      case 'kick': beam.kick(b.dataset.id); break;
      case 'kick-all': for (const c of STATUS.clients) beam.kick(c.id); break;
      case 'tunnel-start': beam.tunnelStart(); break;
      case 'domain-setup': case 'domain-overwrite': case 'domain-relogin': {
        const host = ($('#domain-host') || {}).value || (ST.domain && ST.domain.hostname) || '';
        domainStep = { step: 'tool', message: 'Starting…' };
        const box = $('#domain-box'); if (box) box.innerHTML = domainStepHtml();
        const r = await beam.domainSetup({ hostname: host, overwrite: act === 'domain-overwrite', forceLogin: act === 'domain-relogin' });
        if (!r.ok && r.error && (!domainStep || domainStep.step !== 'error')) { domainStep = { step: 'error', message: r.error }; const bx = $('#domain-box'); if (bx) bx.innerHTML = domainStepHtml(); }
        break;
      }
      case 'domain-cancel': domainStep = null; { const bx = $('#domain-box'); if (bx) bx.innerHTML = ''; } break;
      case 'domain-token': {
        const r = await beam.domainToken({ token: ($('#domain-token') || {}).value, hostname: ($('#domain-host') || {}).value });
        if (r.ok) toast('Token saved. Starting your tunnel…', 'ok'); else toast(r.error, 'error');
        break;
      }
      case 'domain-forget':
        if (confirm('Disconnect this domain from the app? The tunnel and DNS record stay in your Cloudflare account, so you can delete them there or reconnect later.')) { await beam.domainForget(); domainStep = null; toast('Domain disconnected'); }
        break;
      case 'tunnel-stop': beam.tunnelStop(); break;
      case 'tunnel-log': showLog('Tunnel log', await beam.tunnelLog()); break;
      case 'cap-log': showLog('Streamer log', await beam.capLog()); break;
      case 'save-json': {
        const key = b.dataset.for;
        const ta = document.querySelector(`textarea[data-key="${key}"]`);
        let v;
        try { v = JSON.parse(ta.value); } catch (err) { toast(`That isn't valid JSON: ${err.message}`, 'error'); return; }
        await save({ [key]: v });
        break;
      }
      case 'set-password': {
        const a = $('#pw-new').value, c = $('#pw-confirm').value;
        if (a !== c) { toast('The two passwords are different.', 'error'); return; }
        const r = await beam.setPassword(a);
        if (r.ok) { toast('Password saved', 'ok'); $('#pw-new').value = ''; $('#pw-confirm').value = ''; } else toast(r.error, 'error');
        break;
      }
      case 'totp-on': totpWizard(); break;
      case 'totp-off': if (confirm('Turn off two-step sign-in?')) { await beam.totpDisable(); toast('Two-step sign-in is off'); } break;
      case 'signout-all': if (confirm('Sign out every device? They will need the password again.')) { await beam.signOutAll(); toast('All devices signed out', 'ok'); } break;
      case 'open-path': beam.openPath(b.dataset.which); break;
      case 'export': if (await beam.exportConfig()) toast('Settings exported', 'ok'); break;
      case 'import': {
        const r = await beam.importConfig();
        if (r.ok) toast(r.problems && r.problems.length ? `Imported with ${r.problems.length} value(s) reset to default.` : 'Settings imported', 'ok');
        else if (r.error) toast(r.error, 'error');
        break;
      }
      case 'reset-all': if (confirm('Reset every setting to the default? Your password stays.')) { await beam.resetConfig(); toast('Settings reset', 'ok'); } break;
      case 'restart-admin': beam.restartAdmin(); break;
      case 'appearance-reset': {
        const d = ST.defaults.appearance;
        await save(Object.fromEntries(Object.entries(d).map(([k, v]) => [`appearance.${k}`, v])));
        render();
        break;
      }
      case 'preset-add': {
        const rows = readPresetRows();
        rows.push({ name: 'My preset', resolution: '1080p', fps: 60, bitrateKbps: 15000 });
        $('#preset-rows').innerHTML = rows.map(presetRow).join('');
        break;
      }
      case 'preset-del': b.closest('tr').remove(); break;
      case 'preset-save': {
        const rows = readPresetRows();
        if (!rows.length) { toast('Keep at least one preset.', 'error'); return; }
        await save({ presets: rows });
        render();
        break;
      }
      case 'preset-reset': await save({ presets: ST.defaults.presets }); render(); break;
      default: break;
    }
  });

  // ------------------------------------------------------------ modals
  function modal(html, onClick) {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-card">${html}</div>`;
    m.hidden = false;
    m.onclick = e => {
      if ((e.target === m && !m.dataset.locked) || e.target.closest('[data-close]')) { closeModal(); return; }
      if (onClick) onClick(e);
    };
  }
  function closeModal() {
    ACT.open = false;
    clearInterval(ACT.poll);
    const m = $('#modal');
    m.hidden = true; m.innerHTML = ''; m.onclick = null; m.dataset.locked = '';
    renderNav();
    if (!editing()) render();
  }
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden && !$('#modal').dataset.locked) closeModal(); });

  async function showQr(url) {
    const img = await beam.qr(url);
    modal(`<h2>Open on your phone</h2><p>Point your phone's camera at the code, then tap the link it finds.</p>
      <img class="qr" src="${img}" alt="QR code"><p class="mono faint" style="text-align:center;word-break:break-all;margin:0">${esc(url)}</p>
      <div class="foot"><button class="btn" data-copy="1">${icon('copy')}Copy link</button><button class="btn primary" data-close="1">Done</button></div>`,
    e => { if (e.target.closest('[data-copy]')) { beam.copy(url); toast('Link copied', 'ok'); } });
  }

  function showLog(title, lines) {
    modal(`<h2>${esc(title)}</h2><p>The most recent lines.</p><pre class="term">${esc((lines || []).join('\n') || 'Nothing yet.')}</pre><div class="foot"><button class="btn primary" data-close="1">Close</button></div>`);
  }

  async function totpWizard() {
    const t = await beam.totpStart();
    modal(`<h2>Turn on two-step sign-in</h2>
      <p>Scan this code with your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</p>
      <img class="qr" src="${t.qr}" alt="QR code">
      <p style="text-align:center;margin:0 0 18px" class="muted">Can't scan? Enter this key: <code style="user-select:all">${esc(t.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
      <label class="muted" style="display:block;margin-bottom:6px">Then type the 6-digit code it shows</label>
      <input class="input mono" id="totp-code" inputmode="numeric" maxlength="6" placeholder="000000" style="font-size:18px;letter-spacing:.35em;text-align:center;height:40px">
      <div class="foot"><button class="btn" data-close="1">Cancel</button><button class="btn primary" data-totp-ok="1">Turn on</button></div>`,
    async e => {
      if (!e.target.closest('[data-totp-ok]')) return;
      const ok = await beam.totpConfirm($('#totp-code').value.trim());
      if (ok) { closeModal(); toast('Two-step sign-in is on', 'ok'); } else toast('That code didn\'t match. Check the time on your phone and try the newest code.', 'error');
    });
    setTimeout(() => { const i = $('#totp-code'); if (i) i.focus(); }, 50);
  }

  // First-run wizard: password, quality, remote access, done.
  async function openWizard() {
    const w = { step: 0, preset: 1, remote: 'cloudflare', auto: true };
    const steps = 4;
    const opt = (attr, id, active, title, desc) => `<button class="option ${active ? 'active' : ''}" ${attr}="${id}"><span class="radio"></span><div><b>${title}</b><span>${desc}</span></div></button>`;
    const draw = async () => {
      const head = `<div class="wizard-progress">${Array.from({ length: steps }, (_, i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div><div class="wizard-step">Step ${w.step + 1} of ${steps}</div>`;
      let html = '';
      if (w.step === 0) {
        html = `${head}<h2>Set up ${esc(ST.config.appearance.appName)}</h2>
          <p>Stream this PC to any web browser, at home or away, and control it with a mouse, keyboard or touch screen. First, choose a password. Only people who know it can connect.</p>
          ${ST.auth.passwordSet ? `<div style="margin:-4px 0 14px">${note('info', 'A password is already set. Leave these empty to keep it.')}</div>` : ''}
          <input class="input" type="password" id="wz-pw" placeholder="Password, at least 8 characters" autocomplete="new-password">
          <input class="input" type="password" id="wz-pw2" placeholder="Type it again" autocomplete="new-password">
          <div class="strength" id="wz-strength"><i></i></div>
          <div class="foot">${ST.auth.passwordSet ? '<button class="btn" data-close="1">Close</button>' : ''}<button class="btn primary" data-next="1">Continue</button></div>`;
      } else if (w.step === 1) {
        html = `${head}<h2>Starting quality</h2><p>You can change it any time, including from the browser while streaming.</p>
          ${ST.config.presets.map((p, i) => opt('data-pick', i, w.preset === i, esc(p.name), `${p.resolution === 'native' ? 'Native resolution' : p.resolution} · ${p.fps} fps · up to ${mbps(p.bitrateKbps)} Mbps`)).join('')}
          <div class="foot"><button class="btn" data-back="1">Back</button><button class="btn primary" data-next="1">Continue</button></div>`;
      } else if (w.step === 2) {
        html = `${head}<h2>Connect from outside your home?</h2><p>Devices on your home network can already reach this PC.</p>
          ${opt('data-remote', 'cloudflare', w.remote === 'cloudflare', 'Yes, with a quick link', 'A free Cloudflare tunnel. No router changes or account needed.')}
          ${opt('data-remote', 'tailscale', w.remote === 'tailscale', 'Yes, with Tailscale', 'A private network for your own devices. Steps are on the Remote access page.')}
          ${opt('data-remote', 'none', w.remote === 'none', 'Not now', 'Only at home for now. You can turn it on later.')}
          ${w.remote === 'cloudflare' ? `<label class="option" style="cursor:pointer"><input type="checkbox" id="wz-auto" ${w.auto ? 'checked' : ''}><div><b>Start it whenever the app opens</b><span>Keeps the PC reachable.</span></div></label>` : ''}
          <div class="foot"><button class="btn" data-back="1">Back</button><button class="btn primary" data-next="1">Continue</button></div>`;
      } else {
        const lan = STATUS.urls.find(u => u.kind === 'lan');
        const img = lan ? await beam.qr(lan.url) : null;
        html = `${head}<h2>Ready</h2>
          <p>Try it in this PC's browser now, or scan the code to open it on your phone at home.${w.remote === 'cloudflare' ? ' Your link for anywhere else appears on Home in a few seconds.' : ''}</p>
          ${img ? `<img class="qr" src="${img}" alt="QR code"><p class="mono faint" style="text-align:center;margin:0">${esc(lan.url)}</p>` : ''}
          <div class="foot"><button class="btn" data-local="1">${icon('external')}Open in browser</button><button class="btn primary" data-close="1">Done</button></div>`;
      }
      modal(html, onClick);
      $('#modal').dataset.locked = ST.auth.passwordSet ? '' : '1';
      if (w.step === 0) setTimeout(() => $('#wz-pw') && $('#wz-pw').focus(), 50);
    };
    const onClick = async e => {
      const t = e.target;
      if (t.closest('[data-pick]')) { w.preset = +t.closest('[data-pick]').dataset.pick; return draw(); }
      if (t.closest('[data-remote]')) { w.remote = t.closest('[data-remote]').dataset.remote; return draw(); }
      if (t.id === 'wz-auto') { w.auto = t.checked; return; }
      if (t.closest('[data-back]')) { w.step--; return draw(); }
      if (t.closest('[data-local]')) { beam.testInBrowser(); return; }
      if (!t.closest('[data-next]')) return;
      if (w.step === 0) {
        const a = $('#wz-pw').value, b = $('#wz-pw2').value;
        if (a || b || !ST.auth.passwordSet) {
          if (a !== b) return toast('The two passwords are different.', 'error');
          const r = await beam.setPassword(a);
          if (!r.ok) return toast(r.error, 'error');
          ST.auth.passwordSet = true;
        }
      } else if (w.step === 1) {
        const p = ST.config.presets[w.preset];
        await save({ 'stream.resolution': p.resolution, 'stream.fps': p.fps, 'stream.bitrateKbps': p.bitrateKbps }, true);
      } else if (w.step === 2) {
        if (w.remote === 'cloudflare') {
          await save({ 'network.tunnel': 'cloudflare', 'network.tunnelAutoStart': w.auto }, true);
          beam.tunnelStart();
        } else {
          remoteGuide = w.remote === 'tailscale' ? 'tailscale' : remoteGuide;
          localStorage.setItem('remoteGuide', remoteGuide);
          await save({ 'network.tunnel': 'none', 'network.tunnelAutoStart': false }, true);
        }
      }
      w.step++;
      draw();
    };
    draw();
  }
  $('#modal').addEventListener('input', e => { if (e.target.id === 'wz-pw') strength(e.target.value, '#wz-strength'); });

  init();
})();
