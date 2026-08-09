import type {
  CaptureOptions,
  CheckInOptions,
  LogisterCheckInPayload,
  LogisterClientOptions,
  LogisterContext,
  LogisterDeploymentPayload,
  LogisterExceptionContext,
  LogisterEventPayload,
  LogisterStackFrame,
  MetricOptions,
  PreparedLogisterEventPayload,
  SpanOptions
} from "./types";

const DEFAULT_INGEST_PATH = "/api/v1/ingest_events";
const DEFAULT_BATCH_INGEST_PATH = "/api/v1/ingest_events/batch";
const DEFAULT_CHECK_IN_PATH = "/api/v1/check_ins";
const DEFAULT_DEPLOYMENT_PATH = "/api/v1/deployments";
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const UNSUPPORTED_BATCH_STATUS_CODES = new Set([404, 405, 415, 501]);
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 65_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;

class LogisterRequestError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | undefined = undefined) {
    super(`Logister request failed with status ${status}`);
    this.name = "LogisterRequestError";
  }
}

class LogisterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogisterTimeoutError";
  }
}

export class LogisterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly environment: string | undefined;
  private readonly release: string | undefined;
  private readonly repository: string | undefined;
  private readonly commitSha: string | undefined;
  private readonly branch: string | undefined;
  private readonly defaultContext: LogisterContext;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly retryJitterRatio: number;
  private readonly requestTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly batchSize: number;
  private readonly batchCompression: boolean;
  private readonly generatedEventIds = new WeakMap<object, string>();

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
    this.repository = options.repository;
    this.commitSha = options.commitSha;
    this.branch = options.branch;
    this.defaultContext = options.defaultContext ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? "logister-js/0.4.0";
    this.maxRetries = nonNegativeInteger(options.maxRetries, 3);
    this.retryBaseDelayMs = nonNegativeNumber(options.retryBaseDelayMs, 100);
    this.maxRetryDelayMs = nonNegativeNumber(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
    this.retryJitterRatio = clampNumber(options.retryJitterRatio, DEFAULT_RETRY_JITTER_RATIO, 0, 1);
    this.requestTimeoutMs = positiveNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.totalTimeoutMs = positiveNumber(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
    this.batchSize = positiveInteger(options.batchSize, 50);
    this.batchCompression = options.batchCompression ?? true;
  }

  async sendEvent(payload: LogisterEventPayload): Promise<Response> {
    return this.postJson(DEFAULT_INGEST_PATH, {
      event: this.normalizeEvent(payload)
    }, this.requestDeadline());
  }

  prepareEvents(payloads: readonly LogisterEventPayload[]): PreparedLogisterEventPayload[] {
    return payloads.map((payload) => this.normalizeEvent(payload) as PreparedLogisterEventPayload);
  }

  async sendEvents(payloads: readonly LogisterEventPayload[]): Promise<Response> {
    if (payloads.length === 0) throw new Error("LogisterClient.sendEvents requires at least one event");

    const events = this.prepareEvents(payloads);
    const deadlineAt = this.requestDeadline();
    let lastResponse: Response | undefined;

    for (let offset = 0; offset < events.length; offset += this.batchSize) {
      const batch = events.slice(offset, offset + this.batchSize);
      lastResponse = await this.postEventBatch(batch, deadlineAt);
    }

    return lastResponse as Response;
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

  async recordDeployment(deployment: LogisterDeploymentPayload): Promise<Response> {
    return this.postJson(DEFAULT_DEPLOYMENT_PATH, {
      deployment: normalizeDeploymentPayload(deployment, {
        environment: this.environment,
        branch: this.branch
      })
    });
  }

  private async postJson(path: string, body: unknown, deadlineAt = this.requestDeadline()): Promise<Response> {
    return this.requestWithRetry(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": this.userAgent
      },
      body: JSON.stringify(body)
    }, deadlineAt);
  }

  private async postEventBatch(events: readonly LogisterEventPayload[], deadlineAt: number): Promise<Response> {
    const ndjson = `${events.map((event) => JSON.stringify({ event })).join("\n")}\n`;
    const encoded = await encodeBatchBody(ndjson, this.batchCompression);
    const headers: Record<string, string> = {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${this.apiKey}`,
      "user-agent": this.userAgent,
      "x-logister-batch-id": await deterministicBatchId(events)
    };
    if (encoded.compressed) headers["content-encoding"] = "gzip";

    try {
      return await this.requestWithRetry(DEFAULT_BATCH_INGEST_PATH, {
        method: "POST",
        headers,
        body: encoded.body
      }, deadlineAt);
    } catch (error) {
      if (error instanceof LogisterRequestError && error.status === 413 && events.length > 1) {
        const middle = Math.ceil(events.length / 2);
        const failures: unknown[] = [];
        let firstResponse: Response | undefined;
        let secondResponse: Response | undefined;
        try {
          firstResponse = await this.postEventBatch(events.slice(0, middle), deadlineAt);
        } catch (splitError) {
          failures.push(splitError);
        }
        try {
          secondResponse = await this.postEventBatch(events.slice(middle), deadlineAt);
        } catch (splitError) {
          failures.push(splitError);
        }
        if (failures.length > 0) throw failures[0];

        return secondResponse ?? firstResponse as Response;
      }
      if (error instanceof LogisterRequestError && UNSUPPORTED_BATCH_STATUS_CODES.has(error.status)) {
        const failures: unknown[] = [];
        let response: Response | undefined;
        for (const event of events) {
          try {
            response = await this.postJson(DEFAULT_INGEST_PATH, { event }, deadlineAt);
          } catch (fallbackError) {
            failures.push(fallbackError);
          }
        }
        if (failures.length > 0) throw failures[0];

        return response as Response;
      }

      throw error;
    }
  }

  private async requestWithRetry(path: string, init: RequestInit, deadlineAt: number): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchWithDeadline(`${this.baseUrl}${path}`, init, deadlineAt);
        if (response.ok) return response;

        const error = new LogisterRequestError(
          response.status,
          parseRetryAfterMs(response.headers?.get("retry-after"))
        );
        if (!isRetryableStatus(response.status) || attempt === this.maxRetries) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error instanceof LogisterRequestError && !isRetryableStatus(error.status)) throw error;
        if (attempt === this.maxRetries) throw error;
      }

      await this.waitForRetry(lastError, attempt, deadlineAt);
    }

    throw lastError;
  }

  private normalizeEvent(payload: LogisterEventPayload): LogisterEventPayload {
    return compact({
      ...payload,
      uuid: this.stableEventIdentifier(payload),
      occurred_at: normalizeTimestamp(payload.occurred_at),
      context: this.withDefaultContext(payload.context)
    });
  }

  private stableEventIdentifier(payload: LogisterEventPayload): string {
    const supplied = firstNonBlankString(payload.uuid, payload.event_id);
    if (supplied) return supplied;

    const cached = this.generatedEventIds.get(payload);
    if (cached) return cached;

    const generated = randomUuid();
    this.generatedEventIds.set(payload, generated);
    return generated;
  }

  private requestDeadline(): number {
    return Date.now() + this.totalTimeoutMs;
  }

  private async fetchWithDeadline(url: string, init: RequestInit, deadlineAt: number): Promise<Response> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new LogisterTimeoutError("Logister request exceeded its total timeout");

    const timeoutMs = Math.max(1, Math.min(this.requestTimeoutMs, remaining));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LogisterTimeoutError(`Logister request attempt timed out after ${Math.ceil(timeoutMs)}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForRetry(error: unknown, attempt: number, deadlineAt: number): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new LogisterTimeoutError("Logister request exceeded its total timeout");

    const retryAfterMs = error instanceof LogisterRequestError ? error.retryAfterMs : undefined;
    const baseDelay = retryAfterMs ?? this.retryBaseDelayMs * (2 ** attempt);
    const boundedDelay = Math.min(Math.max(0, baseDelay), this.maxRetryDelayMs);
    const jitterRoom = Math.max(0, this.maxRetryDelayMs - boundedDelay);
    const jitter = Math.min(jitterRoom, boundedDelay * this.retryJitterRatio * Math.random());
    const requestedDelay = boundedDelay + jitter;
    if (requestedDelay >= remaining) {
      await delay(remaining);
      throw new LogisterTimeoutError("Logister request exceeded its total timeout while waiting to retry");
    }

    await delay(requestedDelay);
  }

  private withDefaultContext(context: LogisterContext | undefined): LogisterContext | undefined {
    const merged = compact({
      ...this.defaultContext,
      ...context,
      environment: context?.environment ?? this.defaultContext.environment ?? this.environment,
      release: context?.release ?? this.defaultContext.release ?? this.release,
      repository: context?.repository ?? this.defaultContext.repository ?? this.repository,
      commit_sha: context?.commit_sha ?? this.defaultContext.commit_sha ?? this.commitSha,
      branch: context?.branch ?? this.defaultContext.branch ?? this.branch
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

function normalizeDeploymentPayload(
  deployment: LogisterDeploymentPayload,
  defaults: Pick<LogisterDeploymentPayload, "environment" | "branch">
): Record<string, unknown> {
  return compact({
    release: deployment.release,
    environment: deployment.environment ?? defaults.environment,
    repository: deployment.repository,
    commit_sha: deployment.commitSha,
    branch: deployment.branch ?? defaults.branch,
    deployed_at: normalizeTimestamp(deployment.deployedAt),
    pull_request_number: deployment.pullRequestNumber,
    pull_request_url: deployment.pullRequestUrl,
    release_tag: deployment.releaseTag,
    release_url: deployment.releaseUrl,
    compare_url: deployment.compareUrl,
    workflow_run_url: deployment.workflowRunUrl,
    deployment_url: deployment.deploymentUrl
  });
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

function randomUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const hex = randomId(16).padEnd(32, "0").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

async function encodeBatchBody(
  ndjson: string,
  compress: boolean
): Promise<{ body: BodyInit; compressed: boolean }> {
  if (!compress || typeof CompressionStream === "undefined") return { body: ndjson, compressed: false };

  const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
  return { body: await new Response(stream).arrayBuffer(), compressed: true };
}

async function deterministicBatchId(events: readonly LogisterEventPayload[]): Promise<string> {
  const identifiers = events.map((event) => event.uuid ?? event.event_id ?? "").join("\n");
  const bytes = new TextEncoder().encode(identifiers);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const dateMs = Date.parse(header);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

function firstNonBlankString(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return Math.max(0, finiteNumber(value, fallback));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Math.max(1, finiteNumber(value, fallback));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Math.floor(nonNegativeNumber(value, fallback));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

function clampNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
