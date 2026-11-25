# Review and CI remediation: audit of #133

An audit of issue #133 ("Make PR reviews conversational with inline findings, threaded fixes, and
reliable CI remediation") against what is on `main`. It was done for reliability epic #159 (Phase 3,
item 14). It sorts each requirement and acceptance criterion into one of three kinds:

- **(a) Done and tested.** The code is on `main` and automated tests cover it.
- **(b) Hosted evidence needed.** The code is on `main` and tested against fakes, but it can only be
  shown to work on real GitHub or a deployed environment. That evidence is for #149 (threads) and
  #150 (hosted CI repair).
- **(c) Code gap.** Something is missing in the code. Gaps found by this audit were fixed on the
  audit's branch; see [Gaps fixed by this audit](#gaps-fixed-by-this-audit).

## What implemented #133

| Item | What it did | State |
| --- | --- | --- |
| #143 | Made CI repair (`ci`, compiled to `ciFix`) a setting in the Cloud console; Actions read for CI fix job tokens | Merged |
| #146 | Posts reviewer findings as inline threads, with coding-agent replies, re-checks, resolving and reopening | Merged |
| #151 / PR #160 | Reads a finding's status again right before its thread is reopened | Merged, closed |
| PR #163 | Checks a PR against its issue's acceptance criteria before it can be ready | Merged |
| PR #164 | Queues capacity-blocked Cloud jobs, including review, revision and CI steps, durably | Merged |
| PR #166 | Recovery: starts the CI step for a missed `check_suite` event, and retries a lost worker's job | Merged |
| PR #167 | Reporting: adds the selection line (tier, model, effort) to review and revision messages | Merged |
| #149 | Check findings-as-threads against a real pull request | Open: hosted evidence |
| #150 | Show hosted CI repair end to end on a labeled issue | Open: hosted evidence |

## Section 1: conversational PR reviews

