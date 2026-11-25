# Acceptance criteria

A clean code review is not enough when the pull request only does part of what the issue asked
for. With the [review loop](review-loop.md) on, Updraft reads the issue's acceptance criteria,
gives them to the coding agent, and has the reviewer check each one on the commit under review,
on its own. The coding agent's account of what it did never counts as proof. A head is not
ready while a mandatory criterion is not verified.

On by default wherever `review` is on. To change it:

```yaml
repositories:
  octo/widgets:
    review:
      acceptance: enforce   # the default; or report, or off
```

- **`enforce`:** the reviewer assesses every criterion. A head with a mandatory criterion that is not verified is never ready to merge.
- **`report`:** the same assessment and checklist, but it never holds a head back. This is the repository-wide waiver; see [Live gates and waivers](#live-gates-and-waivers).
- **`off`:** the agents are not given the criteria, and nothing is checked.

In the Cloud console, the same setting is *Acceptance criteria* under a workflow's review. The
workflows of one repository must agree on it.

Everything else in the review loop is unchanged and still applies on top: the verdict protocol,
structured findings and their threads, `maxRevisions`, [CI](ci-fix.md) and every
[auto-merge](review-loop.md#auto-merge) gate.

## Where the criteria come from

The criteria are read from the issue as each run is given it: its title and body, fetched
just before the run, with the same rule as for every run. If the issue's text is no longer
text an allowed actor stands behind, the body is withheld.

- **A task list:** every `- [ ]` and `- [x]` item is a criterion, in order, nested ones too. A ticked box is recorded as ticked, and never taken as evidence.
- **No task list:** the list items under a heading such as *Acceptance*, *Acceptance criteria*, *Requirements*, *Definition of done* or *Must* are criteria. A bold line (`**Requirements**`) or a short label ending in a colon (`Requirements:`) counts as a heading.
- **Neither:** the issue has no criteria. The reviewer is asked to name the concrete requirements the text states, as `I1`, `I2`, ..., and to say `needs-clarification` where the issue does not say clearly what is wanted.
- **Body withheld or unreadable:** nothing can be checked. The checklist has one row for the issue's requirements, unverified, and a person has to confirm them.

Only the text is read, never rewritten. Items in code blocks and HTML comments are not
criteria. Items under an *Out of scope* or *Non-goals* heading are left out. An item marked
`(optional)`, or listed under an *Optional*, *Nice to have*, *Stretch* or *Follow-ups* heading,
is optional: it is shown, and never holds a head back. At most 30 criteria are taken. The rest
are counted, the prompt says so, and they appear on the checklist as one mandatory row, `MORE`.
That row is always unverified, since no review was given them, so a head is never ready on 30
of more. Split such an issue, or have a person confirm them.

Every listed item is a criterion, including issue-template boilerplate such as a ticked "I
searched existing issues". No item is dropped by guessing at its wording. The reviewer is told
to mark an item that is plainly about the issue report, not the change, `not-applicable` with
that reason, and never to do so for anything the change could do.

### Ids and issue revisions

- **Criterion id:** each criterion's id is `AC-` and 8 hex characters of a hash of its own text. Case, spacing and Markdown emphasis are ignored. Editing the rest of the issue keeps the id. Editing the criterion itself gives it a new id, so an earlier assessment of the old text does not carry over to the new one. A repeated text gets `-2`, `-3`, and so on.
- **Issue revision:** the issue revision is a hash of the title and body the criteria were read from, shown on every checklist. The reviewer is told when the coding agent reported on a different revision. The checklist says when the issue changed since the previous review.

## The coding agent

An implementation or revision run is given the criteria, fenced as untrusted input like the
issue. It is asked to implement every mandatory one, and to include a report in its final
message:

````text
```updraft-acceptance
[{"criterion": "AC-1a2b3c4d", "status": "implemented", "evidence": "src/pool.ts; test in src/pool.test.ts", "tests": "npm test: 214 passed"}]
```
````

`status` is `implemented`, `partial`, `not-done` or `needs-live-validation`. Only ids the run was
given are read. The report is recorded with the run as the agent's claim
(`runs.summary.acceptanceReport`). The reviewer of the head that run pushed is given it,
labelled as a claim. A head someone else pushed has no report. A missing or unreadable report
fails nothing: run.log says so.

A revision of a review that held the head back is also told, criterion by criterion, what the
reviewer found and why. The prompt tells it not to deploy, change live systems or contact other
systems to produce live evidence. That is for a person.

## The reviewer

The reviewer is given the criteria, the coding agent's claims, earlier reviews, authorized
change requests and the issue. It writes its assessment in the same `updraft-findings` block as
its [findings](review-loop.md#findings-as-threads), in a `criteria` list:

````text
```updraft-findings
{"findings": [],
 "criteria": [{"criterion": "AC-1a2b3c4d", "status": "verified",
               "evidence": ["file: src/pool.ts:40-48", "test: npm test -- pool (ran it: 12 passed)"],
               "note": "Retire compares generations before it acts."},
              {"criterion": "AC-5e6f7a8b", "status": "unmet", "note": "docs/pool.md is unchanged."},
              {"criterion": "S1", "text": "Keep the --legacy flag (asked in a change request)", "status": "verified",
               "evidence": ["src/cli.ts:12"]}]}
```
````

- **`status`:** one of the following.
  - `verified`: checked on this commit, with evidence.
  - `unmet`: the change does not do it. The reviewer is asked to list a blocker finding too.
  - `unverified`: it needs evidence the reviewer cannot produce. The note says what a person must check.
  - `not-applicable`: the `note` gives the reason.
  - `needs-clarification`: the requirement is ambiguous. The note says what must be clarified.
- **`evidence`:** what the reviewer read or ran in this review.
  - `file: path[:line[-line]]`, or a bare repository path.
  - `test: <test or command, and its result>`.
  - `check: <CI check>`.
  - `commit: <sha>`.
  - An `https://` link.

  At most 8 per criterion. A reference in any other form is left out, and the checklist says so. The worker checks only the form of a reference, not that it exists. The prompt says never to cite a test run, screenshot or deployment the reviewer did not see.
- **Added criteria:** `I<n>` adds a requirement the issue states but did not list. `S<n>` adds one an authorized change request asked for. Each needs a `text`, and at most 10 can be added. `"optional": true` makes one a suggestion that never blocks.

There is no separate model call: the reviewer that reviews the code checks the criteria, on the
same pool, retries and routing.

### What the worker takes as verified

The reviewer's word is read and then held to these rules. Each one only ever makes a criterion
harder to pass:

| What the review says | What the worker records |
| --- | --- |
| Nothing about a criterion | unverified ("the reviewer gave no assessment of it") |
| No `updraft-findings` block, two blocks, invalid JSON, or no `criteria` list | every criterion unverified, with the reason |
| `verified` without a usable evidence reference | unverified |
| `verified` for a live gate (below) | unverified: a person confirms it |
| `not-applicable` without a reason | unverified |
| Any other status | unverified |
| A criterion id it was not given (other than `I<n>`/`S<n>` with text) | ignored, and counted |
| A ticked box in the issue, the coding agent's report | nothing: neither is evidence |

Every review assesses every criterion afresh on its own head. An earlier review's `verified`
never carries over to a new head, whether the coding agent pushed it, a person did, or the
issue changed. A revision or a human push is a new head, so it gets a new review, and the
review re-evaluates everything.

## What follows

Only the mandatory criteria decide, after the rules above. With `acceptance: enforce`:

- **All verified, or not applicable:** nothing changes. The verdict stands as the reviewer and the [findings](review-loop.md#findings-as-threads) make it.
- **One or more not met**, and the reviewer wrote ready-to-merge: the verdict is recorded and acted on as **changes requested**, and the review says why. A revision is queued, given every criterion that is not verified, through the same `maxRevisions` count as any revision.
- **Only unverified or needs-clarification** (no unmet criterion, and no open blocker finding), and the reviewer wrote ready-to-merge: a revision cannot supply missing evidence or settle an ambiguous issue, so none is queued. The verdict is recorded as changes requested, with the outcome `needs-verification`. The pull request stays at **needs a human**, and the line says which criteria hold it back. A person checks them, clarifies the issue, or pushes a change. A clarified issue is read by the next review, which a push starts. Or the person merges it themselves.
- **The reviewer wrote changes-requested itself:** the revision is queued as before, and is also given the criteria that are not verified. The reviewer is asked to write ready-to-merge when the only open criteria are ones a person has to settle, so that such a head is held for a person, not revised. A reviewer that writes changes-requested anyway gets an ordinary revision, bounded by `maxRevisions` as always.

A head that is held back is never marked ready for review, never goes to the CI step, and is
never auto-merged: every one of those needs a ready-to-merge verdict for the current head. Updraft never
bypasses GitHub's checks or branch rules for a criterion, and never merges because a criterion
passed.

With `acceptance: report`, all of the above is shown and nothing is held back.

### Live gates and waivers

A **live gate** is a criterion that asks for something to be shown or done on a live system,
which no agent review can provide. Examples:

- "on staging" or "a staging PR/run/test";
- "a hosted run/test/validation";
- "screenshot", "screen recording", "manual test" or "manually verify";
- "a real PR/deployment/environment";
- "confirmed in production", "deploy(ed) to prod/production" or "after deploy(ment)";
- "real device(s)";
- "live validation/test/run".

A criterion that only names a live system is a code criterion. "Keep hosted mode working" and
"Don't break production deployments" are both code criteria. The phrases are deliberately
narrow, and the match is a heuristic. A false match only makes a
criterion need a person, never pass. A live gate is never verified by an agent review,
whatever the reviewer cites and however green the tests are. It stays unverified, and the head
waits for a person.

Agents are told not to make live changes to produce such evidence. The coding agent reports
`needs-live-validation`; the reviewer says what a person must check.

The waivers:

- **A person merges** a head that is held back. Updraft never does it for them.
- **Edit the issue** to move a criterion under an *Optional* heading, or mark it `(optional)`. The edit must be by an allowed actor, or the body is withheld. The next review reads the new text.
- **`acceptance: report`** for the repository, set by whoever controls the config.

There is no per-criterion waiver comment yet.

## On the pull request

The review posts no extra comment. Its one comment review carries a compact checklist after the
findings, and no thread is opened for a criterion, so nothing is duplicated. For example:

```markdown
**Acceptance criteria** · reviewed `2f9c1e07a3b4` · issue revision `74d08ba1de6105e6`

3 of 4 mandatory criteria verified (or not applicable) on this commit.

- **Verified** · `AC-307b26f1` · Retire compares the worker generation
  - Evidence (the reviewer's references): [`src/pool.ts:40-48`](https://github.com/octo/widgets/blob/2f9c1e0…/src/pool.ts#L40-L48), test `npm test -- pool (ran it: 12 passed)`
  - Review agent: Retire compares generations before it acts.
- **Verified** · `AC-5ac36c9b` · Tests cover the race (ticked in the issue, not evidence)
  - Evidence (the reviewer's references): [`src/pool.test.ts`](https://github.com/octo/widgets/blob/2f9c1e0…/src/pool.test.ts)
- **Not met** · `AC-82dddf95` · Docs describe the generation check
  - Review agent: docs/pool.md is unchanged.
- **Unverified** · `AC-8f15ffe2` · Real staging PR shows the evidence at the exact head (live validation)
  - Updraft: the reviewer called it verified; it needs live evidence (a real deployment, staging run or screenshot), which an agent review cannot provide; a person confirms it

Since the previous review: `AC-82dddf95` unverified → not met.

Updraft: this head is not ready while 1 mandatory acceptance criterion is not met (AC-82dddf95); 1 mandatory acceptance criterion is unverified (AC-8f15ffe2). A coding agent's report or a ticked box does not count; a criterion that needs live validation needs a person.
```

- **Links:** file references link to the reviewed commit, and commit references to the commit.
- **Inert text:** criterion text, notes and references are flattened to one line and made inert: no mentions, HTML, comments, links of their own or closing keywords.
- **Changes since the previous review:** a line compares each criterion with the previous review of the pull request. It names a criterion that is new because the issue changed, one the issue no longer has, and any status change.
- **Elsewhere:** `updraft status` shows a held-back head as `needs a human: <head> is held back by its acceptance criteria: ...`, and the verdict as `held back: ...`.

## What is stored

- **The criteria:** the criteria each reviewer run was given, and its issue revision, policy and source, are in that run's recorded result (`runs.summary.review.acceptance`). The review's assessment is in its findings text, which is capped as before. The checklist is computed from both, and the same input always gives the same checklist. That history is per review run, so per head and per round.
- **The coding agent's claims:** they are in its run (`runs.summary.acceptanceReport`).
- **The outcome:** the outcome of a held-back head is `needs-verification` in `pr_reviews`, with the reason. Schema v20 adds that value. No new table is added, and the [shared-state merge](shared-state.md) is unchanged.

Nothing here holds a secret: it is issue text, agent text, ids and hashes, bounded as above.

**Compatibility:**

- **Older runs:** a reviewer run from before this existed has no criteria in its result, and is posted and acted on exactly as before.
- **Older agents and custom prompts:** the worker appends the protocol to every `reviewPrompt` itself. A reviewer that ignores it gets every criterion recorded as unverified, not passed.
- **Legacy free-text reviews:** they keep working. Their criteria are unverified.

## What this does not do yet

- **An issue edit:** an edit made after a head was found ready does not start a new review by itself. The next push does, and that review reads the edited issue. A head that is already ready stays ready until then.
- **A workflow view:** there is no issue-level workflow view of the checklist yet. It is on the review only.
- **Evidence:** the existence of an evidence reference is not checked. A reference to a file, test or commit that does not exist is shown as the reviewer wrote it, linked, so a person can see that it is wrong.
