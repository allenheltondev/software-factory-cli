import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { WorkflowEvent, WorkflowHistory, WorkflowPause, WorkflowView } from '../api/client';
import { workflowLifecycle } from '../lib/workflowLifecycle';
import { formatDuration } from '../lib/diagnostics';

const ICON: Record<string, string> = { Completed: '✓', Running: '▶', Waiting: '◷', Paused: 'Ⅱ', Failed: '!', Canceled: '×', Skipped: '–', 'Not observed': '○', Unknown: '?' };
const points = Array.from({ length: 6 }, (_, i) => {
  const angle = (i * 60 - 90) * Math.PI / 180;
  return { x: 300 + 207 * Math.cos(angle), y: 285 + 207 * Math.sin(angle) };
});

/** Fixed geometry; the ring is a stage key. Only recorded transitions get arrows. */
export function WorkflowLifecycle({ workflow, events, base, pause, history }: { workflow: WorkflowView; events: WorkflowEvent[]; base: string; pause?: WorkflowPause; history?: WorkflowHistory }) {
  const [selectedRun, setRun] = useState<number | null>(null);
  const [selectedStage, setStage] = useState(1);
  const marker = useId().replace(/:/g, '');
  const runs = [...new Set([workflow.generation, ...events.map((e) => e.generation)])].sort((a, b) => a - b);
  const run = selectedRun ?? workflow.generation;
  const model = workflowLifecycle(workflow, events, run, pause);
  const stage = model.stages[selectedStage]!;
  return <section aria-label="Workflow lifecycle" className="flex min-w-0 flex-col gap-4" data-testid="workflow-lifecycle">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">Workflow lifecycle</h2>
      <label className="flex items-center gap-2 text-sm">Execution run
        <select className="input" value={run} onChange={(e) => setRun(Number(e.target.value))}>
          {runs.map((n) => <option key={n} value={n}>Run {n}{n === workflow.generation ? ' (latest)' : ''}</option>)}
        </select>
      </label>
    </div>
    <p className="text-sm text-muted-foreground">Fixed stage positions; arrows show recorded paths, not a mandatory sequence. Delivery never restarts triage.</p>
    <div className="lifecycle-illustration relative mx-auto hidden w-full max-w-[660px] sm:block">
      <svg viewBox="0 0 600 570" aria-hidden="true" className="w-full overflow-visible">
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="currentColor" /></marker></defs>
        <circle cx="300" cy="285" r="207" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 8" className="text-border" />
        {model.edges.map(({ from, to, count }) => {
          // Keep arrows inside the nodes and outside the center's text.
          const inner = (i: number) => ({ x: 300 + (points[i]!.x - 300) * 145 / 207, y: 285 + (points[i]!.y - 285) * 145 / 207 });
          const a = inner(from), b = inner(to);
          return <g key={`${from}-${to}`} className="text-primary"><path d={`M ${a.x} ${a.y} A 145 145 0 0 ${to > from ? 1 : 0} ${b.x} ${b.y}`} fill="none" stroke="currentColor" strokeWidth="2" markerEnd={`url(#${marker})`} /><title>{model.stages[from]!.label} to {model.stages[to]!.label}: {count} recorded transitions</title></g>;
        })}
      </svg>
      <div className="pointer-events-none absolute left-1/2 top-1/2 flex w-[38%] -translate-x-1/2 -translate-y-1/2 flex-col gap-1 text-center">
        <span className="text-xs font-semibold uppercase tracking-widest text-primary">Updraft · Run {run}</span>
        <strong className="text-2xl">{workflow.issue !== undefined ? `Issue #${workflow.issue}` : `PR #${workflow.pullRequest ?? '?'}`}</strong>
        <span className="text-sm" data-testid="lifecycle-outcome">{model.outcome.replace(/-/g, ' ')}</span>
        <span className="text-xs text-muted-foreground">{model.elapsedSeconds === undefined ? 'Duration unknown' : `${formatDuration(model.elapsedSeconds)} recorded span`}</span>
        <span className="text-xs">{model.reviews} recorded reviews · {model.revisions} revisions</span>
      </div>
      {model.stages.map((s, i) => <button key={s.label} type="button" aria-pressed={selectedStage === i} aria-controls={`${marker}-details`} onClick={() => setStage(i)}
        className={`lifecycle-node absolute flex w-[29%] -translate-x-1/2 -translate-y-1/2 flex-col gap-1 rounded-xl border bg-card p-3 text-left text-sm shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${s.status === 'Running' ? 'border-primary ring-2 ring-primary' : 'border-border'} ${selectedStage === i ? 'ring-2 ring-primary' : ''}`}
        style={{ left: `${points[i]!.x / 6}%`, top: `${points[i]!.y / 5.7}%` }}>
        <strong>{i + 1}. {s.label}</strong><span>{ICON[s.status]} {s.status}</span>
        <span className="text-xs text-muted-foreground">{s.attempts.length} recorded entries</span>
        {s.attempts.at(-1)?.agent && <span className="truncate text-xs">{s.attempts.at(-1)!.agent} · {s.attempts.at(-1)!.model ?? 'model unknown'}</span>}
        {s.attempts.some((a) => a.durationMs !== undefined) && <span className="text-xs">{formatDuration(Math.round(s.attempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0) / 1000))} reported execution</span>}
      </button>)}
    </div>
    <div className="sm:hidden"><p className="mb-2 text-sm">Run {run}: {model.outcome} · {model.elapsedSeconds === undefined ? 'Duration unknown' : formatDuration(model.elapsedSeconds)} · {model.reviews} recorded reviews · {model.revisions} revisions</p></div>
    <ol className="grid gap-2 sm:sr-only focus-within:not-sr-only" aria-label="Lifecycle stages">
      {model.stages.map((s, i) => <li key={s.label}><button type="button" aria-pressed={selectedStage === i} aria-controls={`${marker}-details`} onClick={() => setStage(i)} className="auth-link text-left">{s.label}: {ICON[s.status]} {s.status} · {s.attempts.length} recorded entries</button></li>)}
    </ol>
    {model.edges.length > 0 && <p className="text-sm" aria-label="Recorded transitions">{model.edges.map((e) => `${model.stages[e.from]!.label} → ${model.stages[e.to]!.label}: ${e.count}`).join(' · ')}</p>}
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">History availability and timing</summary><p className="mt-2">Counts use retained steps and cumulative loop records; individual attempts may be missing. Unobserved stages may be pending, skipped or unavailable. Recorded waits are separate from execution duration. Review approval alone does not establish CI success or merge. Live review-loop jobs do not report their current inner step. Cloud events are retained for {history?.eventRetentionDays ?? 90} days; local-only executions and expired history are unavailable here.{history && ` Showing ${history.shown} events; ${history.omitted} older events omitted.${!history.complete || history.expiredEarlier ? ' History is incomplete.' : ''}`}</p></details>
    <details id={`${marker}-details`} open key={`${run}-${selectedStage}`} className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">{stage.label} · {stage.status} · attempts and outcomes</summary>
      {!stage.attempts.length && <p className="mt-3 text-sm text-muted-foreground">No retained execution details for this stage.</p>}
      <ol className="divide-y divide-border">
        {stage.attempts.map((a) => <li key={a.id} className="flex flex-col gap-1 py-3 text-sm">
          <strong>{a.label}: {ICON[a.status]} {a.status}</strong>
          <span>Reported at {a.event.at} · {a.durationMs === undefined ? 'Execution duration unknown' : formatDuration(Math.round(a.durationMs / 1000))}</span>
          {a.waitSeconds !== undefined && <span>Recorded wait: {formatDuration(a.waitSeconds)} for {a.waitFor?.replace(/_/g, ' ')}</span>}
          <span>Agent: {a.agent ?? 'unknown'} · Provider: {a.adapter ?? 'unknown'} · Model: {a.model ?? 'unknown'}{a.modelSource ? ` (${a.modelSource})` : ''} · Tier: {a.tier ?? 'unknown'}</span>
          {a.event.loop && <span>Job loop snapshot: {a.event.loop.reviews} reviews · {a.event.loop.rounds} revision rounds · verdict {a.event.loop.verdict ?? 'unknown'}</span>}
          <div className="flex flex-wrap gap-4">{a.event.jobId && <Link className="auth-link" to={`${base}/jobs/${a.event.jobId}`}>Job details</Link>}
            {a.event.prUrl && <a className="auth-link" href={a.event.prUrl} target="_blank" rel="noreferrer">Pull request / reviews / checks ↗</a>}</div>
        </li>)}
      </ol>
    </details>
    <a className="auth-link text-sm" href="#workflow-history">All recorded events and interventions below</a>
  </section>;
}
