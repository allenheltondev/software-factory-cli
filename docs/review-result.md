# Machine-readable review result

Design [§5](design.md#5-chatgpt-pr-review) and [§7](design.md#7-decisions-to-make-before-unattended-runs)
leave open where a review result lives that Updraft can read reliably. Issue #13 settles it:
the result is a **GitHub pull request review** whose body carries one small hidden block. Any
reviewer can post it, including a ChatGPT review task that posts as your own GitHub account.
Updraft reads it with the same REST API and the same credentials the worker uses: your `gh`
sign-in, or the GitHub App of `github.app` when one is configured, so a private repository
that only the App can read works too.

`updraft reviews` shows the current result for each PR Updraft published. It only reads: the
state database is opened read-only (it is never created, migrated or otherwise changed by this
command), and GitHub gets GET requests only. A database from before publications were recorded
is reported with how to upgrade it. Nothing else reads the block yet: **findings are not sent to an implementation agent automatically**, and no fix cycle
starts from a review. That comes later, on top of this format.

## The block

Put this HTML comment anywhere in the review body. GitHub does not render HTML comments, so it
is invisible on the PR page.

```
<!-- updraft-review-result v1
head: <the full 40-character SHA of the commit you reviewed>
blockers: yes | no
-->
```

- `head` is the commit the review covers, as a full 40-character hex SHA. Short SHAs are
  rejected.
- `blockers: yes` means at least one finding must be fixed before merging; `blockers: no`
  means none.
- Everything in the review body outside the block is the **findings** text. Updraft keeps
  it (trimmed, at most 20,000 characters, flagged when cut) for a later fix cycle and does
  nothing with it now.

Blocker status lives in the block, not in the review's state. GitHub does not let a PR's author
approve their own PR or request changes on it, so a review posted from your own account (as the
ChatGPT task does on PRs Updraft opened as you) is always `COMMENTED`. Updraft therefore
treats `COMMENTED`, `APPROVED` and `CHANGES_REQUESTED` reviews alike and reads `blockers` from
the block.

### Parsing rules

- **Lenient** about whitespace, blank lines, `\r\n` line endings, and the case of keys and
  values (`Blockers: YES`, an upper-case SHA). The first line may sit on the same line as `<!--`
  or on its own, and `-->` may end the last line.
- **Strict** about the version tag: the block's first line must be exactly
  `updraft-review-result v1`. `updraft-review-result v2`, `Updraft-Review-Result v1` or a missing version make the
  block invalid. A later format would use a new version tag.
- **Strict** about values: `head` must be 40 hex characters, and `blockers` must be `yes` or
  `no`. Both are required, and each may appear only once.
- Every other line must be `key: value`. **Unknown keys are ignored**, so a reviewer may add,
  say, `summary: two nits` without breaking the block. Free text inside the block is invalid.
- **One block per review.** A review with two or more `updraft-review-result` blocks is invalid, as is
  a block opened with `<!-- updraft-review-result` but never closed with `-->`.
- Any HTML comment whose text starts with `updraft-review-result` counts as an attempt at a block, so a
  near miss is reported as invalid rather than silently ignored. Other HTML comments are
  ignored.

## Trust

A review result counts only when all of these hold:

1. The review is **submitted**. Pending reviews and dismissed reviews don't count.
2. Its author is in **`review.reviewers`** in the config: GitHub logins, compared
   case-insensitively. The default is an empty list, which trusts no review result at all.

   ```yaml
   review:
     reviewers: [your-github-login]
   ```

3. The block parses (see above).
4. The block's `head` equals the review's `commit_id` as GitHub reports it. GitHub's value is
   authoritative: it records the commit the review was made on (through the API, the PR's head
   at submission unless the reviewer names another commit). A mismatch means the reviewer
   labeled a different commit from the one GitHub attached the review to, so the review is
   reported as invalid and not trusted.

## The current result for a PR

Updraft fetches the PR (for its current head SHA) and all of its reviews, then takes the
**newest trusted, valid review whose head equals the PR's current head**. Newest means latest
`submitted_at`, then the larger review id.

- If there is one, that is the result: blockers yes or no, the reviewer, the review's link and
  its findings.
- If there is none for the current head, the result is "no review for head `<sha>`". When
  trusted reviews of earlier heads exist, the newest of them is named as the latest reviewed
  SHA. Reviews of older heads are history: a push after a review always needs a new review.
- If there is no trusted, valid review at all, the PR is "not reviewed".

Reviews that carried a block but did not count (untrusted author, invalid block, head mismatch,
pending or dismissed) are listed with the reason. `updraft reviews` shows those that concern the
current head, so you can see why a review you expected didn't count. `--json` includes all of
them.

## Instruction to give your reviewer

Paste this into the ChatGPT review task (or any other reviewer's instructions), after the
instructions for the review itself:

> Post your review as a GitHub pull request review on the PR. At the very end of the review
> body, append exactly one block in this format, with nothing else inside it:
>
> ```
> <!-- updraft-review-result v1
> head: <full 40-character SHA of the PR head commit you reviewed>
> blockers: <yes or no>
> -->
> ```
>
> Use the full SHA of the exact commit you reviewed, not a short SHA and not the branch name. If
> new commits were pushed while you reviewed, use the commit you actually read. Write
> `blockers: yes` if any finding must be fixed before the PR can be merged, otherwise
> `blockers: no`. Put all findings, with file and line references, above the block. Include the
> block only once, and never quote or repeat it elsewhere in the review.

Then add the account the reviewer posts as to `review.reviewers`. For a ChatGPT task that posts
as you, that is your own login.

## What this does not do yet

- Findings from this block are **not** sent to any agent, and no job is queued from it.
  Updraft's own revision loop ([revisions.md](revisions.md)) does not read it.
- The worker does not poll reviews. `updraft reviews` reads them on demand and writes nothing:
  not to GitHub, and not to the state database.
- It plays no part in merging: `autoMerge` goes by Updraft's own reviewer, not by this block.

## How this relates to Updraft's own reviewer

`repositories.<OWNER/REPO>.review` turns on a different thing: a reviewer agent that Updraft
runs itself, whose verdict lives in Updraft's state database and drives the revision loop and
auto-merge ([review-loop.md](review-loop.md)). The reviews that agent posts carry the marker
`<!-- updraft-review: <run id> -->`, which is not this block and is never read as one.

The block described here is for a reviewer **outside** Updraft (a person, or another tool
posting to GitHub). `review.reviewers`, at the top level of the config, names whose blocks are
trusted. The two do not feed each other yet: a result from an outside reviewer is shown by
`updraft reviews` and acts on nothing.
