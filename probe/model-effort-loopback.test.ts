import { describe, expect, test } from 'bun:test';
import {
  CASES,
  activation,
  compareTurns,
  effortAnswer,
  effortChoice,
  modelAnswer,
  redactHeaders,
  requireEffort,
  type CaseResult,
  type ChatSummary,
  type Field,
  type Judging,
  type ProcessRecord,
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
