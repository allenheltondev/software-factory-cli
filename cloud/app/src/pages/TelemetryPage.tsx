import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  PageHero,
  PageHeroChip,
  PageHeroChips,
  PageHeroSubtitle,
  PageHeroTitle,
  PasswordInput,
  SegmentedControl,
  Skeleton,
  StatusBadge,
} from '@readysetcloud/ui';
import { api as defaultApi, type ApiClient, type TelemetryRegion, type TelemetryView } from '../api/client';
import { relativeTime } from '../lib/time';

type Api = Pick<ApiClient, 'telemetry' | 'updateTelemetry' | 'setTelemetryKey' | 'removeTelemetryKey'>;
type Load = { state: 'loading' } | { state: 'ok'; view: TelemetryView } | { state: 'error'; message: string };

const exact = (iso: string) => new Date(iso).toLocaleString();
const KEYS_DOCS = 'https://docs.honeycomb.io/configure/environments/manage-api-keys/';
const TIMELINE_DOCS = 'https://docs.honeycomb.io/investigate/observe/agent-timeline';
const SERVICE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Agent telemetry settings: send what each job's agents did to the installation's own Honeycomb,
 * as OpenTelemetry GenAI spans, and watch it in Agent Timeline. A key is pasted once, checked
 * with Honeycomb, and never shown again; the rest is on or off, the dataset, and whether prompts
 * and outputs are recorded.
 */
