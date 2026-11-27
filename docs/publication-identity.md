# Publication identity: threat model and hosted design

Separate GitHub identities for the coding agent and the reviewer (issue #134). The local CLI
implements this as [Publishing as a person](github-app.md#publishing-as-a-person). This page is
the threat model for that, and the design that Updraft Cloud must follow before it offers the
same. **The hosted part is not implemented**: Cloud jobs still publish as the App only, and
nothing here should be enabled for hosted jobs until the design below has been built and
reviewed.

## Roles

| Role | Identity | Writes |
| --- | --- | --- |
| Coding agent (publisher) | the consenting person (`github.publisher`) | branch pushes, the pull request, revision and CI-fix pushes, the coding agent's comments, claims and thread replies |
| Reviewer | the GitHub App installation | reviews (formal or comment), inline findings, thread resolution, dismissing its own outdated approvals |
| Orchestrator | the GitHub App installation | status, assignment, CI, merge and limit notices; ready for review; `autoMerge` |

Code: `src/github/publisher.ts` (the identity check), `src/publish/publisher-role.ts` (which
role a step takes), `src/publish/review-form.ts` (formal or comment review),
`src/poller/reviews.ts` (`isOwnReview`).

## Threats and what answers them (local CLI)

| Threat | Answer | Test |
| --- | --- | --- |
| Publishing as someone who never agreed | Only the login named in `github.publisher`; never the issue author, label actor or installation owner | `src/config/validate.test.ts` |
| The `gh` sign-in is another account (switched, shared machine) | `GET /user` with the exact token that will push; login (and id, if set) must match | `src/github/publisher.test.ts`, `publish.test.ts` "another account" |
| Token swapped between check and push (refresh, `gh auth switch`) | Each check reads its own token and returns that token and an API bound to it | `publisher.test.ts` "binds each check to its own token" |
| Silent fallback to the App on failure | Every refusal is a `PublishRefusal`; nothing retries with the worker's credentials | `publisher-role.test.ts`, `publish.test.ts`, `revision.test.ts` |
| Publisher changes mid-loop | Publisher recorded before the first push; later steps require the same login/id | `publish.test.ts` "keeps the recorded publisher" |
| Revoked or expired sign-in | 401/403 from GitHub: refusal with how to sign in again; at dispatch the job stays queued | `publisher.test.ts`, `publisher-role.test.ts` |
| Wrong or replaced repository | Repository compared by configured id; push permission required | `publisher.test.ts`, `publish.test.ts` |
| Token used for another repository | The role's push token is handed out only for its one repository | `publisher-role.test.ts` |
| Push to a protected or default branch, force push | Unchanged publication fences: job branch only, create-only first push, lease on revisions, base/default branch refused | existing `publish.test.ts`, `revision.test.ts` |
| SSH key of unknown account pushes | Person's pushes always go over HTTPS with the checked token | `publish.test.ts`, `revision.test.ts` |
| Credential reaches an agent or the reviewer | The token is read only inside publication steps; `GH_TOKEN`/`GITHUB_TOKEN` stay withheld from every agent (`src/worker/live.ts`); review posting only uses the App's API | `publish.test.ts` (App API sees no person writes), `review.test.ts` |
| Credential in logs, DB or comments | Redacted from `run.log` and errors like any token; only login and id are stored | `publish.test.ts` "pushes and opens …" |
| App's formal change request queues a second revision | Reviews by the worker with the review marker are recorded as ignored | `review.test.ts` "requests changes formally …" |
| A person forges an "own review" | Author must be the worker and the review must carry the marker; a marker in a person's review still counts as their request | same |
| Stale approval | Formal review only when the live head is the reviewed commit; `commit_id` pinned; own outdated approvals dismissed | `review.test.ts` |
| Misrepresenting a bot approval as a required human one | Review and PR text say what it does not replace; fallback comments never read as approvals | `review-form.test.ts` |
| Adopting a person's unrelated pull request | Restore needs the job branch, same repository, the run marker, and the configured publisher as author; an author whose account id is not `github.publisher.id` is not adopted, and the adopted publication records the author's id so the rest of the loop checks it | `src/commands/run-event-restore.test.ts` |
| A formal review refused for its event loses the inline threads | A refused formal review with inline comments is retried as a comment with the same inline comments first; only a refusal of those too moves the findings to the summary | `review.test.ts` "keeps the inline threads …" |
| Duplicate jobs or self-trigger loops in the whole loop | The person-published loop end to end (publication, formal change request, revision, formal approval) on the standard and the native subscription worker paths, with separate profiles and with one profile in both roles, with auto-merge and with manual merge: exactly one revision, the App's own change request recorded as ignored, every push the person's over HTTPS | `src/worker/review-loop.test.ts` "the loop of a pull request a person published" |

Deployment limitations of the local CLI: publication as a person needs the configured GitHub
App for reviews (`github.app`) and the person's own `gh` sign-in on the worker machine; the
tests run both worker paths against an in-memory GitHub, so GitHub's own review state, branch
protection and CI on a real repository are for a person to check (below). Updraft Cloud does
not offer it yet (next section).

What the local CLI does **not** protect against: an agent runs as the same OS user as the
worker, so without [isolation](isolation.md) it can run `gh auth token` itself. That is true
today without this feature; `publishAs: user` does not make it worse, and running agents in a
container keeps both the App key and the `gh` session out of reach.

## Hosted design (not implemented)

What Updraft Cloud needs before hosted jobs may publish as a person. The existing GitHub
linking flow (`cloud/server/src/flows/github.ts`) establishes identity and installation
membership only; it is **not** consent to keep a token for unattended pushes.

1. **Consent.** A separate "Publish as me" authorization per tenant member, using GitHub App
   user-to-server tokens (the App's OAuth flow with expiring tokens and refresh tokens). The
   screen states the verified GitHub account id and login, the installation and repositories
   it applies to, and the actions (push job branches, open pull requests, reply as the coding
   agent). Reconnect and disconnect are explicit. No pasted PATs, no uploaded `gh` caches.
2. **Configuration.** Per repository/workflow, an owner picks `publishAs: user` and a publisher
   among members who have consented themselves; a member cannot select another member. The
   console shows the publisher's login and the reviewer App's login before enabling, and both
   on jobs and PR lifecycle metadata.
3. **Storage.** Access and refresh tokens only in the broker's boundary, encrypted, bound to
   tenant and GitHub account id. Refresh is a compare-and-swap on the stored refresh token so
   two concurrent refreshes cannot both rotate it; a lost race re-reads.
4. **Use.** Jobs never receive the user token. The broker performs publication operations on
   the job's behalf, each constrained to the exact repository id, the job branch, the expected
   head (lease), and the operation (create branch, fast-forward, open PR, comment as coding
   agent). User tokens can reach more than one repository and cannot be minted per repository
   like installation tokens, which is why they must not leave the broker.
5. **Roles in one microVM.** Implementation, review and revision can share a microVM; authority
   is per operation and run role, not per initial job type. Reviewer runs get an installation
   token with contents read and pull requests write only; merge authority is separate.
6. **Checks.** Consent, membership, repository access and account id are checked at dispatch
   and again at each publication operation. Revocation, unlink, uninstall, suspension and SSO
   restrictions stop the job with a visible status; nothing falls back to the App.
7. **Webhooks.** `pull_request_review` events by the App with Updraft's marker are suppressed
   as self-events (as the poller does locally); pushes by the publisher to a managed branch are
   new heads to review, not new work.

## What a person must verify before rollout

These need a real GitHub repository and cannot be shown by the tests here:

- In a staging labeled-issue flow with `publishAs: user`: the pull request's author is the
  configured person; the first push, a revision push and a CI-fix push each show that person as
  the actor; the reviewer's reviews are by the App.
- A formal REQUEST_CHANGES and a formal APPROVE appear in GitHub's review state on the exact
  head SHA, and the CI checks on that SHA are the ones Updraft waited for.
- The fallback comment appears for a legacy App-authored pull request and when a repository
  rule refuses the App's approval.
- Branch protection: whether the App's approval counts toward required reviews in your
  configuration, and that Updraft's messages do not claim more than GitHub reports.
- A review of this threat model and of the hosted design above before anything is enabled in
  Cloud.
