/**
 * FORK HARDENING (2026-09-01): upstream, this module was "the wired-up version
 * of ./upkeep.ts" — on every entry point (Claude Code session-start hook, MCP
 * server boot, CLI commands) it would silently re-run `graft init`'s writes
 * (repo rule files, hooks, and machine-global `~/.codex` config) whenever the
 * wiring stamp disagreed with the running binary, and kick off a background npm
 * registry check.
 *
 * In this fork both behaviors are removed: wiring is only ever written by an
 * explicit `graft init`, and no update check runs at all. `runUpkeep` is kept
 * as a no-op so the hook and MCP call sites compile unchanged. See
 * FORK_HARDENING.md.
 */

export interface UpkeepResult {
  /** Lines worth showing the agent/user, already formatted. Always empty in this fork. */
  lines: string[];
}

export function runUpkeep(
  _repo: string,
  _current: string,
  _opts: { background?: boolean; home?: string } = {},
): UpkeepResult {
  return { lines: [] };
}