| Requirement | Kind | Evidence | What remains |
| --- | --- | --- | --- |
| Structured finding contract: id, severity/blocking, path, side, line/range, problem, suggestion. Bounded and validated. | a | `src/agents/findings.ts`; `docs/review-loop.md` "The contract"; `src/agents/findings.test.ts`. | None |
| Keep the verdict contract and legacy free text working | a | `review.test.ts`: "posts a legacy review as before, and a broken block as prose"; "leaves a review from before acceptance existed exactly as it was" | None |
| Never drop a blocking finding when it cannot be anchored; findings outside the diff go in the summary | a | `src/publish/anchors.ts`, `threads.ts` `planThreads`/`withoutInline`. `review.test.ts`: "keeps every finding when GitHub refuses the inline comments, and when the head moved"; `anchors.test.ts` | Hosted: the 422 fallback on real GitHub (#149) |
| No made-up anchors: check against the reviewed diff and use GitHub's coordinates | a / b | `anchors.ts` (hunk-bounded ranges, RIGHT/LEFT). `anchors.test.ts` | Hosted: a range and a LEFT-side line on a real PR (#149) |
| A COMMENT review with inline comments; never approve or request changes on its own PR | a / b | `src/github/client.ts` `createPullRequestReview({comments})`. `review-client.test.ts` | Hosted: the shape on real GitHub (#149) |
| Read threads and replies, reply in threads, resolve and reopen | a / b | `client.ts` `listPullRequestFiles`, `listPullRequestReviewComments`, `replyToReviewComment`, `listReviewThreads` (paginated), `resolveReviewThread`, `unresolveReviewThread` (GraphQL, with a repository-id check). `review-client.test.ts` | Hosted: every call against real REST and GraphQL, and App permissions for resolve and unresolve (#149) |
| Stable markers per finding and run; durable link to GitHub ids, the source SHA and revision commits | a | `review_findings` (migration 19), `threads.ts` `findingMarker`/`threadReplyMarker`, merge rule in `docs/shared-state.md` | None |
| Lost responses, partial posting, pagination, stale heads, outdated comments, retries, merging Cloud state; no duplicates; no forged markers | a | `review.test.ts`: "never posts the review or its threads twice when the first answer was lost…", "does not take a marker in someone else's review for its own", "stops writing in the threads as soon as another attempt takes over…", "is stopped between replies…", "changes nothing about earlier findings from a review whose head has moved on…", "does not resolve a thread once the pull request moves on…", "promotes a repeat and records it in one step…". `run-event-shared.test.ts` (Cloud shared state) | None |
| Attempt fencing, dedupe, redaction, Markdown cleanup, verdict authority and claim markers kept | a | `docs/review-loop.md` "What decides"; tests above; `markdown.test.ts` | None |
| The coding agent gets structured findings and thread ids, and reports per finding (fixed, disagreed, deferred, unable) | a | `src/agents/prompt.ts`, `threads.ts` `revisionFindingsOf`. `revision.test.ts`: "answers each finding in its thread once the push is confirmed, and the rest in its reply" | None |
| Fixes are claimed only after a confirmed push; replies link the commit; if a thread reply fails, the PR comment has the answer | a | `revision.ts` (replies after the push), `threads.ts` `answerFindings`/`commitUrl`. `revision.test.ts`: "says nothing in the threads of a revision that pushed nothing" | Hosted: working commit links (#149) |
| Human reviews behave as before; human threads are never resolved or reopened | a | `review.test.ts`: "answers the checks of a later round…resolves only verified threads it started", "never reopens a thread a person started…" | None |
| The reviewer checks earlier findings on the new head itself, resolves only verified worker threads, and reuses the thread when a finding recurs | a | `review.test.ts`: "follows up in the existing thread when a finding with a thread recurs", "never verifies a thread the same review repeats…", "never takes ready when a check reopens a blocker verified before", "does not reopen a thread a newer check verified while the threads were listed" (#151) | Hosted: resolve and reopen on real GitHub (#149) |
| Unresolved and declined blockers stay in the verdict | a | `threads.ts` `verdictContradiction`. `review.test.ts`: "takes ready-to-merge with a blocker as changes requested, and never merges it", "…when an earlier blocker is unresolved or not re-checked", "checks a ready verdict against every recorded blocker…", "never lets a repeat that calls an open blocker a suggestion make it one" | None |
| Short top-level comments with role, round, head SHA, the next action and the outcome | a (fixed here) | Review: `Review agent · Round N · reviewed <sha>` (`threads.ts` `renderStructuredReview`). Coding agent: `revision.ts`. Updraft · CI: `ci.ts` `renderCiNotice`. **Fixed by this audit: gaps G1–G3 below.** | None |
| Links to the originating review, commits, checks and Cloud job (#129 job link context) | a / c (partly) | Review and finding threads link each other; revision replies link the review and now the pushed commit (G2); CI comments now link each failed check (G1). The assignment comment links the Cloud job (`assignment-comment.ts` `consoleJobUrl`). | **Open:** the CI comment names the revision job by id but does not link its Cloud job page. The Cloud id of the queued job is not known when the comment is written. Small follow-up; not needed for the exit gate. |
| No comment per status poll; one updated progress comment per round and head | a (partly) | One comment per transition, found again by marker: one review per run, one revision reply per run, one CI comment per head and state, one merge-blocked comment per head. Polls post nothing. | **Not done:** a single progress comment edited in place for each round was left out of #146 on purpose ("Not in this PR"). Today each step is its own idempotent comment. That meets "no spam" and "history kept". The owner decides whether a single edited comment is still wanted. |
| Persisted verdict and routing state decide, not the posted text | a | `pr_reviews`, `revision_prs`, `review_findings`. `review.test.ts`: "records a ready verdict only together with the findings it verified…" | None |
| Standard and native subscription workers, local CLI and hosted paths | a / b | One publish path for all of them (`src/publish/*`). The subscription worker runs the same `run-event`. `run-event-shared.test.ts` covers the Cloud/shared-state path. | Hosted: the native subscription path end to end (#150) |
| Role names agreed with #130 | a | `threads.ts` `ROLE` (Review agent, Coding agent, Updraft) | None |

## Section 2: the CI repair regression

| Requirement | Kind | Evidence | What remains |
| --- | --- | --- | --- |
| Find the real cause of the reported failure on a deployed environment | b | #143 found it: the Cloud console model had no `ciFix`, so the published dispatch rule never took `check_suite`. | Hosted: reproduce, then show the fix on staging (#150) |
| `ciFix` in the simple and full editors, import/export, normalization, publishing, YAML and dispatch, with round trips | a | `cloud/server/src/tenants/console.test.ts`: "compiles CI repair to ciFix, and the published dispatch rule takes check suites", "keeps CI settings through a save and a reload", "allows CI repair only where a workflow reviews, within the ceiling". `cloud/app/src/pages/config.test.tsx` (editors, `withoutUnreviewedCi`) | None |
| Explain what it depends on, the budget and why it stops; on by default for new reviewing repos; explicit off kept | a | `Simple.tsx`/`Editor.tsx` copy. `console.test.ts`: "leaves CI repair off where it is not set: an existing repository keeps its policy" | None |
| Event subscriptions and permissions; missed or unsupported events recovered | a / b | Cloud dispatches `check_suite.completed` (`dispatch.ts`; `dispatch.test.ts`: "starts a job for a finished check suite when ciFix is on…"). Every PR event reconciles checks (`run-event.ts`). Missed events: `cloud/server/src/workflows/recovery.ts` (PR #166), with `recovery.test.ts`: "starts the CI step once, for exactly the current head…", "starts nothing twice…", "blocks with exactly why when the launcher refuses for good (ciFix is off)" | Hosted: App event subscriptions and a missed-event recovery run (#150). The known limit (status-only external CI in Cloud) is in `docs/ci-fix.md` "Not covered" |
| Missing PR associations, drafts, stale heads, ignored or deployment checks | a | `dispatch.test.ts`: "finds the pull request of a check suite in its payload". `ci.test.ts`: "never fixes a head the pull request moved on from…", "leaves out checks it is told to ignore…", "waits for pending checks without marking the draft ready…". `jobs/queue.test.ts`: "drops a queued push or check suite whose head is stale…" | None |
| Job token scoped for redacted Actions diagnostics, falling back without Actions read; failed checks linked even without logs | a (fixed here) | #143 (optional Actions read, fallback). `ci.test.ts` redaction and diagnostics tests. **Fixed by this audit (G1):** the PR comment now links each failed check. Before, `docs/ci-fix.md` said it did, but the code only named them. | Hosted: annotation-only diagnostics where Actions read is not granted (#150) |
| A clean review, then a CI failure, dispatches a real revision through the same pool and auth mode, pushes, is reviewed again and runs CI again | a / b | `ci.test.ts`: "queues one revision with the diagnostics when CI fails after the review, and reviews and checks the fix again". `run-event-shared.test.ts`: "with ciFix: ends while CI is pending, then fixes a failure a check suite reports, reviews the fix and merges it once its checks pass". Queued behind capacity: PR #164 (`jobs/queue.test.ts`) | Hosted: the end-to-end run (#150) |
| No idle worker while checks run, no duplicate fixes per head, no unbounded loops, no weakened tests, no API-key fallback | a | `ci.test.ts`: dedupe (repeated deliveries), the no-progress signature, `maxRevisions`. Prompt rules (`prompt.ts`). The revision job uses the opening job's pool (`revisionJob`) | Hosted: a redelivered or stale event queues nothing (#150) |
| Disabled, blocked, exhausted, infra or manual failure, no progress, no push: said on the PR with a next action | a (fixed here) | `ci.test.ts`: "stops for a person on failures a code change cannot fix". The CI comment for `blocked`. **Fixed by this audit (G2):** when a CI fix pushed nothing or could not push, the reply now says what it was for ("the checks that failed on `<sha>`") and what happens next. Before, it called the worker's own check summary a change request "by" the bot. | Hosted: a refused fix when the budget is used up, CI repair is off, or Actions read is missing (#150) |
| A clean review alone is never shown as CI-ready while checks are pending or failing; no auto-merge until required checks pass on the same head | a | `listMergeCandidates({requireCi})` (`src/db/pr-reviews.ts`). The review's next-step text says "waits for its checks" (`review.ts` `nextStep`). Auto-merge gates (`merge.ts`). `ci.test.ts` (no merge or ready while failing). `review.test.ts` merge-gate tests. Acceptance gate (PR #163, `review.test.ts` "…is ready only once all four are independently verified") | Hosted: auto-merge off and on (#150) |
| The final outcome is reported: ready for a person to merge, or merged by policy, once review and checks are clean on the same head | a (fixed here) | **Fixed by this audit (G3):** after an automatic CI fix, the head whose checks pass gets one **Updraft · CI** comment. It says review and checks are clean on that commit and what happens next. | Hosted: shown on a real PR (#150) |

## Acceptance criteria of #133

| Criterion | Status | Evidence needed or remaining |
| --- | --- | --- |
| A real PR with several findings: one short review, anchored inline threads and a summary fallback; per-finding replies with confirmed commits; the reviewer verifies and resolves only worker threads; the timeline makes sense without logs | Code and tests done (a); hosted evidence needed (b) | **#149:** links or screenshots of one PR with (1) one COMMENT review with at least one single-line, one range and one LEFT-side inline comment plus a summary-only finding; (2) a forced 422 fallback; (3) Coding agent thread replies linking the pushed commit; (4) round-2 checks resolving verified worker threads, a regressed blocker reopening its thread, and a human thread left alone; (5) confirmation that the App and fine-grained token can resolve and unresolve threads, or doc updates if they can't. |
| Regression coverage: retry and lost response, bad anchor, stale head, partial publication, legacy output, human review, mixed providers, local and cloud | Done (a) | Tests are cited above. Mixed providers: reviews route across agents (`review.test.ts` routing tests), and the findings contract does not depend on the agent. |
| CI repair can be set and published in the Cloud UI, with a round-trip test showing the dispatch rule is on; explicit off stays off; users see how to turn it on and why it stops | Done (a) | `console.test.ts`, `config.test.tsx`, `dispatch.test.ts` |
| A real end-to-end hosted run: CI fails after a clean review, then the fix, push, review and green checks, with auto-merge off and on, duplicate and stale events, missed-event recovery, and blocked or limit cases | Code and tests done; **hosted evidence needed (b)** | **#150:** on staging with a safe test repo, links and screenshots of (1) the `check_suite` delivery and the dispatch decision; (2) the queued CI fix job, and the **Updraft · CI** comment linking the failed checks; (3) the Coding agent reply linking the new SHA; (4) the independent review of that SHA; (5) green checks and the **Updraft · CI** "passed" comment; (6) the same run with auto-merge on, ending in a merge of exactly that SHA; (7) a redelivered or stale `check_suite` that queues nothing; (8) a missed event recovered by PR #166's reconciler; (9) refusals when the budget is used up, when CI repair is off, and with no Actions read (annotations only); (10) the native subscription path where it is available. If any of these can't be done, record the exact blocker in #150. |
| Real PR links and screenshots, automated tests, and updated review-loop and CI docs | Tests and docs done (a); links and screenshots needed (b) | `docs/review-loop.md`, `docs/ci-fix.md` (updated here for G1–G3), `docs/revisions.md`, `docs/acceptance.md`. Links and screenshots come from #149 and #150. |

## Phase 3 exit gate (#159)

> A PR can progress from a genuine defect or CI failure to a verified correction with accurate
> GitHub conversation and head-specific acceptance evidence, and cannot auto-merge when mandatory
> checks remain unmet.

- **Auto-merge with checks unmet: met in code.** With `ciFix` on, a head is a merge candidate
  only when the CI step recorded `passed` for exactly that head (`listMergeCandidates`). The merge
  gates also need every check, and each `autoMergeRequiredChecks` entry, to have passed on that
  head. PR #163's acceptance gate holds back a head with unmet or unverified mandatory criteria.
- **Accurate conversation: met in code once G1–G3 are fixed.** Before this audit, the CI path
  ended without saying so on the PR. It called the bot's own check summary a "change request", and
  the failed checks it said were linked were not.
- **Verified correction: met in code.** The next review re-checks findings by key on the new head
  and resolves only what it verified. The CI step judges only the current head.
- **Hosted proof: not met yet.** This is #149 and #150.

## Gaps fixed by this audit

### G1: CI comments did not link the failed checks

- **The gap:** `docs/ci-fix.md` said the comment listed which checks failed, "with links". #133
  also asks for failed checks to be linked even when logs can't be read. The comment only named
  the checks inside a fenced reason.
- **The fix:** `src/publish/ci.ts` now reads the head's checks when it writes the comment, as a
  best effort, and lists each failed check that decides as a link: https only, with characters that
  would break the link escaped. It uses the same `checks`/`ignore` filter (`relevantChecks`) that
  decides. If the checks can't be read, the comment is still posted without the list.
- **Tests (`src/publish/ci.test.ts`):** the existing end-to-end CI test now checks the
  `Updraft · CI · <sha>` heading, the linked `test` and `lint` checks, and that a passing `build`
  check is not listed. A new test checks that a non-https check URL is named but not linked.

### G2: CI fix replies were worded as a change request

- **The gap:** a `ci_failure` revision's reply said "for the changes requested by
  `<worker login>` in `<check url>`". The notices for no commits and no push said the same, and
  the not-pushed notice told people to "submit a new review that requests changes".
- **The fix:** `src/publish/revision.ts` now answers a CI fix as the **Coding agent**: "pushed N
  commit(s) to fix the checks that failed on `<sha>` (<check url>); the pull request is now at
  [`<new sha>`](commit link)". It notes that this is the agent's account, not a verification, and
  that review and CI follow. When there was no push, the reply says what was being fixed, that
  fixing it is now up to a person, and that a new commit starts a new review. Revisions of human
  reviews and legacy reviewer verdicts are unchanged.
- **Test (`src/publish/revision.test.ts`):** "answers a CI fix as the Coding agent, naming the
  failed head and linking the commit it pushed, not as a change request". It covers a pushed fix
  and a fix with no commits.

### G3: the outcome of a CI fix was never reported

- **The gap:** after a CI fix was pushed, reviewed and its checks passed, nothing on the PR said
  so. With auto-merge off, the PR just went quiet. #133 asks that "Reviewer/Updraft subsequently
  report actual review and CI outcomes. Final state: ready for human merge (or merged by policy)."
- **The fix:** `listPendingCiNotices` (`src/db/pr-reviews.ts`) now also picks up a head whose CI
  step `passed` on a PR with at least one automatic CI fix. That head gets one
  **Updraft · CI** comment, found by the same per-head marker. It says review and checks are clean
  on that commit, and that it is ready for a person to merge, or that Updraft merges it with the
  configured method. A head that passes without any CI fix gets no comment: the review already said
  what follows, so there is no extra noise. No schema change; the existing `ci_comment_*` columns
  and their shared-state merge rule are reused.
- **Tests (`src/publish/ci.test.ts`):** the existing end-to-end test now checks the "passed"
  comment for the fixed head with auto-merge on, and that it is not posted twice. A new test covers
  auto-merge off ("ready for a person to merge") and no comment for a head that passed without a
  fix.

## Still open, and not code gaps for the exit gate

- **One progress comment per round:** a single comment edited in place for each round and head.
  It was left out of #146 on purpose, and each step now posts its own idempotent comment. This is
  a design choice for the owner. If it is still wanted, it should get its own issue.
- **Cloud job link in the CI comment:** a link to the queued revision's Cloud job page.
- **"Coding agent" heading on human-review replies:** revisions of a person's review still say
  "Updraft pushed…". This keeps existing behavior, as #133 asks for human-authored reviews.

## Recommendation

Close #133 once #149 and #150 are closed with the hosted evidence listed above, not before. On
`main` plus this audit's fixes, every code requirement of #133 is implemented and tested, except
the single progress comment the owner may decide to drop or split out. The parts that remain need
evidence from real GitHub and staging. #133 explicitly says closing on merged code or mocked tests
alone is not enough.
