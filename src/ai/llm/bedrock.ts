/**
 * AWS Bedrock transport — the fork's ONLY model egress path.
 *
 * Claude on Bedrock speaks the same Messages API as the direct Anthropic
 * endpoint, so this adapter carries the identical request/response mapping the
 * `anthropic` adapter used to hold (that file is deleted; its logic lives here):
 *   - `system` is a top-level parameter, not a message.
 *   - tool results ride inside a USER turn, and all results answering one
 *     assistant turn must be coalesced into a single user message.
 *   - `max_tokens` is required (callers get a default).
 *   - `temperature` is rejected by current models, so it is never forwarded.
 *   - structured output is a forced tool (there is no `response_format`).
 *   - assistant turns are replayed verbatim (via `providerRaw`) so thinking-block
 *     signatures survive a multi-turn loop.
 *
 * WHY BEDROCK IS THE ONLY PROVIDER (2026-09-09). The 2026-09-01 hardening pinned
 * `GRAFT_PROVIDER=anthropic`, i.e. the direct Anthropic endpoint. One day later,
 * claude-code-mastery ADR 0001 section 2 ruled that all model and embedding
 * provisioning routes through AWS Bedrock, with no direct vendor calls to
 * Anthropic, OpenAI, Grok, Perplexity or Gemini. The pin therefore contradicted the
 * governing ADR, and stayed dormant only because ADR 0001 Amendment A1 admits this
 * fork as a deterministic L1 writer in `plain build` mode with no LLM pass at all.
 * Merging the hardening to the default branch would have encoded that contradiction
 * where the next `--deep` run would find it, so the direct-vendor adapters are
 * DELETED rather than deselected — a disabled path is one env var from live, which
 * is the exact OrcaRouter failure mode this fork's own audit was opened by.
 *
 * NOT ARMED. This is the code path, not a live capability. It refuses to construct
 * without an explicit region, and `graft build --deep` over any repository remains
 * a deliberate per-run egress decision (raw file source is sent to the model).
 * Bedrock's own preconditions — a scoped IAM role, resolvable model ids, a budget
 * alarm — are unmet on this fork; see FORK_HARDENING.md.
 */
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { transportRetries } from "./types.js";
import type { ChatModel, ChatRequest, ChatResponse, Message, ToolCall, ToolSpec, Usage } from "./types.js";

const PROVIDER = "bedrock";
const JSON_TOOL = "emit_json";
const DEFAULT_MAX_TOKENS = 4096;

/**
 * The client surface this adapter uses. Declared structurally rather than as the
 * concrete SDK class so a test can inject a stub without an AWS credential chain,
 * and so the adapter never depends on more of the SDK than it calls.
 */
export interface BedrockMessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<BedrockMessage>;
  };
}

interface BedrockMessage {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string | null;
}

export interface BedrockChatModelOptions {
  /** Bedrock model id or inference-profile id. Short form only. */
  model: string;
  /** AWS region. Required: there is no safe default for where data egresses. */
  region?: string;
  label?: string;
  /** Inject a pre-built client (tests pass a stub; production omits it). */
  client?: BedrockMessagesClient;
}

type CacheControl = { cache_control: { type: "ephemeral" } } | Record<string, never>;
const cc = (on: boolean | undefined): CacheControl => (on ? { cache_control: { type: "ephemeral" } } : {});

export class BedrockChatModel implements ChatModel {
  readonly label: string;
  private client: BedrockMessagesClient;
  private model: string;

  constructor(opts: BedrockChatModelOptions) {
    this.model = opts.model;
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;

    if (opts.client) {
      this.client = opts.client;
    } else {
      // Fail closed on region. The SDK would otherwise fall back to an ambient
      // AWS_REGION/profile, which decides WHERE source code is transmitted --
      // never something to infer silently.
      const region = opts.region ?? process.env.AWS_REGION;
      if (!region) {
        throw new Error(
          "No AWS region for Bedrock. Set AWS_REGION (or pass region) so the egress " +
            "destination is explicit. graft never infers where source code is sent.",
        );
      }
      this.client = new AnthropicBedrock({
        awsRegion: region,
        maxRetries: transportRetries(),
      }) as unknown as BedrockMessagesClient;
    }
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    const system: Array<Record<string, unknown>> = [];
    const messages: Array<Record<string, unknown>> = [];

    for (const m of req.messages) {
      if (m.role === "system") {
        system.push({ type: "text", text: m.content, ...cc(m.cacheBreakpoint) });
      } else if (m.role === "user") {
        messages.push({ role: "user", content: [{ type: "text", text: m.content, ...cc(m.cacheBreakpoint) }] });
      } else if (m.role === "tool") {
        // Tool results live in a user turn; coalesce consecutive results together.
        const block = {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: [{ type: "text", text: m.content }],
          ...cc(m.cacheBreakpoint),
        };
        const last = messages[messages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as Array<Record<string, unknown>>).push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
      } else {
        messages.push(this.assistantParam(m));
      }
    }

    const tools = req.tools?.map(toBedrockTool);
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system.length ? { system } : {}),
    };
    // temperature is intentionally NOT forwarded -- current models reject it.

    const fmt = req.responseFormat ?? { kind: "text" };
    if (fmt.kind === "json") {
      params.tools = [
        ...(tools ?? []),
        { name: JSON_TOOL, description: "Return the answer as a JSON object.", input_schema: { type: "object" } },
      ];
      params.tool_choice = { type: "tool", name: JSON_TOOL };
    } else if (fmt.kind === "tool") {
      params.tools = tools;
      params.tool_choice = { type: "tool", name: fmt.name };
    } else if (tools) {
      params.tools = tools;
    }

    const resp = await this.client.messages.create(params);
    return this.fromResponse(resp, fmt.kind);
  }

  /** Reconstruct an assistant turn, replaying the original blocks when we made them. */
  private assistantParam(m: Message): Record<string, unknown> {
    if (m.providerRaw?.provider === PROVIDER) return m.providerRaw.raw as Record<string, unknown>;
    const content: Array<Record<string, unknown>> = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls ?? []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args as Record<string, unknown> });
    }
    return { role: "assistant", content };
  }

  private fromResponse(resp: BedrockMessage, format: "text" | "json" | "tool"): ChatResponse {
    let text = "";
    let toolCalls: ToolCall[] = [];
    for (const block of resp.content ?? []) {
      if (block.type === "text") text += (block as { text: string }).text;
      else if (block.type === "tool_use") {
        const b = block as { id: string; name: string; input: unknown };
        toolCalls.push({ id: b.id, name: b.name, args: b.input });
      }
    }

    if (format === "json") {
      const jsonCall = toolCalls.find((c) => c.name === JSON_TOOL);
      if (jsonCall) text = JSON.stringify(jsonCall.args);
      toolCalls = toolCalls.filter((c) => c.name !== JSON_TOOL);
    }

    return {
      text,
      toolCalls,
      usage: normalizeUsage(resp.usage),
      stopReason: resp.stop_reason ?? null,
      // Replay the raw content verbatim so thinking-block signatures survive.
      assistant: {
        role: "assistant",
        content: text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        providerRaw: { provider: PROVIDER, raw: { role: "assistant", content: resp.content } },
      },
    };
  }
}

function toBedrockTool(t: ToolSpec): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

/** Bedrock reports uncached input in `input_tokens` and cache tokens separately. */
function normalizeUsage(u: BedrockMessage["usage"]): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreate: u?.cache_creation_input_tokens ?? 0,
  };
}
