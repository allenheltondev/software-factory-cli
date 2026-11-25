import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@readysetcloud/ui';
import type { ApiClient, JobView } from '../api/client';

export function JobStopStatus({ job }: { job: JobView }) {
  if (!job.stop) return null;
  const stop = job.stop;
  return <div className="mt-3 space-y-2 text-sm" aria-live="polite">
    <p>{stop.confirmedAt === undefined ? 'Stopping… Requested' : job.outcome === 'canceled' ? 'Canceled. Requested' : 'Execution ended. Stop requested'} by {stop.by} on {new Date(stop.requestedAt).toLocaleString()}. {stop.reason}</p>
    {stop.confirmedAt === undefined && <p>Execution has not yet been confirmed stopped. Automatic continuation is paused.</p>}
    {stop.confirmedAt !== undefined && stop.resumedAt === undefined && <p>Automatic continuation is paused until an owner resumes automation or retries this job.</p>}
    {stop.resumedAt !== undefined && <p>Automation resumed by {stop.resumedBy} on {new Date(stop.resumedAt).toLocaleString()}. This job remains stopped.</p>}
    {stop.error && <Alert variant="error">{stop.error}</Alert>}
    {stop.reconnectRequired && <p>The worker session required termination. Reconnect Claude before retrying this job.</p>}
  </div>;
}

/** A secondary card action. The native modal provides focus trapping and Escape handling. */
export function JobActions({ job, installationId, api, onRefresh }: {
  job: JobView; installationId: number; api: Partial<Pick<ApiClient, 'stopJob' | 'resumeJob' | 'cancelQueuedJob'>>; onRefresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [accepted, setAccepted] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => { if (confirm) dialog.current?.showModal(); }, [confirm]);
  if (!(job.canStop && api.stopJob) && !(job.canResume && api.resumeJob) && !(job.canCancel && api.cancelQueuedJob)) return null;
  // Queued work has nothing running: canceling it ends the wait (nothing to stop, nothing to confirm).
  const cancelQueued = async () => {
    setBusy(true); setError(undefined);
    try { await api.cancelQueuedJob!(installationId, job.jobId); if (menu.current) menu.current.open = false; onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not cancel the queued job.'); }
    finally { setBusy(false); }
  };
  const close = () => { dialog.current?.close(); setConfirm(false); trigger.current?.focus(); };
  const stop = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.stopJob!(installationId, job.jobId);
      setAccepted(true); close(); onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not request a stop. Try again.'); }
    finally { setBusy(false); }
  };
  const target = `${job.repository}#${job.issue ?? job.pullRequest ?? '?'}`;
  const resume = async () => {
    setBusy(true); setError(undefined);
    try { await api.resumeJob!(installationId, job.jobId); if (menu.current) menu.current.open = false; onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not resume automation.'); }
    finally { setBusy(false); }
  };
  return <div className="relative text-sm">
    <details ref={menu}>
      <summary ref={trigger} className="auth-link inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded border border-border" aria-label={`Actions for ${target}`} title="Actions">⋯</summary>
      <div className="absolute right-0 z-10 min-w-40 rounded border border-border bg-surface p-2 shadow-lg">
        {job.canStop && api.stopJob && <button type="button" className="min-h-11 w-full rounded px-3 text-left text-error-600 hover:bg-muted dark:text-error-400" onClick={() => { if (menu.current) menu.current.open = false; if (job.stop?.confirmedAt !== undefined) void stop(); else setConfirm(true); }}>{job.stop?.confirmedAt !== undefined ? 'Retry cleanup' : job.stop ? 'Retry stop' : 'Stop job'}</button>}
        {job.canCancel && api.cancelQueuedJob && <><button type="button" className="min-h-11 w-full rounded px-3 text-left text-error-600 hover:bg-muted dark:text-error-400" disabled={busy} onClick={() => void cancelQueued()}>Cancel queued job</button><p className="px-3 text-xs">It has not started. Apply the label again on GitHub to queue it later.</p></>}
        {job.canResume && api.resumeJob && <><button type="button" className="min-h-11 w-full rounded px-3 text-left hover:bg-muted" disabled={busy} onClick={() => void resume()}>Resume automation</button><p className="px-3 text-xs">Allow future GitHub events to continue. This job stays stopped.</p></>}
      </div>
    </details>
    {accepted && !job.stop && <p role="status">Stop request recorded. Refreshing status…</p>}
    {error && !confirm && <Alert variant="error">{error}</Alert>}
    {confirm && <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => { setConfirm(false); trigger.current?.focus(); }} aria-labelledby={`stop-title-${job.jobId}`} aria-describedby={`stop-help-${job.jobId}`} className="modal p-6">
      <h2 id={`stop-title-${job.jobId}`} className="text-xl font-semibold">Stop job?</h2>
      <p className="mt-3 break-words font-medium">{target}</p>
      <p className="mt-1 break-all text-xs">{job.jobId}</p>
      <p id={`stop-help-${job.jobId}`} className="mt-3">Active execution will stop. Existing commits, pull requests and logs are preserved. Automatic continuation is paused until an owner explicitly resumes or retries. A Claude session may need reconnecting if it cannot stop safely.</p>
      {error && <Alert variant="error" className="mt-3">{error}</Alert>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={close} disabled={busy} autoFocus>Keep running</Button>
        <Button variant="error" onClick={() => void stop()} disabled={busy}>{busy ? 'Requesting stop…' : 'Stop job'}</Button>
      </div>
    </dialog>}
  </div>;
}
