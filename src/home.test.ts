import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
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
import { CREDENTIAL_FILE, FAKE_TOKEN, makeSourceHome, makeTempDir } from '../test/helpers.ts';

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

/** Rewrite the source home's config.toml through `edit`. */
function editConfig(src: string, edit: (text: string) => string): string {
  const configPath = join(src, 'config.toml');
  const text = edit(readFileSync(configPath, 'utf-8'));
  writeFileSync(configPath, text);
  return text;
}

/** Replace a file the way native kimi saves a token: tmp file, then rename. */
function replaceByRename(path: string, content: string): void {
  const tmp = `${path}.tmp.test`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

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
    const through = readFileSync(join(credentials, CREDENTIAL_FILE), 'utf-8');
    expect(through).toBe(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8'));
    expect(through).toContain(FAKE_TOKEN);
    // No marker: link mode owns no copy to shred.
    expect(existsSync(join(credentials, CREDENTIALS_MARKER))).toBe(false);
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
    expect(() => ensureAuth(src, dst)).toThrow('caller-owned symlink');

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

describe('assembleHome config.toml', () => {
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

  test('carries permission rules and hooks verbatim, in order, and nothing between them', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    // Shapes follow kimi 2.1.0's config schema; the assembler carries them
    // without interpreting them.
    const source = editConfig(
      src,
      (text) => `${text}
[permission]
deny = ["Bash(rm -rf *)"]

[unrelated.between]
x = 1

[[permission.rules]]
decision = "deny"
pattern = "Bash(curl *)"
reason = "no network"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "./guard.sh"
timeout = 30
`,
    );

    const config = readFileSync(assembleHome(src, join(root, 'run-home')).configPath, 'utf-8');

    expect(config).toContain('[permission]\ndeny = ["Bash(rm -rf *)"]');
    expect(config).toContain(
      '[[permission.rules]]\ndecision = "deny"\npattern = "Bash(curl *)"\nreason = "no network"',
    );
    expect(config).toContain(
      '[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = "./guard.sh"\ntimeout = 30',
    );
    expect(config).not.toContain('[unrelated');
    const parsedSource = parseToml(source);
    const parsedConfig = parseToml(config);
    expect(parsedConfig['permission']).toEqual(parsedSource['permission']);
    expect(parsedConfig['hooks']).toEqual(parsedSource['hooks']);
  });

  test.each([
    ['permission as root dotted keys', 'permission.deny = ["Bash"]\n'],
    ['hooks as a root inline array', 'hooks = [{ event = "PreToolUse", command = "./guard.sh" }]\n'],
    ['thinking as root dotted keys', 'thinking.effort = "low"\n'],
  ])('refuses %s rather than dropping them, before any effect', (_label, line) => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    rmSync(join(src, 'oauth'), { recursive: true });
    editConfig(src, (text) =>
      text.replace('default_model = "kimi-code/k3"\n', `default_model = "kimi-code/k3"\n${line}`),
    );
    const dst = join(root, 'run-home');

    expect(() => assembleHome(src, dst)).toThrow('cannot be carried verbatim');
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(join(src, 'oauth'))).toBe(false);
  });

  test('a header-like line inside a multi-line string is refused, not mis-split', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    editConfig(
      src,
      (text) => `${text}
[[hooks]]
event = "PreToolUse"
command = """
[models."elsewhere"]
"""
`,
    );
    const dst = join(root, 'run-home');

    expect(() => assembleHome(src, dst)).toThrow('refusing');
    expect(existsSync(dst)).toBe(false);
  });

  test('default_model is read from the root table only', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    editConfig(src, (text) =>
      text
        .replace('default_model = "kimi-code/k3"\n', '')
        .replace('[unrelated]\nkeep = "me"\n', '[unrelated]\nkeep = "me"\ndefault_model = "kimi-code/k3"\n'),
    );
    const dst = join(root, 'run-home');

    expect(() => assembleHome(src, dst)).toThrow('no default_model in the root table');
    expect(existsSync(dst)).toBe(false);
  });

  test('accepts other spellings of the same table headers, carried as written', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const source = editConfig(src, (text) =>
      text
        .replace('[models."kimi-code/k3"]', "[ models . 'kimi-code/k3' ]")
        .replace('[providers."managed:kimi-code"]\n', "[providers.'managed:kimi-code']\n"),
    );

    const config = readFileSync(assembleHome(src, join(root, 'run-home')).configPath, 'utf-8');

    expect(config).toContain("[ models . 'kimi-code/k3' ]");
    expect(config).toContain("[providers.'managed:kimi-code']");
    const parsedSource = parseToml(source) as unknown as Record<string, Record<string, unknown>>;
    const parsedConfig = parseToml(config) as unknown as Record<string, Record<string, unknown>>;
    expect(parsedConfig['models']).toEqual({ 'kimi-code/k3': parsedSource['models']?.['kimi-code/k3'] });
    expect(parsedConfig['providers']).toEqual({
      'managed:kimi-code': parsedSource['providers']?.['managed:kimi-code'],
    });
  });

  test('refuses a source config that is not valid TOML', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    editConfig(src, (text) => `${text}\n[broken\n`);
    const dst = join(root, 'run-home');

    expect(() => assembleHome(src, dst)).toThrow('does not parse as TOML');
    expect(existsSync(dst)).toBe(false);
  });

  // Each is invalid TOML that a permissive parser may accept, keeping one of
  // two readings or ignoring a tail. kimi 2.1.0's parser rejects them, so
  // nothing about the source's meaning, carried or not, can be trusted.
  test.each([
    ['a duplicate key in a carried table', '\n[permission]\ndeny = ["Bash(rm *)"]\ndeny = ["Bash(curl *)"]\n'],
    ['a carried table defined twice', '\n[permission]\ndeny = ["Bash(rm *)"]\n\n[permission]\nallow = ["Read"]\n'],
    ['trailing junk after a value in an uncarried table', '\n[other]\nkeep = "me" junk\n'],
    ['a key-less line at the end', '\n= "orphan"\n'],
    ['an unterminated multi-line string at the end', '\n[[hooks]]\nevent = "PreToolUse"\ncommand = """\nunterminated\n'],
    ['an unterminated array-of-tables header at the end', '\n[[hooks]\nevent = "PreToolUse"\n'],
  ])('refuses a malformed tail: %s, before any effect', (_label, tail) => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    rmSync(join(src, 'oauth'), { recursive: true });
    editConfig(src, (text) => `${text}${tail}`);
    const dst = join(root, 'run-home');

    expect(() => assembleHome(src, dst)).toThrow('does not parse as TOML');
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(join(src, 'oauth'))).toBe(false);
  });
});

