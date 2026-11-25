import { describe, expect, it } from 'vitest';
import { METRICS_NAMESPACE, reconcileMetricsLine } from './metrics.js';

describe('reconciliation metrics', () => {
  it('writes one Embedded Metric Format line with every count of the run', () => {
    const line = JSON.parse(
      reconcileMetricsLine(
        { checked: 3, repaired: 1, blocked: 1, finished: 0, failed: 1, backlog: 4, oldestDueSeconds: 600 },
        { tenants: 2, flagged: 1, failed: 1 },
        1_700_000_000_000,
      ),
    );
    expect(line._aws).toMatchObject({ Timestamp: 1_700_000_000_000, CloudWatchMetrics: [{ Namespace: METRICS_NAMESPACE, Dimensions: [[]] }] });
    const names = line._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name);
    for (const name of names) expect(typeof line[name]).toBe('number');
    expect(line).toMatchObject({ Runs: 1, Checked: 3, Failed: 2, Backlog: 4, OldestDueSeconds: 600, LabelMissed: 1 });
    expect(line._aws.CloudWatchMetrics[0].Metrics).toContainEqual({ Name: 'OldestDueSeconds', Unit: 'Seconds' });
  });
});
