import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseTomlText } from 'smol-toml';

/**
 * Custody model for home assembly and credential donation.
 *
 * Actors: the caller (owns the run home and anything already in it), the
 * source home's owner (owns its config.toml, credentials/ and oauth/), this
 * library, and the native `kimi` child (reads config.toml, reads and
 * refreshes credentials, writes sessions into the run home).
 *
 * - Inputs are paths. A relative home path is resolved once, at entry,
 *   against the calling process's working directory. Everything after that
 *   — symlink targets, `KIMI_CODE_HOME`, identity checks — uses absolute
 *   paths. The child may run in another cwd, where a relative home would
 *   name a different directory; a relative symlink target would resolve
 *   against the link's own directory.
 * - Identity is decided after resolving symlinks. A run home that is the
 *   source home under another name, or that contains or is contained in it,
 *   is refused before anything is created, chmod'ed or written.
 * - Ownership is explicit. A run home this library assembled carries
 *   {@link HOME_STAMP}: the canonical source home it came from and a digest
 *   of the settings in the config.toml it wrote. Only an empty directory or
 *   a stamped home is used; a stamped home only with the same source, and
 *   only while its config.toml still holds what was written (comments may
 *   change) or what the source now yields. A `config.toml` alone proves
 *   nothing: it is a common file name.
 * - Every refusal happens before the first effect. An entry this library did
 *   not make — a real directory, a file, a symlink pointing anywhere but the
 *   intended source — is caller-owned and is never removed or re-pointed.
 *   An existing run-home directory keeps its permissions. A marker-stamped
 *   copy is library-made, but is discarded only when it provably holds
 *   nothing the source lacks (see {@link CREDENTIALS_MARKER}).
 * - Effects, in order: a missing run home is created with mode 0700 and
 *   stamped, the source home's oauth/ is created when missing (link mode),
 *   credentials are donated, config.toml is written (tmp file + rename) when
 *   missing or when the source's settings changed, and the stamp is updated.
 *
 * Native effects this library arranges but does not perform, as read from
 * the installed kimi 2.1.0 bundle: in link mode a refresh writes the new
 * token into the source home's credentials/ (tmp file + rename), sets that
 * directory to 0700, and takes its lock under the source home's oauth/. Every
 * new run home gets its own native device_id, which is sent to the provider,
 * so each ephemeral run appears there as a new device.
 *
 * Not promised: hermeticity. The child still reads ambient AGENTS.md files
 * and skills, inherits the process environment unless told otherwise, and
 * in link mode writes refreshed tokens into the source home by design.
 */

/**
 * How a run home receives the source home's managed-provider credentials.
 *
 * - `link` (default): `<home>/credentials` and `<home>/oauth` are DIRECTORY
 *   symlinks into the source home. No token material is replicated; a lazy
 *   refresh writes through to the shared account file (tmp+rename lands
 *   inside the real directory — file symlinks would be clobbered, directory
 *   symlinks are safe) and the cross-process refresh lock on `oauth/<slot>`
 *   is genuinely shared with every native run on the source home.
 *   Verified 2026-09-24 against kimi-code @ 6451f1e (installed kimi 2.0.1):
 *   `packages/oauth/src/storage.ts`, `packages/oauth/src/oauth-manager.ts`.
 * - `copy`: credential files are copied in, stamped with their digests (see
 *   {@link CREDENTIALS_MARKER}). A refresh
 *   inside the copy rotates the shared refresh token server-side and the
 *   source home's copy goes stale — use only for throwaway forensics, never
 *   as a default.
 */
export type AuthMode = 'link' | 'copy';

export interface AssembledHome {
  /** Absolute path of the run home. */
  readonly home: string;
  readonly configPath: string;
  readonly modelAlias: string;
  readonly provider: string;
}

/**
 * The home credentials are donated from. Explicit argument, else
 * `KIMI_CODE_HOME_SOURCE`, else `~/.kimi-code`. Deliberately NOT
 * `KIMI_CODE_HOME`: that variable names the RUN home, and a run home must
 * never double as its own source.
 *
 * The `~/.kimi-code` fallback is refused when the environment's
 * `KIMI_CODE_HOME` names a different directory: that environment selected
 * another home for native kimi, and silently donating from `~/.kimi-code`
 * would run on a login it did not select.
 */
