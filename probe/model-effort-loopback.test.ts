import { describe, expect, test } from 'bun:test';
import {
  CASES,
  activation,
  compareTurns,
  clientFailure,
  effortAnswer,
  effortChoice,
  modelAnswer,
  offAnswer,
  redactHeaders,
  requireEffort,
  strictContrast,
  type CaseResult,
  type ChatSummary,
  type Field,
  type Judging,
  type ProcessRecord,
  type RetrySummary,
  type StepRecord,
} from './model-effort-loopback.ts';

// Pure: the probe's judges on synthetic step records. Importing the probe
// starts nothing (its main is guarded by import.meta.main), and nothing here
// spawns a process, opens a port or touches the filesystem.

const RAN: ProcessRecord = {
  spawnError: null,
  pid: 4242,
  initialGroupState: 'occupied',
  leader: 'led',
  deadlineHit: false,
  exitCode: 0,
  signalCode: null,
  stoppedBy: null,
  stop: null,
  groupState: 'empty',
  groupObservations: [],
  groupError: null,
};

const effort = (value: unknown, path = '$.reasoning_effort'): Field => ({ path, value });

function chat(seq: number, model: string | null, fields: Field[], main = true): ChatSummary {
  return { seq, path: '/s/case/v1/chat/completions', model, main, fields };
}

function step(over: Partial<StepRecord> = {}): StepRecord {
  return {
    id: 'step',
    via: 'native',
    purpose: 'test',
    status: 'ran',
    process: RAN,
    chats: [],
    requests: 0,
    retrying: null,
    catalogRequests: 0,
    logFaults: 0,
    credentialFaults: 0,
    configChange: null,
    droppedSections: [],
    helpFlags: [],
    ...over,
  };
}

const failedExit = (stderrTail: string): Partial<StepRecord> => ({ process: { ...RAN, exitCode: 1 }, stderrTail });
const envMarker = (state: 'found' | 'not-found') => ({ __kimi_env_model__: { state, where: [], errors: [] } });

describe('the step turn (D1)', () => {
  const high = [effort('high')];

  test('one prompt-bearing request, or several that agree, answer the same', () => {
    expect(effortAnswer(step({ chats: [chat(1, 'probe-model-a', high)] }))).toBe('sent $.reasoning_effort="high"');
    expect(effortAnswer(step({ chats: [chat(1, 'probe-model-a', high), chat(2, 'probe-model-a', high)] }))).toBe(
      'sent $.reasoning_effort="high"',
    );
  });

  test('a request without the prompt does not take part', () => {
    const chats = [chat(1, 'probe-model-a', high), chat(2, 'probe-secondary', [effort('max')], false)];
    expect(modelAnswer(step({ chats }), { 'probe-model-a': 'a' })).toBe('a (requested probe-model-a)');
  });

  test('prompt-bearing requests that disagree on the model or the effort are unknown', () => {
    const models = step({ chats: [chat(1, 'probe-model-a', high), chat(2, 'probe-model-b', high)] });
    expect(effortAnswer(models)).toStartWith('unknown:');
    expect(effortAnswer(models)).toContain('disagree');
    expect(modelAnswer(models, { 'probe-model-a': 'a' })).toStartWith('unknown:');
    const efforts = step({ chats: [chat(1, 'probe-model-a', high), chat(2, 'probe-model-a', [effort('max')])] });
    expect(compareTurns(step({ chats: [chat(3, 'probe-model-a', high)] }), efforts)).toStartWith('unknown:');
  });
});

