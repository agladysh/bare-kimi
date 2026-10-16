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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  ADOPTION_RECORD,
  CREDENTIALS_MARKER,
  HOME_STAMP,
  assembleHome,
  donateAuth,
  ensureAuth,
  isAssembledHome,
  makeEphemeralHome,
  prepareRunHome,
  previewRunHome,
  removeHome,
  runSourceHome,
  shredCopiedCredentials,
  sourceHome,
  type RunHomeOptions,
} from './home.ts';
import {
  ASSEMBLE_CHILD,
  CREDENTIAL_FILE,
  FAKE_TOKEN,
  OTHER_PROVIDER_KEY,
  addSelectableModels,
  makeSourceHome,
  makeTempDir,
  runWithDeadline,
} from '../test/helpers.ts';

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

  test('refuses a config.toml symlink, stamped home or not; its target is untouched', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const callerConfig = join(root, 'caller-config.toml');
    writeFileSync(callerConfig, 'mine\n');

    const unstamped = join(root, 'unstamped');
    mkdirSync(unstamped);
    symlinkSync(callerConfig, join(unstamped, 'config.toml'));
    expect(() => assembleHome(src, unstamped)).toThrow('has no .bare-kimi-home');
    expect(lstatSync(join(unstamped, 'credentials'), { throwIfNoEntry: false })).toBeUndefined();

    const stamped = join(root, 'stamped');
    assembleHome(src, stamped);
    rmSync(join(stamped, 'config.toml'));
    symlinkSync(callerConfig, join(stamped, 'config.toml'));
    expect(() => assembleHome(src, stamped)).toThrow('not a regular file');
    expect(() => prepareRunHome(src, stamped)).toThrow('not a regular file');

    expect(readFileSync(callerConfig, 'utf-8')).toBe('mine\n');
    expect(lstatSync(join(stamped, 'config.toml')).isSymbolicLink()).toBe(true);
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
    assembleHome(src, dst);
    unlinkSync(join(dst, 'credentials'));
    mkdirSync(join(dst, 'credentials'));
    writeFileSync(join(dst, 'credentials', 'hand-placed.json'), '{}');

    expect(() => assembleHome(src, dst)).toThrow('caller-owned');
    expect(readFileSync(join(dst, 'credentials', 'hand-placed.json'), 'utf-8')).toBe('{}');
  });

  test('refuses to re-point a caller-owned symlink; nothing else changes', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    const config = readFileSync(join(dst, 'config.toml'), 'utf-8');
    unlinkSync(join(dst, 'oauth'));
    rmSync(join(src, 'oauth'), { recursive: true });
    const other = join(root, 'other-credentials');
    mkdirSync(other);
    writeFileSync(join(other, 'mine.json'), '{}');
    unlinkSync(join(dst, 'credentials'));
    symlinkSync(other, join(dst, 'credentials'), 'dir');

    expect(() => assembleHome(src, dst)).toThrow('caller-owned symlink');
    expect(() => prepareRunHome(src, dst)).toThrow('caller-owned symlink');
    expect(() => donateAuth(src, dst)).toThrow('caller-owned symlink');
    expect(() => ensureAuth(src, dst)).toThrow('caller-owned symlink');

    expect(readlinkSync(join(dst, 'credentials'))).toBe(other);
    expect(readFileSync(join(other, 'mine.json'), 'utf-8')).toBe('{}');
    expect(lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(dst, 'config.toml'), 'utf-8')).toBe(config);
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
    // Rule shapes kimi 2.1.0 accepts: a `deny` entry as a table (`tool` +
    // `match`), and `[[permission.rules]]` with `decision` + `pattern`. (A bare
    // string entry, `deny = ["Bash"]`, fails its schema, and 2.1.0 drops the
    // whole section.) The assembler carries them without interpreting them.
    const source = editConfig(
      src,
      (text) => `${text}
[permission]
deny = [{ tool = "Bash", match = "rm -rf *" }]

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

    expect(config).toContain('[permission]\ndeny = [{ tool = "Bash", match = "rm -rf *" }]');
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
    ['permission as root dotted keys', 'permission.deny = [{ tool = "Bash" }]\n'],
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

  test('a CRLF config with commented table headers is carried, not refused', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const source = editConfig(src, (text) =>
      `${text}\n[thinking] # effort\nenabled = true\neffort = "low"\n`
        .replace('[models."kimi-code/k3"]', '[models."kimi-code/k3"] # the default model')
        .replaceAll('\n', '\r\n'),
    );

    const config = readFileSync(assembleHome(src, join(root, 'run-home')).configPath, 'utf-8');

    expect(config).toContain('[models."kimi-code/k3"] # the default model');
    expect(config).toContain('[thinking] # effort');
    const parsedSource = parseToml(source);
    const parsedConfig = parseToml(config);
    expect(parsedConfig['thinking']).toEqual(parsedSource['thinking']);
    expect(parsedConfig['models']).toEqual(parsedSource['models']);
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
    [
      'a duplicate key in a carried table',
      '\n[permission]\ndeny = [{ tool = "Bash", match = "rm *" }]\ndeny = [{ tool = "Bash", match = "curl *" }]\n',
    ],
    [
      'a carried table defined twice',
      '\n[permission]\ndeny = [{ tool = "Bash", match = "rm *" }]\n\n[permission]\nallow = [{ tool = "Read" }]\n',
    ],
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

