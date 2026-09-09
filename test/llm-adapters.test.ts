/**
 * Network-free adapter tests for the fork's ONLY transport.
 *
 * The adapter is handed a STUB client that records the request it received and
 * returns a canned response, so both directions of the translation
 * (neutral -> wire, wire -> neutral) are asserted with no credentials and no
 * network.
 *
 * FORK HARDENING (2026-09-09): this file previously tested the `openai` and
 * `anthropic` adapters. The OpenAI half is DELETED with its subject. The Anthropic
 * half is CONVERTED rather than dropped: Claude on Bedrock speaks the same Messages
 * API, so these five mapping behaviours -- system hoisting, tool-result coalescing,
 * object-valued tool input, assistant replay, forced-tool json mode -- are exactly
 * the logic that moved into `bedrock.ts`, and losing the coverage would have been
 * the real cost of the provider swap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BedrockChatModel } from "../src/ai/llm/bedrock.js";
import type { BedrockMessagesClient } from "../src/ai/llm/bedrock.js";
import type { ChatRequest } from "../src/ai/llm/types.js";

function fakeBedrock(resp: unknown) {
  const box: { params?: any } = {};
  const client = {
    messages: { create: async (params: any) => ((box.params = params), resp) },
  } as unknown as BedrockMessagesClient;
  return { client, box };
}

function bedrockResp(over: Partial<any> = {}): any {
  return {
    content: [{ type: "text", text: "hi there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 },
    ...over,
  };
}

test("bedrock: system is hoisted, temperature dropped, max_tokens defaulted", async () => {
  const { client, box } = fakeBedrock(bedrockResp());
  const m = new BedrockChatModel({ model: "claude-x", client });
  const res = await m.create({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    temperature: 0, // must NOT be forwarded
  });
  assert.equal(box.params.system[0].text, "sys");
  assert.equal(box.params.messages.length, 1);
  assert.equal(box.params.messages[0].role, "user");
  assert.equal(box.params.temperature, undefined);
  assert.equal(box.params.max_tokens, 4096);
  assert.deepEqual(res.usage, { input: 70, output: 20, cacheRead: 30, cacheCreate: 5 });
});

test("bedrock: consecutive tool results coalesce into ONE user turn", async () => {
  const { client, box } = fakeBedrock(bedrockResp());
  const m = new BedrockChatModel({ model: "claude-x", client });
  const req: ChatRequest = {
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", args: {} }, { id: "b", name: "t", args: {} }] },
      { role: "tool", toolCallId: "a", content: "ra" },
      { role: "tool", toolCallId: "b", content: "rb" },
    ],
  };
  await m.create(req);
  const msgs = box.params.messages;
  const lastUser = msgs[msgs.length - 1];
  assert.equal(lastUser.role, "user");
  assert.equal(lastUser.content.length, 2); // both tool_result blocks in one turn
  assert.equal(lastUser.content[0].tool_use_id, "a");
  assert.equal(lastUser.content[1].tool_use_id, "b");
});

test("bedrock: tool_use input is an object (no JSON.parse round-trip)", async () => {
  const resp = bedrockResp({
    content: [{ type: "tool_use", id: "u1", name: "record_graph", input: { nodes: [1] } }],
    stop_reason: "tool_use",
  });
  const { client } = fakeBedrock(resp);
  const m = new BedrockChatModel({ model: "claude-x", client });
  const res = await m.create({
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "record_graph", description: "d", parameters: { type: "object" } }],
    responseFormat: { kind: "tool", name: "record_graph" },
  });
  assert.deepEqual(res.toolCalls[0].args, { nodes: [1] });
});

test("bedrock: reconstructed assistant tool_use carries the object input", async () => {
  const { client, box } = fakeBedrock(bedrockResp());
  const m = new BedrockChatModel({ model: "claude-x", client });
  await m.create({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "u1", name: "t", args: { k: 1 } }] },
      { role: "tool", toolCallId: "u1", content: "res" },
    ],
  });
  const asst = box.params.messages[1];
  assert.equal(asst.content[0].type, "tool_use");
  assert.deepEqual(asst.content[0].input, { k: 1 });
});

test("bedrock: json mode forces emit_json and returns serialized text", async () => {
  const resp = bedrockResp({
    content: [{ type: "tool_use", id: "j1", name: "emit_json", input: { correct: true } }],
    stop_reason: "tool_use",
  });
  const { client, box } = fakeBedrock(resp);
  const m = new BedrockChatModel({ model: "claude-x", client });
  const res = await m.create({ messages: [{ role: "user", content: "grade" }], responseFormat: { kind: "json" } });
  assert.deepEqual(box.params.tool_choice, { type: "tool", name: "emit_json" });
  assert.equal(res.text, '{"correct":true}');
  assert.equal(res.toolCalls.length, 0);
});
