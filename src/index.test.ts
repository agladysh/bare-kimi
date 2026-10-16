import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_SKILLS_DIR,
  HOME_STAMP,
  KimiCustodyError,
  LaunchConfig,
  assertSafePrompt,
  buildArgv,
  buildEnv,
  checkLaunchOptions,
  isModelOverlayVar,
  isScrubbedEnvVar,
  prepareRunHome,
  runKimi,
  sourceHome,
  spawnKimi,
} from './index.ts';
import { checkPreloadOptions, runPreloaded } from './preload.ts';
import {
  CREDENTIAL_FILE,
  CREDENTIAL_SLOT,
  FAKE_KIMI,
  FAKE_TOKEN,
  addSelectableModels,
  assertFakeExecutable,
  hasFlag,
  makeSourceHome,
  makeTempDir,
  readSessionReports,
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

  test('the output format is passed for text too, before the forwarded arguments and the prompt', () => {
    // kimi takes the flag over KIMI_MODEL_OUTPUT_FORMAT, and keeps a repeated flag's last value.
    const argv = buildArgv(LaunchConfig({ prompt: 'x', extraArgs: ['--agent', 'reviewer'] }), 'kimi');
    expect(argv).toEqual(['kimi', '--output-format', 'text', '--agent', 'reviewer', '-p', 'x']);
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
      'KIMI_SECONDARY_MODEL',
      'KIMI_SECONDARY_EFFORT',
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

  test('extraArgs that kimi 2.1.0 would read as selecting a model or a session are refused, in any spelling', () => {
    const models = [['-m', 'x'], ['--model', 'x'], ['--model=x'], ['-mkimi-code/k3-thinking'], ['-ym', 'x']];
    const sessions = [
      ['-S', 's'],
      ['-Ssession_a'],
      ['--session'],
      ['--session=session_a'],
      ['-r', 's'],
      ['--resume=s'],
      ['-c'],
      ['--continue'],
      ['-C'],
      ['-yc'],
    ];
    for (const extraArgs of models) {
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs })).toThrow('selects a model');
    }
    for (const extraArgs of sessions) {
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs })).toThrow('selects a session');
      // Otherwise preload's fresh session and resume/continue exclusivity would be bypassed.
      expect(() => checkPreloadOptions({ prompt: 'x', extraArgs })).toThrow('selects a session');
    }
    // Controls: flags that select neither, and a value that is not a flag.
    for (const extraArgs of [['--verbose-native'], ['-y'], ['--agent', 'reviewer'], ['--add-dir', 'cache']]) {
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs })).not.toThrow();
    }
  });

  test('extraArgs that would take over the output format or the prompt, or end option parsing, are refused', () => {
    const outputs = [['--output-format', 'text'], ['--output-format=stream-json']];
    // kimi's parser reads -px and -yp as -p with a value: a forwarded prompt bare-kimi's own -p would replace.
    const prompts = [['-p', 'other'], ['--prompt', 'other'], ['--prompt=other'], ['-pother'], ['-p-like'], ['-yp', 'other']];
    for (const extraArgs of outputs) {
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs })).toThrow('sets the output format');
    }
    for (const extraArgs of prompts) {
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs })).toThrow('sets the prompt');
    }
    expect(() => checkLaunchOptions({ prompt: 'x', extraArgs: ['--', 'y'] })).toThrow("ends kimi's options");
    expect(() => checkPreloadOptions({ prompt: 'x', extraArgs: ['--output-format=text'] })).toThrow('sets the output format');
  });

  test('extraArgs may not end in a flag that waits for a value, which would take bare-kimi\'s -p', () => {
    for (const flag of ['--add-dir', '--skills-dir', '--agent', '--agent-file']) {
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs: ['-y', flag] })).toThrow(`ends with "${flag}"`);
      // With its value, or the value attached, the flag stays usable.
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs: [flag, 'v'] })).not.toThrow();
      expect(() => checkLaunchOptions({ prompt: 'x', extraArgs: [`${flag}=v`] })).not.toThrow();
    }
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