describe('run-home ownership', () => {
  /** A directory some other tool owns, holding its own config.toml. */
  function foreignHome(root: string): { dir: string; config: string } {
    const dir = join(root, 'site');
    mkdirSync(dir);
    const config = 'baseURL = "https://example.org/"\ntitle = "not kimi"\n';
    writeFileSync(join(dir, 'config.toml'), config);
    return { dir, config };
  }

  test("another tool's directory with a config.toml is refused, untouched", () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const { dir, config } = foreignHome(root);

    expect(() => prepareRunHome(src, dir)).toThrow('has no .bare-kimi-home');
    expect(() => assembleHome(src, dir)).toThrow('has no .bare-kimi-home');
    expect(() => prepareRunHome(src, dir, 'copy')).toThrow('has no .bare-kimi-home');

    expect(readFileSync(join(dir, 'config.toml'), 'utf-8')).toBe(config);
    expect(readdirSync(dir)).toEqual(['config.toml']);
    expect(isAssembledHome(dir)).toBe(false);
  });

  test('a home assembled here is stamped (version 2) with its canonical source, model and effort', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    expect(assembleHome(src, dst).migrated).toBeNull();

    // Exactly these fields: no `adopted` or `migrated` for a home assembled
    // from scratch, and a null effort for one that carries the source's own
    // [thinking].
    expect(JSON.parse(readFileSync(join(dst, HOME_STAMP), 'utf-8'))).toStrictEqual({
      version: 2,
      source: realpathSync(src),
      model: 'kimi-code/k3',
      effort: null,
      config: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(isAssembledHome(dst)).toBe(true);
  });

  test('reuse keeps a config.toml whose settings still agree, comments and all', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    writeFileSync(join(dst, 'config.toml'), '# a note\n', { flag: 'a' });
    const edited = readFileSync(join(dst, 'config.toml'), 'utf-8');

    prepareRunHome(src, dst);
    assembleHome(src, dst);

    expect(readFileSync(join(dst, 'config.toml'), 'utf-8')).toBe(edited);
  });

  test('reuse follows a source whose policy changed: an unedited config.toml is rewritten', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    const stampBefore = readFileSync(join(dst, HOME_STAMP), 'utf-8');
    editConfig(
      src,
      (text) => `${text}\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm *)"\n`,
    );

    prepareRunHome(src, dst);

    const config = readFileSync(join(dst, 'config.toml'), 'utf-8');
    expect(config).toContain('[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm *)"');
    expect(readFileSync(join(dst, HOME_STAMP), 'utf-8')).not.toBe(stampBefore);
    // Stable from then on.
    prepareRunHome(src, dst);
    expect(readFileSync(join(dst, 'config.toml'), 'utf-8')).toBe(config);
  });

  test('an edited config.toml is refused, not run and not overwritten', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    const configPath = join(dst, 'config.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace('max_context_size = 262144', 'max_context_size = 1'));
    const edited = readFileSync(configPath, 'utf-8');
    unlinkSync(join(dst, 'oauth'));

    expect(() => prepareRunHome(src, dst)).toThrow('edited since bare-kimi wrote it');
    expect(() => assembleHome(src, dst)).toThrow('edited since bare-kimi wrote it');
    // Even when the source changed too.
    editConfig(src, (text) => `${text}\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash"\n`);
    expect(() => prepareRunHome(src, dst)).toThrow('edited since bare-kimi wrote it');

    expect(readFileSync(configPath, 'utf-8')).toBe(edited);
    expect(lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a stamped home from another source is refused', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const otherSrc = makeSourceHome(temp('bare-kimi-other-'));
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    const config = readFileSync(join(dst, 'config.toml'), 'utf-8');

    expect(() => prepareRunHome(otherSrc, dst)).toThrow('was assembled from');
    expect(() => assembleHome(otherSrc, dst)).toThrow('was assembled from');
    expect(readFileSync(join(dst, 'config.toml'), 'utf-8')).toBe(config);
    expect(readlinkSync(join(dst, 'credentials'))).toBe(join(src, 'credentials'));
  });

  test('a stamp that does not read as one is refused, not guessed at', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');
    assembleHome(src, dst);
    const { source, config } = JSON.parse(readFileSync(join(dst, HOME_STAMP), 'utf-8'));

    for (const stamp of [
      { version: 2 },
      // A version-2 stamp always pins a model; one without is not ours.
      { version: 2, source, config },
      { version: 2, source, config, model: 'kimi-code/k3', effort: 3 },
      { version: 3, source, config, model: 'kimi-code/k3', effort: null },
      // A `migrated` record that does not read as one this version wrote.
      { version: 2, source, config, model: 'kimi-code/k3', effort: null, migrated: 'config' },
      { version: 2, source, config, model: 'kimi-code/k3', effort: null, migrated: { from: 2, basis: 'config' } },
      { version: 2, source, config, model: 'kimi-code/k3', effort: null, migrated: { from: 1, basis: 'guess' } },
      { version: 2, source, config, model: 'kimi-code/k3', effort: null, migrated: { from: 1 } },
      // An adopted home had no stamp to upgrade.
      { version: 2, source, config, model: 'kimi-code/k3', effort: null, adopted: true, migrated: { from: 1, basis: 'config' } },
    ]) {
      writeFileSync(join(dst, HOME_STAMP), `${JSON.stringify(stamp)}\n`);
      expect(() => prepareRunHome(src, dst)).toThrow('is not a stamp');
      expect(() => isAssembledHome(dst)).toThrow('is not a stamp');
    }
  });
});

describe('sourceHome and an ambient KIMI_CODE_HOME', () => {
  test('the ~/.kimi-code fallback is refused when KIMI_CODE_HOME names another home', () => {
    expect(() => sourceHome(undefined, { HOME: '/h', KIMI_CODE_HOME: '/elsewhere' })).toThrow(
      'KIMI_CODE_HOME is /elsewhere',
    );
    expect(sourceHome(undefined, { HOME: '/h', KIMI_CODE_HOME: '/h/.kimi-code' })).toBe('/h/.kimi-code');
    // An explicit choice is never second-guessed.
    expect(sourceHome('/x', { HOME: '/h', KIMI_CODE_HOME: '/elsewhere' })).toBe('/x');
    expect(
      sourceHome(undefined, { HOME: '/h', KIMI_CODE_HOME: '/elsewhere', KIMI_CODE_HOME_SOURCE: '/y' }),
    ).toBe('/y');
  });
});

