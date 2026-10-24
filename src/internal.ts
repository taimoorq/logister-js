// Shared across the package's independently bundled entries so console capture can
// ignore anything the SDK itself writes while reporting its own failures.
const key = Symbol.for("logister.captureSuppressed.v1");
const registry = globalThis as typeof globalThis & { [key]?: number };

export function isCaptureSuppressed(): boolean {
  return (registry[key] ?? 0) > 0;
}

export function runWithCaptureSuppressed<T>(callback: () => T): T {
  registry[key] = (registry[key] ?? 0) + 1;
  try {
    return callback();
  } finally {
    registry[key] = Math.max(0, (registry[key] ?? 1) - 1);
  }
}
