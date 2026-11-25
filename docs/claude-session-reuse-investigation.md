# Issue 144: hosted session reuse investigation

Read-only production observation on November 25, 2026, at 19:39 UTC (13:39 Central).
This is partial evidence, not completion of the hosted acceptance matrix in
[issue 144](https://github.com/allenheltondev/software-factory-cli/issues/144).

## Observed environment

- Stack: `updraft-cloud`, region `us-east-1`.
- Configured managed image: `21.0`; existing session image: `18.0`.
- Session generation: `683b51c0…`; dispatcher session: `13f24067…`.
- VM suffix: `…fa94`; AWS state: `RUNNING`.
- Worker: connected, unfenced, heartbeat age 4 seconds, no active or settling job,
  no queued jobs. Two retained waiting-request records had status `started`;
  neither was an outstanding sign-in request.
- Session requested at 13:00:23 UTC; ready at 13:01:18 UTC.
- Hard lifetime ends at 21:00:23 UTC. Configured application idle limit is 480
  minutes; idle deadline is 22:21:44 UTC. The earlier hard lifetime still applies.
- AWS GetMicrovm did not return an idle policy for this existing VM. This does
  not establish which provider idle policy was effective at launch.

The local dispatch classifier reports `image-outdated` and `reconnect`, despite
the fresh connected heartbeat. This observation identifies an image mismatch,
not missing authentication or actual VM replacement. It does not establish why
the originally reported repeated sign-ins happened. The script uses the local
classifier; it does not execute the deployed webhook.

## Consecutive hosted work

All five jobs below succeeded on the same VM and generation. Each has a
persisted `releasedAt`; none still owns the worker assignment.

| Source | Job | Created (UTC) | Released (UTC) |
| --- | --- | --- | --- |
| [Issue 131](https://github.com/allenheltondev/software-factory-cli/issues/131) | `job_5Vn4xOaWMe6rqfL4` | 13:05:06 | 13:11:18 |
| [PR 145](https://github.com/allenheltondev/software-factory-cli/pull/145) | `job_KfwJsM6VE4S7E1ul` | 13:18:09 | 13:19:29 |
| [PR 145](https://github.com/allenheltondev/software-factory-cli/pull/145) | `job_qCnQiUDinBbuqIct` | 13:27:04 | 13:28:06 |
| [PR 145](https://github.com/allenheltondev/software-factory-cli/pull/145) | `job_FMsY66zetwK1JACB` | 14:12:50 | 14:13:13 |
| [Issue 129](https://github.com/allenheltondev/software-factory-cli/issues/129) | `job_HpXdn7KblsHOU9Iv` | 14:16:15 | 14:21:43 |

The final distinct issue started about three minutes after the preceding PR job
released its slot. These records support consecutive job reuse, including issue
and PR events. They do not prove the PR event subtypes, absence of API billing,
or that no login took place between jobs. The observed job metadata did not have
an `agentKeys` field; missing data must not be interpreted as no API key use.

## Existing fixes and remaining validation

The checkout already contains `e1ee934` (settlement and dispatcher race fixes)
and `e4791f5` (explicit managed VM idle policy and trace tooling). This work
extends the trace with source links, start/release timestamps, reserved seconds,
and an optional API-key-request indicator. The dispatcher now retries an explicit
settlement-busy response up to three times, waiting one polling interval between
attempts. It cannot poll another assignment during this wait. Transport errors and
refusals still stop immediately; persistent busy stops after the third answer.
Credential-free structured wait diagnostics identify this path.

This does not change session lifetime,
retire the running session, deploy, or request new work from GitHub.

Run the trace during a new-image hosted pilot:

```powershell
cd cloud/server
npm run claude-session-trace -- --installation 183817939 --jobs 10 --watch 30
```

Still required before closing #144: connect once on the current image and run
the requested A/B test across cleanup, implementation/review/revision/CI work,
concurrent delivery and settlement scenarios, genuine expiry/logout/reconnect
and unhealthy environments. Correlate deployed webhook/broker/cleanup logs and
quota records, confirm actual AWS idle settings and per-job credential isolation,
and verify subscription billing. No new hosted pilot was performed in this pass.

## Local validation

- Server typecheck passed; all 855 server tests passed on the updated main base.
- MicroVM tests: 323 passed, 128 skipped, one failed because Windows denied the
  existing telemetry test's file symlink creation (`EPERM`). The changed native
  Cloud loop suite passed all 13 tests, including transient settlement recovery,
  persistent busy, transport uncertainty, cancellation, and same-session handoff.
- ESLint passed for all four changed JavaScript/TypeScript files.
- The hosted pilot on the new worker image is pending interactive owner sign-in.

## Rolling image policy follow-up

The expanded #144 requirement is implemented in the same PR. See
[Claude image rollouts](claude-image-rollouts.md) for exact approvals, optional
owner upgrades, drain/revoke fencing, queued-job recovery, and migration of
pre-registry images. The historical `image-outdated` observation above describes
the previous policy; latest-version inequality alone is no longer a reconnect
reason for explicitly approved images. Hosted A/B rollout evidence is still
pending owner sign-in and deployment.