/** Rewrite the source home's config.toml through `edit`. */
function editSourceConfig(src: string, edit: (text: string) => string): void {
  const configPath = join(src, 'config.toml');
  writeFileSync(configPath, edit(readFileSync(configPath, 'utf-8')));
}

const DEFAULT_LINE = 'default_model = "kimi-code/k3"\n';

describe('model and effort through the fake child', () => {
  test('a selected model and effort reach the child; its new session stores them', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const out = join(root, 'sessions.ndjson');

    const run = await runKimi({
      prompt: 'x',
      home: join(root, 'run-home'),
      srcHome: src,
      model: 'kimi-code/k3-thinking',
      effort: 'high',
      outputFormat: 'stream-json',
      kimiBin: FAKE_KIMI,
      extraEnv: { FAKE_KIMI_SESSION_OUT: out },
    });

    expect(run.code).toBe(0);
    // The finished run says what it was routed to, as its child saw it below.
    expect(run.assembled).toMatchObject({ modelAlias: 'kimi-code/k3-thinking', effort: 'high', effortSupport: 'declared' });
    const reports = readSessionReports(out);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      sessionId: run.sessionId,
      resumed: false,
      model: 'kimi-code/k3-thinking',
      storedEffort: 'high',
      effectiveEffort: 'high',
      configuredEffort: 'high',
    });
    expect(hasFlag(reports[0]!.argv, '--model', 'kimi-code/k3-thinking')).toBe(true);
  });

  test("a resumed session keeps the effort it was created with; the home's configured effort is for new sessions", async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    editSourceConfig(src, (text) => text.replace(DEFAULT_LINE, `${DEFAULT_LINE}\n[thinking]\nenabled = true\neffort = "low"\n`));
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');
    const options = { home, srcHome: src, kimiBin: FAKE_KIMI, extraEnv: { FAKE_KIMI_SESSION_OUT: out } };

    const first = await runKimi({ ...options, prompt: 'x', outputFormat: 'stream-json' });
    expect(first.code).toBe(0);
    expect(first.sessionId).toBeDefined();
    editSourceConfig(src, (text) => text.replace('effort = "low"', 'effort = "high"'));

    const resumed = spawnKimi(
      { ...options, prompt: 'y', resume: first.sessionId },
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    // bare-kimi followed the source: config.toml now gives a new session "high".
    expect(resumed.assembled).toMatchObject({ action: 'reuse', effort: null, configuredEffort: 'high' });
    await resumed.subprocess.exited;
    await resumed.dispose();
    expect(resumed.subprocess.exitCode).toBe(0);
    const later = await runKimi({ ...options, prompt: 'z' });
    expect(later.code).toBe(0);

    const [created, resume, fresh] = readSessionReports(out);
    expect(created).toMatchObject({ resumed: false, storedEffort: 'low' });
    // The resumed session still runs at "low", whatever config.toml now says.
    expect(resume).toMatchObject({
      resumed: true,
      sessionId: first.sessionId,
      storedEffort: 'low',
      effectiveEffort: 'low',
      configuredEffort: 'high',
    });
    expect(fresh).toMatchObject({ resumed: false, storedEffort: 'high' });
  });

  test('a resume by id outlives a pinned effort the source stops listing; a new session and --continue are refused', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const out = join(root, 'sessions.ndjson');
    const options = { home: join(root, 'run-home'), srcHome: src, kimiBin: FAKE_KIMI, extraEnv: { FAKE_KIMI_SESSION_OUT: out } };
    const first = await runKimi({
      ...options,
      prompt: 'x',
      model: 'kimi-code/k3-thinking',
      effort: 'high',
      outputFormat: 'stream-json',
    });
    expect(first.code).toBe(0);
    if (!first.sessionId) throw new Error('the creating run did not report a session id');
    editSourceConfig(src, (text) => text.replace('support_efforts = ["low", "medium", "high"]', 'support_efforts = ["low", "medium"]'));

    await expect(runKimi({ ...options, prompt: 'y' })).rejects.toThrow('can still be resumed by its id');
    // --continue may start a fresh session in kimi 2.1.0, so it gets no such exception.
    await expect(runKimi({ ...options, prompt: 'y', continueRecent: true })).rejects.toThrow('now refuses');
    const resumed = await runKimi({ ...options, prompt: 'z', resume: first.sessionId });

    expect(resumed.code).toBe(0);
    expect(resumed.assembled).toMatchObject({ modelAlias: 'kimi-code/k3-thinking', effort: 'high', effortSupport: 'withdrawn' });
    // Only the creating run and the resume reached the child. (The fake keeps the stored effort;
    // what kimi does with it against the changed table was not observed.)
    expect(readSessionReports(out).map((report) => [report.sessionId, report.resumed])).toEqual([
      [first.sessionId, false],
      [first.sessionId, true],
    ]);
  });

  test('a resume after the source default changed still finds its alias in the kept home', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const out = join(root, 'sessions.ndjson');
    const options = { home: join(root, 'run-home'), srcHome: src, kimiBin: FAKE_KIMI, extraEnv: { FAKE_KIMI_SESSION_OUT: out } };
    const first = await runKimi({ ...options, prompt: 'x', outputFormat: 'stream-json' });
    expect(first.code).toBe(0);
    editSourceConfig(src, (text) => text.replace(DEFAULT_LINE, 'default_model = "kimi-code/k3-thinking"\n'));

    // The fake fails a resume, as kimi does, when the session's alias is not in config.toml.
    const resumed = await runKimi({ ...options, prompt: 'y', resume: first.sessionId });

    expect(resumed.code).toBe(0);
    const reports = readSessionReports(out);
    expect(reports[1]).toMatchObject({ resumed: true, sessionId: first.sessionId, model: 'kimi-code/k3' });
    expect(reports[1]!.argv).not.toContain('--model');
  });

  test('an effort beside a forced one in extraEnv or the spawn env is refused before any home or child', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');
    const options = {
      prompt: 'x',
      home,
      srcHome: src,
      model: 'kimi-code/k3-thinking',
      effort: 'high',
      kimiBin: FAKE_KIMI,
    };

    await expect(
      runKimi({ ...options, extraEnv: { KIMI_MODEL_THINKING_EFFORT: 'low', FAKE_KIMI_SESSION_OUT: out } }),
    ).rejects.toThrow('KIMI_MODEL_THINKING_EFFORT in extraEnv');
    expect(() =>
      spawnKimi({ ...options, extraEnv: { FAKE_KIMI_SESSION_OUT: out } }, { env: { KIMI_MODEL_THINKING_EFFORT: 'low' } }),
    ).toThrow('KIMI_MODEL_THINKING_EFFORT in the spawn env');

    expect(existsSync(home)).toBe(false);
    expect(readSessionReports(out)).toEqual([]);
  });

  test('a forced effort is refused on a home pinned to an effort when the launch omits effort, before the child', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');
    // The model is on a `kimi`-type provider, where the fake (like kimi) applies a forced effort.
    prepareRunHome(src, home, 'link', { model: 'kimi-code/k3-thinking', effort: 'high' });
    const config = readFileSync(join(home, 'config.toml'), 'utf-8');
    const stamp = readFileSync(join(home, HOME_STAMP), 'utf-8');
    // No effort here: the pin comes from the home's stamp alone.
    const options = { prompt: 'x', home, srcHome: src, kimiBin: FAKE_KIMI };

    await expect(
      runKimi({ ...options, extraEnv: { KIMI_MODEL_THINKING_EFFORT: 'max', FAKE_KIMI_SESSION_OUT: out } }),
    ).rejects.toThrow('pinned to effort "high"; KIMI_MODEL_THINKING_EFFORT in extraEnv');
    expect(() =>
      spawnKimi(
        { ...options, extraEnv: { FAKE_KIMI_SESSION_OUT: out } },
        { env: { KIMI_MODEL_THINKING_EFFORT: 'max' } },
      ),
    ).toThrow('pinned to effort "high"; KIMI_MODEL_THINKING_EFFORT in the spawn env');
    await expect(
      runPreloaded(
        { ...options, extraEnv: { KIMI_MODEL_THINKING_EFFORT: 'max', FAKE_KIMI_SESSION_OUT: out } },
        [{ path: 'fact.md', content: 'x' }],
      ),
    ).rejects.toThrow('pinned to effort "high"');

    expect(readSessionReports(out)).toEqual([]);
    expect(existsSync(join(home, 'sessions'))).toBe(false);
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toBe(config);
    expect(readFileSync(join(home, HOME_STAMP), 'utf-8')).toBe(stamp);

    // Controls: without the variable, or with a blank one (taken as unset, as
    // kimi 2.1.0 was observed to take '' and ' ' on a kimi-type provider), the
    // pinned effort is the one every request uses.
    const plain = await runKimi({ ...options, extraEnv: { FAKE_KIMI_SESSION_OUT: out } });
    const empty = await runKimi({ ...options, extraEnv: { KIMI_MODEL_THINKING_EFFORT: ' ', FAKE_KIMI_SESSION_OUT: out } });
    expect([plain.code, empty.code]).toEqual([0, 0]);
    expect(readSessionReports(out).map((report) => report.effectiveEffort)).toEqual(['high', 'high']);
  });

  test('extraEnv decides the forced effort over the spawn env, as the child sees it', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');
    prepareRunHome(src, home, 'link', { model: 'kimi-code/k3-thinking', effort: 'high' });

    // An empty extraEnv value replaces the spawn env's, so the child sees none.
    const launched = spawnKimi(
      {
        prompt: 'x',
        home,
        srcHome: src,
        kimiBin: FAKE_KIMI,
        extraEnv: { KIMI_MODEL_THINKING_EFFORT: '', FAKE_KIMI_SESSION_OUT: out },
      },
      { env: { KIMI_MODEL_THINKING_EFFORT: 'max' }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    const code = await launched.subprocess.exited;
    await launched.dispose();

    expect(code).toBe(0);
    expect(readSessionReports(out)[0]).toMatchObject({ storedEffort: 'high', effectiveEffort: 'high' });
  });

  test('a forced effort stays usable on purpose on a kept home that follows the source [thinking]', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');
    prepareRunHome(src, home, 'link', { model: 'kimi-code/k3-thinking' });

    const run = await runKimi({
      prompt: 'x',
      home,
      srcHome: src,
      kimiBin: FAKE_KIMI,
      extraEnv: { KIMI_MODEL_THINKING_EFFORT: 'max', FAKE_KIMI_SESSION_OUT: out },
    });

    expect(run.code).toBe(0);
    expect(readSessionReports(out)[0]).toMatchObject({ storedEffort: 'medium', effectiveEffort: 'max' });
  });

  test("without effort, a forced effort in extraEnv reaches the child on purpose and overrides the session's own", async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const out = join(root, 'sessions.ndjson');

    const run = await runKimi({
      prompt: 'x',
      home: join(root, 'run-home'),
      srcHome: src,
      model: 'kimi-code/k3-thinking',
      kimiBin: FAKE_KIMI,
      extraEnv: { KIMI_MODEL_THINKING_EFFORT: 'max', FAKE_KIMI_SESSION_OUT: out },
    });

    expect(run.code).toBe(0);
    // No [thinking]: the session stores the model's default; every request is forced.
    expect(readSessionReports(out)[0]).toMatchObject({
      configuredEffort: null,
      storedEffort: 'medium',
      effectiveEffort: 'max',
    });
  });
});

