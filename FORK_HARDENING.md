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

## 4. Anthropic-only egress by default

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
