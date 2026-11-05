/* Entry point */
'use strict';
(async function start() {
  try { await boot(); } catch (e) { document.getElementById('app').innerHTML = '<div class="content"><div class="notice bad">Cannot reach the server.</div></div>'; return; }
  render();
})();
