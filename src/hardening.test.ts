import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogisterClient, LogisterRequestError, LogisterTimeoutError } from "./client";
import { instrumentConsole } from "./console";
import { createLogisterErrorHandler, createLogisterMiddleware } from "./express";
import { REDACTED } from "./sanitize";
import { deliveredEvents } from "./test-support";

type FetchMock = ReturnType<typeof vi.fn>;

function buildClient(fetchMock: FetchMock, options: Partial<ConstructorParameters<typeof LogisterClient>[0]> = {}): LogisterClient {
  return new LogisterClient({
    apiKey: "test-token",
    baseUrl: "https://logister.example",
    fetch: fetchMock as unknown as typeof fetch,
    batchCompression: false,
    maxRetries: 0,
    onError: () => undefined,
    ...options
  });
}

function fakeConsole() {
  return { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const unauthorized = () => vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", recordUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
  vi.restoreAllMocks();
});

describe("delivery failures never reach the host application", () => {
  it("contains a 401 from every Express capture path", async () => {
    const fetchMock = unauthorized();
    const errors: unknown[] = [];
    const client = buildClient(fetchMock, { onError: (error) => errors.push(error) });
    const app = express();
    app.use(createLogisterMiddleware({ client, captureRequestSpans: true }));
    app.get("/boom", () => { throw new Error("BROKEN"); });
    app.use(createLogisterErrorHandler({ client }));
    app.use(((_err, _req, res, _next) => { res.status(500).end(); }) as express.ErrorRequestHandler);

    await request(app).get("/boom").expect(500);
    await client.flush();
    await tick();

    expect(fetchMock).toHaveBeenCalled();
    expect(errors[0]).toBeInstanceOf(LogisterRequestError);
    expect((errors[0] as LogisterRequestError).status).toBe(401);
    expect(unhandled).toEqual([]);
  });

  it("contains a request timeout", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const errors: unknown[] = [];
    const client = buildClient(fetchMock, { requestTimeoutMs: 10, onError: (error) => errors.push(error) });

    expect(client.enqueueMessage("slow network")).toBe(true);
    await client.flush();
    await tick();

    expect(errors[0]).toBeInstanceOf(LogisterTimeoutError);
    expect(unhandled).toEqual([]);
  });

  it("warns once by default instead of rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new LogisterClient({
      apiKey: "test-token", baseUrl: "https://logister.example", maxRetries: 0, fetch: unauthorized() as unknown as typeof fetch
    });

    client.enqueueMessage("one");
    await client.flush();
    client.enqueueMessage("two");
    await client.flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("status 401");
    expect(unhandled).toEqual([]);
  });

  it("swallows a throwing onError hook", async () => {
    const client = buildClient(unauthorized(), { onError: () => { throw new Error("hook"); } });
    client.enqueueMessage("x");
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("keeps Express working when a user callback throws", async () => {
    const client = buildClient(vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    const app = express();
    app.use(createLogisterMiddleware({ client, transactionNamer: () => { throw new Error("namer"); } }));
    app.get("/boom", () => { throw new Error("BROKEN"); });
    app.use(createLogisterErrorHandler({ client, shouldCaptureError: () => { throw new Error("filter"); } }));
    app.use(((err, _req, res, _next) => { res.status(500).json({ message: err.message }); }) as express.ErrorRequestHandler);

    const response = await request(app).get("/boom").expect(500);
    expect(response.body.message).toBe("BROKEN");
  });

  it("captures a frozen error once without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const frozen = Object.freeze(new Error("FROZEN"));
    const app = express();
    app.get("/frozen", () => { throw frozen; });
    app.use(createLogisterErrorHandler({ client }));
    app.use(createLogisterErrorHandler({ client }));
    app.use(((err, _req, res, _next) => { res.status(500).json({ message: err.message }); }) as express.ErrorRequestHandler);

    const response = await request(app).get("/frozen").expect(500);
    await client.flush();

    expect(response.body.message).toBe("FROZEN");
    expect(deliveredEvents(fetchMock.mock.calls).filter((event) => event.event_type === "error")).toHaveLength(1);
  });
});

