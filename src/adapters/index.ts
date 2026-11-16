import type { HarnessId } from "../contracts/index.js";
import type { AdapterOptions, BaseHarnessAdapter } from "../adapter-sdk/index.js";
import { dsError } from "../core/index.js";
import { ClaudeCodeAdapter } from "./claude-code/index.js";
import { CodexAdapter } from "./codex/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";

export { ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter };

export function createAdapter(id: HarnessId, opts: AdapterOptions): BaseHarnessAdapter {
  switch (id) {
    case "claude":
      return new ClaudeCodeAdapter(opts);
    case "codex":
      return new CodexAdapter(opts);
    case "opencode":
      return new OpenCodeAdapter(opts);
    default:
      throw dsError("configuration", "adapter", `Unknown harness: ${String(id)}`, { recoverable: false });
  }
}
