/**
 * The missed first label (#136): a labeled issue whose `issues.labeled` delivery never reached
 * Updraft (an outage, a delivery GitHub gave up on) has no job and no workflow, so nothing else
 * would ever look at it. Once an hour per tenant (a few tenants per reconciliation run), this
 * looks on GitHub for open issues of the tenant's configured repositories that carry one of their
 * trigger labels, were updated since the last successful look, and have no workflow.
 *
 * It never starts a job. A replay cannot be made safe: GitHub's delivery names no label event, so
 * a late real delivery and a replay could not share a claim, and an issue's job from before
 * workflows were recorded (or one whose recording failed) has no workflow either. So it only
 * reports: when neither a delivery nor a job for the issue reached Updraft since the label was
 * applied (its delivery records and job records, both kept 30 days), the issue gets a blocked
 * workflow saying the label's event was missed, and that applying the label again starts it. A
 * delivery that arrives after all starts the job as any would, and the workflow with it.
 *
 * Bounded: only labels applied more than QUIET_MS ago (a delivery in flight is not raced) and less
 * than MAX_AGE_MS ago, at most ISSUES_PER_TENANT issues per tenant and look. A look that fails is
 * tried again at the next interval, from where the last successful look left off.
 */
import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import type { Store } from '../store/store.js';
import { updateWorkflow } from './recorder.js';
import type { WorkflowStore } from './store.js';
import { newWorkflow, workflowIdFor } from './workflow.js';

export const SCAN_INTERVAL_MS = 60 * 60 * 1000;
export const QUIET_MS = 15 * 60 * 1000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far back the first look at a tenant goes. */
export const FIRST_LOOK_MS = 24 * 60 * 60 * 1000;
const TENANTS_PER_RUN = 5;
const ISSUES_PER_TENANT = 20;

/** How far a job's or a delivery's time may be before the label event's and still count as its delivery (clock skew). */
export const EVIDENCE_SKEW_MS = 10 * 60 * 1000;
/** Job and delivery records read per tenant look. */
const EVIDENCE_LIMIT = 500;

export interface LabelScanReport {
  tenants: number;
  /** Issues whose label event was missed: given a blocked workflow. */
  flagged: number;
  failed: number;
}

