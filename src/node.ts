import type { LogisterContext } from "./types";

export function getNodeRuntimeContext(extra: LogisterContext = {}): LogisterContext {
  return {
    runtime: "node",
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid
    },
    ...extra
  };
}

export { currentTraceContext, enableNodeRequestContext, withTraceContext } from "./node-context";
