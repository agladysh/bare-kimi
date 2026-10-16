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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
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
 * - Every refusal happens before the first effect. An entry this library did
 *   not make — a real directory, a file, a symlink pointing anywhere but the
 *   intended source — is caller-owned and is never removed or re-pointed.
 *   An existing run-home directory keeps its permissions, and is used only
 *   when it is empty or already an assembled home. A marker-stamped copy is
 *   library-made, but is discarded only when it provably holds nothing the
 *   source lacks (see {@link CREDENTIALS_MARKER}).
 * - Effects, in order: the source home's oauth/ is created when missing
 *   (link mode), a missing run home is created with mode 0700, credentials
 *   are donated, config.toml is written.
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
 * - `copy`: credential files are copied in (sketch behavior). A refresh
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
  return join(home, '.kimi-code');
}

// ---------------------------------------------------------------- config.toml

type TomlTable = Record<string, unknown>;

function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Parse with smol-toml, pinned to the version kimi 2.1.0 bundles and calls
 * (default options) for every read of its config.toml. Validating with the
 * parser kimi itself uses means a config refused here is one kimi would
 * also refuse or misread, and one accepted here reads the same to kimi.
 * Bun's built-in TOML parser is not used: it accepts malformed input, such
 * as an unterminated table header, that smol-toml rejects.
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
 * Structural equality of parsed TOML values. Dates compare by their TOML
 * form (smol-toml's TomlDate keeps local dates and times distinct), numbers
 * by Object.is (so `nan` equals `nan`), tables by their exact key sets.
 */
function sameTomlValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.toISOString() === b.toISOString();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const right: unknown[] = b;
    return a.every((item: unknown, index) => sameTomlValue(item, right[index]));
  }
  if (isTable(a) || isTable(b)) {
    if (!isTable(a) || !isTable(b)) return false;
    const left: TomlTable = a;
    const right: TomlTable = b;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameTomlValue(left[key], right[key]))
    );
  }
  return Object.is(a, b);
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
  const match = TABLE_HEADER.exec(line);
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
 * - `permission` — the deny/allow/ask rules. In `-p` mode native kimi forces
 *   its auto permission mode, where configured deny rules are checked before
 *   auto-approval; dropping them would approve what the operator denied;
 * - `hooks` — native hooks, carried with the policy they may enforce. They
 *   run in bare runs exactly as configured.
 */
const CARRIED_TABLES = ['thinking', 'permission', 'hooks'] as const;

interface MinimalConfig {
  readonly text: string;
  readonly modelAlias: string;
  readonly provider: string;
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
 * - the whole source config parses under kimi 2.1.0's own TOML parser —
 *   malformed content anywhere, carried or not, is refused, because what
 *   the source means cannot be known;
 * - `default_model` is read from the parsed root table;
 * - the assembled text parses under the same parser, equals the source on
 *   everything it carries, and carries nothing else. Any mismatch — a split
 *   gone wrong, dotted keys or inline tables outside the carried tables' own
 *   headers — is refused rather than dropped or altered.
 * It does not guarantee that kimi's schema accepts the carried values, nor
 * agreement with a different kimi version's parser. Other source settings
 * are not carried.
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
    if (!sameTomlValue(carried[key], expected[key])) {
      throw new Error(
        `${where}: \`${key}\` cannot be carried verbatim (written outside its own table ` +
          'headers, e.g. as dotted keys or an inline table); refusing rather than dropping or altering it',
      );
    }
  }
  return { text, modelAlias, provider };
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

/** Both paths exist and are the same filesystem object. */
function sameExisting(a: string, b: string): boolean {
  const left = statSync(a, { throwIfNoEntry: false });
  const right = statSync(b, { throwIfNoEntry: false });
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
  if (resolve(srcHome) === resolve(runHome) || src === run || sameExisting(srcHome, runHome)) {
    throw new Error('source and run home are the same directory; refusing');
  }
  if (isInside(run, src) || isInside(src, run)) {
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  const credentials = lstatSync(join(dst, 'credentials'), { throwIfNoEntry: false });
  if (credentials === undefined) {
    donateAuth(src, dst, mode);
    return true;
  }
  if (credentials.isSymbolicLink()) {
    if (mode !== 'link') {
      throw new Error(`run home ${dst} has linked credentials, but copy mode was requested; refusing`);
    }
    const donation = planLinkDonation(src, dst);
    applyDonation(donation);
    return donation.oauth.action === 'create';
  }
  if (lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error(
      `run home ${dst} has a linked oauth/ but its own credentials/; refusing the unpaired lock`,
    );
  }
  return false;
}

// ---------------------------------------------------------------- homes

/**
 * An existing directory is assembled into only when it is empty, holds
 * nothing but the ephemeral marker, or already holds a config.toml (an
 * assembled home). Its permissions stay the caller's. Returns whether the
 * run home still has to be created.
 */
function mustCreateRunHome(home: string): boolean {
  const stat = statSync(home, { throwIfNoEntry: false });
  if (stat === undefined) return true;
  if (!stat.isDirectory()) throw new Error(`run home ${home} exists and is not a directory`);
  const entries = readdirSync(home).filter((entry) => entry !== EPHEMERAL_MARKER);
  if (entries.length > 0 && !entries.includes('config.toml')) {
    throw new Error(
      `refusing to assemble into ${home}: it is not empty and holds no config.toml, so it is not a run home`,
    );
  }
  return false;
}

/**
 * Turn `dstHome` into a runnable minimal KIMI_CODE_HOME: authentication
 * donated from `srcHome` (link by default), and a config.toml built by
 * {@link minimalConfig} from `srcHome`'s.
 *
 * config.toml is written as a regular file: the engine persists config via
 * tmp+rename, which would silently replace a symlink. An existing
 * config.toml that is not a regular file is refused. A missing run home is
 * created with mode 0700; an existing one keeps its mode.
 *
 * All refusals happen before the first effect (see the custody model above).
 */
export function assembleHome(
  srcHome: string,
  dstHome: string,
  mode: AuthMode = 'link',
): AssembledHome {
  const src = resolve(srcHome);
  const dst = resolve(dstHome);
  assertDistinctHomes(src, dst);
  const srcConfigPath = join(src, 'config.toml');
  const config = minimalConfig(readFileSync(srcConfigPath, 'utf-8'), srcConfigPath);

  const home = canonicalPath(dst);
  const configPath = join(dst, 'config.toml');
  const existingConfig = lstatSync(join(home, 'config.toml'), { throwIfNoEntry: false });
  if (existingConfig !== undefined && !existingConfig.isFile()) {
    throw new Error(`refusing to replace ${configPath}: not a regular file`);
  }
  const donation = planDonation(src, dst, mode);
  const create = mustCreateRunHome(home);

  // Effects start here; every refusal above left both homes untouched.
  if (create) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
  }
  applyDonation(donation);
  writeFileSync(configPath, config.text, { mode: 0o600 });

  return { home: dst, configPath, modelAlias: config.modelAlias, provider: config.provider };
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
 * A home counts as assembled once it has a config.toml. Used to decide
 * whether a caller-supplied home is a prepared home (use as-is) or a fresh
 * dir to assemble into.
 */
export function isAssembledHome(home: string): boolean {
  return existsSync(join(home, 'config.toml'));
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
