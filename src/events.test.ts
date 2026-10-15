import { describe, expect, test } from 'bun:test';
import {
  isAssistantEvent,
  isKimiStreamEvent,
  isMetaSessionResumeHint,
  isMetaSystemVersion,
  isMetaTurnStepRetrying,
  isToolEvent,
  parseStreamJson,
  sessionIdFromEvents,
} from './events.ts';

// Shape taken from a live kimi 2.0.1 stream-json capture (this repo's
// runtime/build-1/stdout.jsonl), values redacted.
const CAPTURE = [
  '{"role":"meta","type":"system.version","version":"2.0.1"}',
  '{"role":"assistant","content":"I will check.","tool_calls":[{"type":"function","id":"tool_ZJTzzJ1x","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
  '{"role":"tool","tool_call_id":"tool_ZJTzzJ1x","content":"total 8"}',
  '{"role":"assistant","content":"done"}',
  '{"role":"meta","type":"session.resume_hint","session_id":"session_abc123","command":"kimi -r session_abc123","content":"To resume this session: kimi -r session_abc123"}',
].join('\n');

describe('parseStreamJson', () => {
  test('parses a live-capture-shaped stream', () => {
    const { events, unparsed } = parseStreamJson(CAPTURE);
    expect(unparsed).toEqual([]);
    expect(events).toHaveLength(5);
    expect(isMetaSystemVersion(events[0])).toBe(true);
    expect(isAssistantEvent(events[1])).toBe(true);
    expect(isToolEvent(events[2])).toBe(true);
    expect(isMetaSessionResumeHint(events[4])).toBe(true);
  });

  test('assistant tool_calls keep stringified arguments', () => {
    const { events } = parseStreamJson(CAPTURE);
    const assistant = events[1];
    if (!isAssistantEvent(assistant)) throw new Error('expected assistant event');
    expect(assistant.tool_calls?.[0]?.function.name).toBe('Bash');
    expect(JSON.parse(assistant.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      command: 'ls',
    });
  });

  test('session id comes from the resume hint', () => {
    expect(sessionIdFromEvents(parseStreamJson(CAPTURE).events)).toBe('session_abc123');
    expect(sessionIdFromEvents(parseStreamJson('{"role":"assistant","content":"x"}').events)).toBeUndefined();
  });

  test('failure-mode stream: only the version line, error on stderr', () => {
    const { events } = parseStreamJson('{"role":"meta","type":"system.version","version":"2.0.1"}\n');
    expect(events).toHaveLength(1);
    expect(sessionIdFromEvents(events)).toBeUndefined();
  });

  test('retry meta and unknown lines', () => {
    const retry =
      '{"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,"max_attempts":3,"delay_ms":1000,"error_name":"ProviderError","error_message":"boom","status_code":500}';
    const { events, unparsed } = parseStreamJson(`${retry}\nnot json\n{"role":"weird"}`);
    expect(isMetaTurnStepRetrying(events[0])).toBe(true);
    expect(unparsed).toEqual(['not json', '{"role":"weird"}']);
  });

  test('blank lines are ignored', () => {
    const { events, unparsed } = parseStreamJson('\n\n{"role":"assistant","content":"x"}\n\n');
    expect(events).toHaveLength(1);
    expect(unparsed).toEqual([]);
  });
});

describe('guards reject foreign shapes', () => {
  // One-element rows: test.each spreads an array row into arguments, so a
  // bare `[]` row would call the callback with no value, and the unfilled
  // parameter would be taken for a done callback.
  test.each<[unknown]>([[null], [42], ['x'], [[]], [{}], [{ role: 'meta' }], [{ role: 1, type: 'x' }]])(
    'isKimiStreamEvent(%j) is false',
    (value) => {
      expect(isKimiStreamEvent(value)).toBe(false);
    },
  );
});
