import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { LogisterClient } from "./client";
import { createLogisterMiddleware } from "./express";
import { createTraceContext, incomingTraceContext, parseTraceparent, traceHeaders } from "./trace";
import { createTracedFetch, LogisterFetchError } from "./traced-fetch";
import { currentTraceContext } from "./node-context";

describe("request correlation", () => {
  it("isolates concurrent Express requests and manual reports", async () => {
    const payloads: Record<string, any>[] = [];
    const client = new LogisterClient({apiKey: "test", baseUrl: "https://logister.example", fetch: (async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)).event);
      return new Response("{}", {status: 202});
    }) as typeof fetch});
    const app = express();
    app.use(createLogisterMiddleware({client, captureRequestSpans: true}));
    app.get("/work/:id", async (req, res) => {
      await new Promise(resolve => setTimeout(resolve, req.params.id === "a" ? 15 : 1));
      await client.captureException(new Error("handled"));
      res.json({spanId: currentTraceContext()?.spanId});
    });
    const traces = [createTraceContext(), createTraceContext()];
    await Promise.all(traces.map((trace, i) => request(app).get(`/work/${i === 0 ? "a" : "b"}`)
      .set(traceHeaders(trace, "https://api.example", ["https://api.example"]))));
    for (const trace of traces) {
      const events = payloads.filter(p => p.context?.trace_id === trace.traceId);
      expect(events).toHaveLength(3);
      expect(new Set(events.map(p => p.context.span_id)).size).toBe(1);
      expect(events.every(p => p.context.parent_span_id === trace.spanId)).toBe(true);
    }
    expect(currentTraceContext()).toBeUndefined();
  });

  it("bounds propagation and preserves a failed request's immutable identity", async () => {
    const trace = incomingTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    expect(traceHeaders(trace, "http://api.example", ["https://api.example"])).toEqual({});
    const client = new LogisterClient({apiKey: "test", baseUrl: "https://logister.example", fetch: vi.fn().mockResolvedValue(new Response("{}"))});
    const transport = vi.fn().mockRejectedValue(new Error("offline"));
    const send = createTracedFetch(client, {allowedOrigins: ["https://api.example"], fetch: transport});
    try { await send("https://api.example/path", undefined, trace); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(LogisterFetchError);
      expect((error as LogisterFetchError).traceContext?.parentSpanId).toBe(trace.spanId);
      expect(Object.isFrozen((error as LogisterFetchError).traceContext)).toBe(true);
    }
    expect(transport.mock.calls[0]![0].redirect).toBe("manual");
  });
});
