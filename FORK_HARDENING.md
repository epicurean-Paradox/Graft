# Fork Hardening

Date: 2026-09-01
Upstream pin: `aa1e2bb0f632` (NanoNets/context-graph-engine, release 0.16.0)
Branch: `gate-hardening`

This fork strips every network-touching and self-modifying behavior that is not
an explicit, user-initiated LLM request. Rationale: the operator's gate
conditions require (a) no telemetry egress of any kind, (b) no tool that
rewrites agent wiring or machine-global config outside an explicit `graft
init`, (c) no unsolicited registry/update traffic, and (d) LLM egress
restricted to Anthropic by default, with other endpoints reachable only by
explicit operator configuration.

## 1. Telemetry: dead at source

- Deleted `scripts/postinstall.mjs` and the `package.json` `postinstall` hook
  (upstream recorded an `install` event and spawned a detached flush at
  install time).
- Deleted `scripts/stamp-telemetry-key.mjs` and removed its invocation from
  the `prepare` script (upstream baked the PostHog ingestion key into
  `dist/telemetry/key.js` at publish time).
- `src/telemetry/send.ts` `sendBatch` is now an unconditional no-op returning
  `{ ok: true }`: the queue drains locally and nothing is transmitted. The
  exported signature is unchanged so `flush.ts` and `graft telemetry debug`
  compile as before.
- `BAKED_KEY` in `src/telemetry/key.ts` remains `''` (never stamped in this
  fork). The `events.nanonets.com` host constant remains in `key.ts` but is
  unreachable: the only code path that ever dereferenced it for a request was
  the fetch in `sendBatch`, which no longer exists.
- The telemetry gate/contract/queue files are retained: recording is local
  only, auditable via `graft telemetry status|debug`, and still honors
  `DO_NOT_TRACK` / `graft telemetry disable`.

## 2. No auto-rewiring

- `src/upkeep-run.ts` no longer imports or invokes `reconcileWiring` /
  `runInit` / `runHostsInit`. Upstream re-ran `graft init`'s writes (repo rule
  files, hooks, and machine-global `~/.codex` config) from the Claude Code
  `session-start` hook (`src/claude/hooks.ts`), MCP server boot
  (`src/mcp/server.ts`), and CLI startup whenever the wiring stamp disagreed
  with the running binary. `runUpkeep` is kept as a no-op returning no lines,
  so both call sites compile but have no effect. Wiring is written only by an
  explicit `graft init`.
- `reconcileWiring` itself remains in `src/upkeep.ts` as a pure, exported
  function with no live caller (unit tests exercise it); nothing reachable
  from the hook, the MCP server, or the CLI invokes it.

## 3. No update check

- Removed the CLI `preAction` background registry refresh and upgrade nudge
  (`src/cli.ts`), and the hidden `_update-check` command.
- `maybeRefreshInBackground` and `refreshUpdateCache` (`src/upkeep.ts`) are
  no-ops: nothing is spawned, nothing is fetched, nothing is written.
- `getNpmViewVersion` (`src/cli-meta.ts`) always returns `{ ok: false }`
  without spawning `npm view`, so `graft version` reports
  "latest: unreachable" instead of querying the registry. An explicit
  `graft upgrade` still runs `npm install -g` because the user asked for it.

## 4. Anthropic-only egress by default (SUPERSEDED 2026-09-09 by section 4b)

- `src/ai/providers.ts`: removed the `OPENROUTER_API_KEY` and
  `ORCAROUTER_API_KEY` key fallbacks, the `GRAFT_OPENROUTER_MODEL` /
  `ORCAROUTER_MODEL` model fallbacks, the `OPENROUTER_BASE_URL` /
  `ORCAROUTER_BASE_URL` env and constant base-URL defaults, the OpenRouter
  `X-Title` header, and the `usedLegacyEnv` field. Only `GRAFT_API_KEY`,
  `GRAFT_MODEL`, `GRAFT_BASE_URL`, `GRAFT_PROVIDER` (and explicit
  `EngineConfig`) are consulted.
- Default provider is `anthropic` (model `claude-sonnet-5`). `openai` and
  `litellm` remain selectable only via an explicit `GRAFT_PROVIDER` /
  `provider` setting; the `openai` default model is now the unprefixed
  `gpt-4o-mini`, since with no implicit gateway base URL the default endpoint
  is `api.openai.com`.
- Deleted `src/ai/llm/orcarouter.ts`, its factory case and `ProviderKind`
  member, its `src/index.ts` exports, and `test/orcarouter-adapter.test.ts`
  (it imported the deleted module). The `openai` npm dependency is retained:
  the `openai`/`litellm` adapters still compile, but no silent selection path
  reaches them.
- Comment-level mentions of third-party gateways in `src/` were scrubbed so a
  source grep is clean; historical mentions remain in `CHANGELOG.md`, `docs/`,
  and upstream's README.

## 4b. Bedrock-only egress (2026-09-09) — supersedes section 4

Section 4 pinned `GRAFT_PROVIDER=anthropic`, i.e. the direct Anthropic endpoint.
**One day later, claude-code-mastery ADR 0001 section 2 (operator ruling
2026-09-02) ruled that all model and embedding provisioning routes through AWS
Bedrock, with no direct vendor calls.** Section 4 therefore contradicted the
governing ADR from the day after it was written, and stayed dormant only because
ADR 0001 Amendment A1 admits this fork as a deterministic L1 writer in `plain
build` mode with **no LLM pass at all**. Merging this branch to `main` without
fixing it would have encoded the contradiction into the default branch, where the
next `build --deep` would find it.

