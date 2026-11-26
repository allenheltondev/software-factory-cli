# Claude subscription image rollouts

The latest deployed image selects **new** managed sessions. Existing sessions
remain on their immutable image, VM, and generation until natural expiry or an
owner-requested upgrade. Rollouts never copy Claude credentials or extend the
eight-hour hard lifetime or configured idle limit.

Compatibility is an exact approval record in the existing Cloud table:
`pk=NATIVE_IMAGE#<version>, sk=POLICY`. Each record contains `imageVersion`,
`revision`, `state`, `protocol`, and an operator-readable `reason`. There is no
numeric or lexicographic version comparison. This control plane supports only
`tenant-browser-1`; an unknown protocol fails closed even on an approved image.
Before implementing a breaking protocol, retain the old implementation while
supporting it or explicitly drain/revoke its images. Merely declaring a protocol
approved cannot add support for it.

## Routine deployment and rollback

The image deploy workflow seeds exact approvals for the previously active and
newly verified protocol-1 images before changing the latest-image parameter.
For manual parameter changes, run the same `--seed A --seed B
--require-approved B` command before selecting B. Seeding is conditional: it never overwrites an existing approval, drain, or
revocation, including during rollback. Supported older images continue serving
jobs; each job uses the session's actual image and generation. The console stays
Connected and offers an optional **Update available** notice with both versions.
Only an owner can request the update, and active, settling, or queued work blocks
an optional update. Updating creates a new environment and requires sign-in.

For migration, the current latest verified image has a bootstrap approval when
no record exists. Other unrecorded versions fail closed. Operators must approve
any known-compatible preexisting session images that predate this registry; do
not seed arbitrary versions just because their version strings look older.
No policy is cached in application code. An unreadable policy fails closed.

Approval records are never deleted, so an image a session launched on stays
approved however many rollouts later (seeding is additive). A launch on the
bootstrap approval (the latest image, with no record yet) writes that approval
down before the VM starts, so a later rollout that skips seeding, such as a
manual parameter change, cannot turn a live session's image into
"no approval". The write is conditional: a drain or revocation that commits
first wins and stops the launch.

## Image pruning

Each build deletes old versions of the image beyond the newest five, because an
image may hold only so many. For the Claude image it also keeps every version
that a microVM not yet terminated runs (from `lambda:ListMicrovms`), besides the
active and latest versions. If the live microVMs cannot be listed, nothing is
pruned: the build fails at the version cap, loudly, rather than deleting a
version a session may be using. Pruning never reads or writes an approval.

## Retirement reasons and sign-in

Cleanup records the most specific reason it can: `idle`, `lifetime` (the
eight-hour hard limit), `vm-ended` (AWS no longer runs the VM before its
lifetime ends), `suspended`, `worker-lost`, `startup-failed`, `disabled`,
`image-revoked`, `image-blocked`, or `reconnect` (an owner). Records sealed
before #176 may say `expired`, which meant either `lifetime` or `vm-ended`. The
retire log line also carries the session's image version, request time, and
last heartbeat. A job that waits on a sealed session records the reason on its
workflow timeline (event reason `claude_session_<reason>`), and the dispatch
log line carries `retirementReason`.

The Claude login lives only on the session VM's ephemeral disk and is never
copied. So no replacement environment can inherit it, and every retirement
needs a person to sign in again. Updraft does not start a replacement on its
own: it would spend a launch and then wait for the same sign-in. That is why
routine rollouts must never cause a retirement. The waiting-job comment is
posted only when that sign-in is needed. It is one sentence that says why the
previous session ended and links to the console. A wait that ends by itself
(startup, a heartbeat gap, an unreadable auth probe) gets no comment when the
job is parked. If that wait later turns into one that needs a sign-in (cleanup
seals the session as `worker-lost` or `startup-failed`, or the login lapses),
the five-minute workflow reconciliation posts the comment then and records the
wait on the timeline. Each waiting job gets exactly one sign-in comment: the
comment is claimed on the waiting record first, and the claim is given back
only if posting fails for a reason that may pass (a rate limit, a 5xx, the
network). If GitHub refuses the comment for good (403 for a locked issue, an
archived repository or no access; 404; 410; 422), the notice ends there. The
claim is kept, and the timeline records the wait with an `_uncommented` reason
code, so reconciliation does not retry it every five minutes until the wait
expires.

