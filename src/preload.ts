import { randomBytes } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  makeEphemeralHome,
  removeHome,
  runKimi,
  sourceHome,
  type KimiRun,
  type LaunchOptions,
} from './index.ts';

/**
 * Preload: give a run a synthetic past.
 *
 * Mechanism (runtime-measured 2026-09-15 on kimi 0.41.0, re-verified from
 * source 2026-09-24 on kimi-code @ 6451f1e / installed 2.0.1): a primer
 * `kimi -p` run creates a session; each file is appended to
 * `agents/main/wire.jsonl` as a `context.append_message` record (user
 * origin, text part, fabricated `msg_` id); the real call to action resumes
 * the session, and replay folds the records into model-visible context as
 * real past. Replay gates are purely structural: a wire record is any JSON
 * line with a string `type`, a missing agentId is injected as the resuming
 * agent, and the context event schemas are effectively unvalidated
 * (`z.custom()`). Content-part types ARE validated at request assembly
 * (`text|think|image_url|audio_url|video_url`), so preload content goes in
 * as text.
 *
 * Honest costs and caveats:
 * - The preloaded content is served as input tokens on EVERY turn of the
 *   resumed session — what this saves is tool round-trips and prompt
 *   length limits, not tokens. There is no zero-token preload.
 * - A wire file authenticates nothing: replay trusts structure, not
 *   provenance. Anyone who can write the session dir can fabricate past.
 * - A malformed record (e.g. an invalid content-part type) breaks every
 *   later resume of that session until edited out of the wire.
 * - The store is append-only; preload always appends, never rewrites.
 */

export interface PreloadItem {
  readonly path: string;
  readonly content: string;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function fabricateId(): string {
  const bytes = randomBytes(24);
  let out = 'msg_';
  for (const byte of bytes) out += BASE62[byte % 62]!;
  return out;
}

export function formatPreloadMessage(item: PreloadItem): string {
  const lines = item.content.split('\n').length;
  return `[preload] ${item.path} (${lines} lines)\n\n${item.content}`;
}

/**
 * One append-only wire record carrying `item` as a past user message.
 * `at` is epoch milliseconds; wire `time` is optional metadata, never
 * validated, but keeping it plausible costs nothing.
 */
export function preloadRecord(item: PreloadItem, at: number): Record<string, unknown> {
  return {
    type: 'context.append_message',
    agentId: 'main',
    message: {
      role: 'user',
      content: [{ type: 'text', text: formatPreloadMessage(item) }],
      toolCalls: [],
      origin: { kind: 'user' },
      id: fabricateId(),
    },
    time: at,
  };
}

/** Read a preload file, rejecting binary content before any run is wasted. */
export function readPreloadItem(path: string): PreloadItem {
  const buf = readFileSync(path);
  if (buf.includes(0)) {
    throw new Error(`${path} looks binary (contains NUL); preload content goes in as text`);
  }
  return { path, content: buf.toString('utf-8') };
}

/** Locate a session's main-agent wire journal inside a run home. */
export function findWire(home: string, sessionId: string): string {
  const sessions = join(home, 'sessions');
  for (const wd of readdirSync(sessions)) {
    const wire = join(sessions, wd, sessionId, 'agents', 'main', 'wire.jsonl');
    try {
      statSync(wire);
      return wire;
    } catch {
      // try next workspace bucket
    }
  }
  throw new Error(`wire.jsonl for ${sessionId} not found under ${sessions}`);
}

/**
 * Append preload records to a wire.jsonl after a primer run. The store is
 * append-only; a later `kimi -r <id>` replays these as real past.
 */
export function appendPreload(wirePath: string, items: readonly PreloadItem[]): number {
  let at = Date.now();
  for (const item of items) {
    appendFileSync(wirePath, `${JSON.stringify(preloadRecord(item, at))}\n`);
    at += 1;
  }
  return items.length;
}

/** The primer produced no resumable session (exit-code-3 territory for CLIs). */
export class PrimerNoSessionError extends Error {
  constructor(
    readonly primer: KimiRun,
  ) {
    super('primer run produced no session id');
    this.name = 'PrimerNoSessionError';
  }
}

/**
 * Run `options.prompt` with `items` already in context: primer run (default
 * prompt "Acknowledged.") creates the session in a shared home, the items
 * are appended to its wire, and the call to action resumes it.
 *
 * If the primer fails, its KimiRun is returned as-is (nonzero code, child
 * stderr in `stderr`) and no second run happens. Any `resume` /
 * `continueRecent` in `options` applies only to the primer-less path — this
 * function always creates a fresh session.
 *
 * When `options.home` is omitted (or empty) both runs share one ephemeral
 * home, removed before this resolves; pass `home` to keep the preloaded
 * session. A relative `home` resolves as {@link LaunchOptions.home} says.
 */
export async function runPreloaded(
  options: LaunchOptions,
  items: readonly PreloadItem[],
  prime?: string,
): Promise<KimiRun> {
  const requested = options.home ?? '';
  const ephemeral = requested.length === 0;
  const home = ephemeral ? makeEphemeralHome() : resolve(requested);
  try {
    const primer = await runKimi({
      ...options,
      prompt: prime ?? 'Acknowledged.',
      home,
      outputFormat: 'stream-json',
      resume: undefined,
      continueRecent: false,
    });
    if (primer.code !== 0) return primer;
    const sessionId = primer.sessionId;
    if (sessionId === undefined) throw new PrimerNoSessionError(primer);
    appendPreload(findWire(home, sessionId), items);
    return await runKimi({ ...options, home, resume: sessionId });
  } finally {
    if (ephemeral) {
      try {
        // Keeps the home when a credentials copy in it changed during the run.
        removeHome(home, sourceHome(options.srcHome));
      } catch {
        // best effort; a leftover temp dir is better than masking the run result
      }
    }
  }
}
