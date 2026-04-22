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
});
