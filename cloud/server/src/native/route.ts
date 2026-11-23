import { createHmac } from 'node:crypto';

// Persistent VMs have no per-job provider lifetime. A lease deadline is not proof
// that execution stopped. These quota holds require explicit confirmed release.
export const NATIVE_SLOT_HOLD_UNTIL = Date.UTC(9999, 0, 1);

/** Operator-only, single test route. An absent route leaves BYOK dispatch unchanged. */
export interface NativeRoute {
  installationId: number;
  repositoryId: number;
  repository: string;
  labels: string[];
  workerId: string;
  microvmId: string;
  imageVersion: string;
  controlSecretArn: string;
}

export function nativeRoute(text: string | undefined): NativeRoute | undefined {
  if (!text?.trim()) return undefined;
  const r = JSON.parse(text) as NativeRoute;
  if (!r || typeof r !== 'object' || Object.keys(r).sort().join(',') !== 'controlSecretArn,imageVersion,installationId,labels,microvmId,repository,repositoryId,workerId' ||
      !Number.isSafeInteger(r.installationId) || r.installationId <= 0 || !Number.isSafeInteger(r.repositoryId) || r.repositoryId <= 0 ||
      typeof r.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.repository) || typeof r.workerId !== 'string' || !/^[\w-]{1,64}$/.test(r.workerId) ||
      typeof r.microvmId !== 'string' || !/^[\w:-]{1,200}$/.test(r.microvmId) ||
      typeof r.imageVersion !== 'string' || !/^[\w.-]{1,64}$/.test(r.imageVersion) ||
      !Array.isArray(r.labels) || r.labels.length === 0 || r.labels.some((l) => typeof l !== 'string' || !l.trim()) ||
      typeof r.controlSecretArn !== 'string' || !/^arn:[\w-]+:secretsmanager:[\w-]+:\d{12}:secret:updraft\/native-workers\//.test(r.controlSecretArn)) {
    throw new Error('invalid native worker route');
  }
  return r;
}

export const nativeJobToken = (secret: string, jobId: string) => createHmac('sha256', secret).update(`updraft-native-job:${jobId}`).digest('base64url');

export function matchesNativeRoute(r: NativeRoute, installationId: number, d: { repositoryId: number; repository: string; label?: string }): boolean {
  return r.installationId === installationId && r.repositoryId === d.repositoryId && r.repository.toLowerCase() === d.repository.toLowerCase() &&
    typeof d.label === 'string' && r.labels.some((l) => l.toLowerCase() === d.label!.toLowerCase());
}
