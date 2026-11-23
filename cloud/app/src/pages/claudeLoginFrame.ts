import type { NativeClaudeLoginGrant } from '../api/client';

export function claudeLoginFrame(grant: NativeClaudeLoginGrant): string {
  const url = new URL(grant.url);
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.on.aws') || url.pathname !== '/claude-login' ||
      url.port || url.search || url.hash || url.username || url.password || grant.port !== 8081 ||
      !/^[A-Za-z0-9_.-]+$/.test(grant.token)) throw new Error('Invalid worker sign-in link');
  // Opaque-origin, no storage, no external scripts. The code is sent directly to
  // the worker and is never sent to the parent frame or the Updraft API.
  const values = JSON.stringify([url.href, grant.token, grant.port]).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${url.origin}; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#172638;background:#f4f7fa;margin:0;padding:16px;box-sizing:border-box}
p{margin:0 0 10px}a{color:#075aaf}#code-entry{margin-top:12px}label{display:block;font-weight:600}
input{box-sizing:border-box;width:100%;max-width:24rem;margin:4px 0 8px;padding:6px}button{cursor:pointer}
</style></head><body>
<p id="status" role="status">Connecting to the sign-in worker…</p>
<a id="authorize" hidden target="_blank" rel="noopener noreferrer">Continue to Claude ↗</a>
<div id="code-entry" hidden><label for="code">Code from Claude</label>
<input id="code" type="password" autocomplete="off" maxlength="2048" required>
<button id="finish" type="button">Finish sign-in</button></div>
<script>
const [url, token, port] = ${values};
const status = document.querySelector('#status');
const link = document.querySelector('#authorize');
const form = document.querySelector('#code-entry');
const input = document.querySelector('#code');
let terminal = false;
function update(result) {
  terminal = true;
  link.hidden = true;
  link.removeAttribute('href');
  form.hidden = true;
  input.value = '';
  status.textContent = result === 'connected'
    ? 'Claude is connected. Return to the Updraft page.'
    : result === 'expired' ? 'This sign-in expired. Start a new sign-in in Updraft.'
    : 'Could not complete sign-in. Try again in Updraft.';
  parent.postMessage({ kind: 'updraft-claude-login', result }, '*');
}
const socket = new WebSocket(url, ['lambda-microvms','lambda-microvms.authentication.'+token,'lambda-microvms.port.'+port]);
socket.addEventListener('message', ({ data }) => {
  try {
    const message = JSON.parse(data);
    if (['connected', 'expired', 'failed'].includes(message.status)) { update(message.status); return; }
    const authorize = new URL(message.url);
    if (authorize.origin !== 'https://claude.ai' || authorize.pathname !== '/oauth/authorize') throw Error();
    status.textContent = 'Sign in on Claude in a new tab, then return here if Claude gives you a code.';
    link.href = authorize.href;
    link.hidden = false;
    form.hidden = false;
  } catch { socket.close(); }
});
function submit() {
  if (socket.readyState !== WebSocket.OPEN || !input.value.trim()) return;
  socket.send(input.value.trim());
  input.value = '';
  form.hidden = true;
  link.hidden = true;
  link.removeAttribute('href');
  status.textContent = 'Waiting for Claude to confirm sign-in…';
}
document.querySelector('#finish').addEventListener('click', submit);
input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
socket.addEventListener('close', () => { if (!terminal) update('failed'); });
addEventListener('pagehide', () => socket.close(), { once: true });
</script></body></html>`;
}
