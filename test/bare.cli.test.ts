import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  CREDENTIAL_FILE,
  CREDENTIAL_SLOT,
  FAKE_BIN_DIR,
  FAKE_TOKEN,
  assertFakeExecutable,
  makeSourceHome,
  makeTempDir,
  runCli,
} from './helpers.ts';

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

function ephemeralHomes(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('bare-kimi-'))
    .map((name) => join(tmpdir(), name));
}

describe('plain runs', () => {
  test('text run: transcript on stdout, resume hint on stderr, exit 0, home removed', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const before = ephemeralHomes();

    const run = await runCli(['--', 'say ok'], { srcHome: src });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('• ok');
    expect(run.stderr).toContain('To resume this session: kimi -r session_');
    const after = ephemeralHomes().filter((dir) => !before.includes(dir));
    expect(after).toEqual([]);
  });

  test('--json: NDJSON stream on stdout with version, assistant and resume hint', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--json', '--', 'say ok'], { srcHome: src });

    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ role: 'meta', type: 'system.version', version: '9.9.9-fake' });
    expect(lines[1]).toEqual({ role: 'assistant', content: 'ok' });
    expect(lines[2].type).toBe('session.resume_hint');
    expect(lines[2].session_id).toMatch(/^session_/);
  });

  test('prompt from stdin when piped', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--json'], { srcHome: src, stdin: 'say ok\n' });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"content":"ok"');
  });

  test('child exit code propagates', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--json', '--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_EXIT_CODE: '1' },
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('bare-kimi: kimi exited 1');
  });

  test('unspawnable binary exits 127', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--kimi-bin', '/nonexistent/kimi', '--', 'x'], { srcHome: src });

    expect(run.code).toBe(127);
    expect(run.stderr).toContain('failed to spawn');
  });

  test('missing flag value and unknown flag exit 2', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const missing = await runCli(['--home'], { srcHome: src });
    expect(missing.code).toBe(2);

    const unknown = await runCli(['--nope', '--', 'x'], { srcHome: src });
    expect(unknown.code).toBe(2);
  });

  test('a prompt starting with - is refused before any work', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const envOut = join(root, 'env.json');
    const env = { FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_CODE_HOME' };
    const before = ephemeralHomes();

    // Piped on stdin, the prompt reaches the library's own check.
    const piped = await runCli([], { srcHome: src, stdin: '-x\n', env });
    expect(piped.code).toBe(2);
    expect(piped.stderr).toContain('starts with "-"');

    // After `--`, the CLI's parser sees `-x` as an option when run as
    // `bun bin/bare-kimi.ts -- -x` (observed at the recovered baseline) and
    // refuses it as unknown. Either way nothing runs.
    const separated = await runCli(['--', '-x'], { srcHome: src, env });
    expect(separated.code).toBe(2);
    expect(separated.stderr).toContain("'-x'");

    expect(existsSync(envOut)).toBe(false); // kimi never started
    expect(ephemeralHomes().filter((dir) => !before.includes(dir))).toEqual([]);
    expect(existsSync(join(src, 'sessions'))).toBe(false);
  });

  test('a relative --kimi-bin resolves against the invoking directory, not --cwd', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const invokedFrom = dirname(FAKE_BIN_DIR);

    const run = await runCli(
      ['--kimi-bin', relative(invokedFrom, join(FAKE_BIN_DIR, 'kimi')), '--cwd', root, '--', 'x'],
      { srcHome: src, cwd: invokedFrom },
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('• ok');
  });
});

