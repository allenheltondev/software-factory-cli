import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
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
import { api as defaultApi, type ApiClient, type TelemetryKeyInput, type TelemetryProvider, type TelemetryRegion, type TelemetryView } from '../api/client';
import { relativeTime } from '../lib/time';

type Api = Pick<ApiClient, 'telemetry' | 'updateTelemetry' | 'setTelemetryKey' | 'removeTelemetryKey'>;
type Load = { state: 'loading' } | { state: 'ok'; view: TelemetryView } | { state: 'error'; message: string };

const exact = (iso: string) => new Date(iso).toLocaleString();
const KEYS_DOCS = 'https://docs.honeycomb.io/configure/environments/manage-api-keys/';
const TIMELINE_DOCS = 'https://docs.honeycomb.io/investigate/observe/agent-timeline';
const GENAI_DOCS = 'https://github.com/open-telemetry/semantic-conventions-genai';
const SERVICE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const HEADER_VALUE = /^[\x21-\x7e][\x20-\x7e]{6,4094}[\x21-\x7e]$/;

/**
 * Agent telemetry settings: send what each job's agents did to the installation's own tracing
 * tool, as OpenTelemetry GenAI spans: the Honeycomb preset, or any OTLP/HTTP endpoint that takes
 * JSON. The destination and its key are saved together, checked first, and the key is never shown
 * again; the rest is on or off, the service name, whether prompts and outputs are recorded, and a
 * custom destination's link templates.
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
              <DestinationCard view={load.view} api={api} installationId={installationId} onSaved={set} />
              {load.view.keyConfigured && load.view.provider === 'otlp' && <LinksCard view={load.view} api={api} installationId={installationId} onSaved={set} />}
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

/** Where traces go, in words: "Honeycomb US", or a custom endpoint's host. */
const destinationLabel = (view: TelemetryView) => (view.provider === 'otlp' ? (view.otlp?.host ?? 'OTLP endpoint') : `Honeycomb ${view.region.toUpperCase()}`);

