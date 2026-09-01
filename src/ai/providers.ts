import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";

/**
 * User-facing configuration. Anything omitted falls back to environment
 * variables and then to sensible defaults.
 *
 * FORK HARDENING (2026-09-01): the default provider is `anthropic`, and the
 * legacy third-party key/base-URL fallbacks are removed — no environment
 * variable other than the explicit GRAFT_* ones can select an egress endpoint.
 * `openai` and `litellm` remain selectable, but only via an explicit
 * GRAFT_PROVIDER / `provider` setting. See FORK_HARDENING.md.
 */
export interface EngineConfig {
  /** Where the graph lives. Env: GRAFT_DIR. Default: `<repo>/.context`. */
  contextDir?: string;

  /** Wire format / SDK. Env: GRAFT_PROVIDER. Default: `anthropic`. */
  provider?: ProviderKind;
  /** API key for the chosen provider. Env: GRAFT_API_KEY. */
  apiKey?: string;
  /** Model id. Env: GRAFT_MODEL. Provider-specific default. */
  model?: string;
  /** Base URL for OpenAI-compatible endpoints. Env: GRAFT_BASE_URL. */
  baseUrl?: string;

  // --- advanced: bring your own components ---
  /** Override the whole transport (skips provider/apiKey/baseUrl). */
  chatModel?: ChatModel;
  /** Override the synthesizer. */
  synthesizer?: Synthesizer;
  /** Override the code summarizer. */
  summarizer?: Summarizer;
  /** Override the per-symbol crux summarizer. */
  cruxSummarizer?: CruxSummarizer;
}

/** Fully-resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  contextDir?: string;
  provider: ProviderKind;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  chatModel?: ChatModel;
  synthesizer?: Synthesizer;
  summarizer?: Summarizer;
  cruxSummarizer?: CruxSummarizer;
}

/** Per-provider default model. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  // Provider-prefixed so the LiteLLM proxy routes it; override with GRAFT_MODEL.
  litellm: "openai/gpt-4o-mini",
};

export const DEFAULTS = {
  provider: "anthropic" as ProviderKind,
  model: DEFAULT_MODELS.anthropic,
} as const;

/**
 * Merge user config with environment variables and defaults.
 *
 * FORK HARDENING (2026-09-01): only the explicit GRAFT_* environment variables
 * are consulted. The upstream third-party key fallbacks and gateway base-URL
 * defaults are removed, so no endpoint is ever selected implicitly.
 */
export function resolveConfig(config: EngineConfig = {}): ResolvedConfig {
  const env = process.env;
  const provider = config.provider ?? (env.GRAFT_PROVIDER as ProviderKind | undefined) ?? DEFAULTS.provider;

  const apiKey = config.apiKey ?? env.GRAFT_API_KEY;
  const model = config.model ?? env.GRAFT_MODEL ?? DEFAULT_MODELS[provider];
  const baseUrl = config.baseUrl ?? env.GRAFT_BASE_URL;

  return {
    contextDir: config.contextDir ?? env.GRAFT_DIR,
    provider,
    apiKey,
    model,
    baseUrl,
    headers: undefined,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
