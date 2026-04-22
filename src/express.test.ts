import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { LogisterClient } from "./client";
import {
  createLogisterErrorHandler,
  createLogisterMiddleware,
  getLogisterRequestContext
} from "./express";

function buildClient(fetchMock: ReturnType<typeof vi.fn>): LogisterClient {
  return new LogisterClient({
    apiKey: "test-token",
    baseUrl: "https://logister.example",
    fetch: fetchMock as unknown as typeof fetch
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

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.event_type).toBe("transaction");
    expect(payload.event.message).toBe("/orders/:id");
    expect(payload.event.context.request.request_id).toBe("req-123");
    expect(payload.event.context.http.status_code).toBe(200);
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

    await new Promise((resolve) => setTimeout(resolve, 0));

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    const errorPayload = bodies.find((body) => body.event?.event_type === "error");

    expect(errorPayload).toBeTruthy();
    expect(errorPayload.event.message).toBe("BROKEN");
    expect(errorPayload.event.context.request.request_id).toBe("req-500");
    expect(errorPayload.event.context.request.path).toBe("/boom");
    expect(errorPayload.event.context.http.status_code).toBe(500);
  });
});