describe('env-model overlay variables', () => {
  test('every KIMI_MODEL_* counts except the forced effort, keep and output format; the secondary overrides are only scrubbed', () => {
    for (const name of ['KIMI_MODEL_NAME', 'KIMI_MODEL_BASE_URL', 'KIMI_MODEL_PROVIDER_TYPE']) {
      expect(isModelOverlayVar(name)).toBe(true);
    }
    for (const name of [
      'KIMI_MODEL_THINKING_EFFORT',
      'KIMI_MODEL_THINKING_KEEP',
      'KIMI_MODEL_OUTPUT_FORMAT',
      'KIMI_SECONDARY_MODEL',
      'KIMI_CODE_BASE_URL',
    ]) {
      expect(isModelOverlayVar(name)).toBe(false);
    }
    // Still scrubbed from the inherited environment.
    expect(isScrubbedEnvVar('KIMI_MODEL_OUTPUT_FORMAT')).toBe(true);
  });

  test('KIMI_MODEL_OUTPUT_FORMAT is no env-model variable: taken on a kept home and beside an effort, effort fields kept, the flag passed', async () => {
    // As read from kimi 2.1.0 (resolveOutputFormat), the flag wins over the variable, which feeds no overlay.
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');

    const launched = spawnKimi(
      {
        prompt: 'x',
        home,
        srcHome: src,
        model: 'kimi-code/k3-thinking',
        effort: 'high',
        kimiBin: FAKE_KIMI,
        extraEnv: { KIMI_MODEL_OUTPUT_FORMAT: 'stream-json', FAKE_KIMI_SESSION_OUT: out },
      },
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    const code = await launched.subprocess.exited;
    await launched.dispose();

    expect(code).toBe(0);
    expect(launched.modelOverlay).toBeNull();
    expect(launched.assembled).toMatchObject({ effort: 'high', effortSupport: 'declared', configuredEffort: 'high' });
    expect(hasFlag(readSessionReports(out)[0]!.argv, '--output-format', 'text')).toBe(true);
  });

  test('refused on a kept home before any effect on it: a non-blank name as observed, anything else as policy', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    const home = join(root, 'run-home');
    const missing = join(root, 'missing-home');
    const out = join(root, 'sessions.ndjson');
    prepareRunHome(src, home);
    const config = readFileSync(join(home, 'config.toml'), 'utf-8');
    const stamp = readFileSync(join(home, HOME_STAMP), 'utf-8');
    // No model here: the home alone makes the launch kept.
    const options = { prompt: 'x', home, srcHome: src, kimiBin: FAKE_KIMI };
    const observed = 'KIMI_MODEL_NAME in extraEnv switches kimi 2.1.0 to its env model (__kimi_env_model__), as observed';
    const policy = 'is an env-model variable: only a non-blank KIMI_MODEL_NAME was observed';

    const cases: ReadonlyArray<readonly [Record<string, string>, string]> = [
      [{ KIMI_MODEL_NAME: 'env-model' }, observed],
      [{ KIMI_MODEL_NAME: ' ' }, `KIMI_MODEL_NAME in extraEnv ${policy}`],
      [{ KIMI_MODEL_BASE_URL: 'http://127.0.0.1:9/v1' }, `KIMI_MODEL_BASE_URL in extraEnv ${policy}`],
      // A non-blank name is named first, whatever else is set beside it.
      [{ KIMI_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', KIMI_MODEL_NAME: 'env-model' }, observed],
    ];
    for (const [extra, message] of cases) {
      await expect(runKimi({ ...options, extraEnv: { ...extra, FAKE_KIMI_SESSION_OUT: out } })).rejects.toThrow(message);
    }
    expect(() =>
      spawnKimi({ ...options, extraEnv: { FAKE_KIMI_SESSION_OUT: out } }, { env: { KIMI_MODEL_NAME: 'env-model' } }),
    ).toThrow('KIMI_MODEL_NAME in the spawn env switches kimi 2.1.0 to its env model');
    // extraEnv decides what the child sees: its blank name hides the spawn env's, leaving policy.
    expect(() =>
      spawnKimi(
        { ...options, extraEnv: { KIMI_MODEL_NAME: '', FAKE_KIMI_SESSION_OUT: out } },
        { env: { KIMI_MODEL_NAME: 'env-model' } },
      ),
    ).toThrow(`KIMI_MODEL_NAME in extraEnv ${policy}`);
    await expect(
      runKimi({ ...options, home: missing, extraEnv: { KIMI_MODEL_NAME: 'env-model', FAKE_KIMI_SESSION_OUT: out } }),
    ).rejects.toThrow('refused on a kept run home');

    expect(readSessionReports(out)).toEqual([]);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(home, 'sessions'))).toBe(false);
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toBe(config);
    expect(readFileSync(join(home, HOME_STAMP), 'utf-8')).toBe(stamp);
  });

  test('refused beside model on an ephemeral launch, by checkLaunchOptions too, as policy', () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const out = join(root, 'sessions.ndjson');
    const options = { prompt: 'x', srcHome: src, model: 'kimi-code/k3-thinking', kimiBin: FAKE_KIMI };

    // Natively --model beside the overlay requested the named alias; the session binding was not examined.
    expect(() => checkLaunchOptions({ ...options, extraEnv: { KIMI_MODEL_NAME: 'env-model' } })).toThrow(
      'which model such a session is bound to was not examined, so this is policy; refused beside model "kimi-code/k3-thinking"',
    );
    expect(() =>
      spawnKimi({ ...options, extraEnv: { FAKE_KIMI_SESSION_OUT: out } }, { env: { KIMI_MODEL_NAME: 'env-model' } }),
    ).toThrow('KIMI_MODEL_NAME in the spawn env switches kimi 2.1.0 to its env model');
    expect(readSessionReports(out)).toEqual([]);
  });

  test('refused beside effort on an ephemeral launch, before any home or child', () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    const out = join(root, 'sessions.ndjson');
    const options = { prompt: 'x', srcHome: src, kimiBin: FAKE_KIMI };

    // With the env model active, kimi 2.1.0 sent no effort although one was configured.
    expect(() => checkLaunchOptions({ ...options, effort: 'high', extraEnv: { KIMI_MODEL_NAME: 'env-model' } })).toThrow(
      'kimi sent no effort although one was configured; refused beside effort "high"',
    );
    expect(() =>
      spawnKimi(
        { ...options, effort: 'off', extraEnv: { FAKE_KIMI_SESSION_OUT: out } },
        { env: { KIMI_MODEL_PROVIDER_TYPE: 'kimi' } },
      ),
    ).toThrow('KIMI_MODEL_PROVIDER_TYPE in the spawn env is an env-model variable');
    expect(readSessionReports(out)).toEqual([]);
  });

  test('KIMI_MODEL_THINKING_KEEP alone is not one: taken on a kept home beside model and effort, and passed on', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const envOut = join(root, 'env.json');
    prepareRunHome(src, home, 'link', { model: 'kimi-code/k3-thinking', effort: 'high' });
    const options = {
      prompt: 'x',
      home,
      srcHome: src,
      model: 'kimi-code/k3-thinking',
      effort: 'high',
      kimiBin: FAKE_KIMI,
      extraEnv: { KIMI_MODEL_THINKING_KEEP: 'all', FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_MODEL_THINKING_KEEP' },
    };

    expect(() => checkLaunchOptions(options)).not.toThrow();
    expect(() => checkPreloadOptions(options)).not.toThrow();
    const launched = spawnKimi(options, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const code = await launched.subprocess.exited;
    await launched.dispose();

    expect(code).toBe(0);
    expect(launched.modelOverlay).toBeNull();
    // It does not switch the model, so the pinned selection stays reported.
    expect(launched.assembled).toMatchObject({ modelAlias: 'kimi-code/k3-thinking', effort: 'high', configuredEffort: 'high' });
    expect(JSON.parse(readFileSync(envOut, 'utf-8'))).toEqual({ KIMI_MODEL_THINKING_KEEP: 'all' });
  });

  test('a preloaded run refuses it, ephemeral or kept, before its child', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');

    for (const launchHome of [undefined, home]) {
      await expect(
        runPreloaded(
          {
            prompt: 'x',
            home: launchHome,
            srcHome: src,
            kimiBin: FAKE_KIMI,
            extraEnv: { KIMI_MODEL_NAME: 'env-model', FAKE_KIMI_SESSION_OUT: out },
          },
          [{ path: 'fact.md', content: 'x' }],
        ),
      ).rejects.toThrow('KIMI_MODEL_NAME in extraEnv');
    }

    expect(readSessionReports(out)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test('controls: an ephemeral launch without model or effort takes it, names it and claims no effort; a spawn-env undefined deletes it', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    editSourceConfig(src, (text) => text.replace(DEFAULT_LINE, `${DEFAULT_LINE}\n[thinking]\nenabled = true\neffort = "high"\n`));
    const envOut = join(root, 'env.json');

    const ephemeral = spawnKimi(
      {
        prompt: 'x',
        srcHome: src,
        kimiBin: FAKE_KIMI,
        extraEnv: { KIMI_MODEL_NAME: 'env-model', FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_MODEL_NAME' },
      },
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    // The home's config.toml still configures "high"; with the env model active kimi was observed not to send it.
    const carried = readFileSync(join(ephemeral.home, 'config.toml'), 'utf-8');
    const code = await ephemeral.subprocess.exited;
    await ephemeral.dispose();

    expect(code).toBe(0);
    expect(ephemeral.ephemeral).toBe(true);
    expect(ephemeral.modelOverlay).toBe('KIMI_MODEL_NAME');
    expect(carried).toContain('effort = "high"');
    expect(ephemeral.assembled).toMatchObject({
      modelAlias: 'kimi-code/k3',
      effort: null,
      effortSupport: null,
      configuredEffort: null,
    });
    expect(JSON.parse(readFileSync(envOut, 'utf-8'))).toEqual({ KIMI_MODEL_NAME: 'env-model' });

    const kept = spawnKimi(
      { prompt: 'x', home: join(root, 'run-home'), srcHome: src, kimiBin: FAKE_KIMI },
      { env: { KIMI_MODEL_NAME: undefined }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    expect(await kept.subprocess.exited).toBe(0);
    await kept.dispose();
    expect(kept.modelOverlay).toBeNull();
    // Without the overlay, the same source's configured effort is reported.
    expect(kept.assembled.configuredEffort).toBe('high');
  });
});

describe('preload with a model and effort', () => {
  test("both runs share the pinned home; the resumed session keeps the primer's model and effort", async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');

    const run = await runPreloaded(
      {
        prompt: 'what is the answer?',
        home,
        srcHome: src,
        model: 'kimi-code/k3-thinking',
        effort: 'high',
        outputFormat: 'stream-json',
        kimiBin: FAKE_KIMI,
        extraEnv: { FAKE_KIMI_SESSION_OUT: out },
      },
      [{ path: 'fact.md', content: 'The answer is synthesized.\n' }],
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('[has-preload]');
    const reports = readSessionReports(out);
    expect(reports).toHaveLength(2);
    const [primer, resumed] = reports;
    expect(primer).toMatchObject({ resumed: false, model: 'kimi-code/k3-thinking', storedEffort: 'high' });
    expect(resumed).toMatchObject({
      resumed: true,
      sessionId: primer!.sessionId,
      model: 'kimi-code/k3-thinking',
      storedEffort: 'high',
      effectiveEffort: 'high',
    });
    expect(run.sessionId).toBe(primer!.sessionId);
    expect(hasFlag(resumed!.argv, '--session', primer!.sessionId)).toBe(true);
    expect(hasFlag(resumed!.argv, '--model', 'kimi-code/k3-thinking')).toBe(true);
    expect(JSON.parse(readFileSync(join(home, HOME_STAMP), 'utf-8'))).toMatchObject({
      model: 'kimi-code/k3-thinking',
      effort: 'high',
    });
  });

  test('a kept home pinned to another model refuses the preload before the primer', async () => {
    const root = temp('bare-kimi-sdk-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'run-home');
    const out = join(root, 'sessions.ndjson');
    prepareRunHome(src, home);

    await expect(
      runPreloaded(
        {
          prompt: 'x',
          home,
          srcHome: src,
          model: 'kimi-code/k3-thinking',
          kimiBin: FAKE_KIMI,
          extraEnv: { FAKE_KIMI_SESSION_OUT: out },
        },
        [{ path: 'fact.md', content: 'x' }],
      ),
    ).rejects.toThrow('pinned to model "kimi-code/k3"');

    expect(readSessionReports(out)).toEqual([]);
    expect(existsSync(join(home, 'sessions'))).toBe(false);
  });
});
