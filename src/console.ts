import { LogisterClient } from "./client";
import { isCaptureSuppressed, runWithCaptureSuppressed } from "./internal";
import type { CaptureOptions, LogisterContext, LogisterLevel } from "./types";

type ConsoleMethodName = "debug" | "info" | "log" | "warn" | "error";

type ConsoleLike = Pick<Console, ConsoleMethodName>;

interface ConsoleCaptureOptions {
  console?: ConsoleLike | undefined;
  context?: LogisterContext | undefined;
  captureExceptionsAsErrors?: boolean | undefined;
}

const DEFAULT_METHODS: ConsoleMethodName[] = ["debug", "info", "log", "warn", "error"];

export function instrumentConsole(
  client: LogisterClient,
  options: ConsoleCaptureOptions = {}
): () => void {
  const targetConsole = options.console ?? console;
  const originals = new Map<ConsoleMethodName, ConsoleLike[ConsoleMethodName]>();
  const captureExceptionsAsErrors = options.captureExceptionsAsErrors ?? true;

  for (const method of DEFAULT_METHODS) {
    const original = targetConsole[method].bind(targetConsole);
    originals.set(method, original);

    targetConsole[method] = ((...args: unknown[]) => {
      original(...args);
      // Skip console output produced while capturing, including the SDK's own diagnostics,
      // so handlers such as unhandledRejection -> console.error cannot loop.
      if (isCaptureSuppressed()) return;

      runWithCaptureSuppressed(() => {
        try {
          captureConsoleCall(client, method, args, options.context, captureExceptionsAsErrors);
        } catch (error) {
          client.reportInternalError(error);
        }
      });
    }) as ConsoleLike[ConsoleMethodName];
  }

  return () => {
    for (const method of DEFAULT_METHODS) {
      const original = originals.get(method);
      if (original) {
        targetConsole[method] = original;
      }
    }
  };
}

function captureConsoleCall(
  client: LogisterClient,
  method: ConsoleMethodName,
  args: unknown[],
  defaultContext: LogisterContext | undefined,
  captureExceptionsAsErrors: boolean
): void {
  const error = captureExceptionsAsErrors ? args.find((value) => value instanceof Error) : undefined;
  const serialized = args.map((value) => client.redact(value));
  const message = formatConsoleMessage(args, serialized, error);
  const captureOptions = buildConsoleCaptureOptions(method, serialized, defaultContext);

  if (error instanceof Error) {
    client.enqueueException(error, {
      ...captureOptions,
      level: consoleMethodLevel(method),
      message
    });
    return;
  }

  client.enqueueMessage(message, {
    ...captureOptions,
    level: consoleMethodLevel(method)
  });
}

function buildConsoleCaptureOptions(
  method: ConsoleMethodName,
  serializedArgs: unknown[],
  defaultContext: LogisterContext | undefined
): CaptureOptions {
  return {
    context: {
      ...defaultContext,
      runtime: detectRuntime(),
      logger_name: "console",
      logger: {
        name: "console",
        method
      },
      log_record: {
        arguments: serializedArgs,
        original_method: method
      }
    }
  };
}

function formatConsoleMessage(args: unknown[], serialized: unknown[], error: Error | undefined): string {
  const rendered = args
    .flatMap((value, index) => {
      if (error && value === error) return [];
      const entry = serialized[index];
      if (typeof entry === "string") return [entry];
      if (value instanceof Error && entry && typeof entry === "object") {
        const { class: name, message } = entry as { class?: unknown; message?: unknown };
        return [`${String(name)}: ${String(message)}`];
      }
      return [JSON.stringify(entry) ?? String(entry)];
    })
    .filter((value) => value.length > 0);

  if (rendered.length > 0) return rendered.join(" ");
  if (error) return error.message || error.name;
  return "console event";
}

function detectRuntime(): string {
  if (typeof process !== "undefined" && process.release?.name === "node") return "node";
  if (typeof window !== "undefined") return "browser";
  return "javascript";
}

function consoleMethodLevel(method: ConsoleMethodName): LogisterLevel {
  switch (method) {
    case "debug":
      return "debug";
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "info";
  }
}
