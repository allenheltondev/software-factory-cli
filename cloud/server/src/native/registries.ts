import { isIP } from 'node:net';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { RegistryPolicy, Store } from '../store/store.js';

/**
 * Per-installation package registry hosts for Claude subscription (native worker) jobs (#157).
 *
 * The worker's egress proxy (deploy/aws-microvm/image/sandbox/egress-proxy.mjs) allows a fixed set
 * of public registries and whatever the image adds. An installation owner adds the private
 * registries and mirrors its repositories need here. Cloud hands the list to the worker with each
 * assignment, over the worker control credential only the root dispatcher holds; the supervisor
 * applies it for that job and removes it when the job ends. It is never read from repository
 * content, issue text or anything a job can write.
 *
 * The rules are the proxy's (parseTenantHost there), checked again by the worker: an exact host
 * name, or `*.suffix` for the names below a suffix. No IP addresses, ports, URLs, a bare `*`, a
 * single-label or internal name, or a wildcard over a shared domain. A host is a host-level
 * allowance, not download-only access (docs/package-egress.md, "What the boundary is").
 */

export const MAX_REGISTRY_HOSTS = 20;

/** The image's default registries (DEFAULT_REGISTRY_HOSTS in egress-proxy.mjs), for the console. */
export const DEFAULT_REGISTRY_HOSTS = [
  'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'index.crates.io', 'static.crates.io', 'crates.io',
  'proxy.golang.org', 'sum.golang.org',
  'rubygems.org', 'index.rubygems.org',
  'repo.maven.apache.org', 'repo1.maven.org',
  'api.nuget.org',
] as const;

/** INTERNAL_TLDS in egress-proxy.mjs. */
const INTERNAL_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'home', 'corp', 'intranet', 'localdomain', 'arpa', 'test', 'invalid', 'example', 'onion']);

/** SHARED_SUFFIXES in egress-proxy.mjs: a wildcard over one would admit other customers' names. */
const SHARED_SUFFIXES = [
  'amazonaws.com', 'cloudfront.net', 'awsapps.com', 'on.aws',
  'azurewebsites.net', 'azureedge.net', 'core.windows.net', 'azurecr.io', 'trafficmanager.net', 'cloudapp.net',
  'googleapis.com', 'appspot.com', 'run.app', 'web.app', 'firebaseapp.com', 'cloudfunctions.net', 'pkg.dev', 'storage.googleapis.com',
  'github.io', 'githubusercontent.com', 'github.com', 'gitlab.io', 'gitlab.com', 'bitbucket.io',
  'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'fly.dev', 'onrender.com', 'railway.app',
  'jfrog.io', 'cloudsmith.io', 'packagecloud.io', 'gemfury.com', 'fury.io',
  'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'trycloudflare.com', 'r2.dev', 'digitaloceanspaces.com', 'backblazeb2.com',
  'co.uk', 'co.jp', 'com.au', 'com.br', 'co.in', 'com.cn',
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** normalizeHost in egress-proxy.mjs: a lower-case DNS name with at least two labels, or undefined. */
function normalizeHost(text: string): string | undefined {
  let host = text.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253 || isIP(host) !== 0) return undefined;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return undefined;
  return host;
}

/** One entry, normalized (`registry.example.com` or `*.example.com`), or why it cannot be one. */
export function parseRegistryHost(raw: unknown): { host: string } | { problem: string } {
  if (typeof raw !== 'string') return { problem: 'Each registry is a host name' };
  const text = raw.trim().toLowerCase();
  const shown = raw.trim().slice(0, 80);
  if (!text) return { problem: 'A registry host cannot be empty' };
  const wildcard = text.startsWith('*.');
  const host = normalizeHost(wildcard ? text.slice(2) : text);
  if (!host) {
    return { problem: wildcard
      ? `"${shown}" is not a host name pattern: use *.example.com for the names below example.com`
      : `"${shown}" is not a host name: enter a name such as npm.pkg.example.com, without https://, a path, a port or an IP address` };
  }
  if (INTERNAL_TLDS.has(host.split('.').at(-1)!) || host.endsWith('.home.arpa')) return { problem: `"${shown}" is an internal name, which a job can never reach` };
  if (wildcard && SHARED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return { problem: `"${shown}" covers a shared domain where anyone can get a name; list the exact host instead` };
  }
  return { host: `${wildcard ? '*.' : ''}${host}` };
}

