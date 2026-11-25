/**
 * What a workflow reconciliation run did, as CloudWatch metrics (Embedded Metric Format: one JSON
 * log line that CloudWatch turns into metrics, so no API call and no permission is needed). In
 * namespace Updraft/Workflows, without dimensions. The stack's alarms watch Runs, Failed and
 * OldestDueSeconds (infra/template.yaml); the runbook is in cloud/README.md.
 */
import type { LabelScanReport } from './label-scan.js';
import type { ReconcileReport } from './reconcile.js';

export const METRICS_NAMESPACE = 'Updraft/Workflows';

export function reconcileMetricsLine(report: ReconcileReport, labels: LabelScanReport, at: number): string {
  const values: Record<string, { value: number; unit: 'Count' | 'Seconds' }> = {
    Runs: { value: 1, unit: 'Count' },
    Checked: { value: report.checked, unit: 'Count' },
    Recovered: { value: report.recovered, unit: 'Count' },
    Repaired: { value: report.repaired, unit: 'Count' },
    Blocked: { value: report.blocked, unit: 'Count' },
    Finished: { value: report.finished, unit: 'Count' },
    Failed: { value: report.failed + labels.failed, unit: 'Count' },
    Backlog: { value: report.backlog, unit: 'Count' },
    OldestDueSeconds: { value: report.oldestDueSeconds, unit: 'Seconds' },
    LabelTenants: { value: labels.tenants, unit: 'Count' },
    LabelRecovered: { value: labels.recovered, unit: 'Count' },
    LabelRefused: { value: labels.refused, unit: 'Count' },
  };
  return JSON.stringify({
    _aws: {
      Timestamp: at,
      CloudWatchMetrics: [{ Namespace: METRICS_NAMESPACE, Dimensions: [[]], Metrics: Object.entries(values).map(([Name, v]) => ({ Name, Unit: v.unit })) }],
    },
    workflowReconcile: true,
    ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value])),
  });
}