/** Whether the temp directory's filesystem ignores case in names. */
const CASE_INSENSITIVE_TMP = (() => {
  const dir = makeTempDir('bare-kimi-case-');
  try {
    return existsSync(join(dirname(dir), basename(dir).toUpperCase()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe('case-insensitive spellings', () => {
  test.skipIf(!CASE_INSENSITIVE_TMP)(
    'a run home under another case of the source home is the same or nested by identity',
    () => {
      const root = temp('bare-kimi-home-');
      const src = makeSourceHome(root);
      const shouted = join(root, 'SRC-HOME');

      expect(() => assembleHome(src, shouted)).toThrow('same directory');
      expect(() => assembleHome(src, join(shouted, 'run'))).toThrow('nested');
      expect(existsSync(join(src, 'run'))).toBe(false);
      expect(existsSync(join(src, HOME_STAMP))).toBe(false);
    },
  );
});

describe('TOML parser advisories (isolated child under a deadline)', () => {
  // Each case runs assembleHome in a child that is killed at the deadline, so
  // a parser with the defect fails the test instead of hanging the runner.
  const DEADLINE_MS = 15_000;

  test(
    'a comment-terminated inline table at end of file is refused, not looped on',
    async () => {
      const root = temp('bare-kimi-home-');
      const src = makeSourceHome(root);
      // No newline after the comment, and no ',' or '}' earlier in the file:
      // the shape that sent smol-toml <= 1.7.0 into an endless rescan.
      editConfig(src, (text) => `${text}\n[advisory]\nx = {a = 1 #`);
      const dst = join(root, 'run-home');

      const run = await runWithDeadline([process.execPath, ASSEMBLE_CHILD, src, dst], DEADLINE_MS);

      expect(run.timedOut).toBe(false);
      expect(JSON.parse(run.stdout)).toEqual({ ok: false, error: expect.stringContaining('does not parse as TOML') });
      expect(existsSync(dst)).toBe(false);
    },
    DEADLINE_MS * 2,
  );

  test(
    'many plain keys parse in bounded time',
    async () => {
      const root = temp('bare-kimi-home-');
      const src = makeSourceHome(root);
      // 300k dot-free keys: smol-toml <= 1.8.0 rescanned to the end of the
      // document for every key, which is quadratic (minutes here).
      const keys = Array.from({ length: 300_000 }, (_, index) => `k${index} = ${index}`).join('\n');
      editConfig(src, (text) => `${text}\n[bulk]\n${keys}\n`);
      const dst = join(root, 'run-home');

      const run = await runWithDeadline([process.execPath, ASSEMBLE_CHILD, src, dst], DEADLINE_MS);

      expect(run.timedOut).toBe(false);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
      expect(readFileSync(join(dst, 'config.toml'), 'utf-8')).not.toContain('[bulk]');
    },
    DEADLINE_MS * 2,
  );
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

/** The home's stamp, parsed. */
function readStampJson(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, HOME_STAMP), 'utf-8'));
}

/**
 * Rewrite a home's stamp in bare-kimi 0.2's shape: version 1, the source and
 * a settings digest, no model or effort. By default the digest is the one
 * this candidate computed. These tests do not show that 0.2 computes the same
 * one. That rests on a separate exercise outside this suite: a home assembled
 * by the unchanged 0.2 implementation was reused with this candidate, the
 * same digest was found, and the config bytes were held. Pass `config` to
 * stamp a digest this candidate did not compute, as from a 0.2 whose digest
 * disagrees.
 */
function downgradeStampToV1(home: string, config?: string): string {
  const stamp = readStampJson(home);
  const text = `${JSON.stringify({ version: 1, source: stamp['source'], config: config ?? stamp['config'] })}\n`;
  writeFileSync(join(home, HOME_STAMP), text);
  return text;
}

/** Give a home a session journal, as a run would leave one. */
function addSession(home: string): void {
  const wire = join(home, 'sessions', 'wd_kept_000000000000', 'session_kept', 'agents', 'main', 'wire.jsonl');
  mkdirSync(dirname(wire), { recursive: true });
  writeFileSync(wire, '{"type":"metadata","protocol_version":"1.5"}\n');
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Insert a `[thinking]` table right after the source's root default_model line. */
function withSourceThinking(src: string, body: string): void {
  editConfig(src, (text) =>
    text.replace('default_model = "kimi-code/k3"\n', `default_model = "kimi-code/k3"\n\n[thinking]\n${body}`),
  );
}

function setSourceDefault(src: string, alias: string): void {
  editConfig(src, (text) => text.replace('default_model = "kimi-code/k3"\n', `default_model = "${alias}"\n`));
}

describe('model selection', () => {
  test('a selected model carries only itself and its provider; other providers and their keys stay behind', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);

    const selected = prepareRunHome(src, join(root, 'reasoner'), 'link', { model: 'other/reasoner' });

    expect(selected).toMatchObject({
      modelAlias: 'other/reasoner',
      provider: 'other',
      providerType: 'openai',
      modelId: 'reasoner-1',
      effort: null,
      configuredEffort: null,
      action: 'create',
      adopted: false,
    });
    const text = readFileSync(selected.configPath, 'utf-8');
    const config = parseToml(text);
    expect(config['default_model']).toBe('other/reasoner');
    expect(Object.keys(config['models'] as object)).toEqual(['other/reasoner']);
    expect(Object.keys(config['providers'] as object)).toEqual(['other']);
    // Its overrides belong to the model and travel with it.
    expect(text).toContain('[models."other/reasoner".overrides]');
    expect(text).not.toContain('oauth_host');

    const byDefault = prepareRunHome(src, join(root, 'default'));
    expect(byDefault.modelAlias).toBe('kimi-code/k3');
    const defaultText = readFileSync(byDefault.configPath, 'utf-8');
    expect(defaultText).not.toContain(OTHER_PROVIDER_KEY);
    expect(Object.keys(parseToml(defaultText)['models'] as object)).toEqual(['kimi-code/k3']);
  });

  test('an alias the source does not configure is refused before any effect', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    rmSync(join(src, 'oauth'), { recursive: true });
    const dst = join(root, 'run-home');

    expect(() => previewRunHome(src, dst, 'link', { model: 'kimi-code/k9' })).toThrow(
      'model "kimi-code/k9" is not configured',
    );
    expect(() => prepareRunHome(src, dst, 'link', { model: 'kimi-code/k9' })).toThrow(
      'model "kimi-code/k9" is not configured',
    );
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(join(src, 'oauth'))).toBe(false);
  });

  test('a kept home stays on its alias when the source default changes; a new home takes the new default', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    const config = readFileSync(join(kept, 'config.toml'), 'utf-8');
    const stamp = readFileSync(join(kept, HOME_STAMP), 'utf-8');
    setSourceDefault(src, 'kimi-code/k3-thinking');

    const reused = prepareRunHome(src, kept);

    expect(reused).toMatchObject({ action: 'reuse', modelAlias: 'kimi-code/k3' });
    // Nothing the home carries changed, so nothing is rewritten.
    expect(readFileSync(join(kept, 'config.toml'), 'utf-8')).toBe(config);
    expect(readFileSync(join(kept, HOME_STAMP), 'utf-8')).toBe(stamp);
    expect(prepareRunHome(src, join(root, 'fresh')).modelAlias).toBe('kimi-code/k3-thinking');
  });

  test('a kept home refuses another alias, changing nothing; its own alias is accepted', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    unlinkSync(join(kept, 'oauth'));
    const config = readFileSync(join(kept, 'config.toml'), 'utf-8');
    const stamp = readFileSync(join(kept, HOME_STAMP), 'utf-8');
    const other = { model: 'other/reasoner' };

    expect(() => previewRunHome(src, kept, 'link', other)).toThrow('pinned to model "kimi-code/k3"');
    expect(() => prepareRunHome(src, kept, 'link', other)).toThrow('pinned to model "kimi-code/k3"');
    expect(() => assembleHome(src, kept, 'link', other)).toThrow('pinned to model "kimi-code/k3"');

    expect(readFileSync(join(kept, 'config.toml'), 'utf-8')).toBe(config);
    expect(readFileSync(join(kept, HOME_STAMP), 'utf-8')).toBe(stamp);
    expect(lstatSync(join(kept, 'oauth'), { throwIfNoEntry: false })).toBeUndefined();

    expect(prepareRunHome(src, kept, 'link', { model: 'kimi-code/k3' }).action).toBe('reuse');
    expect(readlinkSync(join(kept, 'oauth'))).toBe(join(src, 'oauth'));
  });

  test('a kept home whose alias the source no longer configures is refused rather than switched', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept, 'link', { model: 'kimi-code/k3-thinking' });
    const config = readFileSync(join(kept, 'config.toml'), 'utf-8');
    editConfig(src, (text) => text.replace('[models."kimi-code/k3-thinking"]', '[models."kimi-code/k3-renamed"]'));

    expect(() => prepareRunHome(src, kept)).toThrow('no longer configures');
    expect(readFileSync(join(kept, 'config.toml'), 'utf-8')).toBe(config);
  });
});