- **`src/ai/llm/bedrock.ts` is the single model egress path.** Claude on Bedrock
  speaks the same Messages API, so the mapping the `anthropic` adapter held moved
  here verbatim (system hoisting, tool-result coalescing, forced-tool json mode,
  `providerRaw` replay, no `temperature`).
- **Deleted, not deselected:** `src/ai/llm/anthropic.ts`, `src/ai/llm/openai.ts`,
  `src/ai/llm/litellm.ts`, and the `openai` + `@anthropic-ai/sdk` **declared**
  dependencies. Section 4 kept `openai` declared on the reasoning that "no silent
  selection path reaches them" — a declared SDK beside a deleted adapter is still
  one import from live, which is the OrcaRouter failure mode this fork was opened by.
- **Stated rather than glossed:** `@anthropic-ai/sdk` remains INSTALLED
  transitively, because `@anthropic-ai/bedrock-sdk` depends on it — the Bedrock
  client extends the vendor base client and re-points it at a Bedrock endpoint with
  SigV4. That is the vendor's architecture, not a leak: no code here declares or
  imports it, so no path constructs a direct-endpoint client. The pin is named
  `direct_vendor_sdks_are_not_declared_dependencies` for exactly that reason — it
  checks `package.json`, not `node_modules`, and its name must not claim more.
- **Supply-chain cost, recorded because it is the real trade-off:** the lockfile
  grows from **101 to 247 packages** (+146: `@aws-sdk/*`, `@smithy/*`,
  `@aws-crypto/*`). Deleting the LLM path outright would have added zero. This was
  an explicit operator decision (2026-09-09) in favour of keeping `--deep` reachable
  under ADR 0001 section 2 rather than removing the capability.
- **`ProviderKind` has one member (`bedrock`).** An unsupported `GRAFT_PROVIDER`
  (including a stale `openai` in someone's shell) is now a **hard error**, where
  upstream cast the env var straight through to the factory.
- **The fail-closed gate moved, it was not dropped.** `apiKey` is gone from the
  config surface — Bedrock takes credentials from the AWS chain — so `AWS_REGION`
  is now the value that gates the LLM path, in `engine.ts`, `cli.ts` (`--deep`
  degrades to the $0 structural build without it) and `blast/name.ts`. The adapter
  itself refuses to construct without a region: the region decides *where* source
  code is transmitted, and that is never inferred.
- **Default model** `eu.anthropic.claude-sonnet-5` — short id, never an ARN; a
  cross-region call needs an inference profile rather than a foundation-model id.

**NOT ARMED.** This is a code path, not a live capability. Every Bedrock
precondition recorded for the sibling coppermind fork is unmet here: no scoped IAM
role, no named profile, no budget alarm, no verified model-id resolution. And
`build --deep` still ships raw file source to the model, so it remains a deliberate
per-run egress decision — forbidden outright over employer source without its own
ruling.

### Red-first pins (`test/bedrock-only-egress.test.ts`)

Nine pins, each failing on this branch's own 2026-09-01 state. Mutations applied,
suite re-run, the named pin observed failing:

| Mutation | Pin that goes red |
|---|---|
| restore `src/ai/llm/anthropic.ts` | adapters-stay-deleted + `no_direct_vendor_sdk_imports` |
| re-add `openai` to `ProviderKind` | `provider_kind_is_bedrock_only` |
| accept any `GRAFT_PROVIDER` | `unsupported_provider_is_rejected` |
| default the region to `us-east-1` | `region_is_required` |
| re-add the `openai` dependency | `no_direct_vendor_dependencies` |

`test/llm-adapters.test.ts`: the OpenAI half is deleted with its subject; the
Anthropic half is **converted** to Bedrock rather than dropped, because those five
mapping behaviours are exactly the logic that moved into `bedrock.ts`.

### Verification (2026-09-09)

- `tsc -p tsconfig.json` and `tsc -p viewer/tsconfig.json` both clean.
- `grep -rE "api\.anthropic\.com|api\.openai\.com|openrouter" src/` — zero hits
  (the endpoint-host pin greps all of `src/`; prose was reworded rather than the pin
  exempted).
- `npm test`: **464 pass / 106 fail**, against a pre-change baseline of **466 / 106**.
  Every one of the 106 is `No native build was found for platform=darwin` —
  tree-sitter native modules unbuilt because the fork installs with
  `--ignore-scripts`. Pre-existing and environmental; **zero failures introduced**.
  The net −2 passing is the deleted OpenAI/litellm adapter tests.

## Verification (2026-09-01)

- `npm ci --ignore-scripts` + `tsc -p tsconfig.json` build clean from source.
- `grep -ri "orcarouter\|openrouter" src/` — zero hits.
- `grep -rn "maybeRefreshInBackground\|_update-check" src/` — no live call
  sites (only the neutralized definitions in `src/upkeep.ts`).
- `grep -rn "reconcileWiring" src/` — definition only; no caller reachable
  from hooks or the MCP server.
- `grep -rn "events.nanonets.com" src/` — one hit, the `BAKED_HOST` constant
  in `src/telemetry/key.ts`, unreachable (no fetch path exists).
- `package.json` has no `postinstall`; `BAKED_KEY` is `''`.
