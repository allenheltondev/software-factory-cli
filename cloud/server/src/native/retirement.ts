import type { RetirementReason } from './sessions.js';

/**
 * What a managed session's retirement means for the work waiting on it (#176).
 *
 * The Claude login lives only on the session VM's ephemeral disk: no credential is ever copied
 * to another VM, image or record. So a replacement environment can never inherit the old one's
 * sign-in, and there is no retirement after which Updraft could start a replacement and run the
 * job unattended: starting one would only spend a launch and wait for the same sign-in. A person
 * is asked exactly when that sign-in is needed, which is after every retirement; routine,
 * compatible image rollouts must therefore never cause one (claude-image-rollouts.md).
 */
export const REPLACEMENT_KEEPS_SIGN_IN = false;

const WORDS: Record<RetirementReason, string> = {
  reconnect: 'an owner reconnected it',
  idle: 'it was idle for its whole idle limit',
  lifetime: 'it reached its maximum lifetime',
  'vm-ended': 'its VM stopped running before its lifetime ended',
  expired: 'its VM ended or it reached its maximum lifetime',
  suspended: 'its VM was suspended, and it is never resumed',
  'worker-lost': 'its worker stopped answering',
  disabled: 'an operator paused Claude connections',
  'startup-failed': 'it never became ready',
  'image-revoked': 'its image was revoked',
  'image-blocked': 'its image was no longer approved before it started',
};

/** A known reason's words for people; anything else (a newer writer's reason) is named as is. */
export function retirementWords(reason: string | undefined): string {
  if (!reason) return 'it was retired';
  return (WORDS as Record<string, string>)[reason] ?? `it was retired (${reason})`;
}

/** The reason as a timeline code: `claude_session_<reason>`, in the timeline's own style. */
export const retirementCode = (reason: string | undefined) =>
  `claude_session_${/^[a-z][a-z-]{0,39}$/.test(reason ?? '') ? reason!.replace(/-/g, '_') : 'retired'}`;
