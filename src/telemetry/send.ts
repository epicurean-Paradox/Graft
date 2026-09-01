/**
 * FORK HARDENING (2026-09-01): upstream, this module held the one non-LLM
 * network call in graft — a fetch POST of the queued telemetry batch to a
 * PostHog ingest host. In this fork that call is removed entirely: `sendBatch`
 * discards its input and returns success, so no telemetry ever leaves the
 * machine. `buildBatch` is kept because `graft telemetry debug` prints it so a
 * user can audit what WOULD have been sent. See FORK_HARDENING.md.
 */
export interface SendResult {
  ok: boolean;
  status?: number;
  /** Why it failed, for `graft telemetry debug` only — never itself reported. */
  error?: string;
}

/**
 * The events as PostHog wants them — everything the wire body contains EXCEPT
 * the project key.
 *
 * The key is deliberately not in here. `graft telemetry debug` prints this
 * object so a user can audit exactly what graft sends, and a command that exists
 * to be pasted into a bug report must not also paste our ingestion key into it.
 * `sendBatch` adds the key at the moment of the request and nowhere else, which
 * keeps the key entirely out of every code path that can reach a terminal.
 */
export function buildBatch(events: unknown[]): Record<string, unknown> {
  return {
    batch: events.map((e) => {
      const ev = e as { event: string; properties?: Record<string, string>; timestamp?: string; distinct_id?: string };
      return {
        event: ev.event,
        timestamp: ev.timestamp,
        properties: {
          ...(ev.properties ?? {}),
          distinct_id: ev.distinct_id,
          // Anonymous event: PostHog stores it without creating a person.
          $process_person_profile: false,
        },
      };
    }),
  };
}

/**
 * FORK HARDENING (2026-09-01): telemetry is disabled at source in this fork.
 *
 * This function used to POST the batch to the PostHog ingest host. It now
 * discards the events and reports success unconditionally, so the local queue
 * drains and nothing is ever transmitted. The signature is kept so callers
 * (flush.ts, `graft telemetry debug`) compile unchanged. See FORK_HARDENING.md.
 */
export async function sendBatch(events: unknown[]): Promise<SendResult> {
  void events;
  return { ok: true };
}