describe('home custody', () => {
  test('--home assembles once, keeps the home, links (not copies) credentials', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const home = join(root, 'kept-home');

    const first = await runCli(['--home', home, '--', 'x'], { srcHome: src });
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(`home kept at ${home}`);
    expect(existsSync(join(home, 'config.toml'))).toBe(true);
    expect(lstatSync(join(home, 'credentials')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, 'oauth')).isSymbolicLink()).toBe(true);

    // A caller edit to the assembled config survives the next run (no re-assembly).
    writeFileSync(join(home, 'config.toml'), '# caller edit\n', { flag: 'a' });
    const second = await runCli(['--home', home, '--', 'x'], { srcHome: src });
    expect(second.code).toBe(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toContain('# caller edit');

    // Session records accumulate in the kept home; source home stays pristine.
    expect(existsSync(join(home, 'sessions', 'wd_fake_000000000000'))).toBe(true);
    expect(existsSync(join(src, 'sessions'))).toBe(false);
  });

  test('--home equal to the source home is refused', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--home', src, '--', 'x'], { srcHome: src });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('same directory');
  });

  test('--home that is the source home under another name is refused; source untouched', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const alias = join(root, 'alias');
    symlinkSync(src, alias, 'dir');
    const config = readFileSync(join(src, 'config.toml'), 'utf-8');

    const run = await runCli(['--home', alias, '--', 'x'], { srcHome: src });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('same directory');
    // The child never ran against the source home.
    expect(existsSync(join(src, 'sessions'))).toBe(false);
    expect(readFileSync(join(src, 'config.toml'), 'utf-8')).toBe(config);
  });

  test('relative --home and --src-home resolve against the invoking directory, not --cwd', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const work = join(root, 'work');
    mkdirSync(work);
    const envOut = join(root, 'env.json');

    const run = await runCli(['--home', 'rel-home', '--src-home', 'src-home', '--cwd', work, '--', 'x'], {
      srcHome: src,
      cwd: root,
      env: { FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_CODE_HOME' },
    });

    expect(run.code).toBe(0);
    const home = join(root, 'rel-home');
    const recorded = JSON.parse(readFileSync(envOut, 'utf-8'));
    expect(isAbsolute(recorded['KIMI_CODE_HOME'])).toBe(true);
    expect(realpathSync(recorded['KIMI_CODE_HOME'])).toBe(realpathSync(home));
    // Sessions land in the home the caller named, not under the child's cwd.
    expect(existsSync(join(home, 'sessions'))).toBe(true);
    expect(existsSync(join(work, 'rel-home'))).toBe(false);
    // The credentials link reaches the real source file from anywhere.
    expect(isAbsolute(readlinkSync(join(home, 'credentials')))).toBe(true);
    expect(
      readFileSync(join(home, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'), 'utf-8'),
    ).toContain(FAKE_TOKEN);
  });

  test('--keep-home keeps even an ephemeral home', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const before = ephemeralHomes();

    const run = await runCli(['--keep-home', '--', 'x'], { srcHome: src });

    expect(run.code).toBe(0);
    const kept = ephemeralHomes().filter((dir) => !before.includes(dir));
    expect(kept).toHaveLength(1);
    cleanups.push(kept[0]!);
    expect(existsSync(join(kept[0]!, 'config.toml'))).toBe(true);
  });

  test('copy mode duplicates then shreds credentials; source untouched', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const home = join(root, 'kept-home');

    const run = await runCli(['--home', home, '--auth', 'copy', '--', 'x'], { srcHome: src });

    expect(run.code).toBe(0);
    // Shredded on exit even in a kept home.
    expect(existsSync(join(home, 'credentials'))).toBe(false);
    expect(
      readFileSync(join(src, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'), 'utf-8'),
    ).toContain(FAKE_TOKEN);

    // The next run re-donates: still runnable.
    const second = await runCli(['--home', home, '--auth', 'copy', '--', 'x'], { srcHome: src });
    expect(second.code).toBe(0);
  });

  test('--keep-credentials keeps the copy resumable', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const home = join(root, 'kept-home');

    const run = await runCli(
      ['--home', home, '--auth', 'copy', '--keep-credentials', '--', 'x'],
      { srcHome: src },
    );

    expect(run.code).toBe(0);
    const copied = join(home, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json');
    expect(existsSync(copied)).toBe(true);
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
  });

  test('--home naming a non-empty directory that is not a run home is refused before kimi', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'notes.md'), 'mine\n');
    const envOut = join(root, 'env.json');

    const run = await runCli(['--home', project, '--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_CODE_HOME' },
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('not a run home');
    expect(readdirSync(project)).toEqual(['notes.md']);
    expect(existsSync(envOut)).toBe(false);
  });
});

