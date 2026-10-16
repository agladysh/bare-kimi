import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_SKILLS_DIR,
  KimiCustodyError,
  LaunchConfig,
  assertSafePrompt,
  buildArgv,
  buildEnv,
  checkLaunchOptions,
  isScrubbedEnvVar,
  runKimi,
  sourceHome,
} from './index.ts';
import { checkPreloadOptions, runPreloaded } from './preload.ts';
import {
  CREDENTIAL_FILE,
  CREDENTIAL_SLOT,
  FAKE_KIMI,
  FAKE_TOKEN,
  assertFakeExecutable,
  makeSourceHome,
  makeTempDir,
} from '../test/helpers.ts';

const cleanups: string[] = [];

function temp(prefix: string): string {
  const dir = makeTempDir(prefix);
  cleanups.push(dir);
  return dir;
}

beforeAll(() => {
  assertFakeExecutable();
});

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  test('exports the run source as KIMI_CODE_HOME_SOURCE, replacing an inherited one', () => {
    const env = buildEnv(base, {
      home: '/run/home',
      source: '/the/source',
      parentEnv: { KIMI_CODE_HOME_SOURCE: '/some/other/source' },
    });
    expect(env['KIMI_CODE_HOME_SOURCE']).toBe('/the/source');

    const deliberate = buildEnv(
      LaunchConfig({ prompt: 'x', extraEnv: { KIMI_CODE_HOME_SOURCE: '/chosen' } }),
      { home: '/run/home', source: '/the/source', parentEnv: {} },
    );
    expect(deliberate['KIMI_CODE_HOME_SOURCE']).toBe('/chosen');

    // A nested bare-kimi sees this run home as KIMI_CODE_HOME and the source
    // next to it, so sourceHome takes the source instead of refusing.
    expect(sourceHome(undefined, { HOME: '/h', KIMI_CODE_HOME: env['KIMI_CODE_HOME'], KIMI_CODE_HOME_SOURCE: env['KIMI_CODE_HOME_SOURCE'] })).toBe(
      '/the/source',
    );
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

describe('isScrubbedEnvVar and thinking overrides', () => {
  test('ambient thinking overrides are scrubbed; extraEnv may set one on purpose', () => {
    expect(isScrubbedEnvVar('KIMI_MODEL_THINKING_EFFORT')).toBe(true);
    expect(isScrubbedEnvVar('KIMI_MODEL_THINKING_KEEP')).toBe(true);
    const env = buildEnv(
      LaunchConfig({ prompt: 'x', extraEnv: { KIMI_MODEL_THINKING_EFFORT: 'high' } }),
      { home: '/h', parentEnv: { KIMI_MODEL_THINKING_EFFORT: 'low', KIMI_MODEL_THINKING_KEEP: 'all' } },
    );
    expect(env['KIMI_MODEL_THINKING_EFFORT']).toBe('high');
    expect(env['KIMI_MODEL_THINKING_KEEP']).toBeUndefined();
  });
});

describe('option checks before any work', () => {
  test('checkLaunchOptions refuses a leading-dash prompt and resume+continue', () => {
    expect(() => checkLaunchOptions({ prompt: '-x' })).toThrow('starts with "-"');
    expect(() => checkLaunchOptions({ prompt: 'x', resume: 's', continueRecent: true })).toThrow(
      'mutually exclusive',
    );
    expect(checkLaunchOptions({ prompt: 'x' }).authMode).toBe('link');
  });

  test('checkPreloadOptions refuses the prompt, the primer, resume and continue', () => {
    expect(() => checkPreloadOptions({ prompt: '-x' })).toThrow('starts with "-"');
    expect(() => checkPreloadOptions({ prompt: 'x' }, '-p')).toThrow('starts with "-"');
    expect(() => checkPreloadOptions({ prompt: 'x', resume: 'session_a' })).toThrow('fresh session');
    expect(() => checkPreloadOptions({ prompt: 'x', continueRecent: true })).toThrow('fresh session');
    expect(() => checkPreloadOptions({ prompt: 'x' })).not.toThrow();
  });

  test.each([
    ['a leading-dash prompt', { prompt: '-x' }, undefined],
    ['a leading-dash primer', { prompt: 'x' }, '-p'],
    ['resume', { prompt: 'x', resume: 'session_a' }, undefined],
    ['continue', { prompt: 'x', continueRecent: true }, undefined],
  ] as const)('runPreloaded refuses %s before any home or child', async (_label, options, prime) => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    const home = join(root, 'run-home');
    const recorder = join(root, 'env.json');

    await expect(
      runPreloaded(
        {
          ...options,
          home,
          srcHome: src,
          kimiBin: FAKE_KIMI,
          extraEnv: { FAKE_KIMI_ENV_OUT: recorder, FAKE_KIMI_ENV_KEYS: 'KIMI_CODE_HOME' },
        },
        [{ path: 'fact.md', content: 'x' }],
        prime,
      ),
    ).rejects.toThrow();

    expect(existsSync(recorder)).toBe(false); // kimi never started
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(src, 'sessions'))).toBe(false);
  });
});

describe('runKimi custody', () => {
  test('a cleanup refusal keeps the finished run in the typed error', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    const home = join(root, 'run-home');

    const failure = await runKimi({
      prompt: 'x',
      home,
      srcHome: src,
      authMode: 'copy',
      outputFormat: 'stream-json',
      kimiBin: FAKE_KIMI,
      extraEnv: { FAKE_KIMI_REFRESH_SLOT: CREDENTIAL_SLOT, FAKE_KIMI_SESSION_ID: 'session_kept' },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(KimiCustodyError);
    const run = (failure as KimiCustodyError).run;
    expect(run?.code).toBe(0);
    expect(run?.sessionId).toBe('session_kept');
    expect(run?.stdout).toContain('session.resume_hint');
    // The refreshed copy is kept; the source still has its own token.
    expect(readFileSync(join(home, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'fake-refreshed-access-token',
    );
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
    expect(readdirSync(join(src, 'oauth'))).toEqual([]);
  });
});
