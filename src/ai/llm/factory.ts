/**
 * One place that turns resolved config into a {@link ChatModel}.
 *
 * FORK HARDENING (2026-09-09): Bedrock is the ONLY provider. The `anthropic`,
 * `openai` and `litellm` adapters are DELETED, not deselected -- claude-code-mastery
 * ADR 0001 section 2 bans direct vendor APIs outright ("all model and embedding
 * provisioning routes through AWS Bedrock"), and a merely-deselected adapter is one
 * env var from live. `ProviderKind` keeps its shape so call sites and the exported
 * type surface are unchanged; it simply has one member now, which makes an
 * unsupported `GRAFT_PROVIDER` a hard error instead of a silent endpoint switch.
 *
 * Adding a provider back is a deliberate ADR amendment, not a code convenience.
 */
import type { ChatModel } from "./types.js";
import { BedrockChatModel } from "./bedrock.js";

export type ProviderKind = "bedrock";

export interface ChatModelConfig {
  provider: ProviderKind;
  model: string;
  /** AWS region. Required by the adapter; no default (see bedrock.ts). */
  region?: string;
}

export function createChatModel(cfg: ChatModelConfig): ChatModel {
  switch (cfg.provider) {
    case "bedrock":
      return new BedrockChatModel({ model: cfg.model, region: cfg.region });
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${String(_exhaustive)}`);
    }
  }
}
