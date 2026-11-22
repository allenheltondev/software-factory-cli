// Types for telemetry.mjs, the microVM runner's tracer (deploy/aws-microvm/image/runner/), which
// the local CLI uses too: only what src/telemetry/local.ts calls.

export interface ExporterStats {
  exported: number;
  failed: number;
  dropped: number;
  lastError: string | null;
}

export interface Exporter {
  stats: ExporterStats;
  push(span: unknown): void;
  flush(): Promise<void>;
  pending(): number;
  accepted(spanId: string): boolean;
}

export function createExporter(options: {
  endpoint: string;
  apiKey?: string;
  headerName?: string;
  headers?: Record<string, string>;
  resource?: Record<string, unknown>;
  redact?: (text: string) => string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}): Exporter;

export interface TracerReport {
  traceId: string;
  rootSpanId: string;
  conversationId?: string;
  spans: number;
  exported: number;
  failed: number;
  lastError: string | null;
}

export interface AgentTracer {
  traceId: string;
  start(): void;
  poll(): Promise<void>;
  stop(options?: { outcome?: string; summary?: unknown; deliveryId?: string; eventName?: string; budgetMs?: number }): Promise<TracerReport>;
}

export function createAgentTracer(options: {
  runsDir?: string | null;
  confineTo?: string | null;
  onlyRun?: string | null;
  exporter: Exporter;
  captureContent?: boolean;
  redact?: (text: string) => string;
  now?: () => number;
  log?: (line: string) => void;
  pollMs?: number;
  exportMs?: number;
  startedAt?: number;
  traceId?: string;
}): AgentTracer;