describe('effort selection', () => {
  test('a listed effort is written into [thinking] and pinned in the stamp', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const dst = join(root, 'run-home');

    const assembled = prepareRunHome(src, dst, 'link', { model: 'kimi-code/k3-thinking', effort: 'high' });

    expect(assembled).toMatchObject({ modelAlias: 'kimi-code/k3-thinking', effort: 'high', configuredEffort: 'high' });
    const text = readFileSync(assembled.configPath, 'utf-8');
    expect(text).toContain('[thinking]\nenabled = true\neffort = "high"');
    expect(parseToml(text)['thinking']).toEqual({ enabled: true, effort: 'high' });
    expect(readStampJson(dst)).toMatchObject({ version: 2, model: 'kimi-code/k3-thinking', effort: 'high' });
  });

  test('off disables thinking, and is refused for a model that always thinks', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);

    const off = prepareRunHome(src, join(root, 'off'), 'link', { model: 'kimi-code/k3-thinking', effort: 'off' });
    expect(off).toMatchObject({ effort: 'off', configuredEffort: 'off' });
    expect(parseToml(readFileSync(off.configPath, 'utf-8'))['thinking']).toEqual({ enabled: false });

    const always = join(root, 'always');
    expect(() => prepareRunHome(src, always, 'link', { model: 'kimi-code/k3-always', effort: 'off' })).toThrow(
      'always thinks',
    );
    expect(existsSync(always)).toBe(false);
    expect(prepareRunHome(src, always, 'link', { model: 'kimi-code/k3-always', effort: 'high' }).configuredEffort).toBe(
      'high',
    );
  });

  test("an override's support_efforts replace the model's own list", () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const low = join(root, 'low');

    expect(prepareRunHome(src, join(root, 'max'), 'link', { model: 'other/reasoner', effort: 'max' }).effort).toBe('max');
    // `low` is in the model's own list, not in its override's.
    expect(() => prepareRunHome(src, low, 'link', { model: 'other/reasoner', effort: 'low' })).toThrow(
      'support_efforts (minimal, high, max)',
    );
    expect(existsSync(low)).toBe(false);
  });

  test.each([
    ['an effort the model does not list', 'max', 'is not one of model "kimi-code/k3-thinking"'],
    ['an effort that is not a lowercase name', 'High', 'not a lowercase effort name'],
    ['an effort with surrounding space', ' high', 'not a lowercase effort name'],
  ])('refuses %s before any effect', (_label, effort, message) => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    rmSync(join(src, 'oauth'), { recursive: true });
    const dst = join(root, 'run-home');

    expect(() => prepareRunHome(src, dst, 'link', { model: 'kimi-code/k3-thinking', effort })).toThrow(message);
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(join(src, 'oauth'))).toBe(false);
  });

  test('[thinking] beside a selected effort: keep is carried; forced_effort and non-scalar keys are refused', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const configPath = join(src, 'config.toml');
    const original = readFileSync(configPath, 'utf-8');
    const selection = { model: 'kimi-code/k3-thinking', effort: 'high' };
    const sourceThinking = (body: string): void => {
      writeFileSync(configPath, original);
      withSourceThinking(src, body);
    };

    sourceThinking('enabled = true\neffort = "low"\nkeep = "all"\n');
    const kept = prepareRunHome(src, join(root, 'keep'), 'link', selection);
    expect(parseToml(readFileSync(kept.configPath, 'utf-8'))['thinking']).toEqual({
      enabled: true,
      effort: 'high',
      keep: 'all',
    });

    sourceThinking('forced_effort = "max"\n');
    expect(() => prepareRunHome(src, join(root, 'forced'), 'link', selection)).toThrow(
      'would override the selected effort',
    );
    sourceThinking('budget = 1024\n');
    expect(() => prepareRunHome(src, join(root, 'budget'), 'link', selection)).toThrow(
      'cannot be carried beside a selected effort',
    );
    expect(existsSync(join(root, 'forced'))).toBe(false);
    expect(existsSync(join(root, 'budget'))).toBe(false);
  });

  test("a kept home keeps its pinned effort while the source's [thinking] changes, and refuses another", () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept, 'link', { model: 'kimi-code/k3-thinking', effort: 'high' });
    withSourceThinking(src, 'enabled = true\neffort = "low"\nkeep = "all"\n');

    const reused = prepareRunHome(src, kept);

    expect(reused).toMatchObject({
      action: 'reuse',
      modelAlias: 'kimi-code/k3-thinking',
      effort: 'high',
      configuredEffort: 'high',
    });
    // The source's other [thinking] keys follow it; its effort does not.
    const configPath = join(kept, 'config.toml');
    expect(parseToml(readFileSync(configPath, 'utf-8'))['thinking']).toEqual({ enabled: true, effort: 'high', keep: 'all' });
    const config = readFileSync(configPath, 'utf-8');
    expect(() => prepareRunHome(src, kept, 'link', { effort: 'low' })).toThrow('pinned to effort "high"');
    expect(() => prepareRunHome(src, kept, 'link', { effort: 'off' })).toThrow('pinned to effort "high"');
    expect(readFileSync(configPath, 'utf-8')).toBe(config);
    expect(prepareRunHome(src, kept, 'link', { effort: 'high' }).action).toBe('reuse');
  });

  test("a home made without an effort gives new sessions the source's [thinking], and refuses any explicit effort", () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    withSourceThinking(src, 'enabled = true\neffort = "low"\n');
    const kept = join(root, 'kept');

    expect(prepareRunHome(src, kept)).toMatchObject({ effort: null, configuredEffort: 'low' });
    editConfig(src, (text) => text.replace('effort = "low"', 'effort = "high"'));

    // What config.toml gives a NEW session moved with the source; the pin did
    // not. Sessions created earlier keep "low" (see src/index.test.ts).
    expect(prepareRunHome(src, kept)).toMatchObject({ action: 'reuse', effort: null, configuredEffort: 'high' });
    expect(readStampJson(kept)['effort']).toBeNull();
    // Even the effort config.toml now names: earlier sessions were created with another.
    expect(() => prepareRunHome(src, kept, 'link', { effort: 'high' })).toThrow("pinned to the source's [thinking]");
  });
});