/** A whole list: every entry valid, at most MAX_REGISTRY_HOSTS, duplicates dropped. */
export function parseRegistryHosts(raw: unknown): { hosts: string[] } | { problem: string } {
  if (!Array.isArray(raw)) return { problem: '`hosts` is a list of host names' };
  if (raw.length > MAX_REGISTRY_HOSTS * 2) return { problem: `At most ${MAX_REGISTRY_HOSTS} registry hosts` };
  const hosts: string[] = [];
  for (const entry of raw) {
    const parsed = parseRegistryHost(entry);
    if ('problem' in parsed) return parsed;
    if (!hosts.includes(parsed.host)) hosts.push(parsed.host);
  }
  if (hosts.length > MAX_REGISTRY_HOSTS) return { problem: `At most ${MAX_REGISTRY_HOSTS} registry hosts` };
  return { hosts };
}

/**
 * What a job gets from a stored policy: its hosts, re-validated, or none with the reason. A stored
 * value that no longer validates (an older rule, a hand edit) is never applied in part.
 */
export function effectiveRegistryHosts(stored: RegistryPolicy | null): { hosts: string[]; problem?: 'invalid-stored-policy' } {
  if (!stored) return { hosts: [] };
  const parsed = parseRegistryHosts(stored.hosts);
  if ('problem' in parsed || parsed.hosts.length !== (stored.hosts as unknown[]).length) return { hosts: [], problem: 'invalid-stored-policy' };
  return { hosts: parsed.hosts };
}

export interface RegistryPolicyView {
  hosts: string[];
  defaults: readonly string[];
  max: number;
  /** Only an owner of an active installation may change the list. */
  canEdit: boolean;
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  /** The stored list no longer validates: jobs get the defaults only until it is saved again. */
  problem?: string;
}

export function createRegistryPolicyService(d: { store: Pick<Store, 'getRegistryPolicy' | 'putRegistryPolicy'>; github: Pick<GitHubFlows, 'member'>; now?: () => number }) {
  const now = d.now ?? Date.now;
  function viewOf(stored: RegistryPolicy | null, canEdit: boolean): RegistryPolicyView {
    const effective = effectiveRegistryHosts(stored);
    return {
      hosts: effective.problem ? (Array.isArray(stored?.hosts) ? stored.hosts.filter((h): h is string => typeof h === 'string').slice(0, MAX_REGISTRY_HOSTS * 2) : []) : effective.hosts,
      defaults: DEFAULT_REGISTRY_HOSTS,
      max: MAX_REGISTRY_HOSTS,
      canEdit,
      version: stored?.version ?? 0,
      ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}),
      ...(stored?.updatedBy ? { updatedBy: stored.updatedBy } : {}),
      ...(effective.problem ? { problem: 'The saved list is not valid any more, so jobs reach the default registries only. Correct it and save again.' } : {}),
    };
  }
  return {
    async view(caller: Caller, installationId: number): Promise<RegistryPolicyView> {
      const { summary, tenant } = await d.github.member(caller, installationId);
      return viewOf(await d.store.getRegistryPolicy(installationId), summary.role === 'owner' && tenant.status === 'active');
    },
    /** Replaces the list, over the version the editor loaded. Takes effect from the next assigned job. */
    async update(caller: Caller, installationId: number, input: { hosts?: unknown; version?: unknown }): Promise<RegistryPolicyView> {
      const { summary, tenant, githubLogin } = await d.github.member(caller, installationId);
      if (summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner can change the package registries');
      if (tenant.status !== 'active') throw new FlowError('invalid_settings', 409, 'This installation is not active');
      if (!Number.isSafeInteger(input.version) || (input.version as number) < 0) throw new FlowError('invalid_settings', 400, '`version` is the version the list was loaded at');
      const parsed = parseRegistryHosts(input.hosts);
      if ('problem' in parsed) throw new FlowError('invalid_settings', 400, parsed.problem);
      const next: RegistryPolicy = { hosts: parsed.hosts, updatedAt: new Date(now()).toISOString(), updatedBy: githubLogin ?? caller.sub };
      const out = await d.store.putRegistryPolicy(installationId, next, input.version as number);
      if (out === 'uninstalled') throw new FlowError('uninstalled', 409, 'This installation was uninstalled');
      if (out === 'conflict') throw new FlowError('invalid_settings', 409, 'Someone else changed the package registries; reload and try again');
      return viewOf({ ...next, version: (input.version as number) + 1 }, true);
    },
  };
}
export type RegistryPolicyService = ReturnType<typeof createRegistryPolicyService>;