describe('env-model activation (D2)', () => {
  test('a captured request decides; the marker only corroborates', () => {
    const inactive = activation(step({ chats: [chat(1, 'probe-model-a', [])], markers: envMarker('found') }));
    expect(inactive).toStartWith('inactive');
    expect(inactive).toContain('__kimi_env_model__ found');
    expect(activation(step({ chats: [chat(1, 'probe-env-model', [])], markers: envMarker('not-found') }))).toStartWith('active');
  });

  test('no captured request is unknown, with a marker or a failing exit', () => {
    expect(activation(step({ markers: envMarker('found') }))).toStartWith('unknown:');
    expect(activation(step({ ...failedExit('Error: KIMI_MODEL_API_KEY is missing'), markers: envMarker('not-found') }))).toStartWith(
      'unknown:',
    );
  });

  const n5 = CASES.find((def) => def.id === 'n5-overlay');
  const control = (outcome: CaseResult['outcome']): CaseResult => ({
    id: 'ctl-kimi',
    question: 'control',
    title: 'kimi-type control',
    dependsOn: [],
    outcome,
    facts: {},
    observations: {},
    steps: [],
  });
  const judging = (outcome: CaseResult['outcome']): Judging => ({
    step: (id) =>
      step({
        id,
        chats: [chat(1, id === 'none' ? 'probe-model-a' : 'probe-env-model', [])],
        markers: envMarker('not-found'),
      }),
    control: () => control(outcome),
  });

  test('overlay answers rest on the kimi-type control; the control and the keep model do not', () => {
    if (n5 === undefined) throw new Error('n5-overlay is not defined');
    const gated = n5.judge(judging('unknown'));
    expect(gated['control (no KIMI_MODEL_*)']).toStartWith('inactive');
    expect(gated['KIMI_MODEL_NAME + _API_KEY + _BASE_URL']).toStartWith('unknown: control ctl-kimi');
    expect(gated['the overlay through bare-kimi (ephemeral, no model)']).toStartWith('unknown: control ctl-kimi');
    expect(gated['KIMI_MODEL_THINKING_KEEP alone: model']).toStartWith('active');
    expect(n5.judge(judging('observed'))['KIMI_MODEL_NAME + _API_KEY + _BASE_URL']).toStartWith('active');
  });

  test('a failing exit with a sandbox-like error is unknown, any other is a recorded exit', () => {
    const sandboxed = step(failedExit('Error: EPERM: operation not permitted, open /x'));
    expect(effortAnswer(sandboxed)).toStartWith('unknown:');
    expect(modelAnswer(sandboxed, {})).toStartWith('unknown:');
    expect(effortAnswer(step(failedExit('Error: model "probe/b" is not configured')))).toStartWith('no request; kimi exited 1');
  });
});

describe('effort values (D3)', () => {
  test('an unrecognized value under an effort key is unknown, not "not sent"', () => {
    const auto = step({ chats: [chat(1, 'probe-model-a', [effort('auto')])] });
    expect(effortChoice(auto, { '': 'off honored' })).toStartWith('unknown:');
    expect(requireEffort(auto, 'high')).toStartWith('unknown:');
    expect(effortAnswer(step({ chats: [chat(1, 'probe-model-a', [effort(null)])] }))).toStartWith('unknown:');
  });

  test('other thinking fields are not efforts', () => {
    const kimi = [effort('enabled', '$.thinking.type'), effort('high', '$.thinking.effort')];
    expect(effortAnswer(step({ chats: [chat(1, 'probe-model-a', kimi)] }))).toBe('sent $.thinking.effort="high"');
    const off = step({ chats: [chat(1, 'probe-model-a', [effort('disabled', '$.thinking.type')])] });
    expect(effortChoice(off, { '': 'off honored' })).toBe('off honored: no effort sent');
  });
});

describe('steps that cannot answer for kimi', () => {
  const answered = { chats: [chat(1, 'probe-model-a', [effort('high')])] };
  const faults: [string, Partial<StepRecord>][] = [
    ['stopped', { process: { ...RAN, stop: { signal: 'SIGTERM' }, stoppedBy: 'SIGINT' } }],
    ['deadline', { process: { ...RAN, deadlineHit: true } }],
    ['dropped section', { droppedSections: ['models'] }],
    ['unlogged request', { logFaults: 1 }],
    ['unexpected credential', { credentialFaults: 1 }],
    ['catalog request', { catalogRequests: 1 }],
    ['config changed', { configChange: 'config.toml changed during the step' }],
  ];
  for (const [name, over] of faults) {
    test(name, () => {
      expect(effortAnswer(step({ ...answered, ...over }))).toStartWith('unknown:');
    });
  }
});

const NO_OFF = "Model 'probe-model-a' reasons by default but declares no off effort, so thinking cannot be turned off.";

function retries(message: string, statusCode: number | null = null): RetrySummary {
  return { events: 6, lastFailedAttempt: 6, maxAttempts: 10, errors: [{ name: 'ChatProviderError', message, statusCode, count: 6 }] };
}

/** kimi retrying before any request until the step deadline stopped it. */
const cutShort = (over: Partial<StepRecord> = {}): StepRecord =>
  step({ process: { ...RAN, exitCode: null, signalCode: 'SIGTERM', deadlineHit: true, stop: { signal: 'SIGTERM' } }, retrying: retries(NO_OFF), ...over });

describe('thinking off', () => {
  const sent = (value: string) => step({ chats: [chat(1, 'probe-model-a', [effort(value)])] });

  test("the step's own declared off effort is off honored; undeclared, the same value stays unknown", () => {
    expect(offAnswer(sent('none'), 'none')).toBe('off honored: sent the declared off effort $.reasoning_effort="none"');
    expect(offAnswer(sent('none'), null)).toStartWith('unknown:');
    expect(effortAnswer(sent('none'))).toStartWith('unknown:');
  });

  test('no effort is off honored; any other known effort is thinking despite off, declared off effort or not', () => {
    expect(offAnswer(step({ chats: [chat(1, 'probe-model-a', [])] }), null)).toBe('off honored: no effort sent');
    expect(offAnswer(sent('high'), 'none')).toStartWith('thinks despite off');
    expect(offAnswer(sent('minimal'), 'none')).toStartWith('thinks despite off');
  });
});

