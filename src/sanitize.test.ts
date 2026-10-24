import { describe, expect, it, vi } from "vitest";

import { LogisterClient } from "./client";
import { REDACTED, Redactor, sanitizeContext, sanitizeValue } from "./sanitize";

const EXACT_KEYS = [
  "password", "passwd", "pwd", "secret", "token", "apikey", "authorization", "proxyauthorization",
  "cookie", "setcookie", "sessiontoken", "sessionkey", "credential", "credentials", "privatekey",
  "clientsecret", "accesstoken", "refreshtoken", "idtoken", "authtoken", "xapikey", "xauthtoken",
  "xaccesstoken", "xcsrftoken", "xxsrftoken", "signature", "ssn", "creditcard", "cardnumber", "cvv"
];
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("default redaction spec", () => {
  const redactor = new Redactor();

  it.each(EXACT_KEYS)("redacts the exact key %s", (key) => {
    expect(sanitizeValue({ [key]: "value", nested: { [key]: { deep: 1 } } }, { redactor }))
      .toEqual({ [key]: REDACTED, nested: { [key]: REDACTED } });
  });

  it.each([
    ["api_key"], ["API-Key"], ["X-Api-Key"], ["x_csrf_token"], ["Set-Cookie"], ["Proxy-Authorization"],
    ["private_key"], ["client-secret"], ["credit_card"], ["card_number"], ["CVV"], ["Session.Key"]
  ])("normalizes %s before exact matching", (key) => {
    expect(redactor.isSensitiveKey(key)).toBe(true);
  });

  it.each([
    ["githubToken"], ["AWS_SECRET_ACCESS_KEY"], ["db_password"], ["old_passwd"], ["stripeApiKey"],
    ["upstream_authorization"], ["aws_credential_file"], ["session_cookie"], ["tokenizer"]
  ])("redacts %s by the contains rule", (key) => {
    expect(redactor.isSensitiveKey(key)).toBe(true);
  });

  it.each([["session_id"], ["author"], ["keyboard"], ["user_id"], ["route"], ["passage"], ["sign"]])(
    "keeps the ordinary key %s",
    (key) => {
      expect(redactor.isSensitiveKey(key)).toBe(false);
    }
  );

  it("redacts configured keys after normalization", () => {
    const custom = new Redactor(["Account-Number", "otp"]);
    expect(sanitizeValue({ account_number: "123", OTP: "9", otp_hint: "x" }, { redactor: custom }))
      .toEqual({ account_number: REDACTED, OTP: REDACTED, otp_hint: "x" });
  });

  it.each([
    ["Authorization: Bearer abc123def456", `Authorization: Bearer ${REDACTED}`],
    ["sent bearer A1b2C3d4E5f6", `sent bearer ${REDACTED}`],
    ["Basic dXNlcjpwYXNzd29yZA==", `Basic ${REDACTED}`],
    [`jwt ${JWT} end`, `jwt ${REDACTED} end`],
    ["key=lgst_live_0123456789abcdef", `key=${REDACTED}`],
    ["Use a Bearer token for Basic setup", "Use a Bearer token for Basic setup"],
    ["Bearer authentication is a basic configuration", "Bearer authentication is a basic configuration"]
  ])("scrubs credential-shaped strings: %s", (input, expected) => {
    expect(redactor.scrubString(input)).toBe(expected);
  });

  it.each([
    ["https://app.example/cb?code=1&token=abc&page=2", `https://app.example/cb?code=1&token=${REDACTED}&page=2`],
    ["/login?user[password]=hunter2&next=%2Fhome", `/login?user[password]=${REDACTED}&next=%2Fhome`],
    ["https://user:pass@app.example/path?api_key=k#access_token=x", `https://${REDACTED}@app.example/path?api_key=${REDACTED}`],
    ["https://app.example/path", "https://app.example/path"],
    [`https://app.example/?jwt=${JWT}`, `https://app.example/?jwt=${REDACTED}`]
  ])("redacts sensitive query values in %s", (input, expected) => {
    expect(redactor.redactUrl(input)).toBe(expected);
  });

  it("applies URL and query-string rules to context values", () => {
    expect(sanitizeValue({
      request: { url: "/orders?session_token=s&id=4", referer: "https://shop.example/?cookie=c" },
      query_string: "a=1&password=p"
    }, { redactor })).toEqual({
      request: { url: `/orders?session_token=${REDACTED}&id=4`, referer: `https://shop.example/?cookie=${REDACTED}` },
      query_string: `a=1&password=${REDACTED}`
    });
  });

  it("exempts the SDK's envelope keys at the context root only", () => {
    expect(sanitizeContext({ request_id: "lgst_req", trace_id: "t", nested: { request_id: "lgst_x" } }, redactor))
      .toEqual({ request_id: "lgst_req", trace_id: "t", nested: { request_id: REDACTED } });
  });

  it("redacts events end to end without touching envelope fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new LogisterClient({
      apiKey: "lgst_project_key",
      baseUrl: "https://logister.example",
      fetch: fetchMock as unknown as typeof fetch,
      redactKeys: ["pin"],
      defaultContext: { service: "api", stripe_secret: "sk" }
    });

    await client.captureMessage(`login with Bearer abcdef123456 and ${JWT}`, {
      requestId: "req-1",
      context: { user: { email: "a@example.com", pin: "1234", headers: { Cookie: "sid=1" } } }
    });

    const event = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).event;
    expect(event.uuid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(event.event_type).toBe("log");
    expect(event.message).toBe(`login with Bearer ${REDACTED} and ${REDACTED}`);
    expect(event.context.request_id).toBe("req-1");
    expect(event.context.stripe_secret).toBe(REDACTED);
    expect(event.context.user).toEqual({ email: "a@example.com", pin: REDACTED, headers: { Cookie: REDACTED } });
    expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer lgst_project_key");
  });
});

describe("bounded serialization", () => {
  it("replaces cycles and contains throwing getters", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    Object.defineProperty(value, "broken", { enumerable: true, get: () => { throw new Error("getter"); } });
    const shared = { ok: true };

    expect(sanitizeValue({ value, left: shared, right: shared })).toEqual({
      value: { name: "root", self: "[Circular]", broken: "[Unserializable]" },
      left: { ok: true },
      right: { ok: true }
    });
  });

  it("caps depth, keys, arrays and strings", () => {
    const limits = { maxDepth: 2, maxObjectKeys: 2, maxArrayLength: 2, maxStringLength: 4, maxTotalKeys: 100 };
    expect(sanitizeValue({ a: { b: { c: 1 } }, list: [1, 2, 3], extra: "x" }, { limits })).toEqual({
      a: { b: "[MaxDepth]" },
      list: [1, 2, "[truncated 1 items]"],
      "[truncated]": "1 keys"
    });
    expect(sanitizeValue("abcdefgh", { limits })).toBe("abcd…[truncated 4 chars]");
  });

  it("converts values JSON cannot represent", () => {
    expect(sanitizeValue({ big: 10n, fn: function named() {}, nan: Number.NaN, when: new Date(0), set: new Set([1]) }))
      .toEqual({ big: "10", fn: "[Function named]", nan: "NaN", when: "1970-01-01T00:00:00.000Z", set: [1] });
  });
});
