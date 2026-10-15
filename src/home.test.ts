import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  CREDENTIALS_MARKER,
  assembleHome,
  donateAuth,
  ensureAuth,
  isAssembledHome,
  makeEphemeralHome,
  removeHome,
  shredCopiedCredentials,
  sourceHome,
} from './home.ts';
import { FAKE_TOKEN, makeSourceHome, makeTempDir } from '../test/helpers.ts';

const CREDENTIAL_FILE = 'kimi-code-env-0e4f99c69cc27850.json';

const cleanups: string[] = [];

function temp(prefix: string): string {
  const dir = makeTempDir(prefix);
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sourceHome', () => {
  test('explicit argument wins', () => {
    expect(sourceHome('/x', {})).toBe('/x');
  });

  test('KIMI_CODE_HOME_SOURCE beats ~/.kimi-code', () => {
    expect(sourceHome(undefined, { KIMI_CODE_HOME_SOURCE: '/y', HOME: '/h' })).toBe('/y');
    expect(sourceHome(undefined, { HOME: '/h' })).toBe('/h/.kimi-code');
  });

  test('empty values fall through; missing everything throws', () => {
    expect(sourceHome('', { KIMI_CODE_HOME_SOURCE: '/y' })).toBe('/y');
    expect(() => sourceHome(undefined, {})).toThrow('no source home');
  });
});

describe('assembleHome (link mode, the default)', () => {
  test('assembles a runnable minimal home with linked auth', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    const assembled = assembleHome(src, dst);

    expect(assembled.modelAlias).toBe('kimi-code/k3');
    expect(assembled.provider).toBe('managed:kimi-code');

    const config = readFileSync(join(dst, 'config.toml'), 'utf-8');
    expect(config).toContain('default_model = "kimi-code/k3"');
    expect(config).toContain('[providers."managed:kimi-code"]');
    expect(config).toContain('[providers."managed:kimi-code".oauth]');
    expect(config).toContain('key = "oauth/kimi-code-env-0e4f99c69cc27850"');
    expect(config).toContain('[models."kimi-code/k3"]');
    // The credential slot binds (oauth_host, base_url): these must be verbatim.
    expect(config).toContain('base_url = "https://api.kimi.ai/coding/v1"');
    expect(config).toContain('oauth_host = "https://auth.kimi.ai"');
    // Unrelated sections are not carried over.
    expect(config).not.toContain('[unrelated]');

    // credentials/ and oauth/ are DIRECTORY symlinks into the source home.
    const credentials = join(dst, 'credentials');
    expect(lstatSync(credentials).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dst, 'oauth')).isSymbolicLink()).toBe(true);
    // No token material is replicated: reading through the link IS the source file.
    const through = readFileSync(join(credentials, 'kimi-code-env-0e4f99c69cc27850.json'), 'utf-8');
    expect(through).toBe(
      readFileSync(join(src, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'), 'utf-8'),
    );
    expect(through).toContain(FAKE_TOKEN);
    // No marker: link mode owns no copy to shred.
    expect(existsSync(join(credentials, CREDENTIALS_MARKER))).toBe(false);
  });

  test('carries the configured thinking section, and only when present', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const plain = readFileSync(assembleHome(src, join(root, 'plain')).configPath, 'utf-8');
    expect(plain).not.toContain('[thinking]');

    const configPath = join(src, 'config.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace(
      'default_model = "kimi-code/k3"\n',
      'default_model = "kimi-code/k3"\n\n[thinking]\nenabled = true\neffort = "low"\n',
    ));
    const config = readFileSync(assembleHome(src, join(root, 'thinking')).configPath, 'utf-8');
    expect(config).toContain('[thinking]\nenabled = true\neffort = "low"');
    expect(config).not.toContain('[unrelated]');
  });

  test('refuses thinking configured outside a [thinking] table rather than dropping it', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const configPath = join(src, 'config.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace(
      'default_model = "kimi-code/k3"\n',
      'default_model = "kimi-code/k3"\nthinking.effort = "low"\n',
    ));
    const dst = join(root, 'run-home');

    expect(() => assembleHome(src, dst)).toThrow('outside a [thinking] table');
    expect(existsSync(dst)).toBe(false);
  });

  test('re-assembly over its own links keeps them', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    assembleHome(src, dst);
    assembleHome(src, dst);

    expect(readlinkSync(join(dst, 'credentials'))).toBe(join(src, 'credentials'));
    expect(readlinkSync(join(dst, 'oauth'))).toBe(join(src, 'oauth'));
  });

  test('refuses to replace a config.toml symlink; its target is untouched', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    const callerConfig = join(root, 'caller-config.toml');
    writeFileSync(callerConfig, 'mine\n');
    mkdirSync(dst);
    symlinkSync(callerConfig, join(dst, 'config.toml'));

    expect(() => assembleHome(src, dst)).toThrow('not a regular file');
    expect(readFileSync(callerConfig, 'utf-8')).toBe('mine\n');
    expect(lstatSync(join(dst, 'credentials'), { throwIfNoEntry: false })).toBeUndefined();
  });

  test('creates a missing source oauth/ dir so the refresh lock is shared', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    rmSync(join(src, 'oauth'), { recursive: true });
    const dst = join(root, 'run-home');

    assembleHome(src, dst);

    expect(lstatSync(join(src, 'oauth')).isDirectory()).toBe(true);
    expect(lstatSync(join(dst, 'oauth')).isSymbolicLink()).toBe(true);
  });

  test('refuses when source and destination are the same directory', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    expect(() => assembleHome(src, src)).toThrow('same directory');
    expect(() => donateAuth(src, src)).toThrow('same directory');
  });

  test('refuses to replace a caller-owned credentials entry', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    mkdirSync(join(dst, 'credentials'), { recursive: true });
    writeFileSync(join(dst, 'credentials', 'hand-placed.json'), '{}');

    expect(() => assembleHome(src, dst)).toThrow('caller-owned');
    expect(readFileSync(join(dst, 'credentials', 'hand-placed.json'), 'utf-8')).toBe('{}');
  });

  test('refuses to re-point a caller-owned symlink; nothing else changes', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    rmSync(join(src, 'oauth'), { recursive: true });
    const other = join(root, 'other-credentials');
    mkdirSync(other);
    writeFileSync(join(other, 'mine.json'), '{}');
    const dst = join(root, 'run-home');
    mkdirSync(dst);
    symlinkSync(other, join(dst, 'credentials'), 'dir');

    expect(() => assembleHome(src, dst)).toThrow('caller-owned symlink');
    expect(() => donateAuth(src, dst)).toThrow('caller-owned symlink');
    expect(ensureAuth(src, dst)).toBe(false);

    expect(readlinkSync(join(dst, 'credentials'))).toBe(other);
    expect(readFileSync(join(other, 'mine.json'), 'utf-8')).toBe('{}');
    expect(lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(join(dst, 'config.toml'))).toBe(false);
    expect(existsSync(join(src, 'oauth'))).toBe(false);
  });

  test('an oauth/ refusal comes before any change to credentials or the home', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');
    mkdirSync(join(dst, 'oauth'));
    writeFileSync(join(dst, 'oauth', 'lock'), 'held');
    chmodSync(dst, 0o755);

    expect(() => assembleHome(src, dst, 'link')).toThrow('caller-owned');

    // The marked copy was not swapped for a link before oauth/ refused.
    const credentials = join(dst, 'credentials');
    expect(lstatSync(credentials).isSymbolicLink()).toBe(false);
    expect(existsSync(join(credentials, CREDENTIALS_MARKER))).toBe(true);
    expect(readFileSync(join(credentials, CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
    expect(readFileSync(join(dst, 'oauth', 'lock'), 'utf-8')).toBe('held');
    expect(statSync(dst).mode & 0o777).toBe(0o755);
  });

  test('upgrades an unchanged marked copy to a link', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    assembleHome(src, dst, 'copy');
    expect(existsSync(join(dst, 'credentials', CREDENTIALS_MARKER))).toBe(true);

    assembleHome(src, dst, 'link');
    expect(lstatSync(join(dst, 'credentials')).isSymbolicLink()).toBe(true);
  });
});

