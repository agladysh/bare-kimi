/**
 * The `kimi -p --output-format stream-json` NDJSON contract.
 *
 * Measured 2026-09-14/15 on kimi 0.41.0 (research-20260914-2
 * `kimi-harness-measured.md`, "Print output contracts"); re-verified
 * 2026-09-24 against kimi-code @ 6451f1e (installed kimi 2.0.1):
 * `apps/kimi-code/src/cli/prompt-render.ts` (`writeExperimentalVersion`,
 * `writeResumeHint`, `PromptJsonWriter`) and a live 2.0.1 capture
 * (this repo's `runtime/build-1/stdout.jsonl`).
 *
 * stream-json writes NDJSON on stdout; thinking deltas are deliberately
 * omitted; tool progress goes to stderr. On failure stdout may contain ONLY
 * the system.version line, with the error on stderr and exit 1.
 */

export interface ToolCall {
  readonly type: 'function';
  readonly id: string;
  readonly function: {
    readonly name: string;
    /** Stringified JSON. */
    readonly arguments: string;
  };
}

/** Flushed before each tool result and at finish; several per run are normal. */
export interface AssistantEvent {
  readonly role: 'assistant';
  readonly content?: string;
  readonly tool_calls?: readonly ToolCall[];
}

export interface ToolEvent {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly content: unknown;
}

export interface MetaSystemVersion {
  readonly role: 'meta';
  readonly type: 'system.version';
  readonly version: string;
}

export interface MetaSessionResumeHint {
  readonly role: 'meta';
  readonly type: 'session.resume_hint';
  readonly session_id: string;
  readonly command?: string;
  readonly content?: string;
}

export interface MetaTurnStepRetrying {
  readonly role: 'meta';
  readonly type: 'turn.step.retrying';
  readonly failed_attempt: number;
  readonly next_attempt: number;
  readonly max_attempts: number;
  readonly delay_ms: number;
  readonly error_name?: string;
  readonly error_message?: string;
  readonly status_code?: number;
}

/** A meta line of any other type: forward-compatible catch-all. */
export interface MetaOtherEvent {
  readonly role: 'meta';
  readonly type: string;
  readonly [key: string]: unknown;
}

export type KimiStreamEvent =
  | AssistantEvent
  | ToolEvent
  | MetaSystemVersion
  | MetaSessionResumeHint
  | MetaTurnStepRetrying
  | MetaOtherEvent;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isAssistantEvent(value: unknown): value is AssistantEvent {
  return isObject(value) && value['role'] === 'assistant';
}

export function isToolEvent(value: unknown): value is ToolEvent {
  return (
    isObject(value) && value['role'] === 'tool' && typeof value['tool_call_id'] === 'string'
  );
}

export function isMetaSystemVersion(value: unknown): value is MetaSystemVersion {
  return (
    isObject(value) &&
    value['role'] === 'meta' &&
    value['type'] === 'system.version' &&
    typeof value['version'] === 'string'
  );
}

export function isMetaSessionResumeHint(value: unknown): value is MetaSessionResumeHint {
  return (
    isObject(value) &&
    value['role'] === 'meta' &&
    value['type'] === 'session.resume_hint' &&
    typeof value['session_id'] === 'string'
  );
}

export function isMetaTurnStepRetrying(value: unknown): value is MetaTurnStepRetrying {
  return (
    isObject(value) &&
    value['role'] === 'meta' &&
    value['type'] === 'turn.step.retrying' &&
    typeof value['failed_attempt'] === 'number'
  );
}

export function isMetaEvent(value: unknown): value is MetaOtherEvent {
  return isObject(value) && value['role'] === 'meta' && typeof value['type'] === 'string';
}

export function isKimiStreamEvent(value: unknown): value is KimiStreamEvent {
  return isAssistantEvent(value) || isToolEvent(value) || isMetaEvent(value);
}

export interface ParsedStream {
  /** Lines that parsed as stream-json events, in order. */
  readonly events: KimiStreamEvent[];
  /** Non-empty lines that did not parse as JSON objects. */
  readonly unparsed: string[];
}

/** Parse captured stream-json stdout into events; never throws. */
export function parseStreamJson(stdout: string): ParsedStream {
  const events: KimiStreamEvent[] = [];
  const unparsed: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record: unknown = JSON.parse(trimmed);
      if (isKimiStreamEvent(record)) {
        events.push(record);
      } else {
        unparsed.push(trimmed);
      }
    } catch {
      unparsed.push(trimmed);
    }
  }
  return { events, unparsed };
}

/**
 * The session id a run created or resumed, from its stream-json output.
 * kimi prints exactly one session.resume_hint meta line per run.
 */
export function sessionIdFromEvents(events: readonly KimiStreamEvent[]): string | undefined {
  for (const event of events) {
    if (isMetaSessionResumeHint(event)) return event.session_id;
  }
  return undefined;
}