describe('assembleHome (copy mode)', () => {
  test('copies credentials marker-stamped with 0600 files', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    assembleHome(src, dst, 'copy');

    const copied = join(dst, 'credentials', CREDENTIAL_FILE);
    expect(lstatSync(copied).isFile()).toBe(true);
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, 'utf-8')).toContain(FAKE_TOKEN);
    expect(lstatSync(copied).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dst, 'credentials', CREDENTIALS_MARKER))).toBe(true);
    // The refresh lock is per-home: copy mode does not link oauth/.
    expect(existsSync(join(dst, 'oauth'))).toBe(false);
  });

  test('the marker stamps each copied file with its SHA-256', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    assembleHome(src, dst, 'copy');

    const stamp = JSON.parse(readFileSync(join(dst, 'credentials', CREDENTIALS_MARKER), 'utf-8'));
    const digest = createHash('sha256')
      .update(readFileSync(join(src, 'credentials', CREDENTIAL_FILE)))
      .digest('hex');
    expect(stamp).toEqual({ version: 1, files: { [CREDENTIAL_FILE]: digest } });
  });
});

describe('run-home custody', () => {
  test('a created run home is 0700; an existing empty one keeps its mode', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const created = join(root, 'created');
    assembleHome(src, created);
    expect(statSync(created).mode & 0o777).toBe(0o700);

    const existing = join(root, 'existing');
    mkdirSync(existing);
    chmodSync(existing, 0o755);
    assembleHome(src, existing);
    expect(statSync(existing).mode & 0o777).toBe(0o755);
    expect(isAssembledHome(existing)).toBe(true);
  });

  test('refuses an existing non-empty directory that is not a run home', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'project');
    mkdirSync(dst);
    chmodSync(dst, 0o755);
    writeFileSync(join(dst, 'notes.md'), 'mine\n');

    expect(() => assembleHome(src, dst)).toThrow('not a run home');
    expect(readdirSync(dst)).toEqual(['notes.md']);
    expect(statSync(dst).mode & 0o777).toBe(0o755);
  });

  test('refuses a run home nested inside the source home, or containing it', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const config = readFileSync(join(src, 'config.toml'), 'utf-8');

    expect(() => assembleHome(src, join(src, 'run-home'))).toThrow('nested');
    expect(() => assembleHome(src, root)).toThrow('nested');
    expect(() => donateAuth(src, root)).toThrow('nested');

    expect(existsSync(join(src, 'run-home'))).toBe(false);
    expect(existsSync(join(root, 'credentials'))).toBe(false);
    expect(existsSync(join(root, 'config.toml'))).toBe(false);
    expect(readFileSync(join(src, 'config.toml'), 'utf-8')).toBe(config);
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

describe('credential copies: stale versus changed', () => {
  test('a copy changed since it was copied is neither replaced nor shredded', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');
    const copied = join(dst, 'credentials', CREDENTIAL_FILE);
    replaceByRename(copied, '{"access_token":"rotated"}\n');

    expect(() => assembleHome(src, dst, 'link')).toThrow('may hold the only current refresh token');
    expect(() => assembleHome(src, dst, 'copy')).toThrow('changed since it was copied');
    expect(() => shredCopiedCredentials(dst, src)).toThrow('may hold the only current refresh token');

    expect(lstatSync(join(dst, 'credentials')).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, 'utf-8')).toContain('rotated');
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
  });

  test('a file the copy gained is kept too', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');
    writeFileSync(join(dst, 'credentials', 'kimi-code.json'), '{"access_token":"new-slot"}\n');

    expect(() => shredCopiedCredentials(dst, src)).toThrow('kimi-code.json');
    expect(existsSync(join(dst, 'credentials', 'kimi-code.json'))).toBe(true);
  });

  test('an unchanged copy is discarded after a source-only refresh', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const stale = join(root, 'stale-home');
    const upgraded = join(root, 'upgraded-home');
    assembleHome(src, stale, 'copy');
    assembleHome(src, upgraded, 'copy');
    replaceByRename(join(src, 'credentials', CREDENTIAL_FILE), '{"access_token":"refreshed-in-source"}\n');

    expect(shredCopiedCredentials(stale, src)).toBe(true);
    expect(existsSync(join(stale, 'credentials'))).toBe(false);

    assembleHome(src, upgraded, 'link');
    expect(readFileSync(join(upgraded, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'refreshed-in-source',
    );
  });

  test('re-copying over an unchanged copy refreshes it and its stamp', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');
    replaceByRename(join(src, 'credentials', CREDENTIAL_FILE), '{"access_token":"refreshed-in-source"}\n');

    assembleHome(src, dst, 'copy');

    expect(readFileSync(join(dst, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(
      'refreshed-in-source',
    );
    expect(shredCopiedCredentials(dst, src)).toBe(true);
  });

  test('a legacy unstamped copy is discarded only while identical to the source', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst, 'copy');
    writeFileSync(join(dst, 'credentials', CREDENTIALS_MARKER), ''); // the earlier, empty marker
    const sourceFile = join(src, 'credentials', CREDENTIAL_FILE);
    const original = readFileSync(sourceFile, 'utf-8');
    replaceByRename(sourceFile, '{"access_token":"refreshed-in-source"}\n');

    expect(() => shredCopiedCredentials(dst, src)).toThrow('cannot be verified as unchanged');
    expect(readFileSync(join(dst, 'credentials', CREDENTIAL_FILE), 'utf-8')).toBe(original);

    replaceByRename(sourceFile, original);
    expect(shredCopiedCredentials(dst, src)).toBe(true);
  });

  test('removeHome keeps an ephemeral home whose copy changed, given the source', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = makeEphemeralHome();
    cleanups.push(home);
    assembleHome(src, home, 'copy');
    replaceByRename(join(home, 'credentials', CREDENTIAL_FILE), '{"access_token":"rotated"}\n');

    expect(() => removeHome(home, src)).toThrow('may hold the only current refresh token');
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

    // Its oauth/ link would pair a copied token with the shared lock.
    expect(() => assembleHome(src, dst, 'copy')).toThrow('oauth/ is a symlink');
    unlinkSync(join(dst, 'oauth'));
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
    expect(existsSync(join(src, 'credentials', CREDENTIAL_FILE))).toBe(true);
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
    expect(existsSync(join(src, 'credentials', CREDENTIAL_FILE))).toBe(true);
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

  test('ensureAuth refuses links that do not pair with the intended source', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const otherSrc = makeSourceHome(temp('bare-kimi-other-'));
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    const credentials = join(dst, 'credentials');
    const oauth = join(dst, 'oauth');

    // credentials/ from another source, oauth/ from this one.
    unlinkSync(credentials);
    symlinkSync(join(otherSrc, 'credentials'), credentials, 'dir');
    expect(() => ensureAuth(src, dst)).toThrow('caller-owned symlink');

    // credentials/ from this source, oauth/ from another.
    unlinkSync(credentials);
    symlinkSync(join(src, 'credentials'), credentials, 'dir');
    unlinkSync(oauth);
    symlinkSync(join(otherSrc, 'oauth'), oauth, 'dir');
    expect(() => ensureAuth(src, dst)).toThrow('caller-owned symlink');

    // credentials/ linked, oauth/ a per-home directory.
    unlinkSync(oauth);
    mkdirSync(oauth);
    expect(() => ensureAuth(src, dst)).toThrow('caller-owned entry');

    // Linked credentials used in copy mode.
    rmSync(oauth, { recursive: true });
    expect(() => ensureAuth(src, dst, 'copy')).toThrow('copy mode was requested');

    // Own credentials/ next to a linked oauth/.
    unlinkSync(credentials);
    mkdirSync(credentials);
    symlinkSync(join(src, 'oauth'), oauth, 'dir');
    expect(() => ensureAuth(src, dst)).toThrow('unpaired lock');

    // Nothing was re-pointed along the way.
    expect(readlinkSync(oauth)).toBe(join(src, 'oauth'));
    expect(readdirSync(join(otherSrc, 'oauth'))).toEqual([]);
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
    expect(readFileSync(join(src, 'credentials', CREDENTIAL_FILE), 'utf-8')).toContain(FAKE_TOKEN);
    expect(existsSync(join(src, 'oauth'))).toBe(true);
  });
});
