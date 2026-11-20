import type { DispatchRules } from '../store/store.js';

/**
 * Which labeled issues of a tenant start a job (#68, the launcher's filter). Computed from the
 * compiled config when it is published and stored with the version, so the launcher decides
 * without reading the bundle, and changing it takes a publish, not a deploy.
 *
 * Like the self-hosted launcher's filter this is an optimisation, not the authority: `updraft
 * run-event` in the microVM decides again, against GitHub and the same config. What it must never
 * do is start a job the config would not: an unknown repository, a label that is no trigger, an
 * actor who is not allowed.
 */

type Workflow = { trigger?: { label?: unknown }; allowedActors?: unknown };
type Repository = { id?: unknown; workflows?: unknown };

const lowerStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '').map((v) => v.toLowerCase()) : [];

/** From a compiled (validated) config: `repositories` and `dispatch.allowedActors`. */
export function dispatchRules(compiled: { repositories?: Record<string, unknown>; dispatch?: { allowedActors?: unknown } }): DispatchRules {
  const fallbackActors = lowerStrings(compiled.dispatch?.allowedActors);
  const repositories: DispatchRules['repositories'] = {};
  for (const [fullName, raw] of Object.entries(compiled.repositories ?? {})) {
    const repo = raw as Repository;
    if (typeof repo.id !== 'number') continue;
    const triggers: DispatchRules['repositories'][string]['triggers'] = [];
    for (const wf of Array.isArray(repo.workflows) ? (repo.workflows as Workflow[]) : []) {
      const label = wf.trigger?.label;
      if (typeof label !== 'string' || label === '') continue;
      triggers.push({ label: label.toLowerCase(), actors: wf.allowedActors === undefined ? fallbackActors : lowerStrings(wf.allowedActors) });
    }
    repositories[fullName.toLowerCase()] = { id: repo.id, triggers };
  }
  return { repositories };
}

export type DispatchDecision = { start: true; repository: string; repositoryId: number; label: string } | { start: false; reason: string };

/**
 * Whether an `issues.labeled` delivery starts a job under these rules. The repository must match
 * by name and id (a renamed or recreated repository is not the configured one).
 */
export function decideDispatch(
  rules: DispatchRules | undefined,
  event: { repositoryFullName: unknown; repositoryId: unknown; label: unknown; sender: unknown },
): DispatchDecision {
  if (!rules) return { start: false, reason: 'the active config has no dispatch rules (publish it again)' };
  if (typeof event.repositoryFullName !== 'string' || typeof event.repositoryId !== 'number') return { start: false, reason: 'no repository in the event' };
  const repository = event.repositoryFullName.toLowerCase();
  const repo = rules.repositories[repository];
  if (!repo || repo.id !== event.repositoryId) return { start: false, reason: 'the repository is not in the active config' };
  if (typeof event.label !== 'string' || event.label === '') return { start: false, reason: 'no label in the event' };
  const label = event.label.toLowerCase();
  const matching = repo.triggers.filter((t) => t.label === label);
  if (matching.length === 0) return { start: false, reason: 'the label is not a trigger' };
  const sender = typeof event.sender === 'string' ? event.sender.toLowerCase() : '';
  if (!matching.some((t) => t.actors.includes(sender))) return { start: false, reason: 'the sender may not dispatch work' };
  return { start: true, repository: event.repositoryFullName, repositoryId: event.repositoryId, label: event.label };
}