describe('native-style token refresh (simulated by the fake)', () => {
  test('link mode: the refresh lands in the source home and takes the shared lock', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_REFRESH_SLOT: CREDENTIAL_SLOT },
    });

    expect(run.code).toBe(0);
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'fake-refreshed-access-token',
    );
    // tmp + rename landed inside the real directory; nothing else was left.
    expect(readdirSync(join(src, 'credentials'))).toEqual([CREDENTIAL_FILE]);
    expect(statSync(join(src, 'credentials')).mode & 0o777).toBe(0o700);
    expect(statSync(join(src, 'oauth', `${CREDENTIAL_SLOT}.lock`)).isDirectory()).toBe(true);
  });

  test('copy mode: a refreshed copy is kept, output survives, the run exits 4', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const home = join(root, 'kept-home');

    const run = await runCli(['--home', home, '--auth', 'copy', '--json', '--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_REFRESH_SLOT: CREDENTIAL_SLOT, FAKE_KIMI_SESSION_ID: 'session_kept' },
    });

    expect(run.code).toBe(4);
    expect(run.stdout).toContain('"session_id":"session_kept"');
    expect(run.stderr).toContain('may hold the only current refresh token');
    expect(readFileSync(join(home, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'fake-refreshed-access-token',
    );
    // The source keeps its own token and saw no lock.
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
    expect(readdirSync(join(src, 'oauth'))).toEqual([]);
  });

  test('copy mode, ephemeral home: the home holding a refreshed copy is kept and named', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const before = ephemeralHomes();

    const run = await runCli(['--auth', 'copy', '--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_REFRESH_SLOT: CREDENTIAL_SLOT },
    });

    expect(run.code).toBe(4);
    const kept = ephemeralHomes().filter((dir) => !before.includes(dir));
    expect(kept).toHaveLength(1);
    cleanups.push(kept[0]!);
    expect(run.stderr).toContain(basename(kept[0]!));
    expect(readFileSync(join(kept[0]!, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'fake-refreshed-access-token',
    );
  });

  test('copy mode: a kept copy left stale by a source refresh is discarded by the next run', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const home = join(root, 'kept-home');

    const keep = await runCli(['--home', home, '--auth', 'copy', '--keep-credentials', '--', 'x'], {
      srcHome: src,
    });
    expect(keep.code).toBe(0);
    // A link-mode run elsewhere refreshes the source.
    const refresh = await runCli(['--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_REFRESH_SLOT: CREDENTIAL_SLOT },
    });
    expect(refresh.code).toBe(0);

    const reuse = await runCli(['--home', home, '--auth', 'copy', '--', 'x'], { srcHome: src });

    expect(reuse.code).toBe(0);
    expect(existsSync(join(home, 'credentials'))).toBe(false);
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'fake-refreshed-access-token',
    );
  });
});

