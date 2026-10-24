import type { LogisterContext } from "./types";

export const REDACTED = "[REDACTED]";

// Shared default redaction spec: keep identical across the Logister SDKs.
const SENSITIVE_KEYS = [
  "password", "passwd", "pwd", "secret", "token", "apikey", "authorization", "proxyauthorization",
  "cookie", "setcookie", "sessiontoken", "sessionkey", "credential", "credentials", "privatekey",
  "clientsecret", "accesstoken", "refreshtoken", "idtoken", "authtoken", "xapikey", "xauthtoken",
  "xaccesstoken", "xcsrftoken", "xxsrftoken", "signature", "ssn", "creditcard", "cardnumber", "cvv"
];
const SENSITIVE_KEY_FRAGMENTS = ["token", "secret", "password", "passwd", "apikey", "authorization", "credential", "cookie"];

// The SDK's own correlation fields are never redacted, even when a caller-supplied
// value happens to look like a credential.
const ENVELOPE_CONTEXT_KEYS = new Set(["uuid", "event_id", "trace_id", "span_id", "parent_span_id", "request_id", "session_id"]);

const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]+=*)/giu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu;
const LOGISTER_KEY_PATTERN = /\blgst_[A-Za-z0-9_-]+/gu;
const URL_WITH_QUERY_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s]*[?#]/iu;

export interface SanitizeLimits {
  maxDepth: number;
  maxObjectKeys: number;
  maxArrayLength: number;
  maxStringLength: number;
  maxTotalKeys: number;
}

export const DEFAULT_CONTEXT_LIMITS: SanitizeLimits = {
  maxDepth: 12,
  maxObjectKeys: 200,
  maxArrayLength: 200,
  maxStringLength: 16_384,
  maxTotalKeys: 400
};

export const COMPACT_CONTEXT_LIMITS: SanitizeLimits = {
  maxDepth: 6,
  maxObjectKeys: 50,
  maxArrayLength: 20,
  maxStringLength: 1_024,
  maxTotalKeys: 200
};

export class Redactor {
  private readonly extraKeys: Set<string>;

  constructor(extraKeys: readonly string[] = []) {
    this.extraKeys = new Set(extraKeys.map(normalizeKey).filter((key) => key.length > 0));
  }

  isSensitiveKey(key: string): boolean {
    const normalized = normalizeKey(key);
    if (normalized.length === 0) return false;
    if (this.extraKeys.has(normalized) || SENSITIVE_KEYS.includes(normalized)) return true;
    return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
  }

  scrubString(value: string): string {
    return value
      .replace(AUTH_SCHEME_PATTERN, (match, scheme: string, space: string, credential: string) =>
        looksLikeCredential(credential) ? `${scheme}${space}${REDACTED}` : match)
      .replace(JWT_PATTERN, REDACTED)
      .replace(LOGISTER_KEY_PATTERN, REDACTED);
  }

  /** Keeps scheme, host and path; redacts sensitive query values, userinfo and the fragment. */
  redactUrl(value: string): string {
    const hashIndex = value.indexOf("#");
    const withoutFragment = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    const queryIndex = withoutFragment.indexOf("?");
    const prefix = (queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment)
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/iu, `$1${REDACTED}@`);
    if (queryIndex < 0) return this.scrubString(prefix);

    return this.scrubString(`${prefix}?${this.redactQueryString(withoutFragment.slice(queryIndex + 1))}`);
  }

  redactQueryString(query: string): string {
    return query
      .split("&")
      .map((part) => {
        const separator = part.indexOf("=");
        const rawName = separator >= 0 ? part.slice(0, separator) : part;
        return this.isSensitiveKey(decodeQueryComponent(rawName)) ? `${rawName}=${REDACTED}` : part;
      })
      .join("&");
  }
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

/**
 * Converts any value into JSON-safe data without throwing: cycles, depth, key counts,
 * array lengths and string sizes are bounded, and throwing getters are contained.
 * With a redactor it also applies the shared redaction rules.
 */
export function sanitizeValue(
  value: unknown,
  options: { redactor?: Redactor | undefined; limits?: SanitizeLimits | undefined; exemptRootKeys?: boolean | undefined } = {}
): unknown {
  const state: SanitizeState = {
    redactor: options.redactor,
    limits: options.limits ?? DEFAULT_CONTEXT_LIMITS,
    ancestors: new WeakSet<object>(),
    remainingKeys: (options.limits ?? DEFAULT_CONTEXT_LIMITS).maxTotalKeys,
    exemptRootKeys: options.exemptRootKeys ?? false
  };
  return sanitizeNode(value, undefined, 0, state);
}

export function sanitizeContext(context: LogisterContext, redactor: Redactor, limits = DEFAULT_CONTEXT_LIMITS): LogisterContext {
  const sanitized = sanitizeValue(context, { redactor, limits, exemptRootKeys: true });
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized as LogisterContext : {};
}

export function envelopeContext(context: LogisterContext | undefined): LogisterContext {
  if (!context) return {};
  return Object.fromEntries(Object.entries(context).filter(([key, value]) =>
    ENVELOPE_CONTEXT_KEYS.has(key) && (typeof value === "string" || typeof value === "number")));
}

interface SanitizeState {
  redactor: Redactor | undefined;
  limits: SanitizeLimits;
  ancestors: WeakSet<object>;
  remainingKeys: number;
  exemptRootKeys: boolean;
}

function sanitizeNode(value: unknown, key: string | undefined, depth: number, state: SanitizeState): unknown {
  switch (typeof value) {
    case "undefined":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "string":
      return sanitizeString(value, key, state);
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return `[Function${value.name ? ` ${value.name}` : ""}]`;
  }
  if (value === null) return null;

  const object = value as object;
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  if (depth >= state.limits.maxDepth) return "[MaxDepth]";
  if (state.ancestors.has(object)) return "[Circular]";

  state.ancestors.add(object);
  try {
    return sanitizeObject(object, depth, state);
  } catch {
    return "[Unserializable]";
  } finally {
    state.ancestors.delete(object);
  }
}

function sanitizeString(value: string, key: string | undefined, state: SanitizeState): string {
  let result = value;
  if (state.redactor) {
    if (key !== undefined && normalizeKey(key) === "querystring") {
      result = state.redactor.redactQueryString(result);
    } else if (URL_WITH_QUERY_PATTERN.test(result)) {
      result = state.redactor.redactUrl(result);
    }
    result = state.redactor.scrubString(result);
  }
  return truncateString(result, state.limits.maxStringLength);
}

function sanitizeObject(object: object, depth: number, state: SanitizeState): unknown {
  if (object instanceof Error) {
    return {
      class: sanitizeNode(object.name, "class", depth + 1, state),
      message: sanitizeNode(object.message, "message", depth + 1, state)
    };
  }
  if (ArrayBuffer.isView(object)) return `[${object.constructor?.name ?? "ArrayBufferView"} ${object.byteLength} bytes]`;
  if (object instanceof ArrayBuffer) return `[ArrayBuffer ${object.byteLength} bytes]`;
  if (Array.isArray(object)) return sanitizeArray(object, depth, state);
  if (object instanceof Set) return sanitizeArray(Array.from(object), depth, state);
  if (object instanceof Map) {
    return sanitizeEntries(Array.from(object.keys(), (key) => [String(key), () => object.get(key)]), depth, state);
  }

  const toJSON = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    const converted: unknown = toJSON.call(object);
    if (converted !== object) return sanitizeNode(converted, undefined, depth + 1, state);
  }

  const record = object as Record<string, unknown>;
  return sanitizeEntries(Object.keys(record).map((key) => [key, () => record[key]]), depth, state);
}

