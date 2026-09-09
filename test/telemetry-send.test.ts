/**
 * FORK HARDENING (2026-09-01): upstream, these tests exercised the real send
 * path against a local HTTP stub. In this fork `sendBatch` is a no-op by
 * design, so the load-bearing assertion is inverted: even with a key and a
 * reachable host configured, NO request is ever made. These tests fail on
 * upstream's implementation (which would hit the stub), so they pin the
 * hardening rather than document it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildBatch, sendBatch } from '../src/telemetry/send.js';
import { posthogHost } from '../src/telemetry/key.js';

interface Hit { path: string; body: any }

let server: Server;
let port = 0;
let hits: Hit[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null });
      res.writeHead(200); res.end('{"status":1}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  process.env.GRAFT_POSTHOG_KEY = 'phc_send_test';
  process.env.GRAFT_POSTHOG_HOST = `http://127.0.0.1:${port}`;
});

after(() => { server.close(); });

const EVENTS = [{ event: 'query', properties: { command: 'ask' }, distinct_id: 'abc', timestamp: '2026-01-01T00:00:00Z' }];

test('sendBatch makes no request even with a key and a reachable host', async () => {
  hits = [];
  const res = await sendBatch(EVENTS);
  assert.deepEqual(res, { ok: true }, 'reports success so the queue drains');
  // Give any (wrongly) fired request a beat to land before asserting silence.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(hits, [], 'fork hardening: no telemetry request may ever be made');
});

test('an empty batch is also not a request', async () => {
  hits = [];
  assert.deepEqual(await sendBatch([]), { ok: true });
  assert.deepEqual(hits, []);
});

test('the default host constant is retained but never contacted', () => {
  const saved = process.env.GRAFT_POSTHOG_HOST;
  delete process.env.GRAFT_POSTHOG_HOST;
  assert.equal(posthogHost(), 'https://events.nanonets.com');
  process.env.GRAFT_POSTHOG_HOST = saved;
});

test('a trailing slash on the configured host does not produce a double slash', () => {
  const saved = process.env.GRAFT_POSTHOG_HOST;
  process.env.GRAFT_POSTHOG_HOST = 'https://events.nanonets.com///';
  assert.equal(posthogHost(), 'https://events.nanonets.com');
  process.env.GRAFT_POSTHOG_HOST = saved;
});

test('buildBatch still carries no key (printed by `graft telemetry debug`)', () => {
  assert.equal('api_key' in buildBatch(EVENTS), false);
});
