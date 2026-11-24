# Claude account connection — issue 123

The Claude settings page now starts with account status. An eligible installation owner can connect without a waiting GitHub issue or selected workflow trigger. The existing Agent keys, Configuration, and waiting-request links converge on this page.

`POST /v1/installations/:id/claude-subscription/connect` checks installation membership, active tenant status, owner role, and managed-route ownership. It uses the existing generation reservation and idempotent MicroVM launch. It does not enable routing, alter saved triggers, remove an API key, or expose an operator-pinned worker as a managed session. The existing eight-hour maximum applies to idle connections too; at most one current session is reserved per installation.

Preparation, official provider sign-in, and heartbeat verification use one reconciliation loop. Requests do not overlap, back off after failures, refresh on focus/visibility, and abort on navigation. Worker/grant generations must agree before the current connection attempt finishes. Frame messages alone cannot confirm connection. Waiting jobs remain linked from setup instead of navigating away automatically.

Upgrade, expired-auth, and offline-worker recovery use the existing exact-VM restart fence. Active, settling, queued, and concurrently changing work prevents stopping the VM. After termination the guided flow starts the replacement automatically. Healthy workers and interrupted authorization attempts reuse their current environment. Members receive owner guidance and cannot change routing or obtain a grant.

The sandbox retains its opaque origin, CSP, official destination allowlist, and direct browser-to-worker WebSocket. The parent only accepts source/origin-validated status and bounded layout metadata. The frame resizes to its content, uses trusted static design-token colors, supports both themes, and clears the code after submission. No authorization code passes through parent state or the application API.

## Visual evidence

Captured on November 24, 2026 with headless Chrome at 1280 × 960 and 390 × 844. These are the actual React page and sandboxed frame with **mock session, grant, and worker responses**. The provider URL/code interaction is simulated. They do not establish live authentication or isolation acceptance. Each sign-in frame was checked for vertical and horizontal overflow.

| Layout | Connect | Official sign-in handoff | Connected, routing off |
| --- | --- | --- | --- |
| Desktop, light | [Connect](desktop-light-connect.png) | [Sign in](desktop-light-signin.png) | [Connected](desktop-light-connected.png) |
| Desktop, dark | [Connect](desktop-dark-connect.png) | [Sign in](desktop-dark-signin.png) | [Connected](desktop-dark-connected.png) |
| Mobile, light | [Connect](mobile-light-connect.png) | [Sign in](mobile-light-signin.png) | [Connected](mobile-light-connected.png) |
| Mobile, dark | [Connect](mobile-dark-connect.png) | [Sign in](mobile-dark-signin.png) | [Connected](mobile-dark-connected.png) |

## Live acceptance still required

These checks require a deployed staging build and an eligible owner completing Claude's official authorization:

- Fresh account connection without a waiting issue; verify matching session generation and heartbeat.
- Explicitly route and execute a real GitHub issue; verify other workflows retain their billing mode.
- Reconnect after actual session expiry, image upgrade, and worker loss; verify busy/queued work blocks termination.
- Resume a waiting issue without relabeling, duplicated jobs, or API-key fallback.
- Concurrent browser tabs, expired grants, closed provider tab, and return/reload during provisioning.
- Validate the live port grant, lifecycle-port denial, credential isolation, and absence of credentials/codes from API traffic and telemetry.

Do not mark these staging checks complete based on the mock screenshots or unit tests.
