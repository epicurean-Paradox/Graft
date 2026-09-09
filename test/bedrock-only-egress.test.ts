/**
 * Fork gate: Bedrock is the ONLY model egress path.
 *
 * These pins fail on this fork's own 2026-09-01 `gate-hardening` state, which
 * pinned `GRAFT_PROVIDER=anthropic` (i.e. `api.anthropic.com`) and kept the
 * `openai` / `litellm` adapters selectable. claude-code-mastery ADR 0001 section 2
 * (operator ruling 2026-09-02) bans that outright: "all model and embedding
 * provisioning routes through AWS Bedrock -- no api.anthropic.com, no
 * OpenAI/Grok/Perplexity/Gemini direct calls."
 *
 * Red-first record -- each mutation applied to the source, suite re-run, the named
 * test observed failing:
 *   - restore src/ai/llm/anthropic.ts        -> no_direct_vendor_sdk_imports fails
 *   - re-add "openai" to ProviderKind        -> provider_kind_is_bedrock_only fails
 *   - accept an unsupported GRAFT_PROVIDER   -> unsupported_provider_is_rejected fails
 *   - default the region to a fallback       -> region_is_required fails
 *   - re-add the `openai` npm dependency     -> direct_vendor_sdks_are_not_declared_dependencies fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS, DEFAULTS, resolveConfig } from "../src/ai/providers.js";
import { BedrockChatModel } from "../src/ai/llm/bedrock.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every tracked .ts file under src/, so a new adapter cannot hide in a subdir. */
function srcFiles(dir = join(REPO, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("the deleted direct-vendor adapters stay deleted", () => {
  for (const p of ["src/ai/llm/anthropic.ts", "src/ai/llm/openai.ts", "src/ai/llm/litellm.ts"]) {
    assert.equal(existsSync(join(REPO, p)), false, `${p} is back; deselecting is not deleting`);
  }
});

test("no_direct_vendor_sdk_imports", () => {
  // The Bedrock SDK is @anthropic-ai/bedrock-sdk. The DIRECT SDKs are
  // @anthropic-ai/sdk and openai -- importing either reintroduces a vendor
  // endpoint. Matched on the import specifier, not a bare vendor name, so a
  // comment or a model id like "anthropic.claude-..." does not trip it.
  const offenders: string[] = [];
  for (const p of srcFiles()) {
    const src = readFileSync(p, "utf8");
    if (/from\s+["'](@anthropic-ai\/sdk|openai)["']/.test(src) || /require\(["'](@anthropic-ai\/sdk|openai)["']\)/.test(src)) {
      offenders.push(p.slice(REPO.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `direct-vendor SDK imports found: ${offenders.join(", ")}`);
});

test("no direct-vendor endpoint hosts in src/", () => {
  const offenders: string[] = [];
  for (const p of srcFiles()) {
    const src = readFileSync(p, "utf8");
    // events.nanonets.com is the telemetry constant the 2026-09-01 audit left
    // deliberately unreachable; it is not a model endpoint, so it is not in scope.
    if (/api\.anthropic\.com|api\.openai\.com|openrouter\.ai|orcarouter|api\.x\.ai|generativelanguage\.googleapis/.test(src)) {
      offenders.push(p.slice(REPO.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `direct-vendor hosts found: ${offenders.join(", ")}`);
});

test("direct_vendor_sdks_are_not_declared_dependencies", () => {
  // NAMED for exactly what it checks: the DECLARED dependency set, not the
  // contents of node_modules. `@anthropic-ai/sdk@0.117.x` is still INSTALLED
  // transitively, because @anthropic-ai/bedrock-sdk depends on it -- the Bedrock
  // client extends the vendor's base client and re-points it at a Bedrock
  // endpoint with SigV4 signing. That is the vendor's own architecture and cannot
  // be removed without dropping Bedrock support; what this fork controls is that
  // nothing here DECLARES it or IMPORTS it (see no_direct_vendor_sdk_imports),
  // so no code path constructs a direct-endpoint client.
  //
  // The 2026-09-01 hardening kept `openai` DECLARED on the reasoning that "no
  // silent selection path reaches them". A declared SDK beside a deleted adapter
  // is still one import from live, and it ships the client to every consumer.
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const banned of ["openai", "@anthropic-ai/sdk"]) {
    assert.equal(deps.includes(banned), false, `${banned} is a declared dependency again`);
  }
  assert.equal(deps.includes("@anthropic-ai/bedrock-sdk"), true, "the Bedrock SDK is missing");
});

test("provider_kind_is_bedrock_only", () => {
  assert.deepEqual(Object.keys(DEFAULT_MODELS), ["bedrock"]);
  assert.equal(DEFAULTS.provider, "bedrock");
  // Short id, not an ARN: an ARN fails to resolve on Bedrock, and a cross-region
  // call needs an inference profile rather than a foundation-model id.
  assert.match(DEFAULTS.model, /^[a-z0-9.-]+$/);
  assert.equal(DEFAULTS.model.startsWith("arn:"), false);
});

test("unsupported_provider_is_rejected", () => {
  for (const bad of ["anthropic", "openai", "litellm", "typo"]) {
    assert.throws(
      () => resolveConfig({ provider: bad as never }),
      /Unsupported provider/,
      `provider "${bad}" was accepted; it must be a hard error, never a silent default`,
    );
  }
  // And via the environment, which is how a stale shell would reach it.
  const prev = process.env.GRAFT_PROVIDER;
  process.env.GRAFT_PROVIDER = "openai";
  try {
    assert.throws(() => resolveConfig(), /Unsupported provider/);
  } finally {
    if (prev === undefined) delete process.env.GRAFT_PROVIDER;
    else process.env.GRAFT_PROVIDER = prev;
  }
});

test("region_is_required", () => {
  const prev = process.env.AWS_REGION;
  delete process.env.AWS_REGION;
  try {
    assert.throws(
      () => new BedrockChatModel({ model: "eu.anthropic.claude-sonnet-5" }),
      /No AWS region/,
      "constructed without a region; the region decides WHERE source code is sent",
    );
  } finally {
    if (prev !== undefined) process.env.AWS_REGION = prev;
  }
});

test("the adapter maps the Messages API without reaching the network", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const model = new BedrockChatModel({
    model: "eu.anthropic.claude-sonnet-5",
    client: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          return {
            content: [{ type: "text" as const, text: "ok" }],
            usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
            stop_reason: "end_turn",
          };
        },
      },
    },
  });

  const resp = await model.create({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    maxTokens: 128,
    temperature: 0.5,
  });

  assert.equal(model.label, "bedrock:eu.anthropic.claude-sonnet-5");
  assert.equal(resp.text, "ok");
  assert.deepEqual(resp.usage, { input: 7, output: 3, cacheRead: 2, cacheCreate: 0 });
  assert.equal(resp.assistant.providerRaw?.provider, "bedrock");

  const sent = seen[0];
  // system is hoisted out of messages; temperature is never forwarded (current
  // models reject it); max_tokens is always present.
  assert.ok(Array.isArray(sent.system));
  assert.equal((sent.messages as unknown[]).length, 1);
  assert.equal("temperature" in sent, false);
  assert.equal(sent.max_tokens, 128);
});

test("tool results are coalesced into one user turn", async () => {
  let sent: Record<string, unknown> = {};
  const model = new BedrockChatModel({
    model: "m",
    client: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          sent = params;
          return { content: [], usage: {}, stop_reason: null };
        },
      },
    },
  });

  await model.create({
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", args: {} }] },
      { role: "tool", content: "r1", toolCallId: "a" },
      { role: "tool", content: "r2", toolCallId: "b" },
    ],
  });

  const msgs = sent.messages as Array<{ role: string; content: unknown[] }>;
  // assistant turn, then ONE user turn carrying both tool results.
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, "user");
  assert.equal(msgs[1].content.length, 2);
});