export function TelemetryPage({ api = defaultApi }: { api?: Api }) {
  const { id } = useParams();
  const installationId = Number(id);
  const valid = Number.isSafeInteger(installationId) && installationId > 0;
  const [fetched, setLoad] = useState<Load>({ state: 'loading' });
  const load: Load = valid ? fetched : { state: 'error', message: 'There is no installation at this address.' };

  useEffect(() => {
    if (!valid) return;
    let live = true;
    api.telemetry(installationId).then(
      (view) => live && setLoad({ state: 'ok', view }),
      (err: unknown) => live && setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Could not load the settings.' }),
    );
    return () => {
      live = false;
    };
  }, [api, installationId, valid]);

  const set = (view: TelemetryView) => setLoad({ state: 'ok', view });

  return (
    <div className="flex flex-col gap-6">
      <Link className="auth-link" to={`/installations/${id}`}>
        ← Installation
      </Link>
      {load.state === 'loading' && <Skeleton className="h-48" data-testid="telemetry-loading" />}
      {load.state === 'error' && (
        <Alert variant="error" data-testid="telemetry-error">
          {load.message}
        </Alert>
      )}
      {load.state === 'ok' && (
        <>
          <Hero view={load.view} />
          <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
            <div className="flex flex-col gap-6">
              <KeyCard view={load.view} api={api} installationId={installationId} onSaved={set} />
              {load.view.keyConfigured && <SettingsCard view={load.view} api={api} installationId={installationId} onSaved={set} />}
            </div>
            <div className="flex flex-col gap-6">
              <LastExport view={load.view} installationId={installationId} />
              <HowItWorks />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Hero({ view }: { view: TelemetryView }) {
  const state = !view.keyConfigured ? { label: 'Not set up', tone: 'neutral' as const } : view.enabled ? { label: 'Sending', tone: 'success' as const } : { label: 'Paused', tone: 'warning' as const };
  return (
    <PageHero data-testid="telemetry">
      <PageHeroTitle>Agent telemetry</PageHeroTitle>
      <PageHeroSubtitle>
        See what your agents are doing: every model call, tool call and review round, in order, in Honeycomb's Agent Timeline. Each issue is one conversation, from the first change through every review and
        revision.
      </PageHeroSubtitle>
      <PageHeroChips>
        <PageHeroChip tone={state.tone} data-testid="telemetry-state">
          {state.label}
        </PageHeroChip>
        <PageHeroChip>Honeycomb {view.region.toUpperCase()}</PageHeroChip>
        {view.keyConfigured && <PageHeroChip>Dataset {view.serviceName}</PageHeroChip>}
        {view.keyConfigured && <PageHeroChip>{view.captureContent ? 'With prompts and outputs' : 'Metadata only'}</PageHeroChip>}
      </PageHeroChips>
      {view.environmentUrl && (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <a className="auth-link font-semibold" href={view.environmentUrl} target="_blank" rel="noreferrer" data-testid="telemetry-open">
            Open Honeycomb ↗
          </a>
          <span className="text-muted-foreground">Then AI Ecosystem → Conversations, and pick an issue.</span>
        </div>
      )}
    </PageHero>
  );
}

function KeyCard({ view, api, installationId, onSaved }: { view: TelemetryView; api: Api; installationId: number; onSaved: (v: TelemetryView) => void }) {
  const [editing, setEditing] = useState(!view.keyConfigured);
  const [value, setValue] = useState('');
  const [region, setRegion] = useState<TelemetryRegion>(view.region);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const typed = value.trim();
  const problem = typed && !/^[A-Za-z0-9_-]{16,128}$/.test(typed) ? 'A Honeycomb key is letters, digits, dashes and underscores (an Ingest key starts with hcaik_ or hcxik_).' : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!typed || problem) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setTelemetryKey(installationId, typed, region));
      setValue('');
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.removeTelemetryKey(installationId));
      setEditing(true);
      setSaved(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the key.');
    } finally {
      setBusy(false);
    }
  };

  const k = view.key;
  return (
    <Card data-testid="telemetry-key">
      <CardHeader>
        <CardTitle>Honeycomb key</CardTitle>
        <CardDescription>
          An Ingest key for the Honeycomb environment the traces should go to.{' '}
          <a className="auth-link" href={KEYS_DOCS} target="_blank" rel="noreferrer">
            Create one ↗
          </a>{' '}
          Agent Timeline is on every Honeycomb plan, the free one included.
        </CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {k && (
          <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="telemetry-key-facts">
            <Fact label="Team">{k.team?.name ?? '—'}</Fact>
            <Fact label="Environment">{k.environment?.name || 'Classic'}</Fact>
            <Fact label="Set">
              <span title={exact(k.updatedAt)}>
                {relativeTime(k.updatedAt)} by {k.updatedBy}
              </span>
            </Fact>
          </dl>
        )}
        {saved && !editing && (
          <p role="status" className="text-sm font-medium" data-testid="telemetry-key-saved">
            ✓ Honeycomb accepted the key. The next job sends its traces there.
          </p>
        )}
        {editing ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} noValidate>
            <SegmentedControl<TelemetryRegion>
              aria-label="Honeycomb region"
              value={region}
              onChange={setRegion}
              options={[
                { value: 'us', label: 'US (api.honeycomb.io)' },
                { value: 'eu', label: 'EU (api.eu1.honeycomb.io)' },
              ]}
            />
            <PasswordInput
              label={k ? 'New key' : 'Ingest key'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="hcaik_…"
              value={value}
              disabled={busy}
              {...(problem ? { error: problem } : { hint: 'Checked with Honeycomb, then stored as a secret. Never shown again, and never given to an agent.' })}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            {error && (
              <Alert variant="error" data-testid="telemetry-key-error">
                {error}
              </Alert>
            )}
            <p role="status" className="text-sm" aria-live="polite">
              {busy ? 'Checking the key with Honeycomb…' : ''}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" loading={busy} disabled={!typed || !!problem}>
                {k ? 'Check and replace' : 'Check and save'}
              </Button>
              {k && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Replace key
            </Button>
            <Button variant="ghost" onClick={() => void remove()} loading={busy} data-testid="telemetry-remove">
              Remove key
            </Button>
            {error && (
              <Alert variant="error" className="w-full">
                {error}
              </Alert>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SettingsCard({ view, api, installationId, onSaved }: { view: TelemetryView; api: Api; installationId: number; onSaved: (v: TelemetryView) => void }) {
  const [serviceName, setServiceName] = useState(view.serviceName);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameProblem = SERVICE_NAME.test(serviceName) ? null : 'Letters, digits, dots, dashes or underscores, up to 64.';

  const change = async (what: string, input: Parameters<Api['updateTelemetry']>[1]) => {
    setBusy(what);
    setError(null);
    try {
      onSaved(await api.updateTelemetry(installationId, input));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-testid="telemetry-settings">
      <CardHeader>
        <CardTitle>What is sent</CardTitle>
        <CardDescription>Changes apply to jobs that start after you save.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-5">
        <Setting title="Sending" description="Paused keeps the key; jobs send nothing until you turn it back on.">
          <SegmentedControl<'on' | 'off'>
            aria-label="Sending"
            value={view.enabled ? 'on' : 'off'}
            onChange={(v) => void change('enabled', { enabled: v === 'on' })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Paused' },
            ]}
          />
        </Setting>
        <Setting
          title="Content"
          description={
            view.captureContent
              ? 'Prompts, model responses, and tool arguments and results are recorded, so Agent Timeline shows what was said, not just what happened. Keys and tokens are redacted first; code and issue text are not. Each field is cut at 16 KB.'
              : 'Names, timing, token counts, tool names, errors and verify commands only. Turn on content to read the conversation itself in Agent Timeline.'
          }
        >
          <SegmentedControl<'meta' | 'content'>
            aria-label="Content"
            value={view.captureContent ? 'content' : 'meta'}
            onChange={(v) => void change('content', { captureContent: v === 'content' })}
            options={[
              { value: 'meta', label: 'Metadata only' },
              { value: 'content', label: 'Prompts and outputs' },
            ]}
          />
        </Setting>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nameProblem && serviceName !== view.serviceName) void change('name', { serviceName });
          }}
        >
          <div className="min-w-56 flex-1">
            <Input
              label="Service name"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              {...(nameProblem ? { error: nameProblem } : { hint: 'service.name on every span: the dataset in Honeycomb.' })}
            />
          </div>
          <Button type="submit" variant="secondary" loading={busy === 'name'} disabled={!!nameProblem || serviceName === view.serviceName}>
            Save
          </Button>
        </form>
        {error && (
          <Alert variant="error" data-testid="telemetry-settings-error">
            {error}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

function LastExport({ view, installationId }: { view: TelemetryView; installationId: number }) {
  const e = view.lastExport;
  return (
    <Card data-testid="telemetry-last">
      <CardHeader>
        <CardTitle>Last job</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 text-sm">
        {!e ? (
          <p className="text-muted-foreground">{view.keyConfigured ? 'No job has sent telemetry yet. The next one will.' : 'Add a key, and each job reports here how its export went.'}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={e.failed === 0 && e.exported > 0 ? 'success' : e.exported > 0 ? 'warning' : 'error'}>
                {e.failed === 0 && e.exported > 0 ? 'Delivered' : e.exported > 0 ? 'Partly delivered' : 'Not delivered'}
              </StatusBadge>
              <span title={exact(e.at)}>{relativeTime(e.at)}</span>
            </div>
            <p>
              {e.exported} of {e.spans} span{e.spans === 1 ? '' : 's'} reached Honeycomb{e.lastError ? ` (last error: ${e.lastError})` : ''}.
              {e.lastError === 'HTTP 401' ? ' Honeycomb no longer accepts the key: replace it.' : ''}
            </p>
            <div className="flex flex-wrap gap-4">
              {e.traceUrl && (
                <a className="auth-link font-semibold" href={e.traceUrl} target="_blank" rel="noreferrer" data-testid="telemetry-last-trace">
                  View trace ↗
                </a>
              )}
              <Link className="auth-link" to={`/installations/${installationId}/jobs/${e.jobId}`}>
                View job
              </Link>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function HowItWorks() {
  const tree = [
    ['invoke_workflow updraft', 'the job'],
    ['├ invoke_agent claude', 'writes the change'],
    ['│ ├ chat claude-opus-4-1', 'a model call, with tokens'],
    ['│ └ execute_tool Edit', 'a tool call'],
    ['├ execute_tool verify', 'your verify commands'],
    ['└ invoke_agent codex', 'reviews it, in the next trace'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>How it works</CardTitle>
        <CardDescription>
          The runner reads each agent's own transcript as it is written and sends{' '}
          <a className="auth-link" href="https://github.com/open-telemetry/semantic-conventions-genai" target="_blank" rel="noreferrer">
            OpenTelemetry GenAI
          </a>{' '}
          spans, so{' '}
          <a className="auth-link" href={TIMELINE_DOCS} target="_blank" rel="noreferrer">
            Agent Timeline ↗
          </a>{' '}
          understands them without a collector.
        </CardDescription>
      </CardHeader>
      <CardBody>
        <ul className="flex flex-col gap-1 font-mono text-xs" aria-label="The spans of a job">
          {tree.map(([span, what]) => (
            <li key={span} className="flex flex-wrap justify-between gap-x-3">
              <span className="whitespace-pre">{span}</span>
              <span className="font-sans text-muted-foreground">{what}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          Every span carries <code>gen_ai.conversation.id</code> = <code>owner/repo#issue</code>, so one issue's implement run, reviews and revisions read as one conversation.
        </p>
      </CardBody>
    </Card>
  );
}

function Setting({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
