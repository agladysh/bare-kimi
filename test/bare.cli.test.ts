import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_TOKEN,
  ensureFakeExecutable,
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
  ensureFakeExecutable();
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

    const run = await runCli(['--', '-x'], { srcHome: src });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('starts with "-"');
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
