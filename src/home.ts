import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * `providers`/`models` sections of a managed config.toml.
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

/** Stamp left inside a credentials dir copied by this library. */
export const CREDENTIALS_MARKER = '.bare-kimi-copied';

/** Stamp left at the root of a home created by makeEphemeralHome(). */
export const EPHEMERAL_MARKER = '.bare-kimi-ephemeral';

function refuseSelf(srcHome: string, dstHome: string): void {
  if (resolve(srcHome) === resolve(dstHome)) {
    throw new Error('source and destination home are the same directory; refusing');
  }
}

function copyCredentials(srcHome: string, dstHome: string): void {
  const srcCredentials = join(srcHome, 'credentials');
  if (!existsSync(srcCredentials)) {
    throw new Error(`no credentials directory in source home ${srcHome}`);
  }
  const dstCredentials = join(dstHome, 'credentials');
  if (existsSync(dstCredentials) && !existsSync(join(dstCredentials, CREDENTIALS_MARKER))) {
    throw new Error(
      `refusing to overwrite unmarked credentials directory at ${dstCredentials}`,
    );
  }
  mkdirSync(dstCredentials, { recursive: true, mode: 0o700 });
  chmodSync(dstCredentials, 0o700);
  for (const entry of readdirSync(srcCredentials)) {
    const from = join(srcCredentials, entry);
    if (!statSync(from).isFile()) continue;
    const to = join(dstCredentials, entry);
    copyFileSync(from, to);
    chmodSync(to, 0o600);
  }
  writeFileSync(join(dstCredentials, CREDENTIALS_MARKER), '', { mode: 0o600 });
}

/**
 * Replace `dstPath` with a directory symlink to `srcPath`. An existing
 * symlink is re-pointed; a marker-stamped credentials copy made by this
 * library is removed; anything else that already occupies the path is
 * caller-owned and is never touched.
 */
function replaceWithDirLink(srcPath: string, dstPath: string, isMarkedCopy: boolean): void {
  if (lstatSync(dstPath, { throwIfNoEntry: false }) !== undefined) {
    if (lstatSync(dstPath).isSymbolicLink()) {
      unlinkSync(dstPath);
    } else if (isMarkedCopy) {
      rmSync(dstPath, { recursive: true, force: true });
    } else {
      throw new Error(`refusing to replace caller-owned entry at ${dstPath}`);
    }
  }
  symlinkSync(srcPath, dstPath, 'dir');
}

/**
 * Link `<dstHome>/credentials` and `<dstHome>/oauth` to the source home's
 * directories. `oauth/` is created in the SOURCE home when missing (mode
 * 0700): the native CLI creates it on first refresh anyway, and without it
 * the run would fall back to a per-home lock — silently defeating the shared
 * refresh serialization that is the point of link mode.
 */
function linkCredentials(srcHome: string, dstHome: string): void {
  const srcCredentials = join(srcHome, 'credentials');
  if (!existsSync(srcCredentials)) {
    throw new Error(`no credentials directory in source home ${srcHome}`);
  }
  const srcOauth = join(srcHome, 'oauth');
  mkdirSync(srcOauth, { recursive: true, mode: 0o700 });
  const dstCredentials = join(dstHome, 'credentials');
  replaceWithDirLink(
    srcCredentials,
    dstCredentials,
    existsSync(join(dstCredentials, CREDENTIALS_MARKER)),
  );
  const dstOauth = join(dstHome, 'oauth');
  replaceWithDirLink(srcOauth, dstOauth, false);
}

/**
 * Give `dstHome` working authentication from `srcHome` according to `mode`.
 */
export function donateAuth(srcHome: string, dstHome: string, mode: AuthMode = 'link'): void {
  refuseSelf(srcHome, dstHome);
  if (mode === 'link') {
    linkCredentials(srcHome, dstHome);
  } else {
    copyCredentials(srcHome, dstHome);
  }
}

/**
 * Re-donate authentication on a kept home whose previous donation is gone
 * (shredded copy or removed link). A no-op when `credentials` already
 * exists — hand-placed or `--keep-credentials` material is left alone.
 * Returns whether it donated.
 */
export function ensureAuth(srcHome: string, dstHome: string, mode: AuthMode = 'link'): boolean {
  if (existsSync(join(dstHome, 'credentials'))) return false;
  donateAuth(srcHome, dstHome, mode);
  return true;
}

/**
 * Turn `dstHome` into a runnable minimal KIMI_CODE_HOME: authentication
 * donated from `srcHome` (link by default), and a config.toml carrying
 * `default_model` + the provider section + the model alias section VERBATIM
 * from `srcHome`'s config.toml. Verbatim matters: the credential slot is
 * `kimi-code[-env-<sha256({oauthHost, baseUrl})[:16]>]` — recompute the pair
 * and the token is never read. (Verified 2026-09-24 for kimi 2.0.1:
 * `packages/oauth/src/managed-kimi-code.ts` — mechanism identical to the
 * 0.41.0-era measurement this library started from.)
 *
 * config.toml is written as a regular file: the engine persists config via
 * tmp+rename, which would silently replace a symlink.
 */
export function assembleHome(
  srcHome: string,
  dstHome: string,
  mode: AuthMode = 'link',
): AssembledHome {
  refuseSelf(srcHome, dstHome);
  const srcConfigPath = join(srcHome, 'config.toml');
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

  mkdirSync(dstHome, { recursive: true, mode: 0o700 });
  chmodSync(dstHome, 0o700);

  donateAuth(srcHome, dstHome, mode);

  const config = `default_model = "${modelAlias}"\n\n${providerSection}\n\n${modelSection}\n`;
  const configPath = join(dstHome, 'config.toml');
  writeFileSync(configPath, config, { mode: 0o600 });

  return { home: dstHome, configPath, modelAlias, provider };
}

/**
 * Remove `<home>/credentials` only when it carries the marker copyCredentials
 * leaves behind — i.e. the copy THIS library made. Linked or hand-prepared
 * homes have no marker and are never touched. Returns whether it shredded.
 */
export function shredCopiedCredentials(home: string): boolean {
  const credentials = join(home, 'credentials');
  if (!existsSync(join(credentials, CREDENTIALS_MARKER))) return false;
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
 * files are not touched.
 */
export function removeHome(home: string): void {
  if (!existsSync(join(home, EPHEMERAL_MARKER))) {
    throw new Error(`refusing to remove ${home}: not created by makeEphemeralHome()`);
  }
  rmSync(home, { recursive: true, force: true });
}
