export type LogisterLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogisterEventType =
  | "error"
  | "metric"
  | "transaction"
  | "span"
  | "log"
  | "check_in";

export type LogisterContext = Record<string, unknown>;

export interface LogisterStackFrame {
  filename: string;
  lineno: number;
  colno?: number | undefined;
  name?: string | undefined;
}

export interface LogisterExceptionContext extends LogisterContext {
  class: string;
  message: string;
  qualified_class?: string | undefined;
  stack?: string | undefined;
  backtrace?: string[] | undefined;
  frames?: LogisterStackFrame[] | undefined;
  cause?: LogisterContext | undefined;
  context?: LogisterContext | undefined;
  raw?: unknown;
}

export interface LogisterEventPayload {
  event_type: LogisterEventType;
  level?: LogisterLevel | undefined;
  message?: string | undefined;
  fingerprint?: string | undefined;
  occurred_at?: string | undefined;
  context?: LogisterContext | undefined;
}

export interface LogisterCheckInPayload {
  slug: string;
  status: "ok" | "error" | "in_progress";
  environment?: string | undefined;
  release?: string | undefined;
  duration_ms?: number | undefined;
  checked_at?: string | undefined;
  expected_interval_seconds?: number | undefined;
  trace_id?: string | undefined;
  request_id?: string | undefined;
  context?: LogisterContext | undefined;
}

export interface LogisterClientOptions {
  apiKey: string;
  baseUrl: string;
  environment?: string | undefined;
  release?: string | undefined;
  repository?: string | undefined;
  commitSha?: string | undefined;
  branch?: string | undefined;
  defaultContext?: LogisterContext | undefined;
  fetch?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

export interface CaptureOptions {
  level?: LogisterLevel | undefined;
  message?: string | undefined;
  fingerprint?: string | undefined;
  occurredAt?: string | Date | undefined;
  environment?: string | undefined;
  release?: string | undefined;
  traceId?: string | undefined;
  requestId?: string | undefined;
  sessionId?: string | undefined;
  userId?: string | undefined;
  context?: LogisterContext | undefined;
}

export interface LogisterDeploymentPayload {
  release: string;
  repository: string;
  commitSha: string;
  environment?: string | undefined;
  branch?: string | undefined;
  deployedAt?: string | Date | undefined;
  pullRequestNumber?: string | number | undefined;
  pullRequestUrl?: string | undefined;
  releaseTag?: string | undefined;
  releaseUrl?: string | undefined;
  compareUrl?: string | undefined;
  workflowRunUrl?: string | undefined;
  deploymentUrl?: string | undefined;
}

export interface MetricOptions extends CaptureOptions {
  unit?: string | undefined;
}

export interface SpanOptions extends CaptureOptions {
  traceId?: string | undefined;
  requestId?: string | undefined;
  spanId?: string | undefined;
  parentSpanId?: string | undefined;
  kind?: "app" | "browser" | "cache" | "db" | "http" | "internal" | "queue" | "render" | "resource" | "server" | string | undefined;
  status?: "ok" | "error" | string | undefined;
  startedAt?: string | Date | undefined;
  endedAt?: string | Date | undefined;
}

export interface CheckInOptions {
  environment?: string | undefined;
  release?: string | undefined;
  durationMs?: number | undefined;
  checkedAt?: string | Date | undefined;
  expectedIntervalSeconds?: number | undefined;
  traceId?: string | undefined;
  requestId?: string | undefined;
  context?: LogisterContext | undefined;
}
