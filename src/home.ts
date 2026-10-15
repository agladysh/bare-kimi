import {
  chmodSync,
  copyFileSync,
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
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Custody model for home assembly and credential donation.
 *
 * Actors: the caller (owns the run home and anything already in it), the
 * source home's owner (owns its config.toml, credentials/ and oauth/), this
 * library, and the native `kimi` child (reads config.toml, reads and
 * refreshes credentials, writes sessions into the run home).
 *
 * - Inputs are paths. A relative path is resolved once, at entry, against
 *   the calling process's working directory. Everything after that —
 *   symlink targets, `KIMI_CODE_HOME`, identity checks — uses absolute
 *   paths. The child may run in another cwd, where a relative home would
 *   name a different directory; a relative symlink target would resolve
 *   against the link's own directory.
 * - Identity is decided after resolving symlinks, so a run home that is the
 *   source home under another name is refused before anything is created,
 *   chmod'ed or written.
 * - Every refusal happens before the first effect. An entry this library did
 *   not make — a real directory, a file, a symlink pointing elsewhere — is
 *   caller-owned and is never removed or re-pointed. A marker-stamped copy
 *   is library-made, but it is replaced or shredded only while it still
 *   matches the source byte for byte: after a refresh has rotated it, it may
 *   hold the only current refresh token.
 * - Effects, in order: the source home's oauth/ is created when missing
 *   (link mode), the run home is created and set to 0700, credentials are
 *   donated, config.toml is written.
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

function scalar(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match?.[1];
}

/**
 * Extract a TOML section by exact header line, including any immediately
 * following sub-table sections (`[header.x]`). Stops at the next unrelated
 * header. Not a TOML parser — sufficient for the machine-written
 * `providers`/`models`/`thinking` sections of a managed config.toml.
 */
function extractSection(text: string, header: string): string | undefined {
  const lines = text.split('\n');
  const out: string[] = [];
  let inside = false;
  const subPrefix = `${header.slice(0, -1)}.`;
  for (const line of lines) {
    const isHeader = line.startsWith('[');
    if (!inside) {
      if (isHeader && line.trim() === header) {
        inside = true;
        out.push(line);
      }
      continue;
    }
    if (isHeader) {
      const trimmed = line.trim();
      if (trimmed.startsWith(subPrefix)) {
        out.push(line);
        continue;
      }
      break;
    }
    out.push(line);
  }
  return inside ? out.join('\n').trimEnd() : undefined;
}

/** The lines before the first table header: TOML's root table. */
function rootTable(text: string): string {
  const header = text.search(/^\[/m);
  return header === -1 ? text : text.slice(0, header);
}

/** Stamp left inside a credentials dir copied by this library. */
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

/**
 * Refuse a run home that is the source home under another name: `..`
 * segments, symlinks anywhere on the path, or a case-insensitive spelling.
 * A run home must never double as its own source.
 */
export function assertDistinctHomes(srcHome: string, runHome: string): void {
  if (
    resolve(srcHome) === resolve(runHome) ||
    canonicalPath(srcHome) === canonicalPath(runHome) ||
    sameExisting(srcHome, runHome)
  ) {
    throw new Error('source and run home are the same directory; refusing');
  }
}

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

/**
 * Refuse to discard a marker-stamped copy that no longer matches the source
 * byte for byte. A refresh in either home makes them differ, and the copy
 * may then hold the only current refresh token. Entries that are not
 * regular files count as differing.
 */
function assertCopyMatchesSource(srcCredentials: string, copy: string): void {
  const differing = readdirSync(copy).filter((entry) => {
    if (entry === CREDENTIALS_MARKER) return false;
    const copied = join(copy, entry);
    const source = join(srcCredentials, entry);
    return (
      !lstatSync(copied).isFile() ||
      !existsSync(source) ||
      !readFileSync(copied).equals(readFileSync(source))
    );
  });
  if (differing.length > 0) {
    throw new Error(
      `refusing to discard credentials copy at ${copy}: ${differing.join(', ')} no longer match ` +
        'the source home (a refresh may have rotated the token); move it aside by hand',
    );
  }
}

/** One directory symlink a link-mode donation needs, and what it does to it. */
interface LinkStep {
  readonly target: string;
  readonly path: string;
  readonly action: 'keep' | 'create' | 'replace-copy';
}

/** A donation decided in full before any effect; refusals throw while planning. */
type Donation =
  | {
      readonly mode: 'link';
      readonly sourceOauth: string;
      readonly credentials: LinkStep;
      readonly oauth: LinkStep;
    }
  | {
      readonly mode: 'copy';
      readonly from: string;
      readonly to: string;
      readonly existing: boolean;
    };

/**
 * Decide what to do with `path` so it becomes a directory symlink to
 * `target`. Only an existing link to the same target, or (when `copyOf` is
 * given) an unchanged marker-stamped copy, may already occupy it.
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
    assertCopyMatchesSource(copyOf, path);
    return { target, path, action: 'replace-copy' };
  }
  throw new Error(`refusing to replace caller-owned entry at ${path}`);
}

function planDonation(srcHome: string, dstHome: string, mode: AuthMode): Donation {
  const src = resolve(srcHome);
  const dst = resolve(dstHome);
  assertDistinctHomes(src, dst);
  const srcCredentials = join(src, 'credentials');
  if (statSync(srcCredentials, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`no credentials directory in source home ${src}`);
  }
  const dstCredentials = join(dst, 'credentials');

  if (mode === 'copy') {
    const stat = lstatSync(dstCredentials, { throwIfNoEntry: false });
    if (stat === undefined) {
      return { mode, from: srcCredentials, to: dstCredentials, existing: false };
    }
    if (!isMarkedCopy(dstCredentials)) {
      throw new Error(`refusing to overwrite unmarked credentials entry at ${dstCredentials}`);
    }
    assertCopyMatchesSource(srcCredentials, dstCredentials);
    return { mode, from: srcCredentials, to: dstCredentials, existing: true };
  }

  const sourceOauth = join(src, 'oauth');
  const sourceOauthStat = statSync(sourceOauth, { throwIfNoEntry: false });
  if (sourceOauthStat !== undefined && !sourceOauthStat.isDirectory()) {
    throw new Error(`source home oauth entry is not a directory: ${sourceOauth}`);
  }
  return {
    mode,
    sourceOauth,
    credentials: planLink(srcCredentials, dstCredentials, srcCredentials),
    oauth: planLink(sourceOauth, join(dst, 'oauth')),
  };
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
 */
function applyDonation(donation: Donation): void {
  if (donation.mode === 'link') {
    mkdirSync(donation.sourceOauth, { recursive: true, mode: 0o700 });
    applyLink(donation.credentials);
    applyLink(donation.oauth);
    return;
  }
  // The marker goes in first, so an interrupted copy is still recognizably
  // this library's and can be shredded.
  if (!donation.existing) mkdirSync(donation.to, { recursive: true, mode: 0o700 });
  chmodSync(donation.to, 0o700);
  writeFileSync(join(donation.to, CREDENTIALS_MARKER), '', { mode: 0o600 });
  for (const entry of readdirSync(donation.from)) {
    if (entry === CREDENTIALS_MARKER) continue;
    const from = join(donation.from, entry);
    if (!statSync(from).isFile()) continue;
    const to = join(donation.to, entry);
    copyFileSync(from, to);
    chmodSync(to, 0o600);
  }
}

/**
 * Give `dstHome` working authentication from `srcHome` according to `mode`.
 * Refuses, changing nothing, when the homes are the same directory or when
 * an entry it would replace is caller-owned or a changed copy.
 */
export function donateAuth(srcHome: string, dstHome: string, mode: AuthMode = 'link'): void {
  applyDonation(planDonation(srcHome, dstHome, mode));
}

/**
 * Re-donate authentication on a kept home whose previous donation is gone
 * (shredded copy or removed link). A no-op when `credentials` already
 * exists — hand-placed or `--keep-credentials` material is left alone —
 * except that in link mode a missing `oauth/` link next to this library's
 * own credentials link is restored, so refreshes keep the shared lock.
 * Returns whether it changed anything.
 */
export function ensureAuth(srcHome: string, dstHome: string, mode: AuthMode = 'link'): boolean {
  const src = resolve(srcHome);
  const dst = resolve(dstHome);
  assertDistinctHomes(src, dst);
  const credentials = join(dst, 'credentials');
  if (lstatSync(credentials, { throwIfNoEntry: false }) === undefined) {
    donateAuth(src, dst, mode);
    return true;
  }
  if (
    mode === 'link' &&
    lstatSync(join(dst, 'oauth'), { throwIfNoEntry: false }) === undefined &&
    isLinkTo(credentials, join(src, 'credentials'))
  ) {
    donateAuth(src, dst, mode);
    return true;
  }
  return false;
}

/**
 * Turn `dstHome` into a runnable minimal KIMI_CODE_HOME: authentication
 * donated from `srcHome` (link by default), and a config.toml carrying
 * `default_model` + the provider section + the model alias section + the
 * `[thinking]` section (when present) VERBATIM from `srcHome`'s config.toml.
 * Verbatim matters: the credential slot is
 * `kimi-code[-env-<sha256({oauthHost, baseUrl})[:16]>]` — recompute the pair
 * and the token is never read. (Verified 2026-09-24 for kimi 2.0.1:
 * `packages/oauth/src/managed-kimi-code.ts` — mechanism identical to the
 * 0.41.0-era measurement this library started from.) Without `[thinking]`
 * the run would use the model's default effort instead of the configured
 * one. Other root-table settings are not carried.
 *
 * config.toml is written as a regular file: the engine persists config via
 * tmp+rename, which would silently replace a symlink. An existing
 * config.toml that is not a regular file is refused.
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
  const configText = readFileSync(srcConfigPath, 'utf-8');

  const modelAlias = scalar(configText, 'default_model');
  if (modelAlias === undefined) {
    throw new Error(`no default_model in ${srcConfigPath}`);
  }
  const modelSection = extractSection(configText, `[models."${modelAlias}"]`);
  if (modelSection === undefined) {
    throw new Error(`no [models."${modelAlias}"] in ${srcConfigPath}`);
  }
  const provider = scalar(modelSection, 'provider');
  if (provider === undefined) {
    throw new Error(`no provider in [models."${modelAlias}"]`);
  }
  const providerSection = extractSection(configText, `[providers."${provider}"]`);
  if (providerSection === undefined) {
    throw new Error(`no [providers."${provider}"] in ${srcConfigPath}`);
  }
  const thinkingSection = extractSection(configText, '[thinking]');
  if (thinkingSection === undefined && /^\s*thinking\s*[.=]/m.test(rootTable(configText))) {
    throw new Error(
      `${srcConfigPath} configures thinking outside a [thinking] table; ` +
        'refusing rather than dropping it',
    );
  }

  const home = canonicalPath(dst);
  const configPath = join(dst, 'config.toml');
  const existingConfig = lstatSync(join(home, 'config.toml'), { throwIfNoEntry: false });
  if (existingConfig !== undefined && !existingConfig.isFile()) {
    throw new Error(`refusing to replace ${configPath}: not a regular file`);
  }
  const donation = planDonation(src, dst, mode);

  // Effects start here; every refusal above left both homes untouched.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  applyDonation(donation);

  const sections = [providerSection, modelSection];
  if (thinkingSection !== undefined) sections.push(thinkingSection);
  const config = `default_model = "${modelAlias}"\n\n${sections.join('\n\n')}\n`;
  writeFileSync(configPath, config, { mode: 0o600 });

  return { home: dst, configPath, modelAlias, provider };
}

/**
 * Remove `<home>/credentials` only when it is the marker-stamped copy
 * this library made. Linked or hand-prepared credentials have no marker and
 * are never touched. When `srcHome` is given, a copy that no longer matches
 * the source byte for byte is refused (thrown) and kept: a refresh inside it
 * may have left it holding the only current refresh token. Returns whether
 * it shredded.
 */
export function shredCopiedCredentials(home: string, srcHome?: string): boolean {
  const credentials = join(resolve(home), 'credentials');
  if (!isMarkedCopy(credentials)) return false;
  if (srcHome !== undefined) {
    assertCopyMatchesSource(join(resolve(srcHome), 'credentials'), credentials);
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
 * files are not touched. When `srcHome` is given, a credentials copy that no
 * longer matches it is refused as in shredCopiedCredentials, and the whole
 * home is kept.
 */
export function removeHome(home: string, srcHome?: string): void {
  if (!existsSync(join(home, EPHEMERAL_MARKER))) {
    throw new Error(`refusing to remove ${home}: not created by makeEphemeralHome()`);
  }
  if (srcHome !== undefined) shredCopiedCredentials(home, srcHome);
  rmSync(home, { recursive: true, force: true });
}
