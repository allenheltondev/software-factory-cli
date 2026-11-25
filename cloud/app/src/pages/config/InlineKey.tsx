import { useState, type FormEvent } from 'react';
import { Button, PasswordInput } from '@readysetcloud/ui';
import type { AgentAdapter, AgentKeysView, ApiClient } from '../../api/client';
import { AGENT_GUIDES } from '../../lib/agentGuides';
import { PROVIDERS } from '../AgentKeysPage';
import { KEY_FOR } from './model';

export type KeyApi = Pick<ApiClient, 'setAgentKey'>;

/**
 * An agent's API key, added where the agent is chosen: checked with the provider and saved
 * write-only, as on the Agent keys page, without leaving the draft. `onSaved` gets which keys
 * are set now.
 */
export function InlineKey({ adapter, installationId, api, onSaved }: { adapter: AgentAdapter; installationId: number; api: KeyApi; onSaved: (keys: Record<string, boolean>) => void }) {
  const name = KEY_FOR[adapter];
  const provider = PROVIDERS[name];
  const guide = AGENT_GUIDES[adapter];
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = value.trim();
  const problem = typed && provider ? provider.problem(typed) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!typed || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const view: AgentKeysView = await api.setAgentKey(installationId, name, typed);
      setValue('');
      onSaved(Object.fromEntries(view.keys.map((k) => [k.name, k.configured])));
    } catch (err) {
      // The typed value stays, so a typo or a transient failure is fixed in place.
      setError(err instanceof Error ? err.message : 'Could not save the key. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void save(e)} data-testid={`inline-key-${adapter}`}>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:flex-1">
          <PasswordInput
            label={guide.credential}
            autoComplete="off"
            spellCheck={false}
            placeholder={provider?.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            {...(error ? { error } : problem ? { error: problem } : {})}
          />
        </div>
        <Button type="submit" loading={busy} disabled={!typed || !!problem}>
          Save key
        </Button>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{provider?.checkedOnSave === false ? 'Saved, then never shown again.' : `Checked with ${provider?.company ?? 'the provider'}, then never shown again.`}</span>
        <a className="auth-link" href={guide.getKeyUrl} target="_blank" rel="noreferrer">
          Get a key ↗
        </a>
        {guide.note && <span className="w-full">{guide.note}</span>}
      </p>
    </form>
  );
}
