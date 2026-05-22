import type {
  CaptureOptions,
  CheckInOptions,
  LogisterCheckInPayload,
  LogisterClientOptions,
  LogisterContext,
  LogisterExceptionContext,
  LogisterEventPayload,
  LogisterStackFrame,
  MetricOptions,
  SpanOptions
} from "./types";

const DEFAULT_INGEST_PATH = "/api/v1/ingest_events";
const DEFAULT_CHECK_IN_PATH = "/api/v1/check_ins";

export class LogisterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly environment: string | undefined;
  private readonly release: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: LogisterClientOptions) {
    if (!options.apiKey) throw new Error("LogisterClient requires apiKey");
    if (!options.baseUrl) throw new Error("LogisterClient requires baseUrl");
    if (!options.fetch && typeof fetch === "undefined") {
      throw new Error("LogisterClient requires a fetch implementation in this runtime");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.environment = options.environment;
    this.release = options.release;
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? "logister-js/0.2.3";
  }

  async sendEvent(payload: LogisterEventPayload): Promise<Response> {
    return this.postJson(DEFAULT_INGEST_PATH, {
      event: compact({
        ...payload,
        occurred_at: normalizeTimestamp(payload.occurred_at),
        context: this.withDefaultContext(payload.context)
      })
    });
  }

  async captureException(error: unknown, options: CaptureOptions = {}): Promise<Response> {
    const normalized = normalizeError(error);

    return this.sendEvent(compact({
      event_type: "error" as const,
      level: options.level ?? "error",
      message: options.message ?? extractMessage(normalized),
      fingerprint: options.fingerprint,
      occurred_at: normalizeTimestamp(options.occurredAt) ?? new Date().toISOString(),
      context: this.withCaptureContext({
        ...options.context,
        exception: normalized
      }, options)
    }));
  }

  async captureMessage(message: string, options: CaptureOptions = {}): Promise<Response> {
    return this.sendEvent(compact({
      event_type: "log" as const,
      level: options.level ?? "info",
      message,
      fingerprint: options.fingerprint,
      occurred_at: normalizeTimestamp(options.occurredAt) ?? new Date().toISOString(),
      context: this.withCaptureContext(options.context, options)
    }));
  }

  async captureMetric(name: string, value: number, options: MetricOptions = {}): Promise<Response> {
    return this.sendEvent(compact({
      event_type: "metric" as const,
      level: options.level ?? "info",
      message: name,
      fingerprint: options.fingerprint,
      occurred_at: normalizeTimestamp(options.occurredAt) ?? new Date().toISOString(),
      context: compact({
        ...this.withCaptureContext(options.context, options),
        metric: options.context?.metric ?? compact({
          name,
          value,
          unit: options.unit
        }),
        value,
        unit: options.unit
      })
    }));
  }

  async captureTransaction(name: string, durationMs: number, options: CaptureOptions = {}): Promise<Response> {
    return this.sendEvent(compact({
      event_type: "transaction" as const,
      level: options.level ?? "info",
      message: name,
      fingerprint: options.fingerprint,
      occurred_at: normalizeTimestamp(options.occurredAt) ?? new Date().toISOString(),
      context: this.withCaptureContext({
        ...options.context,
        transaction_name: name,
        duration_ms: durationMs
      }, options)
    }));
  }

  async captureSpan(name: string, durationMs: number, options: SpanOptions = {}): Promise<Response> {
    const spanId = options.spanId ?? randomId(16);
    const traceId = options.traceId ?? spanId;
    const startedAt = normalizeTimestamp(options.startedAt) ?? new Date(Date.now() - Math.max(0, durationMs)).toISOString();

    return this.sendEvent(compact({
      event_type: "span" as const,
      level: options.level ?? (options.status === "error" ? "error" : "info"),
      message: name,
      fingerprint: options.fingerprint,
      occurred_at: normalizeTimestamp(options.occurredAt) ?? startedAt,
      name,
      trace_id: traceId,
      request_id: options.requestId,
      span_id: spanId,
      parent_span_id: options.parentSpanId,
      kind: options.kind ?? "internal",
      status: options.status,
      duration_ms: durationMs,
      started_at: startedAt,
      ended_at: normalizeTimestamp(options.endedAt),
      context: this.withCaptureContext({
        ...options.context,
        name,
        trace_id: traceId,
        request_id: options.requestId,
        span_id: spanId,
        parent_span_id: options.parentSpanId,
        span_kind: options.kind ?? "internal",
        kind: options.kind ?? "internal",
        status: options.status,
        duration_ms: durationMs,
        started_at: startedAt,
        ended_at: normalizeTimestamp(options.endedAt)
      }, options)
    }));
  }

  async checkIn(slug: string, status: LogisterCheckInPayload["status"], options: CheckInOptions = {}): Promise<Response> {
    return this.postJson(DEFAULT_CHECK_IN_PATH, {
      check_in: compact({
        slug,
        status,
        environment: options.environment ?? this.environment,
        release: options.release ?? this.release,
        duration_ms: options.durationMs,
        checked_at: normalizeTimestamp(options.checkedAt) ?? new Date().toISOString(),
        expected_interval_seconds: options.expectedIntervalSeconds,
        trace_id: options.traceId,
        request_id: options.requestId,
        context: this.withDefaultContext(options.context)
      })
    });
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": this.userAgent
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Logister request failed with status ${response.status}`);
    }

    return response;
  }

  private withDefaultContext(context: LogisterContext | undefined): LogisterContext | undefined {
    const merged = compact({
      ...context,
      environment: context?.environment ?? this.environment,
      release: context?.release ?? this.release
    });

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private withCaptureContext(
    context: LogisterContext | undefined,
    options: CaptureOptions
  ): LogisterContext | undefined {
    const merged = compact({
      ...context,
      environment: context?.environment ?? options.environment,
      release: context?.release ?? options.release,
      trace_id: context?.trace_id ?? options.traceId,
      request_id: context?.request_id ?? options.requestId,
      session_id: context?.session_id ?? options.sessionId,
      user_id: context?.user_id ?? options.userId
    });

    return Object.keys(merged).length > 0 ? merged : undefined;
  }
}

function normalizeError(error: unknown): LogisterExceptionContext {
  if (error instanceof Error) {
    const stack = error.stack;
    return compact({
      class: error.name,
      qualified_class: error.name,
      message: error.message,
      stack,
      frames: normalizeStackFrames(stack),
      backtrace: normalizeBacktrace(stack),
      cause: normalizeNestedError(error.cause),
      context: normalizeNestedError("errors" in error ? (error as { errors?: unknown }).errors : undefined)
    });
  }

  if (typeof error === "string") {
    return { class: "Error", message: error };
  }

  return compact({
    class: "UnknownError",
    message: "Unknown error",
    raw: error
  });
}

function normalizeNestedError(error: unknown, depth = 0): LogisterContext | undefined {
  if (error === undefined || error === null || depth >= 3) return undefined;

  if (error instanceof Error) {
    return compact({
      class: error.name,
      qualified_class: error.name,
      message: error.message,
      stack: error.stack,
      frames: normalizeStackFrames(error.stack),
      backtrace: normalizeBacktrace(error.stack),
      cause: normalizeNestedError(error.cause, depth + 1)
    });
  }

  if (Array.isArray(error)) {
    const normalized = error.map((entry) => normalizeNestedError(entry, depth + 1) ?? serializeUnknown(entry));
    return normalized.length > 0 ? { values: normalized } : undefined;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error === "object") {
    return { raw: serializeUnknown(error) };
  }

  return { raw: error };
}

function extractMessage(error: LogisterContext): string {
  const message = error.message;
  return typeof message === "string" && message.length > 0 ? message : "Unknown error";
}

function normalizeTimestamp(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeStackFrames(stack: string | undefined): LogisterStackFrame[] | undefined {
  if (!stack) return undefined;

  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1)
    .map(parseStackFrame)
    .filter((frame): frame is LogisterStackFrame => frame !== undefined);

  return frames.length > 0 ? frames : undefined;
}

function normalizeBacktrace(stack: string | undefined): string[] | undefined {
  if (!stack) return undefined;

  const lines = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1);

  return lines.length > 0 ? lines : undefined;
}

function parseStackFrame(line: string): LogisterStackFrame | undefined {
  const chromeWithMethod = /^at (?<name>.+?) \((?<filename>.+?):(?<lineno>\d+):(?<colno>\d+)\)$/u.exec(line);
  if (chromeWithMethod?.groups) {
    const { name, filename, lineno, colno } = chromeWithMethod.groups;
    if (!name || !filename || !lineno || !colno) return undefined;

    return {
      name,
      filename,
      lineno: Number(lineno),
      colno: Number(colno)
    };
  }

  const chromeNoMethod = /^at (?<filename>.+?):(?<lineno>\d+):(?<colno>\d+)$/u.exec(line);
  if (chromeNoMethod?.groups) {
    const { filename, lineno, colno } = chromeNoMethod.groups;
    if (!filename || !lineno || !colno) return undefined;

    return {
      filename,
      lineno: Number(lineno),
      colno: Number(colno)
    };
  }

  const firefox = /^(?<name>[^@]+)@(?<filename>.+?):(?<lineno>\d+):(?<colno>\d+)$/u.exec(line);
  if (firefox?.groups) {
    const { name, filename, lineno, colno } = firefox.groups;
    if (!name || !filename || !lineno || !colno) return undefined;

    return {
      name,
      filename,
      lineno: Number(lineno),
      colno: Number(colno)
    };
  }

  return undefined;
}

function serializeUnknown(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => serializeUnknown(entry));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeUnknown(entry)])
    );
  }

  return String(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function randomId(bytes: number): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) {
    const values = cryptoRef.getRandomValues(new Uint8Array(bytes));
    return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, bytes * 2);
}
