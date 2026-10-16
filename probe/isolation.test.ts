import { describe, expect, test } from 'bun:test';
import { DELEGATION_EXEC, DELEGATION_MACH, droppedSections, judgeIsolation, sandboxProfile } from './isolation.ts';

// Pure: these build profiles and judge synthetic preflight reports. Nothing is spawned.

const connected = { result: 'connected', ms: 1 };

function control(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'control', provider: true, providerTcp: connected, otherLoopback: connected, write: 'allowed', decoyRead: 'allowed', ...extra };
}

function sandboxed(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'sandboxed',
    provider: true,
    providerTcp: connected,
    otherLoopback: { result: 'EPERM', ms: 1 },
    egress: { result: 'EPERM', ms: 1 },
    write: 'EPERM',
    decoyRead: 'EPERM',
    ...extra,
  };
}

const TARGETS = DELEGATION_EXEC.map((target) => target.path);
const executable = Object.fromEntries(TARGETS.map((path) => [path, 'executable']));
const denied = Object.fromEntries(TARGETS.map((path) => [path, 'EPERM']));

describe('sandboxProfile', () => {
  test('without exec or Mach options it is the network, write and read profile alone', () => {
    const profile = sandboxProfile({ root: '/r', port: 1234, deniedReads: ['/d'] });
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:1234"))');
    expect(profile).toContain('(deny file-read* (subpath "/d"))');
    expect(profile).not.toContain('process-exec');
    expect(profile).not.toContain('mach-lookup');
  });

  test('names each denied executable and Mach service', () => {
    const profile = sandboxProfile({ root: '/r', port: 1, deniedReads: [], deniedExec: TARGETS, deniedMach: DELEGATION_MACH });
    for (const path of TARGETS) expect(profile).toContain(`(literal "${path}")`);
    for (const name of DELEGATION_MACH) expect(profile).toContain(`(global-name "${name}")`);
  });
});

describe('judgeIsolation', () => {
  test('held by errno, without an exec check', () => {
    const verdict = judgeIsolation(control(), sandboxed(), control());
    expect(verdict.failures).toEqual([]);
    expect(verdict.networkDenialBasis).toBe('errno');
    expect(verdict.execDenial).toBeUndefined();
  });

  test('ECONNREFUSED counts only through the contrast with controls that held', () => {
    const refused = { otherLoopback: { result: 'ECONNREFUSED', ms: 1 }, egress: { result: 'ECONNREFUSED', ms: 1 } };
    expect(judgeIsolation(control(), sandboxed(refused), control()).networkDenialBasis).toBe('contrast');
    const broken = judgeIsolation(control({ write: 'EACCES' }), sandboxed(refused), control());
    expect(broken.networkDenial).toBeUndefined();
    expect(broken.failures.length).toBeGreaterThan(0);
  });

  test('exec denial is shown only with the control executable running everywhere and each target denied', () => {
    const before = control({ execControl: 'ran:0', execTargets: executable });
    const inside = sandboxed({ execControl: 'ran:0', execTargets: denied });
    const held = judgeIsolation(before, inside, before, { execTargets: TARGETS });
    expect(held.failures).toEqual([]);
    expect(held.execDenial).toEqual(denied);

    const ran = judgeIsolation(before, sandboxed({ execControl: 'ran:0', execTargets: { ...denied, '/usr/bin/open': 'ran:1' } }), before, {
      execTargets: TARGETS,
    });
    expect(ran.failures.some((failure) => failure.includes('/usr/bin/open'))).toBe(true);

    const noControl = judgeIsolation(before, sandboxed({ execControl: 'EPERM', execTargets: denied }), before, { execTargets: TARGETS });
    expect(noControl.failures.some((failure) => failure.includes('exec control'))).toBe(true);

    const missing = judgeIsolation(control(), sandboxed(), control(), { execTargets: TARGETS });
    expect(missing.failures.length).toBeGreaterThan(0);
  });
});

test('droppedSections reads kimi warnings from any output', () => {
  expect(droppedSections("x\nIgnored invalid config section 'hooks'\nIgnored invalid config section 'permission'\n")).toEqual([
    'hooks',
    'permission',
  ]);
  expect(droppedSections('nothing here')).toEqual([]);
});