describe('thinking off on a wire that also sends a thinking type (the kimi type)', () => {
  const type = (value: unknown) => effort(value, '$.thinking.type');
  const kimiEffort = (value: unknown) => effort(value, '$.thinking.effort');
  const sentKimi = (fields: Field[]) => step({ chats: [chat(1, 'probe-model-a', fields)] });

  test('an explicit enabled type contradicts off, even with no effort value at all', () => {
    expect(offAnswer(sentKimi([type('enabled'), effort('all', '$.thinking.keep')]), null)).toBe(
      'thinks despite off: sent $.thinking.type="enabled" with no effort',
    );
    expect(offAnswer(sentKimi([type('enabled'), kimiEffort('high')]), 'none')).toStartWith('thinks despite off');
  });

  test('a disabled type, alone or with only the declared off effort, supports off', () => {
    expect(offAnswer(sentKimi([type('disabled')]), null)).toBe('off honored: sent $.thinking.type="disabled"');
    expect(offAnswer(sentKimi([type('disabled'), kimiEffort('none')]), 'none')).toStartWith('off honored: sent the declared off effort');
  });

  test('the declared off effort beside an enabled type is recorded as conflicting, not as off', () => {
    const answer = offAnswer(sentKimi([type('enabled'), kimiEffort('none')]), 'none');
    expect(answer).toStartWith('conflicting:');
    expect(answer).not.toContain('off honored');
  });

  test('an unknown thinking type, an undeclared off value, or a blank effort stays unknown', () => {
    expect(offAnswer(sentKimi([type('adaptive')]), null)).toStartWith('unknown:');
    expect(offAnswer(sentKimi([type('disabled'), kimiEffort('none')]), null)).toStartWith('unknown:');
    expect(offAnswer(sentKimi([type('disabled'), kimiEffort(' ')]), null)).toStartWith('unknown:');
  });
});

describe('n8c-kimi-off', () => {
  const n8c = CASES.find((def) => def.id === 'n8c-kimi-off');
  const judge = (control: CaseResult['outcome'], steps: Record<string, StepRecord>): Record<string, string> => {
    if (n8c === undefined) throw new Error('n8c-kimi-off is not defined');
    return n8c.judge({
      step: (id) => steps[id] ?? step({ id, status: 'not-run', notRunReason: 'not in this test' }),
      control: (id) => ({ id, question: 'control', title: '', dependsOn: [], outcome: control, facts: {}, observations: {}, steps: [] }),
    });
  };
  const steps = {
    efforts: cutShort({ id: 'efforts' }),
    'efforts-none': step({ id: 'efforts-none', chats: [chat(1, 'probe-model-a', [effort('disabled', '$.thinking.type')])] }),
    'caps-only': step({ id: 'caps-only', chats: [chat(2, 'probe-model-a', [effort('enabled', '$.thinking.type')])] }),
  };

  test('every answer rests on the kimi-type control', () => {
    const facts = judge('unknown', steps);
    for (const fact of Object.values(facts)) expect(fact).toStartWith('unknown: control ctl-kimi');
  });

  test('with the control observed, each step reads its own wire', () => {
    const facts = judge('observed', steps);
    expect(facts['support_efforts ["low", "high"], no off_effort, off']).toStartWith('client-side failure before any request');
    expect(facts['the same with off_effort "none", off']).toBe('off honored: sent $.thinking.type="disabled"');
    expect(facts['capabilities ["thinking"] only, off']).toStartWith('thinks despite off');
    expect(facts['off through bare-kimi on the first model']).toStartWith('unknown:');
  });
});