/**
 * Model declarations that kimi 2.1.0 itself writes or accepts, with only part
 * of the thinking metadata. Evidence, from the installed 2.1.0 bundle
 * (bounded excerpts):
 * - custom-registry models are written with `capabilities` derived from
 *   `reasoning` or a non-empty `support_efforts` (capabilitiesFromCustomEntry),
 *   and with `supportEfforts: model.support_efforts`, which may be absent;
 * - "Non-Kimi providers receive effort strings without client-side mapping"
 *   (appendThinkingEffortConfigHint); strict thinking validation depends on
 *   the provider type (requiresStrictThinkingValidation);
 * - a managed model's efforts come from the provider's /models catalog
 *   (parseThinkEfforts), which bare-kimi does not read.
 * What the declaration excludes is refused; what it leaves open is taken and
 * reported as `undeclared`, never refused as if unsupported.
 */
describe('effort selection: partial model declarations', () => {
  function registrySource(root: string, declaration: string): string {
    const src = makeSourceHome(root);
    editConfig(
      src,
      (text) => `${text}
[providers."registry"]
type = "openai"
base_url = "https://registry.example/v1"
api_key = ""

[models."registry/reasoner"]
provider = "registry"
model = "reasoner"
max_context_size = 131072
${declaration}
`,
    );
    return src;
  }

  test('an openai-type model declaring thinking without support_efforts takes a selected effort, reported undeclared', () => {
    // As native writes a registry model with `reasoning: true` and no efforts.
    const root = temp('bare-kimi-home-');
    const src = registrySource(root, 'capabilities = ["thinking"]');
    const dst = join(root, 'run-home');

    const assembled = prepareRunHome(src, dst, 'link', { model: 'registry/reasoner', effort: 'high' });

    expect(assembled).toMatchObject({ effort: 'high', configuredEffort: 'high', effortSupport: 'undeclared' });
    expect(parseToml(readFileSync(assembled.configPath, 'utf-8'))['thinking']).toEqual({ enabled: true, effort: 'high' });
    expect(readStampJson(dst)).toMatchObject({ model: 'registry/reasoner', effort: 'high' });
  });

  test('an openai-type model listing support_efforts without capabilities takes a listed effort and refuses another', () => {
    // Native derives the thinking capability from a non-empty support_efforts.
    const root = temp('bare-kimi-home-');
    const src = registrySource(root, 'support_efforts = ["low", "high"]');
    const max = join(root, 'max');

    const assembled = prepareRunHome(src, join(root, 'run-home'), 'link', { model: 'registry/reasoner', effort: 'high' });

    expect(assembled).toMatchObject({ configuredEffort: 'high', effortSupport: 'declared' });
    expect(() => prepareRunHome(src, max, 'link', { model: 'registry/reasoner', effort: 'max' })).toThrow(
      'support_efforts (low, high)',
    );
    expect(existsSync(max)).toBe(false);
  });

  test('a model declared without thinking refuses an effort before any effect, but takes off', () => {
    // As native writes a registry model whose rich fields omit reasoning and efforts.
    const root = temp('bare-kimi-home-');
    const src = registrySource(root, 'capabilities = ["tool_use", "image_in"]');
    const dst = join(root, 'run-home');

    expect(() => prepareRunHome(src, dst, 'link', { model: 'registry/reasoner', effort: 'high' })).toThrow(
      'declared without thinking',
    );
    expect(existsSync(dst)).toBe(false);
    expect(prepareRunHome(src, dst, 'link', { model: 'registry/reasoner', effort: 'off' })).toMatchObject({
      effort: 'off',
      effortSupport: 'declared',
    });
  });

  test('an openai-type model declaring nothing about thinking takes an effort, reported undeclared', () => {
    const root = temp('bare-kimi-home-');
    const src = registrySource(root, '');

    expect(
      prepareRunHome(src, join(root, 'run-home'), 'link', { model: 'registry/reasoner', effort: 'max' }),
    ).toMatchObject({ effort: 'max', effortSupport: 'undeclared' });
  });

  test('the managed default model, declared without capabilities or support_efforts, takes an effort, reported undeclared', () => {
    // Its efforts are the provider catalog's, which bare-kimi does not read
    // (no network or login reads): neither refused nor claimed as checked.
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const dst = join(root, 'run-home');

    const assembled = prepareRunHome(src, dst, 'link', { effort: 'high' });

    expect(assembled).toMatchObject({
      modelAlias: 'kimi-code/k3',
      providerType: 'kimi',
      effort: 'high',
      configuredEffort: 'high',
      effortSupport: 'undeclared',
    });
    expect(readStampJson(dst)).toMatchObject({ model: 'kimi-code/k3', effort: 'high' });
    expect(prepareRunHome(src, join(root, 'off'), 'link', { effort: 'off' }).effortSupport).toBe('undeclared');
    // Still a lowercase effort name, like any other.
    expect(() => prepareRunHome(src, join(root, 'bad'), 'link', { effort: 'High' })).toThrow('lowercase effort name');
  });

  test('a fully declared model reports its effort as declared; no effort reports none', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);

    expect(
      prepareRunHome(src, join(root, 'high'), 'link', { model: 'kimi-code/k3-thinking', effort: 'high' }).effortSupport,
    ).toBe('declared');
    expect(prepareRunHome(src, join(root, 'none'), 'link', { model: 'kimi-code/k3-thinking' }).effortSupport).toBeNull();
  });
});

