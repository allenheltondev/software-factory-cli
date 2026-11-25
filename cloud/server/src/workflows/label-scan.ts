/**
 * The missed first label (#136): a labeled issue whose `issues.labeled` delivery never reached
 * Updraft (an outage, a delivery GitHub gave up on) has no job and no workflow, so nothing else
 * would ever look at it. Once an hour per tenant (a few tenants per reconciliation run), this
 * looks on GitHub for open issues of the tenant's configured repositories that carry one of their
 * trigger labels and were updated since the last look, and that have no workflow. For each, the
 * newest application of the label is the event that was missed: it is dispatched as the
 * delivery GitHub would have sent, through the launcher, which checks everything a delivery is
 * checked for (the active config, who applied the label, keys, quotas, the kill switch).
 *
 * Bounded and once only:
 *   - only labels applied more than QUIET_MS ago (a delivery in flight is not raced) and less
 *     than MAX_AGE_MS ago (an old label is a person's decision to leave it, not a missed event);
 *   - each label event is claimed before it is acted on, and its delivery id is derived from it,
 *     so a second scan, a redelivery that arrives late, or two reconcilers start one job at most;
 *   - at most ISSUES_PER_TENANT issues are looked at per tenant and look.
 * A launch the launcher refuses (an actor who may not start work, a label no longer configured)
 * is left as it is: the claim keeps it from being tried again.
 */
import { createHash } from 'node:crypto';
import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import type { LaunchRequest, LaunchResult } from '../jobs/launch.js';
import type { Store } from '../store/store.js';
import type { WorkflowStore } from './store.js';
import { workflowIdFor } from './workflow.js';

export const SCAN_INTERVAL_MS = 60 * 60 * 1000;
export const QUIET_MS = 15 * 60 * 1000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far back the first look at a tenant goes. */
export const FIRST_LOOK_MS = 24 * 60 * 60 * 1000;
const TENANTS_PER_RUN = 5;
const ISSUES_PER_TENANT = 20;

export interface LabelScanReport {
  tenants: number;
  recovered: number;
  refused: number;
  failed: number;
}

export function labelDeliveryId(installationId: number, repositoryId: number, issue: number, eventId: number): string {
  return `label-${createHash('sha256').update(`${installationId}:${repositoryId}:${issue}:${eventId}`).digest('hex').slice(0, 32)}`;
}

export function createLabelScanner(deps: {
  tenants: Pick<Store, 'listTenants' | 'getConfigVersion'>;
  store: WorkflowStore;
  github: Pick<GitHubApi, 'createInstallationToken' | 'labeledIssues' | 'latestLabelEvent'>;
  loadSettings: LoadSettings;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
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
          const age = at - Date.parse(ev.createdAt);
          if (!(age >= QUIET_MS && age <= MAX_AGE_MS)) continue;
          if (!(await deps.store.claimLabelEvent(installationId, rules.id, ev.id))) continue;
          const payload = {
            action: 'labeled',
            issue: { number: issue.number, title: issue.title, html_url: issue.htmlUrl, state: 'open', labels: issue.labels.map((name) => ({ name })) },
            label: { name: ev.label },
            repository: { id: rules.id, full_name: repository },
            sender: { login: ev.actor ?? '' },
            installation: { id: installationId },
          };
          const result = await deps.launch({
            installationId,
            deliveryId: labelDeliveryId(installationId, rules.id, issue.number, ev.id),
            eventName: 'issues',
            body: JSON.stringify(payload),
            payload: payload as unknown as LaunchRequest['payload'],
          });
          if (result.disposition === 'launched' || result.disposition === 'coalesced') {
            report.recovered++;
            const message = `The label ${ev.label} was applied${ev.actor ? ` by @${ev.actor}` : ''} without its event reaching Updraft: started the job that event would have.`;
            await deps.store.addWorkflowEvent(installationId, workflowId, { id: `label-recovered:${ev.id}`, at: new Date(at).toISOString(), kind: 'label_recovered', generation: 1, ...(result.jobId ? { jobId: result.jobId } : {}), message });
          } else {
            report.refused++;
          }
          log({ installationId, repository, issue: issue.number, labelEvent: ev.id, labelScan: result.disposition, ...(result.reason ? { reason: result.reason } : {}) });
        }
      }
    }
  }

  return async function scanLabels(): Promise<LabelScanReport> {
    const report: LabelScanReport = { tenants: 0, recovered: 0, refused: 0, failed: 0 };
    if (!deps.github.labeledIssues || !deps.github.latestLabelEvent) return report;
    const at = now();
    const due: { installationId: number; version: number; since: string; mark: number }[] = [];
    for (const t of await deps.tenants.listTenants()) {
      if (t.status !== 'active' || t.activeConfigVersion === undefined) continue;
      const mark = await deps.store.getScanMark(t.installationId);
      const last = mark ? Date.parse(mark) : 0;
      if (at - last < SCAN_INTERVAL_MS) continue;
      // The look overlaps the last one by an interval, so an issue updated around it is not missed.
      due.push({ installationId: t.installationId, version: t.activeConfigVersion, since: new Date(mark ? last - SCAN_INTERVAL_MS : at - FIRST_LOOK_MS).toISOString(), mark: last });
    }
    // The longest unlooked-at first.
    due.sort((a, b) => a.mark - b.mark);
    for (const t of due.slice(0, TENANTS_PER_RUN)) {
      report.tenants++;
      try {
        await scanTenant(t.installationId, t.version, at, t.since, report);
        await deps.store.setScanMark(t.installationId, new Date(at).toISOString());
      } catch (err) {
        report.failed++;
        log({ installationId: t.installationId, error: 'label scan failed', name: (err as Error)?.name, message: (err as Error)?.message });
        // Tried again at the next interval, not every run: one failing tenant cannot crowd out the others.
        await deps.store.setScanMark(t.installationId, new Date(at).toISOString()).catch(() => {});
      }
    }
    return report;
  };
}
