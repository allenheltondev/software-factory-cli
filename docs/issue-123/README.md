# Claude account connection — issue 123

The Claude settings page now starts with account status. An eligible installation owner can connect without a waiting GitHub issue or selected workflow trigger. The existing Agent keys, Configuration, and waiting-request links converge on this page.

`POST /v1/installations/:id/claude-subscription/connect` checks installation membership, active tenant status, owner role, and managed-route ownership. It uses the existing generation reservation and idempotent MicroVM launch. It does not enable routing, alter saved triggers, remove an API key, or expose an operator-pinned worker as a managed session. A strongly consistent shared admission registry reserves maximum exposure before provisioning. Defaults are four concurrent environments, 24 runtime hours per installation per UTC day and 192 platform runtime hours per UTC day. After confirmed termination, settlement charges the elapsed possible runtime once and returns the unused exposure. Separate launch-attempt limits default to 12 per installation and 96 platform-wide per UTC day. The eight-hour session ceiling remains; idle timeout now defaults to eight hours so normal morning and lunch breaks preserve the connection.

Preparation, official provider sign-in, and heartbeat verification use one reconciliation loop. Requests do not overlap, back off after failures, refresh on focus/visibility, and abort on navigation. Worker/grant generations must agree before the current connection attempt finishes. Frame messages alone cannot confirm connection. Waiting jobs remain linked from setup instead of navigating away automatically.

Upgrade, expired-auth, and offline-worker recovery use the existing exact-VM restart fence. Active, settling, queued, and concurrently changing work prevents stopping the VM. An explicitly requested reconnect starts its replacement after confirmed termination. Idle, expired, disabled, and legacy sessions with unknown retirement intent stay ended on reload until the owner explicitly reconnects. Healthy workers and interrupted authorization attempts reuse their current environment. Members receive owner guidance and cannot change routing or obtain a grant.

The sandbox retains its opaque origin, CSP, official destination allowlist, and direct browser-to-worker WebSocket. The parent only accepts source/origin-validated status and bounded layout metadata. The frame resizes to its content, uses trusted static design-token colors, supports both themes, and clears the code after submission. No authorization code passes through parent state or the application API.

## Review follow-up

The platform kill switch guards admission too, including when SSM cannot be read. Capacity reservations do not expire using DynamoDB TTL. Pre-launch failures release capacity only after sealing the generation; ambiguous launch responses retain capacity until replaying the same AWS client token identifies the VM and physical termination is confirmed. The existing five-minute cleanup schedule reconciles these reservations independently of console polling. Uncertain stop/replay failures keep their capacity reserved and fail reconciliation for alarms/retry. Even recovery replay of a pre-budget unbound generation must obtain admission before it can create compute. The cleanup role has narrowly scoped managed-image launch, connector, execution-role, control-secret, and kill-switch permissions for this recovery path.

Each reserved generation has a ten-minute startup deadline. A missing registration or continuously unavailable auth probe becomes an explicit failed-startup recovery action. Retirement atomically seals the session generation, advances the dispatch revision, and fences either the matching idle worker or a placeholder inserted only if no worker exists. A concurrent registration, claim, or enqueue makes the fence fail. An absent row alone is never taken as proof that no work can run. Last work timestamps and busy/queued checks protect active work from idle cleanup.

Transient status-poll failures retain the active authorization frame and grant. Only explicit retry, terminal frame failure, or a changed worker generation clears an attempt. A changed generation requires explicit reconnect. Cancellation also ignores any result from an in-flight start/restart; consuming the Agent keys entry intent happens before opening a grant so route reconciliation cannot cancel a newly opened login.

Restart captures the session once, before route and eligibility reads. VM/lifecycle reads validate that generation, and retirement receives only the captured generation. A replacement that wins between eligibility and retirement is reconciled as current status, never adopted as a stale restart target.

Runtime holds remain reserved across UTC midnight and uncertain termination. Settlement only charges the current UTC day's elapsed interval, capped by maximum exposure; duplicate settlement cannot add charges or credit twice. Migration preserves unknown settled legacy charges conservatively while converting known active prepaid holds to the new accounting model. The UI shows the configured idle duration before connection and the effective minimum of the idle and lifetime deadlines while connected.

Operators configure these CloudFormation parameters; deployment variables use the corresponding `NATIVE_MANAGED_*` names. Existing leases retain their recorded idle policy; new settings apply to new leases.

| Parameter | Default | Purpose |
| --- | --- | --- |
| `ManagedClaudeIdleMinutes` | 480 | Idle timeout, 15–480 minutes, always capped by eight-hour lifetime |
| `ManagedClaudeConcurrentSessions` | 4 | Shared session capacity |
| `ManagedClaudeTenantDailyHours` | 24 | Per-installation settled runtime plus active maximum-exposure holds |
| `ManagedClaudePlatformDailyHours` | 192 | Platform runtime plus active holds |
| `ManagedClaudeTenantLaunchesPerDay` | 12 | Per-installation launch-attempt bound, separate from runtime settlement |
| `ManagedClaudePlatformLaunchesPerDay` | 96 | Platform launch-attempt bound |

## Visual evidence

Captured on November 24, 2026 with headless Chrome at 1280 × 960 and 390 × 844. These are the actual React page and sandboxed frame with **mock session, grant, and worker responses**. The provider URL/code interaction is simulated. They do not establish live authentication or isolation acceptance. Each sign-in frame was checked for vertical and horizontal overflow. These original layout captures predate the configurable-policy and effective-expiration copy.

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
