import { describe, expect, it, vi } from "vitest";

import { LogisterClient } from "./client";
import { instrumentConsole } from "./console";

function buildClient(fetchMock: ReturnType<typeof vi.fn>): LogisterClient {
  return new LogisterClient({
    apiKey: "test-token",
    baseUrl: "https://logister.example",
    fetch: fetchMock as unknown as typeof fetch
  });
}

describe("console integration", () => {
  it("captures console warnings as log events", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = buildClient(fetchMock);
    const fakeConsole = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const restore = instrumentConsole(client, {
      console: fakeConsole,
      context: { service: "web" }
    });

    fakeConsole.warn("Queue backlog rising", { queue: "emails" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    restore();

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.event_type).toBe("log");
    expect(payload.event.level).toBe("warn");
    expect(payload.event.message).toBe("Queue backlog rising {\"queue\":\"emails\"}");
    expect(payload.event.context.logger_name).toBe("console");
    expect(payload.event.context.logger.method).toBe("warn");
    expect(payload.event.context.log_record.arguments[1]).toEqual({ queue: "emails" });
  });

  it("captures Error arguments on console.error as error events", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = buildClient(fetchMock);
    const fakeConsole = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const error = new Error("BROKEN");

    const restore = instrumentConsole(client, { console: fakeConsole });
    fakeConsole.error("checkout failed", error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    restore();

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.event.event_type).toBe("error");
    expect(payload.event.message).toBe("checkout failed");
    expect(payload.event.context.exception.class).toBe("Error");
    expect(payload.event.context.log_record.original_method).toBe("error");
  });
});