describe("console instrumentation safety", () => {
  it("does not throw on circular or hostile arguments", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const target = fakeConsole();
    const originalLog = target.log;
    const restore = instrumentConsole(client, { console: target });
    const req: Record<string, unknown> = { method: "GET" };
    req.socket = { parser: { incoming: req } };
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });

    expect(() => target.log("request", req, hostile)).not.toThrow();
    restore();
    await client.flush();

    expect(originalLog).toHaveBeenCalledWith("request", req, hostile);
    const [event] = deliveredEvents(fetchMock.mock.calls);
    expect(event?.context.log_record.arguments[1]).toEqual({ method: "GET", socket: { parser: { incoming: "[Circular]" } } });
    expect(event?.context.log_record.arguments[2]).toBe("[Unserializable]");
  });

  it("redacts console arguments and the rendered message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const target = fakeConsole();
    const restore = instrumentConsole(client, { console: target });

    target.info("env", { GITHUB_TOKEN: "ghp_secret", NODE_ENV: "production" });
    restore();
    await client.flush();

    const [event] = deliveredEvents(fetchMock.mock.calls);
    expect(event?.message).toBe(`env {"GITHUB_TOKEN":"${REDACTED}","NODE_ENV":"production"}`);
    expect(JSON.stringify(event)).not.toContain("ghp_secret");
  });

  it("terminates the unhandledRejection -> console.error loop", async () => {
    const fetchMock = unauthorized();
    const target = fakeConsole();
    const originalError = target.error;
    const client = buildClient(fetchMock, { onError: (error) => target.error(error) });
    const restore = instrumentConsole(client, { console: target });
    const forward = (reason: unknown) => target.error(reason);
    process.on("unhandledRejection", forward);

    try {
      target.error(new Error("application failure"));
      for (let round = 0; round < 3; round += 1) {
        await client.flush();
        await tick();
      }
    } finally {
      process.off("unhandledRejection", forward);
      restore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(originalError).toHaveBeenCalledTimes(2);
    expect(originalError.mock.calls[1]?.[0]).toBeInstanceOf(LogisterRequestError);
    expect(unhandled).toEqual([]);
  });
});

describe("background queue", () => {
  it("drops and counts events beyond the bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock, { maxQueueSize: 3, flushIntervalMs: 60_000 });

    const accepted = [1, 2, 3, 4, 5].map((index) => client.enqueueMessage(`event ${index}`));
    expect(accepted).toEqual([true, true, true, false, false]);
    expect(client.queuedEventCount).toBe(3);
    expect(client.droppedEventCount).toBe(2);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://logister.example/api/v1/ingest_events/batch");
    expect(deliveredEvents(fetchMock.mock.calls).map((event) => event.message)).toEqual(["event 1", "event 2", "event 3"]);
  });

  it("sends batches of batchSize and flushes a full batch without waiting", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock, { batchSize: 2, flushIntervalMs: 60_000 });

    client.enqueueMessage("a");
    client.enqueueMessage("b");
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    ["c", "d", "e"].forEach((message) => client.enqueueMessage(message));
    await client.flush();
    expect(fetchMock.mock.calls.map((call) => deliveredEvents([call]).length)).toEqual([2, 2, 1]);
  });

  it("flushes on the interval with unref'd timers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock, { flushIntervalMs: 10 });

    client.enqueueMessage("later");
    const timer = (client as unknown as { flushTimer: NodeJS.Timeout }).flushTimer;
    expect(timer.hasRef()).toBe(false);
    await tick(40);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops accepting events after close", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock, { flushIntervalMs: 60_000 });

    client.enqueueMessage("before");
    await client.close();
    expect(client.enqueueMessage("after")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.droppedEventCount).toBe(1);
  });

  it("truncates an event over maxEventBytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock, { maxEventBytes: 4_096 });

    client.enqueueMessage("large", { requestId: "req-9", context: { blob: "x".repeat(10_000), items: Array.from({ length: 100 }, (_, i) => i) } });
    await client.flush();

    const [event] = deliveredEvents(fetchMock.mock.calls);
    expect(JSON.stringify(event).length).toBeLessThanOrEqual(4_096);
    expect(event?.context.logister_truncated).toBe(true);
    expect(event?.context.request_id).toBe("req-9");
  });

  it("does not keep the process alive while waiting to retry in the background", async () => {
    const created: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
      const timer = realSetTimeout(callback, ms);
      created.push(timer);
      return timer;
    }) as typeof setTimeout);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers() });
    const client = buildClient(fetchMock, { maxRetries: 1, retryBaseDelayMs: 5 });

    client.enqueueMessage("retry me");
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(created.length).toBeGreaterThanOrEqual(3);
    expect(created.every((timer) => !timer.hasRef())).toBe(true);
  });

  it("jitters capped retry delays downward", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(callback, 0);
    }) as typeof setTimeout);
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const client = buildClient(fetchMock, { maxRetries: 1, retryBaseDelayMs: 100, maxRetryDelayMs: 100, retryJitterRatio: 0.5 });

    await client.captureMessage("capped");
    expect(delays).toContain(50);
  });
});

