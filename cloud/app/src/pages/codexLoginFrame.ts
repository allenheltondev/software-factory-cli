import type { NativeClaudeLoginGrant } from '../api/client';

/**
 * The Codex (Sign in with ChatGPT) frame (#125). The worker runs the official
 * `codex login --device-auth` and sends this frame only OpenAI's verification page and the
 * one-time code; the person opens the page, signs in to ChatGPT and types the code there. The
 * frame never sends anything to the worker (any message ends the attempt), and the parent page
 * gets only a status: the code is never sent to the parent frame or the Updraft API.
 */
export function codexLoginFrame(grant: NativeClaudeLoginGrant, theme?: 'light' | 'dark'): string {
  const url = new URL(grant.url);
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.on.aws') || url.pathname !== '/codex-login' ||
      url.port || url.search || url.hash || url.username || url.password || grant.port !== 8081 ||
      !/^[A-Za-z0-9_.-]+$/.test(grant.token)) throw new Error('Invalid worker sign-in link');
  const values = JSON.stringify([url.href, grant.token, grant.port]).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"${theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${url.origin}; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<style>
 :root{color-scheme:light dark;--bg:#fff;--fg:#0e2233;--muted:#5a7184;--border:#dce6ee;--accent:#0668b8}
@media(prefers-color-scheme:dark){:root:not([data-theme]){--bg:#0e2233;--fg:#e2ecf3;--muted:#8ca6b8;--border:#244155;--accent:#4eaeff}}
:root[data-theme="dark"]{--bg:#0e2233;--fg:#e2ecf3;--muted:#8ca6b8;--border:#244155;--accent:#4eaeff}
*{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:20px}
p{margin:0 0 16px;color:var(--muted)}a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border-radius:8px;padding:10px 16px;font:600 14px/1.5 system-ui,sans-serif;text-decoration:none;border:1px solid var(--accent);background:var(--accent);color:var(--bg)}
[hidden]{display:none!important}#device{margin-top:4px}
#code{display:block;margin:8px 0 16px;padding:12px;border:1px solid var(--border);border-radius:8px;font:600 22px/1.4 ui-monospace,monospace;letter-spacing:.12em;color:var(--fg);user-select:all;overflow-wrap:anywhere}
a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
</style></head><body>
<p id="status" role="status">Connecting to the sign-in worker…</p>
<div id="device" hidden>
<p>1. Open the ChatGPT sign-in page and sign in.</p>
<a id="verify" target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in ↗</a>
<p style="margin-top:16px">2. Enter this one-time code there. It expires in 15 minutes.</p>
<output id="code" aria-label="One-time code"></output>
<p>Codex finishes signing in on your private worker. Nothing you type there comes back here.</p>
</div>
<script>
const [url, token, port] = ${values};
const status = document.querySelector('#status');
const device = document.querySelector('#device');
const link = document.querySelector('#verify');
const code = document.querySelector('#code');
let terminal = false;
new ResizeObserver(() => parent.postMessage({ kind: 'updraft-codex-login', result: 'resize', height: Math.ceil(document.body.getBoundingClientRect().height) + 2 }, '*')).observe(document.body);
function update(result) {
  terminal = true;
  device.hidden = true;
  link.removeAttribute('href');
  code.textContent = '';
  status.textContent = result === 'connected'
    ? 'ChatGPT confirmed sign-in. Verifying your connection…'
    : result === 'expired' ? 'This sign-in expired. Start a new sign-in in Updraft.'
    : 'Could not complete sign-in. Try again in Updraft.';
  parent.postMessage({ kind: 'updraft-codex-login', result }, '*');
}
const socket = new WebSocket(url, ['lambda-microvms','lambda-microvms.authentication.'+token,'lambda-microvms.port.'+port]);
socket.addEventListener('message', ({ data }) => {
  try {
    const message = JSON.parse(data);
    if (['connected', 'expired', 'failed'].includes(message.status)) { update(message.status); return; }
    const page = new URL(message.verificationUrl);
    if (page.href !== 'https://auth.openai.com/codex/device') throw Error();
    if (typeof message.userCode !== 'string' || !/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/.test(message.userCode)) throw Error();
    status.textContent = 'Sign in with ChatGPT in a new tab, then come back: this page updates on its own.';
    link.href = page.href;
    code.textContent = message.userCode;
    device.hidden = false;
  } catch { socket.close(); }
});
socket.addEventListener('close', () => { if (!terminal) update('failed'); });
addEventListener('pagehide', () => socket.close(), { once: true });
</script></body></html>`;
}
