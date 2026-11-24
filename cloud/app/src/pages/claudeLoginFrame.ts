import type { NativeClaudeLoginGrant } from '../api/client';

export function claudeLoginFrame(grant: NativeClaudeLoginGrant, theme?: 'light' | 'dark'): string {
  const url = new URL(grant.url);
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.on.aws') || url.pathname !== '/claude-login' ||
      url.port || url.search || url.hash || url.username || url.password || grant.port !== 8081 ||
      !/^[A-Za-z0-9_.-]+$/.test(grant.token)) throw new Error('Invalid worker sign-in link');
  // Opaque-origin, no storage, no external scripts. The code is sent directly to
  // the worker and is never sent to the parent frame or the Updraft API.
  const values = JSON.stringify([url.href, grant.token, grant.port]).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"${theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${url.origin}; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<style>
 :root{color-scheme:light dark;--bg:#fff;--fg:#0e2233;--muted:#5a7184;--border:#dce6ee;--accent:#0668b8}
@media(prefers-color-scheme:dark){:root:not([data-theme]){--bg:#0e2233;--fg:#e2ecf3;--muted:#8ca6b8;--border:#244155;--accent:#4eaeff}}
:root[data-theme="dark"]{--bg:#0e2233;--fg:#e2ecf3;--muted:#8ca6b8;--border:#244155;--accent:#4eaeff}
*{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:20px}
p{margin:0 0 16px;color:var(--muted)}a,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border-radius:8px;padding:10px 16px;font:600 14px/1.5 system-ui,sans-serif;text-decoration:none;border:1px solid var(--accent);background:var(--accent);color:var(--bg);cursor:pointer}
[hidden]{display:none!important}#code-entry{margin-top:20px}label{display:block;font-weight:600}
input{width:100%;margin:8px 0 12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}input:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
</style></head><body>
<p id="status" role="status">Connecting to the sign-in worker…</p>
<a id="authorize" hidden target="_blank" rel="noopener noreferrer">Continue to Claude ↗</a>
<div id="code-entry" hidden><label for="code">Code from Claude</label>
<input id="code" type="password" autocomplete="off" maxlength="2048" aria-describedby="code-help" required>
<p id="code-help">Return from Claude and paste the authorization code here. It goes directly to your private environment.</p>
<button id="finish" type="button">Finish sign-in</button></div>
<script>
const [url, token, port] = ${values};
const status = document.querySelector('#status');
const link = document.querySelector('#authorize');
const form = document.querySelector('#code-entry');
const input = document.querySelector('#code');
let terminal = false;
new ResizeObserver(() => parent.postMessage({ kind: 'updraft-claude-login', result: 'resize', height: Math.ceil(document.body.getBoundingClientRect().height) + 2 }, '*')).observe(document.body);
function update(result) {
  terminal = true;
  link.hidden = true;
  link.removeAttribute('href');
  form.hidden = true;
  input.value = '';
  status.textContent = result === 'connected'
    ? 'Claude confirmed sign-in. Verifying your connection…'
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