function Hero({ view }: { view: TelemetryView }) {
  const state = !view.keyConfigured ? { label: 'Not set up', tone: 'neutral' as const } : view.enabled ? { label: 'Sending', tone: 'success' as const } : { label: 'Paused', tone: 'warning' as const };
  return (
    <PageHero data-testid="telemetry">
      <PageHeroTitle>Agent telemetry</PageHeroTitle>
      <PageHeroSubtitle>
        See what your agents are doing: every model call, tool call and review round, in order, as OpenTelemetry traces in the tracing tool you already use. Each issue is one conversation, from the first
        change through every review and revision.
      </PageHeroSubtitle>
      <PageHeroChips>
        <PageHeroChip tone={state.tone} data-testid="telemetry-state">
          {state.label}
        </PageHeroChip>
        {view.keyConfigured && <PageHeroChip data-testid="telemetry-destination">{destinationLabel(view)}</PageHeroChip>}
        {view.keyConfigured && <PageHeroChip>Service {view.serviceName}</PageHeroChip>}
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

/** Where the traces go and the key, set together: Honeycomb, or any OTLP/HTTP endpoint. */
function DestinationCard({ view, api, installationId, onSaved }: { view: TelemetryView; api: Api; installationId: number; onSaved: (v: TelemetryView) => void }) {
  const [editing, setEditing] = useState(!view.keyConfigured);
  const [provider, setProvider] = useState<TelemetryProvider>(view.provider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (input: TelemetryKeyInput) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setTelemetryKey(installationId, input));
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
        <CardTitle>Destination</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {k && (
          <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="telemetry-key-facts">
            {view.provider === 'otlp' ? (
              <>
                <Fact label="Endpoint" className="sm:col-span-3">
                  <span className="break-all">{view.otlp?.endpoint ?? '—'}</span>
                </Fact>
                <Fact label="Header">
                  <code>{view.otlp?.header ?? '—'}</code>
                </Fact>
              </>
            ) : (
              <>
                <Fact label="Team">{k.team?.name ?? '—'}</Fact>
                <Fact label="Environment">{k.environment?.name || 'Classic'}</Fact>
              </>
            )}
            <Fact label="Set">
              <span title={exact(k.updatedAt)}>
                {relativeTime(k.updatedAt)} by {k.updatedBy}
              </span>
            </Fact>
          </dl>
        )}
        {saved && !editing && (
          <p role="status" className="text-sm font-medium" data-testid="telemetry-key-saved">
            ✓ {view.provider === 'otlp' ? `${view.otlp?.host ?? 'The endpoint'} accepted the key.` : 'Honeycomb accepted the key.'} The next job sends its traces there.
          </p>
        )}
        {editing ? (
          <div className="flex flex-col gap-4">
            <SegmentedControl<TelemetryProvider>
              aria-label="Destination"
              value={provider}
              onChange={(p) => {
                setProvider(p);
                setError(null);
              }}
              options={[
                { value: 'honeycomb', label: 'Honeycomb' },
                { value: 'otlp', label: 'Any OTLP endpoint' },
              ]}
            />
            {provider === 'honeycomb' ? (
              <HoneycombForm view={view} busy={busy} replacing={Boolean(k)} onSubmit={(input) => void save(input)} onCancel={k ? () => setEditing(false) : undefined} />
            ) : (
              <OtlpForm view={view} busy={busy} replacing={Boolean(k)} onSubmit={(input) => void save(input)} onCancel={k ? () => setEditing(false) : undefined} />
            )}
            {error && (
              <Alert variant="error" data-testid="telemetry-key-error">
                {error}
              </Alert>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Change destination or key
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

type FormProps = { view: TelemetryView; busy: boolean; replacing: boolean; onSubmit: (input: TelemetryKeyInput) => void; onCancel?: () => void };

function HoneycombForm({ view, busy, replacing, onSubmit, onCancel }: FormProps) {
  const [value, setValue] = useState('');
  const [region, setRegion] = useState<TelemetryRegion>(view.region);
  const typed = value.trim();
  const problem = typed && !/^[A-Za-z0-9_-]{16,128}$/.test(typed) ? 'A Honeycomb key is letters, digits, dashes and underscores (an Ingest key starts with hcaik_ or hcxik_).' : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed && !problem) onSubmit({ provider: 'honeycomb', value: typed, region });
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate data-testid="telemetry-honeycomb-form">
      <p className="text-sm text-muted-foreground">
        An Ingest key for the Honeycomb environment the traces should go to.{' '}
        <a className="auth-link" href={KEYS_DOCS} target="_blank" rel="noreferrer">
          Create one ↗
        </a>
      </p>
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
        label={replacing ? 'New key' : 'Ingest key'}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="hcaik_…"
        value={value}
        disabled={busy}
        {...(problem ? { error: problem } : { hint: "Checked with Honeycomb's /1/auth, then stored as a secret." })}
        onChange={(e) => setValue(e.target.value)}
      />
      <p role="status" className="text-sm" aria-live="polite">
        {busy ? 'Checking the key with Honeycomb…' : ''}
      </p>
      <FormButtons busy={busy} disabled={!typed || !!problem} replacing={replacing} onCancel={onCancel} />
    </form>
  );
}

function OtlpForm({ view, busy, replacing, onSubmit, onCancel }: FormProps) {
  const [endpoint, setEndpoint] = useState(view.otlp?.endpoint ?? '');
  const [header, setHeader] = useState(view.otlp?.header ?? 'authorization');
  const [value, setValue] = useState('');
  const url = endpoint.trim();
  const endpointProblem = url && !/^https:\/\/[^\s/?#]+\.[^\s/?#]+(\/[^\s?#]*)?$/.test(url) ? 'An https:// URL of a public host, with no query string.' : null;
  const headerProblem = header && !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header.trim()) ? 'Letters, digits and dashes.' : null;
  const typed = value.trim();
  const valueProblem = typed && !HEADER_VALUE.test(typed) ? '8 to 4096 printable characters, on one line.' : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url && header.trim() && typed && !endpointProblem && !headerProblem && !valueProblem) onSubmit({ provider: 'otlp', value: typed, endpoint: url, header: header.trim() });
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate data-testid="telemetry-otlp-form">
      <p className="text-sm text-muted-foreground">
        Any backend that takes OTLP/HTTP with JSON: a hosted tracing service, or your own OpenTelemetry Collector on a public HTTPS address. Traces go to the endpoint plus <code>/v1/traces</code> (or to the
        endpoint itself, when it already ends with it).
      </p>
      <Input
        label="OTLP endpoint"
        placeholder="https://otlp.example.com"
        autoComplete="off"
        spellCheck={false}
        value={endpoint}
        disabled={busy}
        onChange={(e) => setEndpoint(e.target.value)}
        {...(endpointProblem ? { error: endpointProblem } : { hint: 'The base OTLP endpoint, as in OTEL_EXPORTER_OTLP_ENDPOINT.' })}
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <Input label="Header" autoComplete="off" spellCheck={false} value={header} disabled={busy} onChange={(e) => setHeader(e.target.value)} {...(headerProblem ? { error: headerProblem } : { hint: 'Where the key goes.' })} />
        <PasswordInput
          label={replacing ? 'New header value' : 'Header value'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Bearer …"
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          {...(valueProblem ? { error: valueProblem } : { hint: 'The whole value, with any "Bearer " or "Basic " it needs. Stored as a secret.' })}
        />
      </div>
      <p role="status" className="text-sm" aria-live="polite">
        {busy ? 'Checking the endpoint with an empty export…' : ''}
      </p>
      <FormButtons busy={busy} disabled={!url || !header.trim() || !typed || !!endpointProblem || !!headerProblem || !!valueProblem} replacing={replacing} onCancel={onCancel} />
    </form>
  );
}

function FormButtons({ busy, disabled, replacing, onCancel }: { busy: boolean; disabled: boolean; replacing: boolean; onCancel?: () => void }) {
  return (
    <div className="flex flex-wrap gap-3">
      <Button type="submit" loading={busy} disabled={disabled}>
        {replacing ? 'Check and replace' : 'Check and save'}
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

/** A custom destination's links: templates the console fills in for each job's trace, span and conversation. */
function LinksCard({ view, api, installationId, onSaved }: { view: TelemetryView; api: Api; installationId: number; onSaved: (v: TelemetryView) => void }) {
  const [trace, setTrace] = useState(view.links?.trace ?? '');
  const [conversation, setConversation] = useState(view.links?.conversation ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = trace !== (view.links?.trace ?? '') || conversation !== (view.links?.conversation ?? '');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateTelemetry(installationId, { links: { trace: trace.trim(), conversation: conversation.trim() } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the links.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="telemetry-links">
      <CardHeader>
        <CardTitle>Links</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} noValidate>
          <Input
            label="Trace link"
            placeholder="https://tracing.example.com/trace/{trace_id}?span={span_id}"
            spellCheck={false}
            value={trace}
            onChange={(e) => setTrace(e.target.value)}
            hint="{trace_id} {span_id} {start} {end} (UNIX seconds) {start_ms} {end_ms} {service}. With {span_id}, each moment opens the trace at its span."
          />
          <Input
            label="Conversation link"
            placeholder="https://tracing.example.com/search?q=gen_ai.conversation.id%3D{conversation}"
            spellCheck={false}
            value={conversation}
            onChange={(e) => setConversation(e.target.value)}
            hint="{conversation} {start} {end} {start_ms} {end_ms} {service}: every trace of an issue."
          />
          {error && (
            <Alert variant="error" data-testid="telemetry-links-error">
              {error}
            </Alert>
          )}
          <div>
            <Button type="submit" variant="secondary" loading={busy} disabled={!changed}>
              Save links
            </Button>
          </div>
        </form>
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
      </CardHeader>
      <CardBody className="flex flex-col gap-5">
        <Setting title="Sending">
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
        <Setting title="Content">
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
              {...(nameProblem ? { error: nameProblem } : { hint: view.provider === 'honeycomb' ? 'service.name on every span: the dataset in Honeycomb.' : 'service.name on every span.' })}
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
  const where = view.provider === 'otlp' ? (view.otlp?.host ?? 'the endpoint') : 'Honeycomb';
  return (
    <Card data-testid="telemetry-last">
      <CardHeader>
        <CardTitle>Last job</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 text-sm">
        {!e ? (
          <p className="text-muted-foreground">{view.keyConfigured ? 'No job has sent telemetry yet. The next one will.' : 'Set a destination, and each job reports here how its export went.'}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={e.failed === 0 && e.exported > 0 ? 'success' : e.exported > 0 ? 'warning' : 'error'}>
                {e.failed === 0 && e.exported > 0 ? 'Delivered' : e.exported > 0 ? 'Partly delivered' : 'Not delivered'}
              </StatusBadge>
              <span title={exact(e.at)}>{relativeTime(e.at)}</span>
            </div>
            <p>
              {e.exported} of {e.spans} span{e.spans === 1 ? '' : 's'} reached {where}
              {e.lastError ? ` (last error: ${e.lastError})` : ''}.{e.lastError === 'HTTP 401' || e.lastError === 'HTTP 403' ? ` ${where} no longer accepts the key: replace it.` : ''}
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
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-sm">
          The runner reads each agent's own transcript as it is written and sends{' '}
          <a className="auth-link" href={GENAI_DOCS} target="_blank" rel="noreferrer">
            OpenTelemetry GenAI
          </a>{' '}
          spans over OTLP, so any tool that reads the GenAI conventions shows them without a collector (Honeycomb's{' '}
          <a className="auth-link" href={TIMELINE_DOCS} target="_blank" rel="noreferrer">
            Agent Timeline ↗
          </a>
          , for one).
        </p>
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

function Setting({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      {children}
    </div>
  );
}

function Fact({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