function sanitizeArray(values: readonly unknown[], depth: number, state: SanitizeState): unknown[] {
  const limit = Math.min(values.length, state.limits.maxArrayLength);
  const result: unknown[] = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(sanitizeNode(readSafely(() => values[index]), undefined, depth + 1, state));
  }
  if (values.length > limit) result.push(`[truncated ${values.length - limit} items]`);
  return result;
}

function sanitizeEntries(entries: Array<[string, () => unknown]>, depth: number, state: SanitizeState): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let omitted = 0;
  for (const [key, read] of entries) {
    if (Object.keys(result).length >= state.limits.maxObjectKeys || state.remainingKeys <= 0) {
      omitted += 1;
      continue;
    }
    state.remainingKeys -= 1;
    const exempt = depth === 0 && state.exemptRootKeys && ENVELOPE_CONTEXT_KEYS.has(key);
    if (!exempt && state.redactor?.isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    const entry = readSafely(read);
    if (entry === undefined) continue;
    result[key] = exempt && typeof entry === "string"
      ? truncateString(entry, state.limits.maxStringLength)
      : sanitizeNode(entry, key, depth + 1, state);
  }
  if (omitted > 0) result["[truncated]"] = `${omitted} keys`;
  return result;
}

function readSafely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return "[Unserializable]";
  }
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
}

// "Basic setup" or "Bearer authentication" in prose should survive; real credentials
// are long and mix case, digits or base64 punctuation.
function looksLikeCredential(value: string): boolean {
  if (value.length < 8) return false;
  return /\d/u.test(value) || /[+/=_.~-]/u.test(value) || (/[a-z]/u.test(value) && /[A-Z]/u.test(value.slice(1)));
}