describe('version-1 stamps (bare-kimi 0.2)', () => {
  test('an unchanged 0.2 home is reused on its alias; its stamp is upgraded, its config.toml kept byte for byte', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    const digest = readStampJson(kept)['config'];
    downgradeStampToV1(kept);
    const config = readFileSync(join(kept, 'config.toml'), 'utf-8');
    expect(isAssembledHome(kept)).toBe(true);
    expect(runSourceHome(kept, undefined, {})).toBe(realpathSync(src));

    const reused = prepareRunHome(src, kept);

    expect(reused).toMatchObject({
      action: 'reuse',
      modelAlias: 'kimi-code/k3',
      effort: null,
      adopted: false,
      migrated: { from: 1, basis: 'config' },
    });
    expect(readFileSync(join(kept, 'config.toml'), 'utf-8')).toBe(config);
    expect(readStampJson(kept)).toStrictEqual({
      version: 2,
      source: realpathSync(src),
      model: 'kimi-code/k3',
      effort: null,
      config: digest,
      migrated: { from: 1, basis: 'config' },
    });
  });

  test('a 0.2 home stays on the alias its config.toml holds when the source default changed', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    downgradeStampToV1(kept);
    setSourceDefault(src, 'kimi-code/k3-thinking');

    expect(prepareRunHome(src, kept).modelAlias).toBe('kimi-code/k3');

    expect(parseToml(readFileSync(join(kept, 'config.toml'), 'utf-8'))['default_model']).toBe('kimi-code/k3');
    expect(readStampJson(kept)).toMatchObject({
      version: 2,
      model: 'kimi-code/k3',
      effort: null,
      migrated: { from: 1, basis: 'config' },
    });
  });

  test('the basis survives later rewrites of config.toml and the stamp, and preview reports it', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    addSession(kept);
    downgradeStampToV1(kept);
    rmSync(join(kept, 'config.toml'));
    // No alias reproduces the stamp's digest: the caller names it.
    editConfig(src, (text) => `${text}\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm *)"\n`);
    expect(prepareRunHome(src, kept, 'link', { model: 'kimi-code/k3' }).migrated).toEqual({ from: 1, basis: 'caller' });
    const upgraded = readStampJson(kept);

    // The source changes again: config.toml and the stamp's digest are rewritten, the basis is kept.
    editConfig(src, (text) => text.replace('pattern = "Bash(rm *)"', 'pattern = "Bash(curl *)"'));
    expect(previewRunHome(src, kept).migrated).toEqual({ from: 1, basis: 'caller' });
    expect(prepareRunHome(src, kept)).toMatchObject({ modelAlias: 'kimi-code/k3', migrated: { from: 1, basis: 'caller' } });
    const rewritten = readStampJson(kept);
    expect(rewritten['config']).not.toBe(upgraded['config']);
    expect(rewritten).toMatchObject({ version: 2, model: 'kimi-code/k3', migrated: { from: 1, basis: 'caller' } });
    expect(readFileSync(join(kept, 'config.toml'), 'utf-8')).toContain('pattern = "Bash(curl *)"');
  });

  test('a 0.2 home refuses another alias, an effort, and a source that dropped its alias; its stamp stays version 1', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    const v1 = downgradeStampToV1(kept);

    expect(() => prepareRunHome(src, kept, 'link', { model: 'kimi-code/k3-thinking' })).toThrow(
      'pinned to model "kimi-code/k3"',
    );
    expect(() => prepareRunHome(src, kept, 'link', { effort: 'off' })).toThrow("pinned to the source's [thinking]");
    setSourceDefault(src, 'kimi-code/k3-thinking');
    editConfig(src, (text) => text.replace('[models."kimi-code/k3"]', '[models."kimi-code/k3-retired"]'));
    expect(() => prepareRunHome(src, kept)).toThrow('no longer configures');

    expect(readFileSync(join(kept, HOME_STAMP), 'utf-8')).toBe(v1);
  });

  test('a 0.2 home whose config.toml was edited is refused, as a version-2 home is', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    const v1 = downgradeStampToV1(kept);
    const configPath = join(kept, 'config.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace('max_context_size = 262144', 'max_context_size = 1'));

    expect(() => prepareRunHome(src, kept)).toThrow('edited since bare-kimi wrote it');
    expect(readFileSync(join(kept, HOME_STAMP), 'utf-8')).toBe(v1);
  });

  test('a 0.2 digest that disagrees with this one fails safe: kept while the source agrees, refused rather than switched', () => {
    // Independent of whether 0.2 and this candidate compute the same digest.
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    const config = readFileSync(join(kept, 'config.toml'), 'utf-8');
    downgradeStampToV1(kept, 'f'.repeat(64));

    // The pin is the source's default, which the file agrees with; the stamp proves nothing here.
    expect(previewRunHome(src, kept)).toMatchObject({
      action: 'reuse',
      modelAlias: 'kimi-code/k3',
      migrated: { from: 1, basis: 'source-default' },
    });
    setSourceDefault(src, 'kimi-code/k3-thinking');
    expect(() => prepareRunHome(src, kept)).toThrow('edited since bare-kimi wrote it');
    expect(readFileSync(join(kept, 'config.toml'), 'utf-8')).toBe(config);
    expect(readStampJson(kept)).toMatchObject({ version: 1 });
  });

  test('a 0.2 home without config.toml stays on the alias its stamp proves, even after the source default changed', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    addSession(kept);
    downgradeStampToV1(kept);
    rmSync(join(kept, 'config.toml'));
    setSourceDefault(src, 'kimi-code/k3-thinking');

    const reused = prepareRunHome(src, kept);

    // The stamp's digest covers the default_model 0.2 wrote; only k3's config reproduces it.
    expect(reused).toMatchObject({
      action: 'reuse',
      modelAlias: 'kimi-code/k3',
      effort: null,
      migrated: { from: 1, basis: 'digest' },
    });
    expect(parseToml(readFileSync(join(kept, 'config.toml'), 'utf-8'))['default_model']).toBe('kimi-code/k3');
    expect(readStampJson(kept)).toMatchObject({
      version: 2,
      model: 'kimi-code/k3',
      effort: null,
      migrated: { from: 1, basis: 'digest' },
    });
  });

  test('a 0.2 home without config.toml whose alias cannot be proven: refused with sessions unless named; followed without', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const withSessions = join(root, 'with-sessions');
    const withoutSessions = join(root, 'without-sessions');
    for (const home of [withSessions, withoutSessions]) prepareRunHome(src, home);
    addSession(withSessions);
    const v1 = downgradeStampToV1(withSessions);
    downgradeStampToV1(withoutSessions);
    rmSync(join(withSessions, 'config.toml'));
    rmSync(join(withoutSessions, 'config.toml'));
    // A carried table changed since: no alias reproduces the stamp's digest.
    editConfig(src, (text) => `${text}\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm *)"\n`);
    setSourceDefault(src, 'kimi-code/k3-thinking');

    expect(() => prepareRunHome(src, withSessions)).toThrow('the model alias the home last configured is unknown');
    expect(existsSync(join(withSessions, 'config.toml'))).toBe(false);
    expect(readFileSync(join(withSessions, HOME_STAMP), 'utf-8')).toBe(v1);
    // The caller's name is recorded as the caller's, not as proof.
    expect(prepareRunHome(src, withSessions, 'link', { model: 'kimi-code/k3' })).toMatchObject({
      action: 'reuse',
      modelAlias: 'kimi-code/k3',
      migrated: { from: 1, basis: 'caller' },
    });
    expect(readStampJson(withSessions)).toMatchObject({
      version: 2,
      model: 'kimi-code/k3',
      migrated: { from: 1, basis: 'caller' },
    });

    // No session is bound to any alias: the home follows the source's default.
    expect(prepareRunHome(src, withoutSessions)).toMatchObject({
      modelAlias: 'kimi-code/k3-thinking',
      migrated: { from: 1, basis: 'source-default' },
    });
    expect(readStampJson(withoutSessions)).toMatchObject({
      model: 'kimi-code/k3-thinking',
      migrated: { from: 1, basis: 'source-default' },
    });
  });
});

