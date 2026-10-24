import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { LogisterClient } from "./client";
import {
  createLogisterErrorHandler,
  createLogisterMiddleware,
  getLogisterRequestContext
} from "./express";
import { deliveredEvents } from "./test-support";

function buildClient(fetchMock: ReturnType<typeof vi.fn>): LogisterClient {
  return new LogisterClient({
    apiKey: "test-token",
    baseUrl: "https://logister.example",
    fetch: fetchMock as unknown as typeof fetch,
    batchCompression: false
  });
}

describe("Express integration", () => {
  it("captures request timing as a transaction event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = buildClient(fetchMock);
    const app = express();

    app.use(createLogisterMiddleware({ client }));
    app.get("/orders/:id", (req, res) => {
      const context = getLogisterRequestContext(req);
      res.json({ requestId: context?.requestId, route: context?.route });
    });

    const response = await request(app)
      .get("/orders/42?expand=true")
      .set("X-Request-Id", "req-123")
      .expect(200);

    expect(response.body.requestId).toBe("req-123");
    expect(response.body.route).toBe("/orders/:id");

    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = { event: deliveredEvents(fetchMock.mock.calls)[0]! };
    expect(payload.event.event_type).toBe("transaction");
    expect(payload.event.message).toBe("/orders/:id");
    expect(payload.event.context.request.request_id).toBe("req-123");
    expect(payload.event.context.http.status_code).toBe(200);
  });

  it("can capture request timing as a server span without transactions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = buildClient(fetchMock);
    const app = express();

    app.use(createLogisterMiddleware({ client, captureTransactions: false, captureRequestSpans: true }));
    app.get("/orders/:id", (_req, res) => {
      res.status(204).end();
    });

    await request(app)
      .get("/orders/42")
      .set("X-Request-Id", "req-123")
      .set("X-Trace-Id", "trace-123")
      .expect(204);

    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = { event: deliveredEvents(fetchMock.mock.calls)[0]! };
    expect(payload.event.event_type).toBe("span");
    expect(payload.event.kind).toBe("server");
    expect(payload.event.status).toBe("ok");
    expect(payload.event.trace_id).toBe("trace-123");
    expect(payload.event.request_id).toBe("req-123");
    expect(payload.event.context.request.route).toBe("/orders/:id");
    expect(payload.event.context.http.status_code).toBe(204);
  });

  it("captures uncaught route errors with request context", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = buildClient(fetchMock);
    const app = express();

    app.use(createLogisterMiddleware({ client }));
    app.get("/boom", () => {
      throw new Error("BROKEN");
    });
    app.use(createLogisterErrorHandler({ client }));
    app.use(((err, _req, res, _next) => {
      res.status(500).json({ message: err.message });
    }) as express.ErrorRequestHandler);

    await request(app)
      .get("/boom")
      .set("X-Request-Id", "req-500")
      .expect(500);

    await client.flush();

    const events = deliveredEvents(fetchMock.mock.calls);
    const errorPayload = { event: events.find((event) => event.event_type === "error")! };

    expect(errorPayload.event).toBeTruthy();
    expect(errorPayload.event.message).toBe("BROKEN");
    expect(errorPayload.event.context.request.request_id).toBe("req-500");
    expect(errorPayload.event.context.request.path).toBe("/boom");
    expect(errorPayload.event.context.http.status_code).toBe(500);
  });
});