describe('environment and credential boundary', () => {
  test('scrubs slot/lock overrides, forces run home, defaults telemetry/update off', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const envOut = join(root, 'env.json');

    const run = await runCli(['--', 'x'], {
      srcHome: src,
      env: {
        FAKE_KIMI_ENV_OUT: envOut,
        FAKE_KIMI_ENV_KEYS:
          'KIMI_CODE_HOME,KIMI_CODE_BASE_URL,KIMI_OAUTH_HOST,KIMI_DISABLE_OAUTH_LOCK,KIMI_MODEL_NAME,KIMI_DISABLE_TELEMETRY,KIMI_CODE_NO_AUTO_UPDATE',
        KIMI_CODE_BASE_URL: 'https://evil.example/v1',
        KIMI_OAUTH_HOST: 'https://evil.example',
        KIMI_MODEL_NAME: 'injected/model',
      },
    });

    expect(run.code).toBe(0);
    const recorded = JSON.parse(readFileSync(envOut, 'utf-8'));
    expect(recorded['KIMI_CODE_BASE_URL']).toBeUndefined();
    expect(recorded['KIMI_OAUTH_HOST']).toBeUndefined();
    expect(recorded['KIMI_DISABLE_OAUTH_LOCK']).toBeUndefined();
    expect(recorded['KIMI_MODEL_NAME']).toBeUndefined();
    expect(recorded['KIMI_DISABLE_TELEMETRY']).toBe('1');
    expect(recorded['KIMI_CODE_NO_AUTO_UPDATE']).toBe('1');
    expect(recorded['KIMI_CODE_HOME']).toContain('bare-kimi-');
    expect(recorded['KIMI_CODE_HOME']).not.toBe(src);
  });

  test('no credential material reaches the child environment', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const envOut = join(root, 'env.json');

    const run = await runCli(['--', 'x'], {
      srcHome: src,
      env: {
        FAKE_KIMI_ENV_OUT: envOut,
        FAKE_KIMI_ENV_KEYS: 'PATH,HOME,KIMI_CODE_HOME,KIMI_CODE_HOME_SOURCE',
      },
    });

    expect(run.code).toBe(0);
    const raw = readFileSync(envOut, 'utf-8');
    expect(raw).not.toContain(FAKE_TOKEN);
    expect(run.stdout).not.toContain(FAKE_TOKEN);
    expect(run.stderr).not.toContain(FAKE_TOKEN);
  });
});

describe('preload', () => {
  test('preloaded content is served as past on resume; exit 0', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const preloadFile = join(root, 'fact.md');
    writeFileSync(preloadFile, 'The answer is synthesized.\n');

    const run = await runCli(['--json', '--preload', preloadFile, '--', 'what is the answer?'], {
      srcHome: src,
    });

    expect(run.code).toBe(0);
    // The fake child answers [has-preload] only when the resumed session's
    // wire journal carries the [preload] record — proving primer + append +
    // resume happened in one home.
    expect(run.stdout).toContain('[has-preload]');
  });

  test('binary preload is refused before any run', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const binary = join(root, 'blob.bin');
    writeFileSync(binary, Buffer.from([0x66, 0x00, 0x66]));

    const run = await runCli(['--preload', binary, '--', 'x'], { srcHome: src });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('looks binary');
  });

  test.each([
    ['--continue', ['--continue'], 'fresh session'],
    ['--resume', ['--resume', 'session_a'], 'fresh session'],
    ['a leading-dash --prime', ['--prime=-p'], 'starts with "-"'],
  ] as const)('--preload with %s is refused before any home or kimi', async (_label, extra, message) => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const preloadFile = join(root, 'fact.md');
    writeFileSync(preloadFile, 'x');
    const envOut = join(root, 'env.json');
    const before = ephemeralHomes();

    const run = await runCli(['--keep-home', '--preload', preloadFile, ...extra, '--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_CODE_HOME' },
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(existsSync(envOut)).toBe(false); // no primer, no provider turn
    expect(ephemeralHomes().filter((dir) => !before.includes(dir))).toEqual([]);
    expect(existsSync(join(src, 'sessions'))).toBe(false);
  });

  test('--preload with a piped leading-dash prompt is refused before the primer', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const preloadFile = join(root, 'fact.md');
    writeFileSync(preloadFile, 'x');
    const envOut = join(root, 'env.json');

    const run = await runCli(['--preload', preloadFile], {
      srcHome: src,
      stdin: '-x\n',
      env: { FAKE_KIMI_ENV_OUT: envOut, FAKE_KIMI_ENV_KEYS: 'KIMI_CODE_HOME' },
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('starts with "-"');
    expect(existsSync(envOut)).toBe(false);
  });

  test('primer failure propagates the child code', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);
    const preloadFile = join(root, 'fact.md');
    writeFileSync(preloadFile, 'x');

    const run = await runCli(['--preload', preloadFile, '--', 'x'], {
      srcHome: src,
      env: { FAKE_KIMI_EXIT_CODE: '1' },
    });

    expect(run.code).toBe(1);
  });
});

describe('version', () => {
  test('--version prints the package version', async () => {
    const root = temp('bare-kimi-test-');
    const src = makeSourceHome(root);

    const run = await runCli(['--version'], { srcHome: src });

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