describe('source-home identity', () => {
  test('a kept home names its own source; an explicit or environment source still wins', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);

    expect(runSourceHome(kept, undefined, { HOME: '/nonexistent-home' })).toBe(realpathSync(src));
    expect(runSourceHome(kept, '/explicit', {})).toBe('/explicit');
    expect(runSourceHome(kept, undefined, { KIMI_CODE_HOME_SOURCE: '/from-env' })).toBe('/from-env');
    // A missing (or unstamped) home names none: the ~/.kimi-code fallback, with its refusal.
    const missing = join(root, 'missing');
    expect(runSourceHome(missing, undefined, { HOME: '/h' })).toBe('/h/.kimi-code');
    expect(() => runSourceHome(missing, undefined, { HOME: '/h', KIMI_CODE_HOME: '/elsewhere' })).toThrow(
      'KIMI_CODE_HOME is /elsewhere',
    );
  });

  test('the same source through a symlink is the same source; an identical copy elsewhere is not', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const kept = join(root, 'kept');
    prepareRunHome(src, kept);
    const alias = join(root, 'src-alias');
    symlinkSync(src, alias, 'dir');

    expect(prepareRunHome(alias, kept)).toMatchObject({ action: 'reuse', source: realpathSync(src) });
    expect(readlinkSync(join(kept, 'credentials'))).toBe(join(src, 'credentials'));

    const twin = makeSourceHome(temp('bare-kimi-other-'));
    expect(() => prepareRunHome(twin, kept)).toThrow(`was assembled from ${realpathSync(src)}`);
  });
});

/** The legacy session journal, relative to `sessions/`. */
const LEGACY_SESSION = 'wd_legacy_000000000000/session_legacy/agents/main/wire.jsonl';

/** A home as bare-kimi kept it before 0.2: what the assembler writes, a session, and no stamp. */
function legacyHome(src: string, home: string, options: RunHomeOptions = {}): void {
  prepareRunHome(src, home, 'link', options);
  rmSync(join(home, HOME_STAMP));
  const wire = join(home, 'sessions', LEGACY_SESSION);
  mkdirSync(dirname(wire), { recursive: true });
  writeFileSync(wire, '{"type":"metadata","protocol_version":"1.5"}\n');
}

