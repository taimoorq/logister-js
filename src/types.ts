export type LogisterLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogisterEventType =
  | "error"
  | "metric"
  | "transaction"
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
  stack?: string | undefined;
  backtrace?: string[] | undefined;
  frames?: LogisterStackFrame[] | undefined;
  cause?: unknown;
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
  duration_ms?: number | undefined;
  checked_at?: string | undefined;
  context?: LogisterContext | undefined;
}

export interface LogisterClientOptions {
  apiKey: string;
  baseUrl: string;
  environment?: string | undefined;
  release?: string | undefined;
  fetch?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

export interface CaptureOptions {
  level?: LogisterLevel | undefined;
  fingerprint?: string | undefined;
  occurredAt?: string | Date | undefined;
  context?: LogisterContext | undefined;
}

export interface MetricOptions extends CaptureOptions {
  unit?: string | undefined;
}

export interface CheckInOptions {
  environment?: string | undefined;
  durationMs?: number | undefined;
  checkedAt?: string | Date | undefined;
  context?: LogisterContext | undefined;
}
