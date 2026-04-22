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
    error.stack = [
      "TypeError: BROKEN",
      "    at renderCheckout (https://app.example.com/assets/app.min.js:2:1450)",
      "    at onSubmit (https://app.example.com/assets/app.min.js:9:321)"
    ].join("\n");

    await client.captureException(error);

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.context.exception.class).toBe("TypeError");
    expect(payload.event.context.exception.message).toBe("BROKEN");
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
});