export function sourceHome(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = env['KIMI_CODE_HOME_SOURCE'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = env['HOME'];
  if (home === undefined || home.length === 0) {
    throw new Error('no source home: pass srcHome, set KIMI_CODE_HOME_SOURCE, or set HOME');
  }
  const fallback = join(home, '.kimi-code');
  const selected = env['KIMI_CODE_HOME'];
  if (selected !== undefined && selected.length > 0 && !sameDirectory(selected, fallback)) {
    throw new Error(
      `KIMI_CODE_HOME is ${selected}, but the source home would default to ${fallback}; ` +
        'set KIMI_CODE_HOME_SOURCE or pass the source home explicitly',
    );
  }
  return fallback;
}

// ---------------------------------------------------------------- config.toml

type TomlTable = Record<string, unknown>;

function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Parse with smol-toml, the parser kimi 2.1.0 bundles and calls (default
 * options) for every read of its config.toml. kimi 2.1.0 bundles 1.6.1,
 * which has published denial-of-service defects (an infinite loop on some
 * malformed input; quadratic time on many keys); this library pins a later
 * release with both fixed, so it may parse some documents that 1.6.1 would
 * hang on or reject. Bun's built-in TOML parser is not used: it accepts
 * malformed input, such as an unterminated table header, that smol-toml
 * rejects.
 */
function parseToml(text: string, where: string): TomlTable {
  let parsed: unknown;
  try {
    parsed = parseTomlText(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${where} does not parse as TOML (${reason}); refusing`);
  }
  if (!isTable(parsed)) throw new Error(`${where} does not parse as a TOML table; refusing`);
  return parsed;
}

/**
 * A parsed TOML value as one canonical string: two values have the same
 * string exactly when they mean the same. Dates by their TOML form
 * (smol-toml's TomlDate keeps local dates and times distinct), numbers so
 * that `nan` equals `nan` and `-0.0` stays distinct, tables with sorted keys.
 * Comments and layout are not part of a parsed value, so they never count.
 */
function canonicalToml(value: unknown): string {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalToml(item)).join(',')}]`;
  if (isTable(value)) {
    const table: TomlTable = value;
    const entries = Object.keys(table)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalToml(table[key])}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  return `${typeof value}:${JSON.stringify(value) ?? ''}`;
}

/** Digest of a parsed config's settings, as recorded in {@link HOME_STAMP}. */
function settingsDigest(table: TomlTable): string {
  return sha256(canonicalToml(table));
}

const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const TABLE_HEADER = new RegExp(
  String.raw`^\s*(\[\[?)\s*(${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*)\s*(\]\]?)\s*(?:#.*)?$`,
);
const TOML_KEYS = new RegExp(TOML_KEY, 'g');

/**
 * The key path of a `[table]` or `[[array.of.tables]]` header line, or
 * undefined when the line is not one. A header whose key cannot be decoded
 * yields an empty path, which nothing selects.
 */
function headerPath(line: string): string[] | undefined {
  // CRLF files: `.` in a trailing comment does not match `\r`.
  const match = TABLE_HEADER.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
  if (match === null) return undefined;
  const [, open, keys, close] = match;
  if (open === undefined || keys === undefined || close === undefined) return undefined;
  if (open.length !== close.length) return undefined;
  const path: string[] = [];
  for (const [key] of keys.matchAll(TOML_KEYS)) {
    if (key.startsWith('"')) {
      try {
        path.push(JSON.parse(key));
      } catch {
        return [];
      }
    } else if (key.startsWith("'")) {
      path.push(key.slice(1, -1));
    } else {
      path.push(key);
    }
  }
  return path;
}

/** The text of each table: its header line through the line before the next header. */
function tableBlocks(text: string): { path: readonly string[]; text: string }[] {
  const blocks: { path: string[]; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const path = headerPath(line);
    if (path !== undefined) {
      blocks.push({ path, lines: [line] });
    } else {
      blocks.at(-1)?.lines.push(line); // root-table lines are not carried
    }
  }
  return blocks.map(({ path, lines }) => ({ path, text: lines.join('\n').trimEnd() }));
}

function isUnder(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => path[index] === key);
}

/**
 * Root tables carried whole when the source config has them:
 * - `thinking` — the configured effort; without it a run uses the model's
 *   default effort (kimi 2.1.0 keys: `enabled`, `effort`, `keep`);
 * - `permission` — the deny/allow/ask rules, carried so a bare run is
 *   configured exactly as a native run on the source home. This promises a
 *   faithful carry only, and is NOT protection. In a native run of installed
 *   kimi 2.1.0 in `-p` mode (a loopback test provider, the repository's
 *   optional probe), a schema-valid `[[permission.rules]]` deny rule for
 *   `Bash` was carried and accepted without a section-drop warning, yet did
 *   not stop a `Bash` call (it ran: "Command executed successfully."). That
 *   matches the static reading: the rule state the policy chain consults is
 *   filled by a method nothing in the bundle calls. This is one observed
 *   case in one version and mode, not a statement about other versions,
 *   modes or the interactive UI. Do not rely on carried rules to contain a
 *   bare run: confine it from outside (an OS sandbox, a container, a
 *   restricted account);
 * - `hooks` — native hooks, which 2.1.0 loads from config and runs: in the
 *   same native run a `PreToolUse` hook fired. They run in bare runs exactly
 *   as configured.
 *
 * kimi 2.1.0 validates each config section against its own schema and drops
 * a section that fails as a whole, printing only a warning
 * (`Ignored invalid config section '<name>'`). Observed in the same native
 * run: a string `deny = ["Bash"]` rule dropped the whole `[permission]`
 * section, and one invalid `[[hooks]]` entry dropped the whole hooks section,
 * so the valid hook beside it did not fire. This library carries such a
 * section verbatim; it does not validate kimi's schema.
 */
const CARRIED_TABLES = ['thinking', 'permission', 'hooks'] as const;

interface MinimalConfig {
  readonly text: string;
  readonly modelAlias: string;
  readonly provider: string;
  /** {@link settingsDigest} of `text`. */
  readonly digest: string;
}

/**
 * Build a run home's config.toml from the source config: `default_model`,
 * the default model's `[models."<alias>"]` and its `[providers."<name>"]`
 * (with sub-tables), and every {@link CARRIED_TABLES} table — each table
 * copied as text, VERBATIM. Verbatim matters: the credential slot is
 * `kimi-code[-env-<sha256({oauthHost, baseUrl})[:16]>]` — recompute the pair
 * and the token is never read. (Verified 2026-09-24 for kimi 2.0.1:
 * `packages/oauth/src/managed-kimi-code.ts` — mechanism identical to the
 * 0.41.0-era measurement this library started from.)
 *
 * The text is split at header lines only; that is not a TOML parser, and a
 * header-like line inside a multi-line string or array would split wrongly.
 * So the semantics come from {@link parseToml} instead, which guarantees:
 * - the whole source config parses under smol-toml (the parser family kimi
 *   uses; this library pins a newer release than kimi 2.1.0 bundles, see
 *   {@link parseToml}) —
 *   malformed content anywhere, carried or not, is refused, because what
 *   the source means cannot be known;
 * - `default_model` is read from the parsed root table;
 * - the assembled text parses under the same parser, equals the source on
 *   everything it carries, and carries nothing else. Any mismatch — a split
 *   gone wrong, dotted keys or inline tables outside the carried tables' own
 *   headers — is refused rather than dropped or altered.
 * It does not guarantee that kimi's schema accepts the carried values, nor
 * agreement with the parser release kimi itself bundles. Other source
 * settings are not carried.
 */
function minimalConfig(configText: string, where: string): MinimalConfig {
  const source = parseToml(configText, where);
  const modelAlias = source['default_model'];
  if (typeof modelAlias !== 'string') {
    throw new Error(`no default_model in the root table of ${where}`);
  }
  const models = source['models'];
  const model = isTable(models) ? models[modelAlias] : undefined;
  if (!isTable(model)) throw new Error(`no [models."${modelAlias}"] in ${where}`);
  const provider = model['provider'];
  if (typeof provider !== 'string') throw new Error(`no provider in [models."${modelAlias}"]`);
  const providers = source['providers'];
  const providerTable = isTable(providers) ? providers[provider] : undefined;
  if (!isTable(providerTable)) throw new Error(`no [providers."${provider}"] in ${where}`);

  const prefixes: (readonly string[])[] = [
    ['providers', provider],
    ['models', modelAlias],
  ];
  const expected: TomlTable = {
    default_model: modelAlias,
    providers: { [provider]: providerTable },
    models: { [modelAlias]: model },
  };
  for (const key of CARRIED_TABLES) {
    if (Object.hasOwn(source, key)) {
      prefixes.push([key]);
      expected[key] = source[key];
    }
  }

  const sections = tableBlocks(configText)
    .filter((block) => prefixes.some((prefix) => isUnder(block.path, prefix)))
    .map((block) => block.text);
  const text = `default_model = ${JSON.stringify(modelAlias)}\n\n${sections.join('\n\n')}\n`;

  const carried = parseToml(text, `the config assembled from ${where}`);
  for (const key of new Set([...Object.keys(expected), ...Object.keys(carried)])) {
    if (canonicalToml(carried[key]) !== canonicalToml(expected[key])) {
      throw new Error(
        `${where}: \`${key}\` cannot be carried verbatim (written outside its own table ` +
          'headers, e.g. as dotted keys or an inline table); refusing rather than dropping or altering it',
      );
    }
  }
  return { text, modelAlias, provider, digest: settingsDigest(carried) };
}

// ---------------------------------------------------------------- paths

/**
 * Stamp left inside a credentials dir copied by this library. It records the
 * SHA-256 of every file as copied, so cleanup can tell a stale copy (the
 * source was refreshed; the copy is unchanged and discardable) from a
 * refreshed one (the copy changed and may hold the only current refresh
 * token; it is kept). An empty marker from an earlier version, or one that
 * does not parse, proves nothing: such a copy is discarded only where it is
 * byte-identical to the source.
 */
export const CREDENTIALS_MARKER = '.bare-kimi-copied';

/** Stamp left at the root of a home created by makeEphemeralHome(). */
export const EPHEMERAL_MARKER = '.bare-kimi-ephemeral';

/**
 * Absolute path with every symlink in its existing prefix resolved; the
 * not-yet-existing remainder is appended unchanged. Refuses a dangling
 * symlink: creating through it would land wherever it points.
 */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(head), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (lstatSync(head, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(`refusing dangling symlink at ${head}`);
    }
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    missing.unshift(basename(head));
    head = parent;
  }
}

/** stat() that follows symlinks and reports any failure as absence. */
function statIfPresent(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Both paths exist and are the same filesystem object. */
function sameExisting(a: string, b: string): boolean {
  const left = statIfPresent(a);
  const right = statIfPresent(b);
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

/**
 * Where `path` stands relative to the existing directory `ancestor`, by
 * filesystem identity: `same` when `path` is it, `inside` when one of
 * `path`'s existing ancestors is it. Identity, unlike spelling, also sees
 * through case-insensitive names and hard-to-spot aliases, including for a
 * `path` that does not exist yet.
 */
function placeByIdentity(path: string, ancestor: string): 'same' | 'inside' | undefined {
  const target = statIfPresent(ancestor);
  if (target === undefined) return undefined;
  let current = resolve(path);
  for (let first = true; ; first = false) {
    const stat = statIfPresent(current);
    if (stat !== undefined && stat.dev === target.dev && stat.ino === target.ino) {
      return first ? 'same' : 'inside';
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** The two paths name the same directory, by spelling or by identity. */
function sameDirectory(a: string, b: string): boolean {
  if (resolve(a) === resolve(b) || placeByIdentity(a, b) === 'same') return true;
  try {
    return canonicalPath(a) === canonicalPath(b);
  } catch {
    return false;
  }
}

/**
 * Refuse a run home that is the source home under another name (`..`
 * segments, symlinks anywhere on the path, a case-insensitive spelling), or
 * that contains or lies inside the source home. A run home must never double
 * as its own source, and neither may hold the other's files.
 */
export function assertDistinctHomes(srcHome: string, runHome: string): void {
  const src = canonicalPath(srcHome);
  const run = canonicalPath(runHome);
  if (
    resolve(srcHome) === resolve(runHome) ||
    src === run ||
    placeByIdentity(runHome, srcHome) === 'same'
  ) {
    throw new Error('source and run home are the same directory; refusing');
  }
  if (
    isInside(run, src) ||
    isInside(src, run) ||
    placeByIdentity(runHome, srcHome) === 'inside' ||
    placeByIdentity(srcHome, runHome) === 'inside'
  ) {
    throw new Error('source and run home are nested inside one another; refusing');
  }
}

// ---------------------------------------------------------------- credentials

/** `path` is a symlink whose target is `target` (by path or by identity). */
function isLinkTo(path: string, target: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isSymbolicLink()) return false;
  const pointsAt = resolve(dirname(path), readlinkSync(path));
  return pointsAt === target || sameExisting(pointsAt, target);
}

/** A real (non-symlink) directory carrying this library's copy marker. */
function isMarkedCopy(path: string): boolean {
  return (
    lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true &&
    lstatSync(join(path, CREDENTIALS_MARKER), { throwIfNoEntry: false })?.isFile() === true
  );
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Per-file digests written into {@link CREDENTIALS_MARKER}. */
interface CopyStamp {
  readonly version: 1;
  readonly files: Readonly<Record<string, string>>;
}

/** The copy's stamp, or undefined when the marker is legacy or unreadable. */
function readStamp(copy: string): CopyStamp | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(copy, CREDENTIALS_MARKER), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isTable(parsed) || parsed['version'] !== 1 || !isTable(parsed['files'])) return undefined;
  const files = parsed['files'];
  if (!Object.values(files).every((digest) => typeof digest === 'string')) return undefined;
  return { version: 1, files: files as Record<string, string> };
}

/**
 * Refuse to discard a marker-stamped copy that may hold something the source
 * lacks. A file is safe to lose when it is exactly as copied (its stamp
 * matches) or byte-identical to the source's file; anything else — a
 * refreshed token, a revoked tombstone, a new file, a non-file entry — may be
 * the only current state of the login and is kept. A file the stamp lists
 * but the copy lacks holds nothing to lose.
 */
function assertCopyDiscardable(srcCredentials: string, copy: string): void {
  const stamp = readStamp(copy);
  const kept = readdirSync(copy).filter((entry) => {
    if (entry === CREDENTIALS_MARKER) return false;
    const copied = join(copy, entry);
    if (!lstatSync(copied).isFile()) return true;
    const bytes = readFileSync(copied);
    if (stamp !== undefined && Object.hasOwn(stamp.files, entry) && stamp.files[entry] === sha256(bytes)) {
      return false;
    }
    const source = join(srcCredentials, entry);
    return !(statSync(source, { throwIfNoEntry: false })?.isFile() === true && bytes.equals(readFileSync(source)));
  });
  if (kept.length > 0) {
    throw new Error(
      `refusing to discard credentials copy at ${copy}: ${kept.join(', ')} ` +
        (stamp === undefined ? 'cannot be verified as unchanged' : 'changed since it was copied') +
        ' and may hold the only current refresh token; move it aside by hand',
    );
  }
}

/** One directory symlink a link-mode donation needs, and what it does to it. */
interface LinkStep {
  readonly target: string;
  readonly path: string;
  readonly action: 'keep' | 'create' | 'replace-copy';
}

interface LinkDonation {
  readonly mode: 'link';
  readonly sourceOauth: string;
  readonly credentials: LinkStep;
  readonly oauth: LinkStep;
}

interface CopyDonation {
  readonly mode: 'copy';
  readonly from: string;
  readonly to: string;
  /** An existing, discardable copy is removed and made afresh. */
  readonly replace: boolean;
}

/** A donation decided in full before any effect; refusals throw while planning. */
type Donation = LinkDonation | CopyDonation;

/**
 * Decide what to do with `path` so it becomes a directory symlink to
 * `target`. Only an existing link to the same target, or (when `copyOf` is
 * given) a discardable marker-stamped copy, may already occupy it.
 */
function planLink(target: string, path: string, copyOf?: string): LinkStep {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { target, path, action: 'create' };
  if (stat.isSymbolicLink()) {
    if (isLinkTo(path, target)) return { target, path, action: 'keep' };
    throw new Error(
      `refusing to re-point caller-owned symlink at ${path} (-> ${readlinkSync(path)}); ` +
        `remove it to donate from ${target}`,
    );
  }
  if (copyOf !== undefined && isMarkedCopy(path)) {
    assertCopyDiscardable(copyOf, path);
    return { target, path, action: 'replace-copy' };
  }
  throw new Error(`refusing to replace caller-owned entry at ${path}`);
}

function sourceCredentials(src: string): string {
  const credentials = join(src, 'credentials');
  if (statSync(credentials, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`no credentials directory in source home ${src}`);
  }
  return credentials;
}

/** Both links, into the same source: credentials/ and its refresh lock dir. */
function planLinkDonation(src: string, dst: string): LinkDonation {
  const credentials = sourceCredentials(src);
  const sourceOauth = join(src, 'oauth');
  const sourceOauthStat = statSync(sourceOauth, { throwIfNoEntry: false });
  if (sourceOauthStat !== undefined && !sourceOauthStat.isDirectory()) {
    throw new Error(`source home oauth entry is not a directory: ${sourceOauth}`);
  }
  return {
    mode: 'link',
    sourceOauth,
    credentials: planLink(credentials, join(dst, 'credentials'), credentials),
    oauth: planLink(sourceOauth, join(dst, 'oauth')),
  };
}

function planCopyDonation(src: string, dst: string): CopyDonation {
  const from = sourceCredentials(src);
  const to = join(dst, 'credentials');
  if (lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error(
      `refusing to copy credentials into ${dst}: its oauth/ is a symlink, which would pair ` +
        'a copied token with a shared lock',
    );
  }
  if (lstatSync(to, { throwIfNoEntry: false }) === undefined) return { mode: 'copy', from, to, replace: false };
  if (!isMarkedCopy(to)) {
    throw new Error(`refusing to overwrite unmarked credentials entry at ${to}`);
  }
  assertCopyDiscardable(from, to);
  return { mode: 'copy', from, to, replace: true };
}

function planDonation(srcHome: string, dstHome: string, mode: AuthMode): Donation {
  const src = resolve(srcHome);
  const dst = resolve(dstHome);
  assertDistinctHomes(src, dst);
  return mode === 'link' ? planLinkDonation(src, dst) : planCopyDonation(src, dst);
}

function applyLink(step: LinkStep): void {
  if (step.action === 'keep') return;
  if (step.action === 'replace-copy') rmSync(step.path, { recursive: true, force: true });
  symlinkSync(step.target, step.path, 'dir');
}

/**
 * Carry out a planned donation. In link mode `oauth/` is created in the
 * SOURCE home when missing (mode 0700): the native CLI creates it on first
 * refresh anyway, and without it the run would fall back to a per-home
 * lock — silently defeating the shared refresh serialization that is the
 * point of link mode. Link targets are absolute but not symlink-resolved, so
 * a source home reached through a symlink stays reached through it.
 *
 * A copy is written from the same bytes its stamp was computed from, and the
 * stamp goes in first, so an interrupted copy is still recognizably this
 * library's and its files are verifiably unchanged.
 */
function applyDonation(donation: Donation): void {
  if (donation.mode === 'link') {
    mkdirSync(donation.sourceOauth, { recursive: true, mode: 0o700 });
    applyLink(donation.credentials);
    applyLink(donation.oauth);
    return;
  }
  const files: Record<string, string> = {};
  const contents: [string, Buffer][] = [];
  for (const entry of readdirSync(donation.from)) {
    if (entry === CREDENTIALS_MARKER) continue;
    const from = join(donation.from, entry);
    if (!statSync(from).isFile()) continue;
    const bytes = readFileSync(from);
    files[entry] = sha256(bytes);
    contents.push([entry, bytes]);
  }
  if (donation.replace) rmSync(donation.to, { recursive: true, force: true });
  mkdirSync(donation.to, { recursive: true, mode: 0o700 });
  chmodSync(donation.to, 0o700);
  const stamp: CopyStamp = { version: 1, files };
  writeFileSync(join(donation.to, CREDENTIALS_MARKER), `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
  for (const [entry, bytes] of contents) {
    const to = join(donation.to, entry);
    writeFileSync(to, bytes, { mode: 0o600 });
    chmodSync(to, 0o600);
  }
}

/**
 * Give `dstHome` working authentication from `srcHome` according to `mode`.
 * Refuses, changing nothing, when the homes are the same or nested, or when
 * an entry it would replace is caller-owned, links elsewhere, or is a copy
 * that may hold something the source lacks.
 */
export function donateAuth(srcHome: string, dstHome: string, mode: AuthMode = 'link'): void {
  applyDonation(planDonation(srcHome, dstHome, mode));
}

/**
 * Make a kept home's existing authentication usable from `srcHome`, or
 * re-donate it when it is gone (shredded copy or removed link).
 *
 * - `credentials` missing: donate per `mode`.
 * - `credentials` a symlink: it must be this source's link and `mode` must
 *   be `link`; `oauth` must be the paired link into the same source, and is
 *   restored when missing. Anything else is refused: a token and a lock from
 *   different homes would refresh under a lock nobody else takes.
 * - `credentials` a real directory (hand-placed or `--keep-credentials`
 *   material): left alone, but an `oauth` symlink next to it is refused as
 *   unpaired.
 *
 * Returns whether it changed anything.
 */
export function ensureAuth(srcHome: string, dstHome: string, mode: AuthMode = 'link'): boolean {
  const src = resolve(srcHome);
  const dst = resolve(dstHome);
  assertDistinctHomes(src, dst);
  const donation = planEnsure(src, dst, mode);
  if (donation === undefined) return false;
  applyDonation(donation);
  return true;
}

/** ensureAuth's decision, made before any effect; undefined when nothing is to change. */
function planEnsure(src: string, dst: string, mode: AuthMode): Donation | undefined {
  const credentials = lstatSync(join(dst, 'credentials'), { throwIfNoEntry: false });
  if (credentials === undefined) return planDonation(src, dst, mode);
  if (credentials.isSymbolicLink()) {
    if (mode !== 'link') {
      throw new Error(`run home ${dst} has linked credentials, but copy mode was requested; refusing`);
    }
    const donation = planLinkDonation(src, dst);
    const complete = donation.oauth.action === 'keep' && existsSync(donation.sourceOauth);
    return complete ? undefined : donation;
  }
  if (lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error(
      `run home ${dst} has a linked oauth/ but its own credentials/; refusing the unpaired lock`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------- homes

/**
 * Stamp at the root of every run home this library assembled: proof of
 * ownership, the canonical source home it was assembled from, and the
 * digest of the settings in the config.toml it last wrote.
 */
export const HOME_STAMP = '.bare-kimi-home';

interface HomeStamp {
  readonly version: 1;
  /** Canonical path of the source home. */
  readonly source: string;
  /** {@link settingsDigest} of the config.toml this library last wrote. */
  readonly config: string;
}

/** The home's stamp; undefined when there is none. A stamp that does not read as one is refused. */
function readHomeStamp(home: string): HomeStamp | undefined {
  const path = join(home, HOME_STAMP);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw new Error(`${path} is not a regular file; refusing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    parsed = undefined;
  }
  const source = isTable(parsed) ? parsed['source'] : undefined;
  const config = isTable(parsed) ? parsed['config'] : undefined;
  if (!isTable(parsed) || parsed['version'] !== 1 || typeof source !== 'string' || typeof config !== 'string') {
    throw new Error(`${path} is not a stamp this version of bare-kimi wrote; refusing`);
  }
  return { version: 1, source, config };
}

/** Replace `path` with `text` in one rename, so no reader sees half of it. */
function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function writeHomeStamp(home: string, stamp: HomeStamp): void {
  writeFileAtomic(join(home, HOME_STAMP), `${JSON.stringify(stamp)}\n`);
}

/** What preparing a run home will do, decided in full before any effect. */
interface RunHomePlan {
  /** Canonical run-home path, for the effects that follow. */
  readonly home: string;
  readonly create: boolean;
  /** The home's stamp as found; undefined for a new or empty home. */
  readonly stamp: HomeStamp | undefined;
  readonly writeConfig: boolean;
}

/**
 * Decide how the run home relates to `source` (canonical) and `config` (what
 * the source yields now). Refuses:
 * - an existing non-directory;
 * - a non-empty directory without {@link HOME_STAMP} — this library did not
 *   assemble it, whatever it holds;
 * - a stamped home from another source;
 * - a config.toml that is not a regular file, or no longer parses;
 * - a config.toml whose settings differ both from what was last written
 *   (it was edited) and from what the source yields now.
 *
 * A config.toml whose settings equal the source's is kept byte for byte
 * (comments survive). One that still holds exactly what was last written,
 * while the source changed, is rewritten from the source.
 */
function planRunHome(dst: string, source: string, config: MinimalConfig): RunHomePlan {
  const home = canonicalPath(dst);
  const stat = statIfPresent(home);
  if (stat === undefined) return { home, create: true, stamp: undefined, writeConfig: true };
  if (!stat.isDirectory()) throw new Error(`run home ${home} exists and is not a directory`);
  const stamp = readHomeStamp(home);
  if (stamp === undefined) {
    const entries = readdirSync(home).filter((entry) => entry !== EPHEMERAL_MARKER);
    if (entries.length > 0) {
      throw new Error(
        `refusing to use ${home}: it is not empty and has no ${HOME_STAMP}, ` +
          'so it is not a run home bare-kimi assembled',
      );
    }
    return { home, create: false, stamp, writeConfig: true };
  }
  if (stamp.source !== source) {
    throw new Error(`run home ${home} was assembled from ${stamp.source}, not ${source}; refusing`);
  }
  const configPath = join(home, 'config.toml');
  const current = lstatSync(configPath, { throwIfNoEntry: false });
  if (current === undefined) return { home, create: false, stamp, writeConfig: true };
  if (!current.isFile()) throw new Error(`refusing to use ${configPath}: not a regular file`);
  const digest = settingsDigest(parseToml(readFileSync(configPath, 'utf-8'), configPath));
  if (digest === config.digest) return { home, create: false, stamp, writeConfig: false };
  if (digest === stamp.config) return { home, create: false, stamp, writeConfig: true };
  throw new Error(
    `refusing to use ${configPath}: its settings were edited since bare-kimi wrote it, ` +
      'and they differ from what the source home now yields',
  );
}

/**
 * Make `runHome` a KIMI_CODE_HOME ready to run on `srcHome`'s login and
 * settings: create or reuse it (see {@link planRunHome}), donate
 * authentication, and bring its config.toml in line with the source's —
 * `default_model`, that model's and its provider's tables and the carried
 * tables (see {@link minimalConfig}). A source whose settings changed since
 * the last run is followed, not ignored: an unedited config.toml is
 * rewritten from it.
 *
 * Authentication: with `reassemble`, donation runs as in {@link donateAuth}
 * (an unchanged bare-kimi copy may be replaced, e.g. by a link); otherwise as
 * in {@link ensureAuth} (present credentials are used as they are, once
 * their pairing with the source checks out). A new or empty home always gets
 * a full donation.
 *
 * config.toml is written as a regular file by tmp + rename: kimi persists
 * config the same way, which would silently replace a symlink. A missing run
 * home is created with mode 0700; an existing one keeps its mode.
 *
 * All refusals happen before the first effect (see the custody model above).
 */
export function prepareRunHome(
  srcHome: string,
  runHome: string,
  mode: AuthMode = 'link',
  options: { readonly reassemble?: boolean } = {},
): AssembledHome {
  const src = resolve(srcHome);
  const dst = resolve(runHome);
  assertDistinctHomes(src, dst);
  const source = canonicalPath(src);
  const srcConfigPath = join(src, 'config.toml');
  const config = minimalConfig(readFileSync(srcConfigPath, 'utf-8'), srcConfigPath);
  const plan = planRunHome(dst, source, config);
  const donation =
    plan.stamp === undefined || options.reassemble === true
      ? planDonation(src, dst, mode)
      : planEnsure(src, dst, mode);

  // Effects start here; every refusal above left both homes untouched.
  if (plan.create) {
    mkdirSync(plan.home, { recursive: true, mode: 0o700 });
    chmodSync(plan.home, 0o700);
  }
  if (plan.stamp === undefined) {
    // Stamped first: an interrupted assembly leaves a home that is still ours.
    writeHomeStamp(plan.home, { version: 1, source, config: config.digest });
  }
  if (donation !== undefined) applyDonation(donation);
  const configPath = join(dst, 'config.toml');
  if (plan.writeConfig) writeFileAtomic(join(plan.home, 'config.toml'), config.text);
  if (plan.stamp !== undefined && plan.stamp.config !== config.digest) {
    writeHomeStamp(plan.home, { version: 1, source, config: config.digest });
  }

  return { home: dst, configPath, modelAlias: config.modelAlias, provider: config.provider };
}

/**
 * {@link prepareRunHome} with `reassemble`: turn `dstHome` into a runnable
 * minimal KIMI_CODE_HOME from `srcHome`, donating authentication in full.
 */
export function assembleHome(
  srcHome: string,
  dstHome: string,
  mode: AuthMode = 'link',
): AssembledHome {
  return prepareRunHome(srcHome, dstHome, mode, { reassemble: true });
}

/**
 * Remove `<home>/credentials` only when it is the marker-stamped copy
 * this library made. Linked or hand-prepared credentials have no marker and
 * are never touched. When `srcHome` is given, a copy that may hold something
 * the source lacks is refused (thrown) and kept — see
 * {@link CREDENTIALS_MARKER}. Returns whether it shredded.
 */
export function shredCopiedCredentials(home: string, srcHome?: string): boolean {
  const credentials = join(resolve(home), 'credentials');
  if (!isMarkedCopy(credentials)) return false;
  if (srcHome !== undefined) {
    assertCopyDiscardable(join(resolve(srcHome), 'credentials'), credentials);
  }
  rmSync(credentials, { recursive: true, force: true });
  return true;
}

/**
 * A home counts as assembled when it carries {@link HOME_STAMP}, i.e. this
 * library assembled it. A config.toml alone does not count. A stamp that is
 * not one this version wrote is refused (thrown), not guessed at.
 */
export function isAssembledHome(home: string): boolean {
  return readHomeStamp(resolve(home)) !== undefined;
}

/**
 * Create a fresh ephemeral home in the system temp dir, stamped with
 * EPHEMERAL_MARKER so removeHome can prove it owns what it deletes.
 */
export function makeEphemeralHome(): string {
  const home = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'bare-kimi-'));
  writeFileSync(join(home, EPHEMERAL_MARKER), '', { mode: 0o600 });
  return home;
}

/**
 * Remove a home created by makeEphemeralHome(). Refuses any path lacking the
 * ephemeral marker, so a library caller cannot turn this into rm -rf on an
 * arbitrary directory. Directory symlinks inside the home (link-mode
 * credentials) are unlinked, never traversed — the source home's credential
 * files are not touched. When `srcHome` is given, a credentials copy that may
 * hold something the source lacks is refused as in shredCopiedCredentials,
 * and the whole home is kept.
 */
export function removeHome(home: string, srcHome?: string): void {
  if (!existsSync(join(home, EPHEMERAL_MARKER))) {
    throw new Error(`refusing to remove ${home}: not created by makeEphemeralHome()`);
  }
  if (srcHome !== undefined) shredCopiedCredentials(home, srcHome);
  rmSync(home, { recursive: true, force: true });
}
