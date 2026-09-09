import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";

/**
 * User-facing configuration. Anything omitted falls back to environment
 * variables and then to sensible defaults.
 *
 * FORK HARDENING (2026-09-09): Bedrock is the only provider, so there is no
 * API key and no base URL to configure -- credentials come from the AWS chain and
 * the only egress-selecting value is the region, which is REQUIRED rather than
 * defaulted. `apiKey`/`baseUrl` are gone from the config surface; keeping them as
 * ignored fields would read as configurable and silently do nothing.
 * See FORK_HARDENING.md.
 */
export interface EngineConfig {
  /** Where the graph lives. Env: GRAFT_DIR. Default: `<repo>/.context`. */
  contextDir?: string;

  /** Provider. Env: GRAFT_PROVIDER. Only `bedrock` is supported. */
  provider?: ProviderKind;
  /** Model id. Env: GRAFT_MODEL. Short form only (see reference_bedrock_chat_config). */
  model?: string;
  /** AWS region for Bedrock. Env: AWS_REGION. No default -- egress must be explicit. */
  region?: string;

  // --- advanced: bring your own components ---
  /** Override the whole transport (skips provider/model/region). */
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
  model: string;
  region?: string;
  chatModel?: ChatModel;
  synthesizer?: Synthesizer;
  summarizer?: Summarizer;
  cruxSummarizer?: CruxSummarizer;
}

/**
 * Per-provider default model. Short id only: a Bedrock ARN or a long id fails to
 * resolve, and a cross-region call needs an inference profile rather than a
 * foundation-model id (memory `reference_bedrock_chat_config`).
 */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  bedrock: "eu.anthropic.claude-sonnet-5",
};

export const DEFAULTS = {
  provider: "bedrock" as ProviderKind,
  model: DEFAULT_MODELS.bedrock,
} as const;

/**
 * Merge user config with environment variables and defaults.
 *
 * FORK HARDENING (2026-09-09): an unsupported `GRAFT_PROVIDER` is a hard error,
 * never a silent fall-through to the default. Upstream read the env var straight
 * into a cast, so a typo (or a stale `GRAFT_PROVIDER=openai` in someone's shell)
 * would have been carried into the factory rather than rejected.
 */
export function resolveConfig(config: EngineConfig = {}): ResolvedConfig {
  const env = process.env;
  const requested = config.provider ?? env.GRAFT_PROVIDER ?? DEFAULTS.provider;
  if (requested !== "bedrock") {
    throw new Error(
      `Unsupported provider "${String(requested)}". This fork routes all model calls ` +
        "through AWS Bedrock (claude-code-mastery ADR 0001 section 2); the direct-vendor " +
        "adapters are deleted, not disabled.",
    );
  }
  const provider: ProviderKind = "bedrock";
  const model = config.model ?? env.GRAFT_MODEL ?? DEFAULT_MODELS[provider];
  const region = config.region ?? env.AWS_REGION;

  return {
    contextDir: config.contextDir ?? env.GRAFT_DIR,
    provider,
    model,
    region,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
