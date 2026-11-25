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