describe("Express data minimization", () => {
  it("redacts URLs, query values and headers, and omits the client IP by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const app = express();
    app.use(createLogisterMiddleware({ client, headerAllowList: ["user-agent", "authorization", "cookie", "referer"] }));
    app.get("/login", (_req, res) => { res.status(204).end(); });

    await request(app)
      .get("/login?token=abc&page=2")
      .set("Authorization", "Bearer abcdef123456")
      .set("Cookie", "sid=1")
      .set("Referer", "https://shop.example/cart?api_key=k")
      .set("X-Forwarded-For", "203.0.113.9")
      .expect(204);
    await client.flush();

    const [event] = deliveredEvents(fetchMock.mock.calls);
    const req = event?.context.request;
    expect(req.url).toBe(`/login?token=${REDACTED}&page=2`);
    expect(req.query).toEqual({ token: REDACTED, page: "2" });
    expect(req.headers.authorization).toBe(REDACTED);
    expect(req.headers.cookie).toBe(REDACTED);
    expect(req.headers.referer).toBe(`https://shop.example/cart?api_key=${REDACTED}`);
    expect(req.remote_ip).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("203.0.113.9");
  });

  it("captures the client IP only when opted in", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const app = express();
    app.use(createLogisterMiddleware({ client, captureRemoteIp: true }));
    app.get("/", (_req, res) => { res.status(204).end(); });

    await request(app).get("/").expect(204);
    await client.flush();

    expect(deliveredEvents(fetchMock.mock.calls)[0]?.context.request.remote_ip).toMatch(/127\.0\.0\.1|::1/u);
  });

  it("samples transactions while still capturing errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const app = express();
    app.use(createLogisterMiddleware({ client, transactionSampleRate: 0, captureRequestSpans: true }));
    app.get("/ok", (_req, res) => { res.status(204).end(); });
    app.get("/boom", () => { throw new Error("BROKEN"); });
    app.use(createLogisterErrorHandler({ client }));
    app.use(((_err, _req, res, _next) => { res.status(500).end(); }) as express.ErrorRequestHandler);

    await request(app).get("/ok").expect(204);
    await request(app).get("/boom").expect(500);
    await client.flush();

    expect(deliveredEvents(fetchMock.mock.calls).map((event) => event.event_type)).toEqual(["error"]);
  });
});

describe("transport safety", () => {
  it("refuses redirects on telemetry requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);

    await client.captureMessage("single");
    client.enqueueMessage("batched");
    await client.flush();

    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).redirect)).toEqual(["error", "error"]);
  });

  it("warns about plain-http base URLs outside loopback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const baseUrl of ["http://localhost:3000", "http://127.0.0.1", "http://[::1]:8080", "https://logister.example"]) {
      buildClient(vi.fn(), { baseUrl });
    }
    expect(warn).not.toHaveBeenCalled();

    buildClient(vi.fn(), { baseUrl: "http://insecure.example" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("http://insecure.example");
  });

  it("serializes cyclic non-Error throwables and nested errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const client = buildClient(fetchMock);
    const thrown: Record<string, unknown> = { code: "E_LOOP" };
    thrown.self = thrown;
    const aggregate = new AggregateError([thrown, new Error("inner")], "many");

    await client.captureException(thrown);
    await client.captureException(aggregate);

    const [plain, nested] = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).event);
    expect(plain.context.exception.raw).toEqual({ code: "E_LOOP", self: "[Circular]" });
    expect(nested.context.exception.context.values[0]).toEqual({ raw: { code: "E_LOOP", self: "[Circular]" } });
  });
});