export function createLabelScanner(deps: {
  tenants: Pick<Store, 'listTenants' | 'getConfigVersion' | 'listRecentJobs' | 'listDeliveries'>;
  store: WorkflowStore;
  github: Pick<GitHubApi, 'createInstallationToken' | 'labeledIssues' | 'latestLabelEvent'>;
  loadSettings: LoadSettings;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  async function scanTenant(installationId: number, configVersion: number, at: number, since: string, report: LabelScanReport): Promise<void> {
    const config = await deps.tenants.getConfigVersion(installationId, configVersion);
    const repos = Object.entries(config?.dispatch?.repositories ?? {}).filter(([, r]) => !r.paused && r.triggers.length);
    const settings = await deps.loadSettings();
    if (!settings) throw new Error('the App settings are unavailable');
    // What reached Updraft for each issue: its deliveries (filtered ones too) and its jobs.
    const [jobs, deliveries] = await Promise.all([deps.tenants.listRecentJobs(installationId, EVIDENCE_LIMIT), deps.tenants.listDeliveries(installationId, EVIDENCE_LIMIT)]);
    const seen = new Map<string, number>();
    const note = (repo: string | undefined, issue: number | undefined, at: string) => {
      if (!repo || issue === undefined) return;
      const key = `${repo.toLowerCase()}#${issue}`;
      seen.set(key, Math.max(seen.get(key) ?? 0, Date.parse(at)));
    };
    for (const j of jobs) note(j.repository, j.issue, j.createdAt);
    for (const d of deliveries) note(d.repository, d.issue, d.at);
    let budget = ISSUES_PER_TENANT;
    for (const [repository, rules] of repos) {
      if (budget <= 0) break;
      const { token } = await deps.github.createInstallationToken(appJwt(settings.appId, settings.privateKey, at), installationId, { repositoryIds: [rules.id], permissions: { issues: 'read' } });
      // GitHub compares labels without regard to case: one look per label.
      const labels = rules.triggers.map((t) => t.label).filter((l, i, all) => all.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === i);
      for (const label of labels) {
        if (budget <= 0) break;
        for (const issue of await deps.github.labeledIssues!(token, repository, label, since, budget)) {
          if (budget-- <= 0) break;
          const workflowId = workflowIdFor(rules.id, { issue: issue.number })!;
          if (await deps.store.getWorkflow(installationId, workflowId)) continue;
          const ev = await deps.github.latestLabelEvent!(token, repository, issue.number, label);
          if (!ev) continue;
          const labeledAt = Date.parse(ev.createdAt);
          const age = at - labeledAt;
          if (!(age >= QUIET_MS && age <= MAX_AGE_MS)) continue;
          // A delivery or a job for the issue since the label was applied: its event reached Updraft.
          if ((seen.get(`${repository.toLowerCase()}#${issue.number}`) ?? 0) >= labeledAt - EVIDENCE_SKEW_MS) continue;
          const message = `The label ${ev.label} was applied${ev.actor ? ` by @${ev.actor}` : ''} on ${ev.createdAt}, but its event never reached Updraft, so no job started.`;
          const flagged = await updateWorkflow(deps.store, installationId, workflowId, (w) =>
            w
              ? null
              : {
                  workflow: {
                    ...newWorkflow({ installationId, repository, repositoryId: rules.id, issue: issue.number }, workflowId, at),
                    status: 'blocked',
                    stage: 'implementing',
                    reason: 'label_event_missed',
                    message,
                    nextAction: `Remove the label ${ev.label} and apply it again on GitHub to start the job.`,
                  },
                  event: { id: `label-missed:${ev.id}`, at: new Date(at).toISOString(), kind: 'label_missed', generation: 1, message },
                },
          );
          if (flagged?.reason === 'label_event_missed' && flagged.version === 1) report.flagged++;
          log({ installationId, repository, issue: issue.number, labelEvent: ev.id, labelScan: 'missed' });
        }
      }
    }
  }

  return async function scanLabels(): Promise<LabelScanReport> {
    const report: LabelScanReport = { tenants: 0, flagged: 0, failed: 0 };
    if (!deps.github.labeledIssues || !deps.github.latestLabelEvent) return report;
    const at = now();
    const due: { installationId: number; version: number; since: string; tried: number }[] = [];
    for (const t of await deps.tenants.listTenants()) {
      if (t.status !== 'active' || t.activeConfigVersion === undefined) continue;
      const mark = await deps.store.getScanMark(t.installationId);
      const tried = mark ? Date.parse(mark.at) : 0;
      if (at - tried < SCAN_INTERVAL_MS) continue;
      // From the last look that succeeded, overlapping it by an interval, so nothing updated around it is missed.
      const from = mark?.succeededAt ? Date.parse(mark.succeededAt) - SCAN_INTERVAL_MS : at - FIRST_LOOK_MS;
      due.push({ installationId: t.installationId, version: t.activeConfigVersion, since: new Date(Math.max(from, at - MAX_AGE_MS)).toISOString(), tried });
    }
    // The longest unlooked-at first.
    due.sort((a, b) => a.tried - b.tried);
    for (const t of due.slice(0, TENANTS_PER_RUN)) {
      report.tenants++;
      const iso = new Date(at).toISOString();
      try {
        await scanTenant(t.installationId, t.version, at, t.since, report);
        await deps.store.setScanMark(t.installationId, { at: iso, succeededAt: iso });
      } catch (err) {
        report.failed++;
        log({ installationId: t.installationId, error: 'label scan failed', name: (err as Error)?.name, message: (err as Error)?.message });
        // Tried again at the next interval, not every run, and from where the last successful look left off.
        const previous = await deps.store.getScanMark(t.installationId).catch(() => null);
        await deps.store.setScanMark(t.installationId, { at: iso, ...(previous?.succeededAt ? { succeededAt: previous.succeededAt } : {}) }).catch(() => {});
      }
    }
    return report;
  };
}
