import { describe, expect, test } from 'bun:test';
import {
  EMPTY_SKILLS_DIR,
  LaunchConfig,
  assertSafePrompt,
  buildArgv,
  buildEnv,
  isScrubbedEnvVar,
} from './index.ts';

const base = LaunchConfig({ prompt: 'do the thing' });

describe('assertSafePrompt', () => {
  test('refuses a prompt kimi would parse as a flag', () => {
    expect(() => assertSafePrompt('-verbose please')).toThrow('starts with "-"');
    expect(() => assertSafePrompt('--help')).toThrow('starts with "-"');
    expect(() => assertSafePrompt('a normal prompt')).not.toThrow();
  });
});

describe('LaunchConfig', () => {
  test('applies defaults', () => {
    expect(base.authMode).toBe('link');
    expect(base.outputFormat).toBe('text');
    expect(base.keepCredentials).toBe(false);
    expect(base.noSkills).toBe(false);
    expect(base.skillsDir).toEqual([]);
  });

  test('resume and continueRecent are mutually exclusive', () => {
    expect(() => LaunchConfig({ prompt: 'x', resume: 'session_a', continueRecent: true })).toThrow(
      'mutually exclusive',
    );
  });
});

describe('buildArgv', () => {
  test('prompt is always last, after -p', () => {
    const argv = buildArgv(
      LaunchConfig({
        prompt: 'hello world',
        model: 'kimi-code/k3',
        outputFormat: 'stream-json',
        extraArgs: ['--verbose-native'],
      }),
      'kimi',
    );
    expect(argv.at(-2)).toBe('-p');
    expect(argv.at(-1)).toBe('hello world');
    expect(argv.at(-3)).toBe('--verbose-native');
    expect(argv[0]).toBe('kimi');
    expect(argv).toContain('--model');
    expect(argv).toContain('kimi-code/k3');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
  });

  test('resume, continue, skills and add-dir', () => {
    const resumed = buildArgv(LaunchConfig({ prompt: 'x', resume: 'session_abc' }), 'kimi');
    expect(resumed.join(' ')).toContain('--session session_abc');

    const continued = buildArgv(LaunchConfig({ prompt: 'x', continueRecent: true }), 'kimi');
    expect(continued).toContain('--continue');

    const skilled = buildArgv(
      LaunchConfig({ prompt: 'x', skillsDir: ['/a', '/b'], addDir: ['/c'] }),
      'kimi',
    );
    expect(skilled.join(' ')).toContain('--skills-dir /a --skills-dir /b');
    expect(skilled.join(' ')).toContain('--add-dir /c');
  });

  test('text output format emits no --output-format flag', () => {
    expect(buildArgv(base, 'kimi')).not.toContain('--output-format');
  });
});

describe('isScrubbedEnvVar', () => {
  test('scrubs credential-slot and lock overrides', () => {
    for (const name of [
      'KIMI_CODE_BASE_URL',
      'KIMI_CODE_OAUTH_HOST',
      'KIMI_OAUTH_HOST',
      'KIMI_DISABLE_OAUTH_LOCK',
      'KIMI_MODEL_NAME',
      'KIMI_MODEL_TEMPERATURE',
    ]) {
      expect(isScrubbedEnvVar(name)).toBe(true);
    }
    expect(isScrubbedEnvVar('KIMI_CODE_HOME')).toBe(false); // handled separately: forced
    expect(isScrubbedEnvVar('PATH')).toBe(false);
    expect(isScrubbedEnvVar('KIMI_DISABLE_TELEMETRY')).toBe(false);
  });
});

describe('buildEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    KIMI_CODE_HOME: '/operator/home',
    KIMI_CODE_BASE_URL: 'https://evil.example/v1',
    KIMI_OAUTH_HOST: 'https://evil.example',
    KIMI_MODEL_NAME: 'injected/model',
    KIMI_DISABLE_OAUTH_LOCK: '1',
  };

  test('forces KIMI_CODE_HOME, scrubs slot/lock/model overrides', () => {
    const env = buildEnv(base, { home: '/run/home', parentEnv: parent });
    expect(env['KIMI_CODE_HOME']).toBe('/run/home');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['KIMI_CODE_BASE_URL']).toBeUndefined();
    expect(env['KIMI_OAUTH_HOST']).toBeUndefined();
    expect(env['KIMI_MODEL_NAME']).toBeUndefined();
    expect(env['KIMI_DISABLE_OAUTH_LOCK']).toBeUndefined();
  });

  test('telemetry and auto-update default off but stay overridable', () => {
    const env = buildEnv(base, { home: '/h', parentEnv: {} });
    expect(env['KIMI_DISABLE_TELEMETRY']).toBe('1');
    expect(env['KIMI_CODE_NO_AUTO_UPDATE']).toBe('1');

    const inherited = buildEnv(base, {
      home: '/h',
      parentEnv: { KIMI_DISABLE_TELEMETRY: '0' },
    });
    expect(inherited['KIMI_DISABLE_TELEMETRY']).toBe('0');

    const extra = buildEnv(LaunchConfig({ prompt: 'x', extraEnv: { KIMI_CODE_NO_AUTO_UPDATE: '0' } }), {
      home: '/h',
      parentEnv: {},
    });
    expect(extra['KIMI_CODE_NO_AUTO_UPDATE']).toBe('0');
  });

  test('extraEnv may re-add a scrubbed variable but never override KIMI_CODE_HOME', () => {
    const env = buildEnv(
      LaunchConfig({
        prompt: 'x',
        extraEnv: { KIMI_CODE_BASE_URL: 'https://deliberate.example/v1', KIMI_CODE_HOME: '/escape' },
      }),
      { home: '/run/home', parentEnv: {} },
    );
    expect(env['KIMI_CODE_BASE_URL']).toBe('https://deliberate.example/v1');
    expect(env['KIMI_CODE_HOME']).toBe('/run/home');
  });

  test('spawnEnv layer sits between inherited env and extraEnv; undefined deletes', () => {
    const env = buildEnv(base, {
      home: '/h',
      parentEnv: { A: '1', B: '2' },
      spawnEnv: { A: 'spawn', B: undefined },
    });
    expect(env['A']).toBe('spawn');
    expect(env['B']).toBeUndefined();
  });

  test('noProcessEnv drops inheritance but keeps forced values', () => {
    const env = buildEnv(LaunchConfig({ prompt: 'x', noProcessEnv: true }), {
      home: '/h',
      parentEnv: parent,
    });
    expect(env['PATH']).toBeUndefined();
    expect(env['KIMI_CODE_HOME']).toBe('/h');
    expect(env['KIMI_DISABLE_TELEMETRY']).toBe('1');
  });

  test('refuses an empty run home', () => {
    expect(() => buildEnv(base, { home: '', parentEnv: {} })).toThrow('must not be empty');
  });
});

describe('noSkills plumbing', () => {
  test('the empty skills dir constant is home-relative', () => {
    expect(EMPTY_SKILLS_DIR).not.toContain('/');
  });
});