The in-VM dispatcher retries a poll or heartbeat that failed in transport
(timeout, throttling, a 5xx, a broker invocation that crashed, a function being
updated) with backoff. It also retries when the broker's handler caught its own
failure and answered `error: 'unavailable'`, such as a throttled table during a
deploy. An idle worker retries for at most two minutes, which is shorter than
Cloud's three-minute worker-lost grace. A running job survives only about a
minute of failed heartbeats: its assignment lease is 60 seconds
(`WORKER_LEASE_MS`). After that, Cloud fences the assignment, the next
heartbeat is refused, and the job stops. A refusal from Cloud (fenced, revoked,
another session or generation, a bad credential) still stops the worker at
once. A settlement is never retried after an uncertain answer, including
`unavailable`. An assignment whose poll response was lost is refused on the
retried poll, so the worker stops as it did before.

## Investigation: the 2026-11-26 01:18 UTC retirement (#176)

This section is code analysis only. Confirming it needs the production records
listed at the end.

`environment-retiring` means that the session record was already sealed
(`retiring: true`) when the job was dispatched. Only cleanup's reconcile, an
owner action, or a connect on a blocked pending reservation writes that seal.
An unapproved or draining image on a bound session would have been reported as
`image-unapproved` or `image-draining`, not as `environment-retiring`. So the
cause was a seal with one of these reasons: `idle`, `expired` (lifetime or VM
gone), `suspended`, `worker-lost`, `disabled`, or `startup-failed`.

From the merge history, six of the merges after #155 (21:41 UTC) changed the
Claude image's inputs and built a new version: #155, #162, #163, #167, #169 and
#168, the last at about 00:31. The others reused the active version, because
the build compares input fingerprints. Every merge still redeployed the
backend.

Ranked by likelihood:

1. **Pruning deleted the session's image version, and the VM ended with it
   (reason `expired`, now `vm-ended`).** Before this change, pruning kept only
   the newest five versions plus the active and latest ones. With six new
   versions in three hours, any session that started before about 22:12 had
   its version deleted by the #169 or #168 build (about 23:57 or 00:35). If
   AWS stops or breaks a microVM whose version is deleted, the next five-minute
   reconcile sees the VM as gone and seals the session. This is the only path
   that the number of rollouts drives directly.
2. **The dispatcher stopped after one failed broker call during a backend
   deploy (reason `worker-lost`).** The in-VM loop stops for good on any
   refusal, `FunctionError`, or 15-second timeout (`native-worker/cloud.mjs`).
   Three minutes after the last heartbeat, reconcile seals the session. Each
   merge updated the broker Lambda twice: once in the backend deploy and once
   for the image parameter. #170's deploy ran at about 01:00–01:15 and built
   no image, which matches a seal shortly before 01:18. The dispatcher now
   retries transient transport failures (see above).
3. **Hard lifetime or idle.** The default idle limit and the hard lifetime are
   both eight hours. A session sealed at 01:18 would have started before about
   17:18. Under the code before #155, rollouts at 19:36, 21:00 and 21:33 would
   have needed a reconnect anyway, so this is unlikely unless
   `ManagedClaudeIdleMinutes` is set lower in Production.
4. **An unseeded image.** A session that started on #158's image (about 21:00)
   was never seeded, because #160 was deployed by the workflow from before
   #155. It would read as `image-unapproved`, and its worker would be fenced on
   its next poll. That shows as `image-unapproved` or `fenced`, not
   `environment-retiring`, until a later seal. This explains a reconnect only
   together with cause 1 or 3.
5. **Kill switch (`disabled`) or revocation (`image-revoked`).** Unlikely,
   because no operator action was reported.

To confirm, check these records:

- The cleanup log's `claudeSession: 'retire'` line for the session's
  generation between 00:00 and 01:18. Its `reason` and `vmState` settle the
  question (`expired` with `vmState: null` or `TERMINATED` means cause 1;
  `worker-lost` with `RUNNING` means cause 2).
- `CLAUDE_SESSION` (`imageVersion`, `requestedAt`, `retirementReason`) and the
  worker row's `heartbeatAt`.
