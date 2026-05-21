import { describe, expect, it, vi } from "vitest";

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
    expect(payload.event.context.trace_id).toBe("trace-123");
    expect(payload.event.context.request_id).toBe("req-123");
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
});