describe('adopting a home kept before 0.2', () => {
  test('refused unless asked; adopted with its evidence and sessions untouched, then reused like any stamped home', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = join(root, 'legacy');
    legacyHome(src, home);
    const preimage = readFileSync(join(home, 'config.toml'));
    const wire = readFileSync(join(home, 'sessions', LEGACY_SESSION));
    editConfig(src, (text) => `${text}\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm *)"\n`);

    expect(() => prepareRunHome(src, home)).toThrow('adoptLegacyHome');
    expect(previewRunHome(src, home, 'link', { adoptLegacyHome: true })).toMatchObject({
      action: 'adopt',
      adopted: true,
      modelAlias: 'kimi-code/k3',
    });
    expect(existsSync(join(home, HOME_STAMP))).toBe(false);
    expect(existsSync(join(home, ADOPTION_RECORD))).toBe(false);

    const adopted = prepareRunHome(src, home, 'link', { adoptLegacyHome: true });

    expect(adopted).toMatchObject({ action: 'adopt', adopted: true, modelAlias: 'kimi-code/k3', effort: null, migrated: null });
    expect(readFileSync(join(home, ADOPTION_RECORD, 'config.toml'))).toEqual(preimage);
    const manifest = JSON.parse(readFileSync(join(home, ADOPTION_RECORD, 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      version: 1,
      source: realpathSync(src),
      model: 'kimi-code/k3',
      configuredEffort: null,
      config: { sha256: sha256Hex(preimage) },
      credentials: 'link',
      oauth: 'link',
    });
    // The record claims no effort for the sessions themselves.
    expect(manifest).not.toHaveProperty('effort');
    expect(manifest.sessions).toEqual({ [LEGACY_SESSION]: `sha256:${sha256Hex(wire)}` });
    expect(readStampJson(home)).toStrictEqual({
      version: 2,
      source: realpathSync(src),
      model: 'kimi-code/k3',
      effort: null,
      config: expect.stringMatching(/^[0-9a-f]{64}$/),
      adopted: true,
    });
    // config.toml now follows the source, so its newer policy applies.
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toContain('pattern = "Bash(rm *)"');
    expect(readFileSync(join(home, 'sessions', LEGACY_SESSION))).toEqual(wire);
    expect(readlinkSync(join(home, 'credentials'))).toBe(join(src, 'credentials'));

    expect(prepareRunHome(src, home)).toMatchObject({ action: 'reuse', adopted: true });
  });

  test("the home's own [thinking], unlike the source's, names the effort it configures for new sessions and is pinned to", () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    addSelectableModels(src);
    const home = join(root, 'legacy');
    legacyHome(src, home, { model: 'kimi-code/k3-thinking', effort: 'low' });

    expect(() => prepareRunHome(src, home, 'link', { adoptLegacyHome: true, effort: 'high' })).toThrow(
      'its config.toml configures effort "low" for new sessions',
    );
    expect(() => prepareRunHome(src, home, 'link', { adoptLegacyHome: true, model: 'kimi-code/k3' })).toThrow(
      'its config.toml names model "kimi-code/k3-thinking" for new sessions',
    );
    expect(existsSync(join(home, HOME_STAMP))).toBe(false);

    expect(prepareRunHome(src, home, 'link', { adoptLegacyHome: true })).toMatchObject({
      modelAlias: 'kimi-code/k3-thinking',
      effort: 'low',
      configuredEffort: 'low',
    });
    expect(readStampJson(home)).toMatchObject({ model: 'kimi-code/k3-thinking', effort: 'low', adopted: true });
    expect(JSON.parse(readFileSync(join(home, ADOPTION_RECORD, 'manifest.json'), 'utf-8'))['configuredEffort']).toBe(
      'low',
    );
    expect(() => prepareRunHome(src, home, 'link', { effort: 'high' })).toThrow('pinned to effort "low"');
  });

  test("a home on the managed default with its own effort is adopted; the pin is reported undeclared, not checked", () => {
    // The managed default declares no efforts (its catalog does), so nothing
    // offline shows what kimi ran its sessions at; adoption does not refuse it
    // and does not claim it either.
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = join(root, 'legacy');
    legacyHome(src, home, { effort: 'high' });
    const wire = readFileSync(join(home, 'sessions', LEGACY_SESSION));

    const adopted = prepareRunHome(src, home, 'link', { adoptLegacyHome: true });

    expect(adopted).toMatchObject({
      action: 'adopt',
      modelAlias: 'kimi-code/k3',
      effort: 'high',
      effortSupport: 'undeclared',
      configuredEffort: 'high',
    });
    expect(JSON.parse(readFileSync(join(home, ADOPTION_RECORD, 'manifest.json'), 'utf-8'))).toMatchObject({
      model: 'kimi-code/k3',
      configuredEffort: 'high',
    });
    expect(readFileSync(join(home, 'sessions', LEGACY_SESSION))).toEqual(wire);
  });

  test.each<[string, (home: string, root: string) => void, string]>([
    [
      'credentials linked into another source',
      (home, root) => {
        const other = makeSourceHome(join(root, 'other'));
        unlinkSync(join(home, 'credentials'));
        symlinkSync(join(other, 'credentials'), join(home, 'credentials'), 'dir');
      },
      'its credentials link points at',
    ],
    [
      "a provider table unlike the source's",
      (home) => {
        const configPath = join(home, 'config.toml');
        writeFileSync(
          configPath,
          readFileSync(configPath, 'utf-8').replace('https://api.kimi.ai/coding/v1', 'https://elsewhere.example/v1'),
        );
      },
      'differs from the one in',
    ],
    [
      'a model the source does not configure',
      (home) => {
        const configPath = join(home, 'config.toml');
        writeFileSync(configPath, readFileSync(configPath, 'utf-8').replaceAll('kimi-code/k3', 'kimi-code/k2'));
      },
      'does not configure',
    ],
    [
      'a sessions entry that is not a directory',
      (home) => {
        rmSync(join(home, 'sessions'), { recursive: true });
        writeFileSync(join(home, 'sessions'), 'not a directory\n');
      },
      'its sessions entry is not a directory',
    ],
    [
      'an adoption record that does not record its config.toml',
      (home) => {
        mkdirSync(join(home, ADOPTION_RECORD));
        writeFileSync(join(home, ADOPTION_RECORD, 'config.toml'), 'default_model = "other"\n');
      },
      "does not record this home's config.toml",
    ],
  ])('refuses to adopt a home with %s, leaving it as found', (_label, shape, message) => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = join(root, 'legacy');
    legacyHome(src, home);
    shape(home, root);
    const entries = readdirSync(home).sort();
    const config = readFileSync(join(home, 'config.toml'), 'utf-8');

    expect(() => prepareRunHome(src, home, 'link', { adoptLegacyHome: true })).toThrow(message);
    expect(readdirSync(home).sort()).toEqual(entries);
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toBe(config);
  });

  test('a home named through a symlink is refused; the directory itself is adopted', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = join(root, 'legacy');
    legacyHome(src, home);
    const alias = join(root, 'legacy-alias');
    symlinkSync(home, alias, 'dir');

    expect(() => prepareRunHome(src, alias, 'link', { adoptLegacyHome: true })).toThrow('the run-home path is a symlink');
    expect(existsSync(join(home, HOME_STAMP))).toBe(false);
    expect(prepareRunHome(src, home, 'link', { adoptLegacyHome: true }).action).toBe('adopt');
  });

  test('a home without credentials is adopted in copy mode only, and given a marked copy', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = join(root, 'legacy');
    legacyHome(src, home);
    unlinkSync(join(home, 'credentials'));
    unlinkSync(join(home, 'oauth'));

    expect(() => prepareRunHome(src, home, 'link', { adoptLegacyHome: true })).toThrow('only a copy-mode home');
    expect(existsSync(join(home, HOME_STAMP))).toBe(false);

    expect(prepareRunHome(src, home, 'copy', { adoptLegacyHome: true }).action).toBe('adopt');
    expect(JSON.parse(readFileSync(join(home, ADOPTION_RECORD, 'manifest.json'), 'utf-8'))).toMatchObject({
      credentials: 'absent',
      oauth: 'absent',
    });
    expect(existsSync(join(home, 'credentials', CREDENTIALS_MARKER))).toBe(true);
  });

  test('an interrupted adoption is completed by the next one; its record is kept, not rewritten', () => {
    const root = temp('bare-kimi-home-');
    const src = makeSourceHome(root);
    const home = join(root, 'legacy');
    legacyHome(src, home);
    prepareRunHome(src, home, 'link', { adoptLegacyHome: true });
    const manifestPath = join(home, ADOPTION_RECORD, 'manifest.json');
    const manifest = readFileSync(manifestPath, 'utf-8');
    // As if interrupted after the record was renamed into place, before the stamp.
    rmSync(join(home, HOME_STAMP));

    expect(prepareRunHome(src, home, 'link', { adoptLegacyHome: true }).action).toBe('adopt');
    expect(readFileSync(manifestPath, 'utf-8')).toBe(manifest);
    expect(readStampJson(home)['adopted']).toBe(true);
  });
});