- The `deleted N old image versions: ...` lines of the Claude image builds for
  #169 and #168. Do they include the session's version?
- The broker Lambda's errors and duration around each deploy, and the VM's own
  log line `Cloud worker stopped`.
- The `NATIVE_IMAGE#<version>` policy record and revision for the session's
  version, and the stack's `ManagedClaudeIdleMinutes`.

## Mandatory upgrade and emergency revocation

Run from `cloud/server` with operator AWS credentials (add `--region`/`--stack`
for the intended environment):

```powershell
npx tsx scripts/claude-image-policy.ts --image 18.0 --state draining --reason "Upgrade required for security fix XYZ"
npx tsx scripts/claude-image-policy.ts --image 18.0 --state revoked --reason "Critical security issue XYZ"
```

- `draining` refuses new assignments. An already assigned job retains broker
  access to finish normally. Once active/settling work finishes, the owner can
  upgrade. Durable queued jobs remain queued. After replacement they are rebound
  to the new generation and actual image only if they have never started or
  acquired a VM; their per-job broker token hash rotates. No CLI credentials are
  transferred. Existing job deadlines, quotas, stop checks, and workflow pauses
  still apply.
- `revoked` immediately refuses subsequent broker authorization checks, even
  for active jobs. Worker control, active-job reconciliation, and the independent
  five-minute managed-session reconciliation fence the exact session generation
  and request physical VM termination. Managed-session cleanup checks revocation
  before busy/queue checks, including silent and unregistered workers. Its atomic
  fence checks the revocation revision, so a concurrent reapproval cannot be
  mistaken for the old emergency decision; capacity is released only
  after termination is confirmed. Once committed, the retirement seal is
  irreversible: cleanup retries termination before policy and busy/queue checks,
  even after reapproval or during a policy-read outage. Already delivered credentials cannot be
  recalled, so emergency containment requires that physical stop. This is not a
  claim of instantaneous VM termination at the policy write. Queued jobs are not
  discarded or silently routed to API keys.
- `approved` permits the exact image and implemented protocol. Reapproval is an
  explicit revision-checked operator action; publishing or rolling back a build
  cannot undo revocation. Unknown images/protocols require operator review.

The assignment transaction conditions on the exact approval revision. A policy
change that commits first makes an in-flight assignment fail; an assignment
committed first is existing work governed by drain/revoke semantics. Broker
authorization performs a strongly consistent policy read for every request;
authorization that reads the old policy before revocation is already in flight.
The broker role can read/check these records but cannot change them. Jobs and
workers have no policy-write capability. Operator updates use compare-and-swap.

For new sessions to start after a mandatory upgrade, the latest-image parameter
must name an approved, supported image. Revoking the latest image does not cause
automatic downgrade. The console shows the policy reason separately from auth
failure. Waiting requests and jobs retain their normal expiry; this policy does
not extend their lifetime.

## Pending reservations and ambiguous launches

Connect checks the image actually recorded in a pending reservation, then checks
it again immediately before the ordinary AWS launch. A reservation on blocked A
is sealed and retired before approved B can replace it. Waiting jobs survive.
A never-launched reservation is released without launching A. If a durable launch
marker makes the prior AWS outcome ambiguous, recovery requires the exact sealed
generation and marker: replay its original client token to discover/quarantine
the old VM, terminate it, and confirm termination before freeing accounting or
starting B. That recovery replay can create a VM if the original call never
arrived; the sealed session cannot dispatch work or issue job credentials. A
failed replay or unconfirmed termination retains the hold for retry. No ordinary
launch is allowed to bypass the exact-image approval check.

## Hosted acceptance still required

PR tests cover compatibility, rollback, protocol rejection, revocation fencing,
credential access, queued-job rebinding conditions, and optional-upgrade UI.
These do not replace the #144 hosted pilot. Connect once on A, run issue A,
deploy compatible B, and run a distinct issue 1–5 minutes after settlement on
the original VM/generation. Repeat across cleanup, multiple deployments, and
review/revision/CI. Capture the session trace, job/PR links, auth/billing evidence,
and exact AWS idle policy. Then exercise explicit drain and emergency revoke.
Interactive Claude owner sign-in is required; no hosted rollout was performed
as part of the code-only PR update.