describe('assembleHome (copy mode)', () => {
  test('copies credentials marker-stamped with 0600 files', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    assembleHome(src, dst, 'copy');

    const copied = join(dst, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json');
    expect(lstatSync(copied).isFile()).toBe(true);
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, 'utf-8')).toContain(FAKE_TOKEN);
    expect(lstatSync(copied).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dst, 'credentials', CREDENTIALS_MARKER))).toBe(true);
    // The refresh lock is per-home: copy mode does not link oauth/.
    expect(existsSync(join(dst, 'oauth'))).toBe(false);
  });
});

describe('path resolution and aliasing', () => {
  test('relative paths resolve against the caller cwd; links are absolute and reach the real file', () => {
    const root = temp('bare-kimi-home-');
    makeSourceHome(root);
    mkdirSync(join(root, 'nested'));
    const previous = process.cwd();
    process.chdir(root);
    try {
      const assembled = assembleHome('src-home', join('nested', 'run-home'));
      expect(isAbsolute(assembled.home)).toBe(true);
    } finally {
      process.chdir(previous);
    }

    const dst = join(root, 'nested', 'run-home');
    expect(isAbsolute(readlinkSync(join(dst, 'credentials')))).toBe(true);
    expect(isAbsolute(readlinkSync(join(dst, 'oauth')))).toBe(true);
    // Read from another cwd: the links must not depend on where they were made.
    expect(readFileSync(join(dst, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
    expect(statSync(join(dst, 'oauth')).isDirectory()).toBe(true);
  });

  test('refuses a run home that is the source home through a symlink; source untouched', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    chmodSync(src, 0o755);
    const alias = join(root, 'alias');
    symlinkSync(src, alias, 'dir');
    const config = readFileSync(join(src, 'config.toml'), 'utf-8');

    expect(() => assembleHome(src, alias)).toThrow('same directory');
    expect(() => assembleHome(src, alias, 'copy')).toThrow('same directory');
    expect(() => donateAuth(src, alias)).toThrow('same directory');
    expect(() => ensureAuth(src, alias)).toThrow('same directory');

    // Nothing was chmod'ed or written through the alias.
    expect(statSync(src).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(src, 'config.toml'), 'utf-8')).toBe(config);
    expect(lstatSync(join(src, 'credentials')).isDirectory()).toBe(true);
    expect(existsSync(join(src, 'credentials', CREDENTIALS_MARKER))).toBe(false);
  });

  test('refuses a dangling symlink as run home', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dangling = join(root, 'dangling');
    symlinkSync(join(root, 'nowhere'), dangling, 'dir');

    expect(() => assembleHome(src, dangling)).toThrow('dangling symlink');
    expect(existsSync(join(root, 'nowhere'))).toBe(false);
  });
});

