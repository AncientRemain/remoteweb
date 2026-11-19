// Embedding test page: frames the address from ?src= (the app's "Test on this PC" button
// opens it on 127.0.0.1, a different site from localhost, exactly like another website).
'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  const input = document.getElementById('src');
  const frame = document.getElementById('frame');
  const sandbox = document.getElementById('sandbox');
  input.value = q.get('src') || `http://localhost:${location.port || 80}/`;
  sandbox.checked = q.get('sandbox') === '1';

  function load() {
    let url;
    try { url = new URL(input.value.trim()); } catch { input.focus(); return; }
    if (!/^https?:$/.test(url.protocol)) { input.focus(); return; }
    // A sandbox only applies from the next page load, so set it first.
    if (sandbox.checked) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock allow-popups');
    else frame.removeAttribute('sandbox');
    frame.src = 'about:blank';
    setTimeout(() => { frame.src = url.href; }, 30);
  }

  document.getElementById('load').addEventListener('click', load);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
  sandbox.addEventListener('change', load);
  load();
})();
