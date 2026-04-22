import { LogisterClient } from "./client";
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

      const error = captureExceptionsAsErrors ? args.find((value) => value instanceof Error) : undefined;
      const message = formatConsoleMessage(args, error);
      const captureOptions = buildConsoleCaptureOptions(method, args, options.context);

      if (error instanceof Error) {
        void client.captureException(error, {
          ...captureOptions,
          level: consoleMethodLevel(method),
          message
        });
        return;
      }

      void client.captureMessage(message, {
        ...captureOptions,
        level: consoleMethodLevel(method)
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

function buildConsoleCaptureOptions(
  method: ConsoleMethodName,
  args: unknown[],
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
        arguments: args.map((value) => serializeConsoleValue(value)),
        original_method: method
      }
    }
  };
}

function formatConsoleMessage(args: unknown[], error: Error | undefined): string {
  const values = error ? args.filter((value) => value !== error) : args;
  const rendered = values
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      try {
        return JSON.stringify(serializeConsoleValue(value));
      } catch {
        return String(value);
      }
    })
    .filter((value) => value.length > 0);

  if (rendered.length > 0) return rendered.join(" ");
  if (error) return error.message || error.name;
  return "console event";
}

function serializeConsoleValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      class: value.name,
      message: value.message
    };
  }
  if (Array.isArray(value)) return value.map((entry) => serializeConsoleValue(entry));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeConsoleValue(entry)])
    );
  }

  return String(value);
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
