# Cloud benchmark dispatch

The benchmark harness sends a SigV4-signed POST to `<ApiUrl>/api/benchmark/jobs`
using the stack's execute-api URL. Give the harness role in the stack's AWS account
`execute-api:Invoke` on `<api-id>/<stage>/POST/api/benchmark/jobs`.

1. Onboard a dedicated benchmark GitHub App installation and publish the sandbox
   repository's workflow with an explicit ID, an `issue.labeled` trigger on
   `updraft:benchmark`, and the allowed GitHub actors. Give each candidate builder
   profile an explicit model and configure its provider API key in the sandbox tenant.
2. Deploy a benchmark-capable microVM image and set `BenchmarkInstallationId` and
   `BenchmarkRepositoryId` on the Cloud stack. Both default to zero, which
   disables dispatch. Set the two IDs together. Turn on Job Finished events for the benchmark tenant if
   the harness consumes results from EventBridge.
3. An allowed GitHub actor applies `updraft:benchmark` to an open sandbox issue.
   Use that actor's login in the request. The runner checks the label's GitHub
   history before doing work. The label is reserved even when benchmark dispatch
   is disabled.

```json
{
  "repository": "example/sandbox",
  "issue": 17,
  "workflow": "build",
  "agent": "claude-sonnet",
  "actor": "octocat",
  "configVersion": 7,
  "benchmark": { "runId": "pilot", "caseId": "issue-17", "arm": "sonnet" }
}
```

Use the same published `configVersion` and issue for all arms of a case. Keep the
base branch at the same commit until the arms have finished. If `configVersion`
is omitted, dispatch uses the sandbox tenant's active version at launch.

A successful launch returns HTTP 202 and a `jobId`. Resubmitting the same
request while the backend job record is retained returns the same ID with
`duplicate`. Submit a fresh arm through the harness for another agent or an
intentional rerun. Conflicts return HTTP 409. A dispatch
still being registered returns `benchmark_dispatch_in_progress` and can be
retried. Quota throttling returns HTTP 429.

Each arm gets its own state database, branch, and draft PR. The job keeps the
published prompt and verification commands, and uses a private configuration
with one builder. Revision, dependency waits, and auto-merge are disabled.
The benchmark installation has its own tenant quota counters, while all jobs
share the platform concurrency limit. Benchmark state stays out of ordinary
tenant Insights. The saved job summary and Job Finished event both carry
`benchmark.runId`, `benchmark.caseId`, and `benchmark.arm`.