describe('changed credential copies', () => {
  test('a copy that no longer matches the source is neither replaced nor shredded', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');
    const copied = join(dst, 'credentials', CREDENTIAL_FILE);
    writeFileSync(copied, '{"access_token":"rotated"}\n');

    expect(() => assembleHome(src, dst, 'link')).toThrow('no longer match');
    expect(() => assembleHome(src, dst, 'copy')).toThrow('no longer match');
    expect(() => shredCopiedCredentials(dst, src)).toThrow('no longer match');

    expect(lstatSync(join(dst, 'credentials')).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, 'utf-8')).toContain('rotated');
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
  });

  test('removeHome keeps an ephemeral home whose copy changed, given the source', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = makeEphemeralHome();
    cleanups.push(home);
    assembleHome(src, home, 'copy');
    writeFileSync(join(home, 'credentials', CREDENTIAL_FILE), '{"access_token":"rotated"}\n');

    expect(() => removeHome(home, src)).toThrow('no longer match');
    expect(readFileSync(join(home, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain('rotated');
  });

  test('an unchanged copy is shredded when checked against its source', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');

    expect(shredCopiedCredentials(dst, src)).toBe(true);
    expect(existsSync(join(dst, 'credentials'))).toBe(false);
  });

  test('a credentials symlink is never treated as a copy', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'link');

    expect(() => assembleHome(src, dst, 'copy')).toThrow('unmarked');
    expect(readlinkSync(join(dst, 'credentials'))).toBe(join(src, 'credentials'));
    expect(existsSync(join(src, 'credentials', CREDENTIALS_MARKER))).toBe(false);
  });
});

describe('shredCopiedCredentials / ensureAuth', () => {
  test('shreds only marker-stamped copies', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');

    expect(shredCopiedCredentials(dst)).toBe(true);
    expect(existsSync(join(dst, 'credentials'))).toBe(false);
    // Source home untouched.
    expect(existsSync(join(src, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'))).toBe(true);
  });

  test('never touches an unmarked credentials dir', () => {
    const root = temp('bare-kimi-home-');
    const home = join(root, 'home');
    mkdirSync(join(home, 'credentials'), { recursive: true });
    writeFileSync(join(home, 'credentials', 'keep.json'), '{}');

    expect(shredCopiedCredentials(home)).toBe(false);
    expect(existsSync(join(home, 'credentials', 'keep.json'))).toBe(true);
  });

  test('never touches a linked credentials dir', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'link');

    expect(shredCopiedCredentials(dst)).toBe(false);
    expect(existsSync(join(src, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'))).toBe(true);
  });

  test('ensureAuth re-donates only when credentials are missing', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    mkdirSync(dst, { recursive: true });

    expect(ensureAuth(src, dst)).toBe(true);
    expect(lstatSync(join(dst, 'credentials')).isSymbolicLink()).toBe(true);
    expect(ensureAuth(src, dst)).toBe(false);
  });

  test('ensureAuth restores a missing oauth/ link next to its own credentials link', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    unlinkSync(join(dst, 'oauth'));

    expect(ensureAuth(src, dst)).toBe(true);
    expect(readlinkSync(join(dst, 'oauth'))).toBe(join(src, 'oauth'));
    expect(ensureAuth(src, dst)).toBe(false);
  });
});

describe('ephemeral homes', () => {
  test('makeEphemeralHome stamps the marker; removeHome removes it', () => {
    const home = makeEphemeralHome();
    cleanups.push(home);
    expect(isAssembledHome(home)).toBe(false);
    removeHome(home);
    expect(existsSync(home)).toBe(false);
  });

  test('removeHome refuses an unmarked directory', () => {
    const root = temp('bare-kimi-home-');
    expect(() => removeHome(root)).toThrow('not created by makeEphemeralHome');
    expect(existsSync(root)).toBe(true);
  });

  test('removing an ephemeral link-mode home leaves source credentials intact', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = makeEphemeralHome();
    cleanups.push(home);
    assembleHome(src, home, 'link');

    removeHome(home);

    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(src, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'), 'utf-8')).toContain(
      FAKE_TOKEN,
    );
    expect(existsSync(join(src, 'oauth'))).toBe(true);
  });
});
