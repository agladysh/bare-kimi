import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  test('re-points a stale link and upgrades a marked copy', () => {
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
