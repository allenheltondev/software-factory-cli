import { createHmac } from 'node:crypto';

// Persistent VMs have no per-job provider lifetime. A lease deadline is not proof
// that execution stopped. These quota holds require explicit confirmed release.
export const NATIVE_SLOT_HOLD_UNTIL = Date.UTC(9999, 0, 1);

export interface NativeTrigger {
  repositoryId: number;
  repository: string;
  label: string;
}

/** Operator-pinned worker identity. Older deployments may also have a static trigger allowlist. */
export interface NativeRoute {
  /** Internal generation for an AWS-managed disposable session. */
  generation?: string;
  installationId: number;
  repositoryId?: number;
  repository?: string;
  labels?: string[];
  workerId: string;
  microvmId: string;
  imageVersion: string;
  controlSecretArn: string;
}

export function nativeRoute(text: string | undefined): NativeRoute | undefined {
  if (!text?.trim()) return undefined;
  const r = JSON.parse(text) as NativeRoute;
  if (!r || typeof r !== 'object' ||
      !Number.isSafeInteger(r.installationId) || r.installationId <= 0 || typeof r.workerId !== 'string' || !/^[\w-]{1,64}$/.test(r.workerId) ||
      typeof r.microvmId !== 'string' || !/^[\w:-]{1,200}$/.test(r.microvmId) ||
      typeof r.imageVersion !== 'string' || !/^[\w.-]{1,64}$/.test(r.imageVersion) ||
      typeof r.controlSecretArn !== 'string' || !/^arn:[\w-]+:secretsmanager:[\w-]+:\d{12}:secret:updraft\/native-workers\//.test(r.controlSecretArn)) {
    throw new Error('invalid native worker route');
  }
  const keys = Object.keys(r).sort().join(',');
  if (keys === 'controlSecretArn,imageVersion,installationId,microvmId,workerId') return r;
  if (keys !== 'controlSecretArn,imageVersion,installationId,labels,microvmId,repository,repositoryId,workerId' ||
      typeof r.repositoryId !== 'number' || !Number.isSafeInteger(r.repositoryId) || r.repositoryId <= 0 ||
      typeof r.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.repository) ||
      !Array.isArray(r.labels) || r.labels.length === 0 || r.labels.some((l) => typeof l !== 'string' || !l.trim())) {
    throw new Error('invalid native worker route');
  }
  return r;
}

export function legacyNativeTriggers(route: NativeRoute): NativeTrigger[] {
  const { repositoryId, repository, labels } = route;
  if (repositoryId === undefined || repository === undefined || labels === undefined) return [];
  return labels.map((label) => ({ repositoryId, repository, label }));
}

export function sameNativeRepository(a: Pick<NativeTrigger, 'repositoryId' | 'repository'>, b: Pick<NativeTrigger, 'repositoryId' | 'repository'>) {
  return a.repositoryId === b.repositoryId && a.repository.toLowerCase() === b.repository.toLowerCase();
}

export function sameNativeTrigger(a: NativeTrigger, b: { repositoryId: number; repository: string; label?: string }) {
  return sameNativeRepository(a, b) && a.label.toLowerCase() === b.label?.toLowerCase();
}

export const nativeJobToken = (secret: string, jobId: string) => createHmac('sha256', secret).update(`updraft-native-job:${jobId}`).digest('base64url');
