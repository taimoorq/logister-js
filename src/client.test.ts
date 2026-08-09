import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";

import { LogisterClient } from "./client";

describe("LogisterClient", () => {
  it("posts events to the ingest endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.captureMessage("hello", { level: "info", context: { service: "api" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://logister.example/api/v1/ingest_events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-token" })
      })
    );
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.uuid).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("sends stable events as gzip NDJSON batches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      batchSize: 10
    });

    await client.sendEvents([
      { uuid: "11111111-1111-4111-8111-111111111111", event_type: "log", message: "one" },
      { uuid: "22222222-2222-4222-8222-222222222222", event_type: "metric", message: "two" }
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://logister.example/api/v1/ingest_events/batch");
    expect(init.headers).toEqual(expect.objectContaining({
      "content-type": "application/x-ndjson",
      "content-encoding": "gzip"
    }));

    const compressed = Buffer.from(init.body as ArrayBuffer);
    const envelopes = gunzipSync(compressed).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(envelopes.map((row) => row.event.uuid)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
  });

  it("prepares reusable event identities and replaces blank identifiers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      batchCompression: false
    });
    const source = [
      { uuid: " ", event_id: "", event_type: "log" as const, message: "one" }
    ];

    const prepared = client.prepareEvents(source);
    await client.sendEvents(source);

    expect(prepared[0]?.uuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(source[0]?.uuid).toBe(" ");
    const envelope = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body).trim());
    expect(envelope.event.uuid).toBe(prepared[0]?.uuid);
  });

  it("reuses generated identities when an external caller repeats a partially accepted sendEvents call", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 202 })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      batchSize: 1,
      batchCompression: false,
      maxRetries: 0
    });
    const events = [
      { event_type: "log" as const, message: "one" },
      { event_type: "log" as const, message: "two" }
    ];

    await expect(client.sendEvents(events)).rejects.toThrow("status 503");
    await client.sendEvents(events);

    const identifiers = fetchMock.mock.calls.map(([, init]) => {
      const envelope = JSON.parse(String((init as RequestInit).body).trim());
      return envelope.event.uuid as string;
    });
    expect(identifiers[0]).toBe(identifiers[2]);
    expect(identifiers[1]).toBe(identifiers[3]);
  });

  it("falls back to stable single-event delivery when the batch endpoint is unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValue({ ok: true, status: 201 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.sendEvents([
      { uuid: "11111111-1111-4111-8111-111111111111", event_type: "log", message: "one" },
      { uuid: "22222222-2222-4222-8222-222222222222", event_type: "metric", message: "two" }
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "https://logister.example/api/v1/ingest_events",
      "https://logister.example/api/v1/ingest_events"
    ]);
    const fallbackIds = fetchMock.mock.calls.slice(1).map(([, init]) => (
      JSON.parse(String((init as RequestInit).body)).event.uuid
    ));
    expect(fallbackIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
  });

  it("attempts every single-event fallback even when an earlier fallback fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 201 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      batchCompression: false,
      maxRetries: 0
    });

    await expect(client.sendEvents([
      { uuid: "11111111-1111-4111-8111-111111111111", event_type: "log", message: "one" },
      { uuid: "22222222-2222-4222-8222-222222222222", event_type: "log", message: "two" }
    ])).rejects.toThrow("status 503");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondFallback = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(secondFallback.event.uuid).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("attempts both 413 split halves even when the first half fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 413 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      batchCompression: false,
      maxRetries: 0
    });

    await expect(client.sendEvents([
      { uuid: "11111111-1111-4111-8111-111111111111", event_type: "log", message: "one" },
      { uuid: "22222222-2222-4222-8222-222222222222", event_type: "log", message: "two" }
    ])).rejects.toThrow("status 503");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondHalf = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body).trim());
    expect(secondHalf.event.uuid).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("retries a transient batch response without changing its body or identity", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseDelayMs: 0
    });

    await client.sendEvents([
      { uuid: "11111111-1111-4111-8111-111111111111", event_type: "log", message: "one" }
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(first.headers).toEqual(second.headers);
    expect(Buffer.from(first.body as ArrayBuffer)).toEqual(Buffer.from(second.body as ArrayBuffer));
  });

  it("retries transient failures without changing the event id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 201 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseDelayMs: 0
    });

    await client.captureMessage("retry me");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(first.event.uuid).toBe(second.event.uuid);
  });

  it("aborts an attempt at the configured request timeout", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    ));
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
      requestTimeoutMs: 5,
      totalTimeoutMs: 50
    });

    await expect(client.captureMessage("timeout")).rejects.toThrow("attempt timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses and caps Retry-After before a retry", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ "Retry-After": "120" })
        })
        .mockResolvedValueOnce({ ok: true, status: 201 });
      const client = new LogisterClient({
        apiKey: "test-token",
        baseUrl: "https://logister.example",
        fetch: fetchMock as unknown as typeof fetch,
        maxRetries: 1,
        maxRetryDelayMs: 5,
        retryJitterRatio: 0,
        totalTimeoutMs: 100
      });

      const request = client.captureMessage("rate limited");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses an HTTP-date Retry-After value", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Headers({ "Retry-After": "Sat, 08 Aug 2026 12:00:01 GMT" })
        })
        .mockResolvedValueOnce({ ok: true, status: 201 });
      const client = new LogisterClient({
        apiKey: "test-token",
        baseUrl: "https://logister.example",
        fetch: fetchMock as unknown as typeof fetch,
        maxRetries: 1,
        maxRetryDelayMs: 2_000,
        retryJitterRatio: 0,
        totalTimeoutMs: 2_500
      });

      const request = client.captureMessage("temporarily unavailable");
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at the total retry deadline while honoring Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "60" })
      });
      const client = new LogisterClient({
        apiKey: "test-token",
        baseUrl: "https://logister.example",
        fetch: fetchMock as unknown as typeof fetch,
        maxRetries: 3,
        maxRetryDelayMs: 1_000,
        retryJitterRatio: 0,
        totalTimeoutMs: 10
      });

      const request = client.captureMessage("deadline");
      const rejection = expect(request).rejects.toThrow("total timeout while waiting to retry");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures JavaScript exceptions with structured frames", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch
    });
    const error = new Error("BROKEN");
    error.name = "TypeError";
    error.cause = new Error("root cause");
    error.stack = [
      "TypeError: BROKEN",
      "    at renderCheckout (https://app.example.com/assets/app.min.js:2:1450)",
      "    at onSubmit (https://app.example.com/assets/app.min.js:9:321)"
    ].join("\n");

    await client.captureException(error);

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.context.exception.class).toBe("TypeError");
    expect(payload.event.context.exception.message).toBe("BROKEN");
    expect(payload.event.context.exception.cause.class).toBe("Error");
    expect(payload.event.context.exception.cause.message).toBe("root cause");
    expect(payload.event.context.exception.backtrace).toEqual([
      "at renderCheckout (https://app.example.com/assets/app.min.js:2:1450)",
      "at onSubmit (https://app.example.com/assets/app.min.js:9:321)"
    ]);
    expect(payload.event.context.exception.frames).toEqual([
      {
        name: "renderCheckout",
        filename: "https://app.example.com/assets/app.min.js",
        lineno: 2,
        colno: 1450
      },
      {
        name: "onSubmit",
        filename: "https://app.example.com/assets/app.min.js",
        lineno: 9,
        colno: 321
      }
    ]);
  });

  it("captures metrics with metric context and per-event routing fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      environment: "production",
      release: "web@1.2.3",
      repository: "acme/storefront",
      commitSha: "abc1234",
      branch: "main",
      defaultContext: { service: "web" },
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.captureMetric("queue.depth", 12, {
      unit: "jobs",
      traceId: "trace-123",
      requestId: "req-123"
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.event_type).toBe("metric");
    expect(payload.event.context.metric).toEqual({
      name: "queue.depth",
      value: 12,
      unit: "jobs"
    });
    expect(payload.event.context.value).toBe(12);
    expect(payload.event.context.unit).toBe("jobs");
    expect(payload.event.context.environment).toBe("production");
    expect(payload.event.context.release).toBe("web@1.2.3");
    expect(payload.event.context.repository).toBe("acme/storefront");
    expect(payload.event.context.commit_sha).toBe("abc1234");
    expect(payload.event.context.branch).toBe("main");
    expect(payload.event.context.service).toBe("web");
    expect(payload.event.context.trace_id).toBe("trace-123");
    expect(payload.event.context.request_id).toBe("req-123");
  });

  it("posts deployment records to the deployment endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      environment: "production",
      branch: "main",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.recordDeployment({
      release: "web@1.2.3",
      repository: "acme/storefront",
      commitSha: "abcdef123456",
      deployedAt: new Date("2026-06-18T14:30:00Z"),
      pullRequestNumber: 42,
      workflowRunUrl: "https://github.com/acme/storefront/actions/runs/123"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://logister.example/api/v1/deployments",
      expect.objectContaining({ method: "POST" })
    );
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.deployment).toEqual({
      release: "web@1.2.3",
      environment: "production",
      repository: "acme/storefront",
      commit_sha: "abcdef123456",
      branch: "main",
      deployed_at: "2026-06-18T14:30:00.000Z",
      pull_request_number: 42,
      workflow_run_url: "https://github.com/acme/storefront/actions/runs/123"
    });
  });

  it("posts check-ins with release and monitor metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      environment: "production",
      release: "worker@1.2.3",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.checkIn("nightly-import", "ok", {
      durationMs: 88.5,
      expectedIntervalSeconds: 600,
      traceId: "trace-456",
      requestId: "req-456"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://logister.example/api/v1/check_ins",
      expect.objectContaining({ method: "POST" })
    );
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.check_in.slug).toBe("nightly-import");
    expect(payload.check_in.status).toBe("ok");
    expect(payload.check_in.environment).toBe("production");
    expect(payload.check_in.release).toBe("worker@1.2.3");
    expect(payload.check_in.duration_ms).toBe(88.5);
    expect(payload.check_in.expected_interval_seconds).toBe(600);
    expect(payload.check_in.trace_id).toBe("trace-456");
    expect(payload.check_in.request_id).toBe("req-456");
    expect(payload.check_in.context.release).toBe("worker@1.2.3");
  });

  it("captures spans with trace timing context", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new LogisterClient({
      apiKey: "test-token",
      baseUrl: "https://logister.example",
      environment: "production",
      release: "web@1.2.3",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.captureSpan("GET /checkout", 245.7, {
      kind: "server",
      status: "ok",
      traceId: "trace-123",
      requestId: "req-123",
      spanId: "span-root",
      startedAt: "2026-05-22T12:00:00.000Z",
      context: { route: "GET /checkout", timing_breakdown: { db: 40.2, render: 80 } }
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.event_type).toBe("span");
    expect(payload.event.message).toBe("GET /checkout");
    expect(payload.event.trace_id).toBe("trace-123");
    expect(payload.event.request_id).toBe("req-123");
    expect(payload.event.span_id).toBe("span-root");
    expect(payload.event.kind).toBe("server");
    expect(payload.event.duration_ms).toBe(245.7);
    expect(payload.event.context.environment).toBe("production");
    expect(payload.event.context.release).toBe("web@1.2.3");
    expect(payload.event.context.trace_id).toBe("trace-123");
    expect(payload.event.context.span_kind).toBe("server");
    expect(payload.event.context.timing_breakdown).toEqual({ db: 40.2, render: 80 });
  });
});
