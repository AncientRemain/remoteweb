// Draws the privacy screen the app asks for: black, dimmed, a message, a clock, a picture or
// a floating logo. Text slowly shifts position so nothing burns into the monitor.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let state = { mode: 'black' };
  let clock = 0, raf = 0, drift = 0;

  function whoText(device, since) {
    const m = since ? Math.max(0, Math.floor((Date.now() - since) / 60000)) : 0;
    if (m < 1) return `${device} connected just now`;
    return `${device} has been connected for ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`}`;
  }

  function tick() {
    const d = new Date();
    $('time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const who = $('who');
    who.classList.toggle('on', !!state.device);
    if (state.device) who.textContent = whoText(state.device, state.since);
  }

  function moveText() {
    const x = Math.round((Math.random() - 0.5) * 48), y = Math.round((Math.random() - 0.5) * 48);
    $('card').style.transform = `translate(${x}px, ${y}px)`;
  }

  // The logo glides around and bounces off the edges.
  function float() {
    const el = $('logo');
    let x = Math.random() * (innerWidth - 300), y = Math.random() * (innerHeight - 100);
    let vx = 45, vy = 32, last = performance.now();
    const step = now => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const w = el.offsetWidth, h = el.offsetHeight;
      x += vx * dt; y += vy * dt;
      if (x < 0) { x = 0; vx = Math.abs(vx); } else if (x > innerWidth - w) { x = innerWidth - w; vx = -Math.abs(vx); }
      if (y < 0) { y = 0; vy = Math.abs(vy); } else if (y > innerHeight - h) { y = innerHeight - h; vy = -Math.abs(vy); }
      el.style.transform = `translate(${x}px, ${y}px)`;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function apply(s) {
    state = s || { mode: 'black' };
    document.body.dataset.mode = state.mode;
    $('message').textContent = state.message || '';
    $('hint').textContent = state.hint || '';
    $('logo-name').textContent = state.appName || '';
    const pic = $('picture');
    if (state.mode === 'picture' && state.picture) { if (pic.getAttribute('src') !== state.picture) pic.src = state.picture; } else pic.removeAttribute('src');
    clearInterval(clock); clearInterval(drift); cancelAnimationFrame(raf);
    tick();
    if (state.mode === 'message' || state.mode === 'clock') { clock = setInterval(tick, 1000); drift = setInterval(moveText, 60000); }
    if (state.mode === 'logo') float();
  }

  window.cover.onState(apply);
})();