describe('a client-side failure before any request', () => {
  test('is observed when kimi reported it, even though the deadline cut the step short, and claims no exit', () => {
    const answer = offAnswer(cutShort(), null);
    expect(answer).toStartWith('client-side failure before any request: ChatProviderError:');
    expect(answer).toContain('last failed attempt 6 of 10');
    expect(answer).toContain('no exit observed');
    expect(answer).not.toContain('kimi exited');
  });

  test('names the exit when kimi ended on its own', () => {
    const exited = step({ process: { ...RAN, exitCode: 1 }, retrying: retries(NO_OFF) });
    expect(offAnswer(exited, null)).toContain('kimi exited 1');
  });

  test('is not a client-side failure once a request was made, a response status was reported, or it looks like the sandbox', () => {
    expect(offAnswer(cutShort({ requests: 1 }), null)).toStartWith('unknown:');
    expect(offAnswer(cutShort({ retrying: retries(NO_OFF, 400) }), null)).toStartWith('unknown:');
    expect(offAnswer(cutShort({ retrying: retries('EPERM: operation not permitted, connect') }), null)).toStartWith('unknown:');
    expect(offAnswer(cutShort({ catalogRequests: 1 }), null)).toStartWith('unknown:');
    for (const message of ['getaddrinfo ENOTFOUND api.openai.com', 'Connection error.', 'ECONNREFUSED']) {
      const failed = cutShort({ retrying: retries(message) });
      expect(clientFailure(failed)).toBeUndefined();
      expect(offAnswer(failed, null)).toStartWith('unknown:');
    }
  });

  test('cannot serve as a control that must send an effort', () => {
    expect(requireEffort(cutShort(), 'high')).toStartWith('unknown:');
  });
});

describe('n8b-off', () => {
  const n8b = CASES.find((def) => def.id === 'n8b-off');
  const judge = (steps: Record<string, StepRecord>): Record<string, string> => {
    if (n8b === undefined) throw new Error('n8b-off is not defined');
    return n8b.judge({
      step: (id) => steps[id] ?? step({ id, status: 'not-run', notRunReason: 'not in this test' }),
      control: () => undefined,
    });
  };
  const turn = (id: string, fields: Field[]) => step({ id, chats: [chat(1, 'probe-model-a', fields)] });
  const on = turn('on', [effort('high')]);

  test('an off control that fails as before (off_effort not taken) leaves the always-thinking comparison unknown', () => {
    const facts = judge({ on, off: cutShort({ id: 'off' }), field: turn('field', []), string: turn('string', [effort('high')]) });
    expect(facts['control: thinking off, off_effort "none"']).toStartWith('client-side failure');
    expect(facts['always_thinking = true (model field), off_effort "none", off']).toStartWith('unknown: the off control');
    expect(facts['capability "always_thinking", off_effort "none", off']).toStartWith('unknown: the off control');
  });

  test('against a working off control, the field and the string are each judged on their own wire', () => {
    const facts = judge({
      on,
      off: turn('off', [effort('none')]),
      field: turn('field', [effort('none')]),
      string: turn('string', [effort('high')]),
      'base-no-off': cutShort({ id: 'base-no-off' }),
      'caps-only': cutShort({ id: 'caps-only' }),
      bare: turn('bare', []),
    });
    expect(facts['always_thinking = true (model field), off_effort "none", off']).toStartWith('off honored');
    expect(facts['capability "always_thinking", off_effort "none", off']).toStartWith('thinks despite off');
    expect(facts['thinking + support_efforts, no off_effort, off (as n8-always)']).toStartWith('client-side failure');
    expect(facts['capabilities ["thinking"] only, no off_effort, off']).toStartWith('client-side failure');
    expect(facts['no thinking metadata, off']).toBe('off honored: no effort sent');
    expect(facts['support_efforts ["high"] only, no off_effort, off']).toStartWith('unknown:');
  });
});

describe('strict high/max contrast', () => {
  test('reports which configured value each captured turn sent, and nothing without both turns', () => {
    const high = step({ chats: [chat(1, 'probe-model-a', [effort('enabled', '$.thinking.type'), effort('high', '$.thinking.effort')])] });
    const max = step({ chats: [chat(2, 'probe-model-a', [effort('enabled', '$.thinking.type')])] });
    expect(strictContrast(high, max)).toStartWith('only "high" sent as configured');
    expect(strictContrast(high, cutShort())).toStartWith('unknown:');
  });
});

describe('redactHeaders', () => {
  test('the dummy key is "dummy", the device name a hash, the rest as sent', () => {
    const { headers, unexpected } = redactHeaders({
      authorization: 'Bearer probe-dummy-not-a-secret',
      'x-msh-device-name': 'Example-Host.local',
      host: '127.0.0.1:1',
    });
    expect(headers['authorization']).toBe('dummy');
    expect(headers['x-msh-device-name']).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(headers['host']).toBe('127.0.0.1:1');
    expect(unexpected).toEqual([]);
  });

  test('any other credential is stored as a short hash and reported', () => {
    const { headers, unexpected } = redactHeaders({ authorization: 'Bearer sk-looks-real', 'x-api-key': 'probe-dummy-not-a-secret' });
    expect(headers['authorization']).toMatch(/^other:[0-9a-f]{8}$/);
    expect(JSON.stringify(headers)).not.toContain('sk-looks-real');
    expect(headers['x-api-key']).toBe('dummy');
    expect(unexpected).toEqual(['authorization']);
  });
});
