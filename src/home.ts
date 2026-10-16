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
 *   {@link HOME_STAMP}: the canonical source home it came from, the model
 *   alias and thinking effort it is pinned to, and a digest of the settings
 *   in the config.toml it wrote. Only an empty directory or a stamped home is
 *   used; a stamped home only with the same source, only on the model and
 *   effort it is pinned to, and only while its config.toml still holds what
 *   was written (comments may change) or what the source now yields. A
 *   `config.toml` alone proves nothing: it is a common file name. An
 *   unstamped home kept by bare-kimi before 0.2 is used only when the caller
 *   asks to adopt it, and only when its own shape shows a home assembled from
 *   this source (see {@link ADOPTION_RECORD}).
 * - Pinning follows native kimi (2.1.0, `-p`): a session is bound to the
 *   model alias and the effort it was created with, and a resume looks the
 *   alias up in config.toml again. A kept home therefore keeps its alias when
 *   the source's default_model changes, and refuses a different one; the
 *   alias's own settings and the carried tables still follow the source.
 * - Every refusal happens before the first effect. An entry this library did
 *   not make — a real directory, a file, a symlink pointing anywhere but the
 *   intended source — is caller-owned and is never removed or re-pointed.
 *   An existing run-home directory keeps its permissions. A marker-stamped
 *   copy is library-made, but is discarded only when it provably holds
 *   nothing the source lacks (see {@link CREDENTIALS_MARKER}).
 * - Effects, in order: a missing run home is created with mode 0700 and
 *   stamped (an adopted home gets its evidence record, then its stamp), the
 *   source home's oauth/ is created when missing (link mode), credentials are
 *   donated, config.toml is written (tmp file + rename) when missing or when
 *   the source's settings changed, and the stamp is updated.
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
  /** The model alias the run home carries as its default_model, and is pinned to. */
  readonly modelAlias: string;
  readonly provider: string;
  /** The provider's `type` (`kimi`, `openai`, …), when the source sets one. */
  readonly providerType: string | undefined;
  /** The model's `model` field, the id kimi sends to the provider, when set. */
  readonly modelId: string | undefined;
  /**
   * The thinking effort the home is pinned to: one chosen with `effort`, or
   * null when the home carries the source's own `[thinking]` table (or none).
   * It is configured for new sessions. A resumed session runs at the effort
   * it stored when it was created, and kimi may run another one when
   * {@link AssembledHome.effortSupport} is `undeclared`.
   */
  readonly effort: string | null;
  /**
   * How the pinned effort relates to what the source config declares about
   * the model's thinking (null when no effort is pinned):
   * - `declared`: the model's table (its `overrides` winning) declares its
   *   thinking support, and the effort agrees with it;
   * - `undeclared`: the table declares nothing to check the effort against
   *   (no `support_efforts`, and for `off` no thinking metadata at all), so
   *   kimi decides at run time. kimi 2.1.0 sends a non-`kimi` provider the
   *   string as given. On a `kimi`-type provider it validates the effort
   *   against model metadata that bare-kimi does not read; for the managed
   *   provider that comes from the provider's `/models` catalog. It may then
   *   run the model's default effort or none.
   */
  readonly effortSupport: EffortSupport | null;
  /**
   * The effort the home's config.toml gives a new session: the pinned
   * effort, else the source `[thinking]`'s (`off` when it disables
   * thinking), else null — kimi then uses the model's default effort.
   */
  readonly configuredEffort: string | null;
  /** The canonical source home the run home is stamped with. */
  readonly source: string;
  /** What preparing did (or, from {@link previewRunHome}, would do). */
  readonly action: 'create' | 'reuse' | 'adopt';
  /** The home was adopted from a home kept before 0.2, now or earlier. */
  readonly adopted: boolean;
}

/**
 * Choices for {@link prepareRunHome}. Every one is checked before the first
 * effect.
 */
export interface RunHomeOptions {
  /**
   * Re-donate authentication in full, as {@link donateAuth} does (an
   * unchanged bare-kimi copy may be replaced); otherwise present credentials
   * are used as they are, once they pair with the source (see
   * {@link ensureAuth}).
   */
  readonly reassemble?: boolean;
  /**
   * The model alias to carry. It must be configured in the source. Omitted:
   * the alias a kept home is pinned to, else the source's default_model. A
   * kept home refuses another alias.
   */
  readonly model?: string;
  /**
   * The thinking effort to write into the run home's `[thinking]` and pin:
   * one of the model's `support_efforts`, or `off`. When the model declares
   * no `support_efforts`, any effort name is taken and reported as
   * `undeclared` (see {@link AssembledHome.effortSupport}). Omitted: a new
   * home carries the source's `[thinking]`; a kept home keeps its pin. A kept
   * home refuses another effort.
   */
  readonly effort?: string;
  /**
   * Allow an unstamped, non-empty run home to be adopted as one bare-kimi
   * assembled before 0.2, when its shape shows that (see
   * {@link ADOPTION_RECORD}). No effect on a missing, empty or stamped home.
   */
  readonly adoptLegacyHome?: boolean;
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
 * - `thinking` — the configured effort (kimi 2.1.0 keys: `enabled`,
 *   `effort`, `keep`); without it a new session gets the model's default
 *   effort. A selected effort replaces it (see {@link selectedThinking});
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
  readonly providerType: string | undefined;
  readonly modelId: string | undefined;
  /** The selected effort, or null when the source's `[thinking]` is carried. */
  readonly effort: string | null;
  /** See {@link AssembledHome.effortSupport}. */
  readonly effortSupport: EffortSupport | null;
  /** See {@link AssembledHome.configuredEffort}. */
  readonly configuredEffort: string | null;
  /** {@link settingsDigest} of `text`. */
  readonly digest: string;
}

/** The model alias (default: the source's default_model) and effort (null: the source's `[thinking]`) to carry. */
interface Selection {
  readonly model?: string | undefined;
  readonly effort: string | null;
}

/**
 * The model's settings as kimi uses them: its `overrides` table over the
 * model's own fields (kimi 2.1.0 `effectiveModelConfig`).
 */
function effectiveModel(model: TomlTable): TomlTable {
  const { overrides, ...base } = model;
  return isTable(overrides) ? { ...base, ...overrides } : base;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

function configuresModel(source: TomlTable, alias: string): boolean {
  const models = source['models'];
  return isTable(models) && isTable(models[alias]);
}

const EFFORT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** See {@link AssembledHome.effortSupport}. */
export type EffortSupport = 'declared' | 'undeclared';

/**
 * Check a selected effort against what the source config declares about the
 * model (its `overrides` already applied), refusing what that declaration
 * contradicts and reporting what it leaves open.
 *
 * As read from the installed kimi 2.1.0 bundle: a new session's effort comes
 * from `[thinking]` (`enabled = false` is `off`, else `effort`, else the
 * model's default) and is stored with the session. Whether kimi validates
 * the effort depends on the provider type (`requiresStrictThinkingValidation`;
 * this library reads only the `kimi` type as strict). A strict type replaces
 * an effort the model does not list with the model's default, and runs a
 * model without thinking with thinking off. Other types "receive effort
 * strings without client-side mapping". kimi's own registry import marks a
 * model as thinking when it has `reasoning` or a non-empty `support_efforts`
 * (`capabilitiesFromCustomEntry`), and may leave `support_efforts` out. A
 * managed model's efforts come from the provider's `/models` catalog
 * (`parseThinkEfforts`), which this library does not read: it makes no
 * network or login reads.
 *
 * So, on every provider type:
 * - an effort that is not a lowercase name is refused;
 * - `off` is refused for a model declared always-thinking;
 * - another effort is refused for a model whose declaration excludes
 *   thinking: a `capabilities` list without it and no `support_efforts`;
 * - an effort missing from a declared `support_efforts` is refused. A strict
 *   type would silently run another effort, and kimi's provider-error hint
 *   tells users to choose an effort the model supports;
 * - anything else the declaration does not settle is accepted as
 *   `undeclared`, not refused: unknown support is not taken for no support.
 */
function checkEffort(effort: string, alias: string, model: TomlTable): EffortSupport {
  if (!EFFORT_NAME.test(effort)) {
    throw new Error(`effort ${JSON.stringify(effort)} is not a lowercase effort name; refusing`);
  }
  const capabilities = model['capabilities'];
  const listed = stringList(capabilities).map((item) => item.toLowerCase());
  const efforts = stringList(model['support_efforts']);
  const always = model['always_thinking'] === true || listed.includes('always_thinking');
  const thinks =
    always ||
    model['adaptive_thinking'] === true ||
    listed.includes('thinking') ||
    (isTable(capabilities) && capabilities['thinking'] === true) ||
    efforts.length > 0;
  const declaresThinking =
    capabilities !== undefined ||
    efforts.length > 0 ||
    typeof model['always_thinking'] === 'boolean' ||
    typeof model['adaptive_thinking'] === 'boolean';
  if (effort === 'off') {
    if (always) throw new Error(`model "${alias}" always thinks, so kimi would ignore effort "off"; refusing`);
    return declaresThinking ? 'declared' : 'undeclared';
  }
  if (declaresThinking && !thinks) {
    throw new Error(`model "${alias}" is declared without thinking, so effort "${effort}" would not run as asked; refusing`);
  }
  if (efforts.length === 0) return 'undeclared';
  if (!efforts.includes(effort)) {
    throw new Error(
      `effort "${effort}" is not one of model "${alias}"'s support_efforts (${efforts.join(', ')}); refusing`,
    );
  }
  return 'declared';
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * The `[thinking]` table for a selected effort: `enabled = false` for `off`,
 * else `enabled = true` and `effort`. The source table's other keys (such as
 * `keep`) are kept when they are plain strings or booleans; anything else is
 * refused rather than dropped, as is a `forced_effort`, which would override
 * the selection on every request.
 */
function selectedThinking(source: TomlTable, where: string, effort: string): { text: string; value: TomlTable } {
  const value: TomlTable = effort === 'off' ? { enabled: false } : { enabled: true, effort };
  const configured = source['thinking'];
  if (isTable(configured)) {
    for (const [key, item] of Object.entries(configured)) {
      if (key === 'enabled' || key === 'effort') continue;
      if (key === 'forced_effort' || key === 'forcedEffort') {
        throw new Error(`${where}: [thinking].${key} would override the selected effort on every request; refusing`);
      }
      if (typeof item !== 'string' && typeof item !== 'boolean') {
        throw new Error(`${where}: [thinking].${key} cannot be carried beside a selected effort; refusing`);
      }
      value[key] = item;
    }
  }
  const lines = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${JSON.stringify(item)}`);
  return { text: ['[thinking]', ...lines].join('\n'), value };
}

/** The effort a `[thinking]` table gives a new session, or null for the model's default. */
function thinkingEffort(thinking: unknown): string | null {
  if (!isTable(thinking)) return null;
  if (thinking['enabled'] === false) return 'off';
  const effort = thinking['effort'];
  return typeof effort === 'string' && effort.trim().length > 0 ? effort.trim().toLowerCase() : null;
}

/**
 * Build a run home's config.toml from the source config: `default_model`
 * naming the selected alias (default: the source's default_model), that
 * model's `[models."<alias>"]` and its `[providers."<name>"]` (with
 * sub-tables), and every {@link CARRIED_TABLES} table — each table copied as
 * text, VERBATIM — except that a selected effort replaces `[thinking]`. No
 * other model or provider is carried: their tables may hold API keys that
 * this run does not use. Verbatim matters: the credential slot is
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
function minimalConfig(configText: string, source: TomlTable, where: string, selection: Selection): MinimalConfig {
  const modelAlias = selection.model ?? source['default_model'];
  if (typeof modelAlias !== 'string') {
    throw new Error(`no default_model in the root table of ${where}`);
  }
  const models = source['models'];
  const model = isTable(models) ? models[modelAlias] : undefined;
  if (!isTable(model)) {
    throw new Error(
      selection.model === undefined
        ? `no [models."${modelAlias}"] in ${where}`
        : `model "${modelAlias}" is not configured in ${where}; refusing`,
    );
  }
  const provider = model['provider'];
  if (typeof provider !== 'string') throw new Error(`no provider in [models."${modelAlias}"]`);
  const providers = source['providers'];
  const providerTable = isTable(providers) ? providers[provider] : undefined;
  if (!isTable(providerTable)) throw new Error(`no [providers."${provider}"] in ${where}`);
  const { effort } = selection;
  const effortSupport = effort === null ? null : checkEffort(effort, modelAlias, effectiveModel(model));

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
    if (key === 'thinking' && effort !== null) continue; // replaced by the selected effort below
    if (Object.hasOwn(source, key)) {
      prefixes.push([key]);
      expected[key] = source[key];
    }
  }

  const sections = tableBlocks(configText)
    .filter((block) => prefixes.some((prefix) => isUnder(block.path, prefix)))
    .map((block) => block.text);
  if (effort !== null) {
    const thinking = selectedThinking(source, where, effort);
    sections.push(thinking.text);
    expected['thinking'] = thinking.value;
  }
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
  const providerType = providerTable['type'];
  const modelId = model['model'];
  return {
    text,
    modelAlias,
    provider,
    providerType: typeof providerType === 'string' ? providerType : undefined,
    modelId: typeof modelId === 'string' ? modelId : undefined,
    effort,
    effortSupport,
    configuredEffort: thinkingEffort(expected['thinking']),
    digest: settingsDigest(carried),
  };
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
 * ownership, the canonical source home it was assembled from, the model
 * alias and effort it is pinned to, and the digest of the settings in the
 * config.toml it last wrote. Version 2 since bare-kimi 0.3; a version-1
 * stamp (0.2) is read, taken as pinned to the alias its config.toml holds
 * (see {@link pinnedSelection} for a missing config.toml), and upgraded on
 * the next write. bare-kimi 0.2 refuses a version-2 stamp.
 */
export const HOME_STAMP = '.bare-kimi-home';

/**
 * Directory an adopted home keeps as evidence of what it was before
 * adoption: `config.toml`, byte for byte as found, and `manifest.json` (the
 * source, the model alias its sessions are bound to, the effort its
 * config.toml configured for new sessions, how its credentials were held,
 * and the SHA-256 of every file under `sessions/` at adoption). Adoption
 * never changes `sessions/`.
 *
 * A non-empty home without {@link HOME_STAMP} is adopted only when asked
 * (`adoptLegacyHome`) and only when all of this holds:
 * - the run-home path itself is not a symlink, and the home is not the source
 *   home or nested with it;
 * - `config.toml` is a regular file that parses, with a root `default_model`,
 *   that model's table and its provider's table; the source configures the
 *   same alias on the same provider, and that provider's table is identical
 *   in both — the credential slot depends on it;
 * - `credentials` is a directory link into this source, with `oauth` absent
 *   or the paired link into the same source; or a real directory carrying
 *   bare-kimi's copy marker, with `oauth` absent or a real directory; or, in
 *   copy mode only, absent, as a pre-0.2 copy-mode run left it;
 * - `sessions`, when present, is a real directory;
 * - a model or effort the caller asks for is the one the home is pinned to
 *   (below).
 *
 * The home is pinned to its `default_model`: native kimi binds each session
 * to its alias. When its `[thinking]` differs from the source's, it is also
 * pinned to the effort that table names, and that effort is checked like a
 * selected one. That pin is the effort the home's config.toml gave new
 * sessions when it was found. It says nothing about the effort its existing
 * sessions ran at: each stored its own when created, perhaps under an
 * earlier config.toml, and a `kimi`-type provider may have replaced an
 * effort the model did not list. A resume keeps each session's stored
 * effort whatever the pin says.
 *
 * Effects, in order: the record is written into a temporary directory and
 * renamed into place; the stamp is written, recording the found settings as
 * the ones bare-kimi last wrote; then, as for any stamped home, a missing
 * `oauth` link is restored and config.toml is rewritten from the source for
 * the home's model and effort. An interruption anywhere leaves a home the
 * next adoption or run completes: an existing record is kept, not replaced,
 * as long as it records the config.toml found; otherwise adoption is
 * refused. A leftover `.bare-kimi-adopted.tmp-*` directory is harmless.
 */
export const ADOPTION_RECORD = '.bare-kimi-adopted';

interface HomeStamp {
  readonly version: 1 | 2;
  /** Canonical path of the source home. */
  readonly source: string;
  /** {@link settingsDigest} of the config.toml this library last wrote. */
  readonly config: string;
  /** The pinned model alias; undefined for a version-1 stamp, which pinned none. */
  readonly model: string | undefined;
  /** The pinned effort; null follows the source's `[thinking]`. */
  readonly effort: string | null;
  readonly adopted: boolean;
}

/** What a written stamp records; always version 2. */
interface StampFields {
  readonly source: string;
  readonly model: string;
  readonly effort: string | null;
  readonly config: string;
  readonly adopted: boolean;
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
  const stamp: TomlTable = isTable(parsed) ? parsed : {};
  const { version, source, config, model, effort, adopted } = stamp;
  if (typeof source === 'string' && typeof config === 'string') {
    if (version === 1) return { version: 1, source, config, model: undefined, effort: null, adopted: false };
    if (
      version === 2 &&
      typeof model === 'string' &&
      (typeof effort === 'string' || effort === null) &&
      (adopted === undefined || typeof adopted === 'boolean')
    ) {
      return { version: 2, source, config, model, effort, adopted: adopted === true };
    }
  }
  throw new Error(`${path} is not a stamp this version of bare-kimi wrote; refusing`);
}

/** Replace `path` with `text` in one rename, so no reader sees half of it. */
function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function writeHomeStamp(home: string, stamp: StampFields): void {
  const record = {
    version: 2,
    source: stamp.source,
    model: stamp.model,
    effort: stamp.effort,
    config: stamp.config,
    ...(stamp.adopted ? { adopted: true } : {}),
  };
  writeFileAtomic(join(home, HOME_STAMP), `${JSON.stringify(record)}\n`);
}

/** The manifest written into {@link ADOPTION_RECORD}. */
interface AdoptionManifest {
  readonly version: 1;
  readonly at: string;
  readonly source: string;
  /** The alias the found config.toml names: the one its sessions are bound to. */
  readonly model: string;
  /**
   * The effort the found config.toml configured for new sessions, when it
   * differs from the source's (else null). Not the effort of any existing
   * session.
   */
  readonly configuredEffort: string | null;
  readonly config: { readonly sha256: string };
  readonly credentials: 'link' | 'copy' | 'absent';
  readonly oauth: 'link' | 'directory' | 'absent';
  /** Path under sessions/ → `sha256:<hex>` for a file, `link:<target>` for a symlink, `other` otherwise. */
  readonly sessions: Readonly<Record<string, string>>;
}

interface AdoptionPlan {
  /** An interrupted adoption already wrote the record; it is kept. */
  readonly recorded: boolean;
  /** config.toml exactly as found. */
  readonly preimage: Buffer;
  readonly manifest: AdoptionManifest;
  /** {@link settingsDigest} of the found config.toml, stamped as last written. */
  readonly legacyDigest: string;
  readonly donation: Donation | undefined;
}

/** What preparing a run home will do, decided in full before any effect. */
interface RunHomePlan {
  /** Canonical run-home path, for the effects that follow. */
  readonly home: string;
  readonly action: 'create' | 'reuse' | 'adopt';
  readonly create: boolean;
  /** The home's stamp as found; undefined for a new, empty or adopted home. */
  readonly stamp: HomeStamp | undefined;
  readonly config: MinimalConfig;
  readonly writeConfig: boolean;
  readonly adoption: AdoptionPlan | undefined;
}

function describeEffort(effort: string | null): string {
  return effort === null ? "the source's [thinking]" : `effort "${effort}"`;
}

/** The home holds a `sessions` entry with something in it (or one that is not a directory). */
function holdsSessions(home: string): boolean {
  const sessions = join(home, 'sessions');
  const stat = lstatSync(sessions, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  return !stat.isDirectory() || readdirSync(sessions).length > 0;
}

/**
 * The alias whose config, as the source yields it now with the source's own
 * `[thinking]`, has the settings digest `digest`, if any. Each alias yields
 * its own `default_model`, so at most one matches.
 */
function aliasYielding(sourceText: string, source: TomlTable, sourceWhere: string, digest: string): string | undefined {
  const models = source['models'];
  if (!isTable(models)) return undefined;
  for (const alias of Object.keys(models)) {
    try {
      if (minimalConfig(sourceText, source, sourceWhere, { model: alias, effort: null }).digest === digest) return alias;
    } catch {
      // An alias the source cannot carry yields no config, so no digest.
    }
  }
  return undefined;
}

/**
 * The model and effort a stamped home is pinned to. A version-1 stamp (0.2)
 * pinned nothing: that home followed the source's default_model and carried
 * the source's `[thinking]`, so its effort pin is null. Its alias is:
 * - with config.toml present: the default_model there, while it holds what
 *   0.2 last wrote; otherwise the source's default_model, and an edited file
 *   is then refused unless it equals what the source yields for that alias;
 * - with config.toml missing: the alias whose config, as the source yields it
 *   now, has the stamp's digest. The digest covers the default_model that
 *   0.2 wrote, so a match proves that alias. That rests on 0.2 and this
 *   version computing the same digest, which one reuse of a home assembled
 *   by 0.2 showed. A digest that disagrees proves nothing, and the steps
 *   below apply. Without a match, the caller's
 *   `model` is taken. A home without sessions follows the source's
 *   default_model, since no session is bound to an alias. Anything else is
 *   refused: the alias its sessions are bound to cannot be read.
 */
function pinnedSelection(
  stamp: HomeStamp,
  home: string,
  current: TomlTable | undefined,
  digest: string | undefined,
  request: RunHomeOptions,
  sourceText: string,
  source: TomlTable,
  sourceWhere: string,
): { readonly model: string; readonly effort: string | null } {
  if (stamp.model !== undefined) return { model: stamp.model, effort: stamp.effort };
  const followed = (): { model: string; effort: null } => {
    const model = source['default_model'];
    if (typeof model !== 'string') throw new Error(`no default_model in the root table of ${sourceWhere}`);
    return { model, effort: null };
  };
  if (current !== undefined) {
    const written = current['default_model'];
    if (digest === stamp.config && typeof written === 'string') return { model: written, effort: null };
    return followed();
  }
  const proven = aliasYielding(sourceText, source, sourceWhere, stamp.config);
  if (proven !== undefined) return { model: proven, effort: null };
  if (request.model !== undefined) return { model: request.model, effort: null };
  if (!holdsSessions(home)) return followed();
  throw new Error(
    `run home ${home} has a bare-kimi 0.2 stamp but no config.toml, and the source no longer yields the ` +
      'settings that stamp records, so the model alias its sessions are bound to is unknown; ' +
      'name it explicitly (model, CLI --model)',
  );
}

/**
 * Decide how the run home relates to `source` (canonical) and what the
 * source yields for the requested or pinned model and effort. Refuses:
 * - an existing non-directory;
 * - a non-empty directory without {@link HOME_STAMP} — this library did not
 *   assemble it, whatever it holds — unless adoption was asked for and its
 *   shape allows it (see {@link ADOPTION_RECORD});
 * - a stamped home from another source;
 * - a model or effort other than the one a stamped home is pinned to, and a
 *   source that no longer configures the pinned model;
 * - a 0.2-stamped home with sessions but no config.toml, whose alias neither
 *   the stamp nor the caller establishes (see {@link pinnedSelection});
 * - a config.toml that is not a regular file, or no longer parses;
 * - a config.toml whose settings differ both from what was last written
 *   (it was edited) and from what the source yields now.
 *
 * A config.toml whose settings equal the source's is kept byte for byte
 * (comments survive). One that still holds exactly what was last written,
 * while the source changed, is rewritten from the source.
 */
function planRunHome(
  dst: string,
  source: string,
  src: string,
  sourceText: string,
  sourceWhere: string,
  request: RunHomeOptions,
  mode: AuthMode,
): RunHomePlan {
  const parsed = parseToml(sourceText, sourceWhere);
  const home = canonicalPath(dst);
  const stat = statIfPresent(home);
  const fresh = (create: boolean): RunHomePlan => ({
    home,
    action: 'create',
    create,
    stamp: undefined,
    config: minimalConfig(sourceText, parsed, sourceWhere, { model: request.model, effort: request.effort ?? null }),
    writeConfig: true,
    adoption: undefined,
  });
  if (stat === undefined) return fresh(true);
  if (!stat.isDirectory()) throw new Error(`run home ${home} exists and is not a directory`);
  const stamp = readHomeStamp(home);
  if (stamp === undefined) {
    const entries = readdirSync(home).filter((entry) => entry !== EPHEMERAL_MARKER);
    if (entries.length === 0) return fresh(false);
    if (request.adoptLegacyHome !== true) {
      throw new Error(
        `refusing to use ${home}: it is not empty and has no ${HOME_STAMP}, ` +
          'so it is not a run home bare-kimi assembled; a home kept by bare-kimi before 0.2 ' +
          'can be adopted explicitly (adoptLegacyHome, CLI --adopt-legacy-home)',
      );
    }
    return planAdoption(dst, home, source, src, sourceText, parsed, sourceWhere, request, mode);
  }
  if (stamp.source !== source) {
    throw new Error(`run home ${home} was assembled from ${stamp.source}, not ${source}; refusing`);
  }
  const configPath = join(home, 'config.toml');
  const current = lstatSync(configPath, { throwIfNoEntry: false });
  if (current !== undefined && !current.isFile()) throw new Error(`refusing to use ${configPath}: not a regular file`);
  const currentTable = current === undefined ? undefined : parseToml(readFileSync(configPath, 'utf-8'), configPath);
  const digest = currentTable === undefined ? undefined : settingsDigest(currentTable);
  const pinned = pinnedSelection(stamp, home, currentTable, digest, request, sourceText, parsed, sourceWhere);
  if (request.model !== undefined && request.model !== pinned.model) {
    throw new Error(
      `run home ${home} is pinned to model "${pinned.model}", the alias its sessions are bound to; ` +
        `refusing model "${request.model}" (use another home for it)`,
    );
  }
  if (request.effort !== undefined && request.effort !== pinned.effort) {
    throw new Error(
      `run home ${home} is pinned to ${describeEffort(pinned.effort)}, the effort it configures for new ` +
        `sessions; refusing effort "${request.effort}" (use another home for it)`,
    );
  }
  if (!configuresModel(parsed, pinned.model)) {
    throw new Error(
      `run home ${home} is pinned to model "${pinned.model}", which ${sourceWhere} no longer configures; ` +
        'its sessions are bound to that alias, so the home is refused rather than switched',
    );
  }
  const config = minimalConfig(sourceText, parsed, sourceWhere, pinned);
  if (digest !== undefined && digest !== config.digest && digest !== stamp.config) {
    throw new Error(
      `refusing to use ${configPath}: its settings were edited since bare-kimi wrote it, ` +
        'and they differ from what the source home now yields',
    );
  }
  return { home, action: 'reuse', create: false, stamp, config, writeConfig: digest !== config.digest, adoption: undefined };
}

/** Plan the adoption of an unstamped home; see {@link ADOPTION_RECORD} for what is required. */
function planAdoption(
  dst: string,
  home: string,
  source: string,
  src: string,
  sourceText: string,
  parsed: TomlTable,
  sourceWhere: string,
  request: RunHomeOptions,
  mode: AuthMode,
): RunHomePlan {
  const refusal = (why: string): Error => new Error(`refusing to adopt ${home}: ${why}`);
  if (lstatSync(dst).isSymbolicLink()) throw refusal('the run-home path is a symlink; name the home directory itself');

  const configPath = join(home, 'config.toml');
  if (lstatSync(configPath, { throwIfNoEntry: false })?.isFile() !== true) {
    throw refusal(`${configPath} is missing or not a regular file`);
  }
  const preimage = readFileSync(configPath);
  const legacy = parseToml(preimage.toString('utf-8'), configPath);
  const model = legacy['default_model'];
  if (typeof model !== 'string') throw refusal(`${configPath} has no default_model in its root table`);
  const legacyModels = legacy['models'];
  const legacyModel = isTable(legacyModels) ? legacyModels[model] : undefined;
  if (!isTable(legacyModel)) throw refusal(`${configPath} has no [models."${model}"]`);
  const provider = legacyModel['provider'];
  if (typeof provider !== 'string') throw refusal(`[models."${model}"] in ${configPath} names no provider`);
  const legacyProviders = legacy['providers'];
  const legacyProvider = isTable(legacyProviders) ? legacyProviders[provider] : undefined;
  if (!isTable(legacyProvider)) throw refusal(`${configPath} has no [providers."${provider}"]`);
  const sourceModels = parsed['models'];
  const sourceModel = isTable(sourceModels) ? sourceModels[model] : undefined;
  if (!isTable(sourceModel)) throw refusal(`its sessions use model "${model}", which ${sourceWhere} does not configure`);
  if (sourceModel['provider'] !== provider) throw refusal(`${sourceWhere} configures model "${model}" on another provider`);
  const sourceProviders = parsed['providers'];
  const sourceProvider = isTable(sourceProviders) ? sourceProviders[provider] : undefined;
  if (!isTable(sourceProvider) || canonicalToml(sourceProvider) !== canonicalToml(legacyProvider)) {
    throw refusal(
      `its [providers."${provider}"] differs from the one in ${sourceWhere}, so it was not assembled from this source`,
    );
  }

  // An effort the consumer wrote into the home is what it configured for new
  // sessions, and stays so; one equal to the source's is just the source's.
  // Neither tells what its existing sessions ran at (see ADOPTION_RECORD).
  const effort =
    Object.hasOwn(legacy, 'thinking') && canonicalToml(legacy['thinking']) !== canonicalToml(parsed['thinking'])
      ? thinkingEffort(legacy['thinking'])
      : null;
  if (request.model !== undefined && request.model !== model) {
    throw refusal(`its sessions are bound to model "${model}"; refusing model "${request.model}"`);
  }
  if (request.effort !== undefined && request.effort !== effort) {
    throw refusal(
      `its config.toml configures ${describeEffort(effort)} for new sessions; refusing effort "${request.effort}"`,
    );
  }
  const config = minimalConfig(sourceText, parsed, sourceWhere, { model, effort });

  const credentialsPath = join(home, 'credentials');
  const oauthPath = join(home, 'oauth');
  const credentials = lstatSync(credentialsPath, { throwIfNoEntry: false });
  const oauth = lstatSync(oauthPath, { throwIfNoEntry: false });
  let held: AdoptionManifest['credentials'];
  if (credentials === undefined) {
    if (mode !== 'copy') {
      throw refusal('it has no credentials link into this source; only a copy-mode home may have none (use copy mode)');
    }
    held = 'absent';
  } else if (credentials.isSymbolicLink()) {
    if (!isLinkTo(credentialsPath, join(src, 'credentials'))) {
      throw refusal(`its credentials link points at ${readlinkSync(credentialsPath)}, not into ${src}`);
    }
    if (oauth !== undefined && !isLinkTo(oauthPath, join(src, 'oauth'))) {
      throw refusal('its oauth entry is not the link into this source that pairs with its credentials link');
    }
    held = 'link';
  } else if (isMarkedCopy(credentialsPath)) {
    held = 'copy';
  } else {
    throw refusal('its credentials entry is neither a link into this source nor a bare-kimi copy');
  }
  if (held !== 'link' && oauth?.isSymbolicLink() === true) {
    throw refusal('its oauth entry is a link, unpaired with its own credentials');
  }
  if (oauth !== undefined && !oauth.isSymbolicLink() && !oauth.isDirectory()) {
    throw refusal('its oauth entry is not a directory');
  }
  const oauthHeld: AdoptionManifest['oauth'] =
    oauth === undefined ? 'absent' : oauth.isSymbolicLink() ? 'link' : 'directory';
  // Present credentials are used as they are: adoption never discards a copy.
  const donation = planEnsure(src, dst, mode);

  const sessions = sessionDigests(home, refusal);
  const sha = sha256(preimage);
  const recordPath = join(home, ADOPTION_RECORD);
  const record = lstatSync(recordPath, { throwIfNoEntry: false });
  if (record !== undefined && !(record.isDirectory() && recordMatches(recordPath, source, sha))) {
    throw refusal(`${recordPath} exists but does not record this home's config.toml; refusing to guess`);
  }
  const legacyDigest = settingsDigest(legacy);
  return {
    home,
    action: 'adopt',
    create: false,
    stamp: undefined,
    config,
    writeConfig: legacyDigest !== config.digest,
    adoption: {
      recorded: record !== undefined,
      preimage,
      manifest: {
        version: 1,
        at: new Date().toISOString(),
        source,
        model,
        configuredEffort: effort,
        config: { sha256: sha },
        credentials: held,
        oauth: oauthHeld,
        sessions,
      },
      legacyDigest,
      donation,
    },
  };
}

/** An existing adoption record holds exactly this config.toml, from this source. */
function recordMatches(record: string, source: string, sha: string): boolean {
  const saved = join(record, 'config.toml');
  if (lstatSync(saved, { throwIfNoEntry: false })?.isFile() !== true || sha256(readFileSync(saved)) !== sha) {
    return false;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf-8'));
  } catch {
    return false;
  }
  if (!isTable(manifest)) return false;
  const config = manifest['config'];
  return manifest['version'] === 1 && manifest['source'] === source && isTable(config) && config['sha256'] === sha;
}

/** Every entry under `<home>/sessions`, by relative path, without following links. */
function sessionDigests(home: string, refusal: (why: string) => Error): Record<string, string> {
  const root = join(home, 'sessions');
  const out: Record<string, string> = {};
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (stat === undefined) return out;
  if (!stat.isDirectory()) throw refusal('its sessions entry is not a directory');
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const name = prefix.length === 0 ? entry : `${prefix}/${entry}`;
      const entryStat = lstatSync(path);
      if (entryStat.isSymbolicLink()) out[name] = `link:${readlinkSync(path)}`;
      else if (entryStat.isDirectory()) walk(path, name);
      else if (entryStat.isFile()) out[name] = `sha256:${sha256(readFileSync(path))}`;
      else out[name] = 'other';
    }
  };
  walk(root, '');
  return out;
}

/** Write the record into a temporary directory and rename it into place. */
function writeAdoptionRecord(home: string, adoption: AdoptionPlan): void {
  const tmp = mkdtempSync(join(home, `${ADOPTION_RECORD}.tmp-`));
  writeFileSync(join(tmp, 'config.toml'), adoption.preimage, { mode: 0o600 });
  writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(adoption.manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(home, ADOPTION_RECORD));
}

interface PreparePlan {
  readonly dst: string;
  readonly source: string;
  readonly plan: RunHomePlan;
  readonly donation: Donation | undefined;
}

function planPrepare(srcHome: string, runHome: string, mode: AuthMode, options: RunHomeOptions): PreparePlan {
  const src = resolve(srcHome);
  const dst = resolve(runHome);
  assertDistinctHomes(src, dst);
  const source = canonicalPath(src);
  const srcConfigPath = join(src, 'config.toml');
  const plan = planRunHome(dst, source, src, readFileSync(srcConfigPath, 'utf-8'), srcConfigPath, options, mode);
  const donation =
    plan.adoption !== undefined
      ? plan.adoption.donation
      : plan.stamp === undefined || options.reassemble === true
        ? planDonation(src, dst, mode)
        : planEnsure(src, dst, mode);
  return { dst, source, plan, donation };
}

function describeHome(dst: string, source: string, plan: RunHomePlan): AssembledHome {
  const { config } = plan;
  return {
    home: dst,
    configPath: join(dst, 'config.toml'),
    modelAlias: config.modelAlias,
    provider: config.provider,
    providerType: config.providerType,
    modelId: config.modelId,
    effort: config.effort,
    effortSupport: config.effortSupport,
    configuredEffort: config.configuredEffort,
    source,
    action: plan.action,
    adopted: plan.adoption !== undefined || plan.stamp?.adopted === true,
  };
}

/**
 * Make `runHome` a KIMI_CODE_HOME ready to run on `srcHome`'s login and
 * settings: create, reuse or (when asked) adopt it (see {@link planRunHome}
 * and {@link ADOPTION_RECORD}), donate authentication, and bring its
 * config.toml in line with the source's — `default_model` naming the
 * selected or pinned model, that model's and its provider's tables, and the
 * carried tables, or the selected effort's `[thinking]` (see
 * {@link minimalConfig}). A source whose settings changed since the last run
 * is followed, not ignored: an unedited config.toml is rewritten from it. A
 * kept home stays on its pinned model and effort.
 *
 * Authentication: with `reassemble`, donation runs as in {@link donateAuth}
 * (an unchanged bare-kimi copy may be replaced, e.g. by a link); otherwise as
 * in {@link ensureAuth} (present credentials are used as they are, once
 * their pairing with the source checks out). A new or empty home always gets
 * a full donation; an adopted home is treated as in {@link ensureAuth}.
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
  options: RunHomeOptions = {},
): AssembledHome {
  const { dst, source, plan, donation } = planPrepare(srcHome, runHome, mode, options);
  const { config, adoption } = plan;
  const stamp = (digest: string): StampFields => ({
    source,
    model: config.modelAlias,
    effort: config.effort,
    config: digest,
    adopted: adoption !== undefined || plan.stamp?.adopted === true,
  });

  // Effects start here; every refusal above left both homes untouched.
  if (plan.create) {
    mkdirSync(plan.home, { recursive: true, mode: 0o700 });
    chmodSync(plan.home, 0o700);
  }
  if (adoption !== undefined) {
    // Evidence first, then a stamp recording the found settings as last
    // written: from here an interruption leaves a home that is ours, with
    // its original config.toml kept, and the next run completes it.
    if (!adoption.recorded) writeAdoptionRecord(plan.home, adoption);
    writeHomeStamp(plan.home, stamp(adoption.legacyDigest));
  } else if (plan.stamp === undefined) {
    // Stamped first: an interrupted assembly leaves a home that is still ours.
    writeHomeStamp(plan.home, stamp(config.digest));
  }
  if (donation !== undefined) applyDonation(donation);
  if (plan.writeConfig) writeFileAtomic(join(plan.home, 'config.toml'), config.text);
  const stamped =
    adoption !== undefined
      ? adoption.legacyDigest
      : plan.stamp === undefined
        ? config.digest
        : plan.stamp.version === 2
          ? plan.stamp.config
          : undefined; // a 0.2 stamp is upgraded
  if (stamped !== config.digest) writeHomeStamp(plan.home, stamp(config.digest));
  return describeHome(dst, source, plan);
}

/**
 * What {@link prepareRunHome} would do with the same arguments, decided by
 * the same planning and refusing exactly what it refuses, with no effect on
 * either home. For callers that keep their own records and must check a
 * launch before creating them. The answer can go stale; prepareRunHome
 * plans again when it runs.
 */
export function previewRunHome(
  srcHome: string,
  runHome: string,
  mode: AuthMode = 'link',
  options: RunHomeOptions = {},
): AssembledHome {
  const { dst, source, plan } = planPrepare(srcHome, runHome, mode, options);
  return describeHome(dst, source, plan);
}

/**
 * {@link prepareRunHome} with `reassemble`: turn `dstHome` into a runnable
 * minimal KIMI_CODE_HOME from `srcHome`, donating authentication in full.
 */
export function assembleHome(
  srcHome: string,
  dstHome: string,
  mode: AuthMode = 'link',
  options: Omit<RunHomeOptions, 'reassemble'> = {},
): AssembledHome {
  return prepareRunHome(srcHome, dstHome, mode, { ...options, reassemble: true });
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
 * The source home a run on `runHome` uses: an explicit one, else
 * `KIMI_CODE_HOME_SOURCE`, else the source a stamped `runHome` was
 * assembled from, else `~/.kimi-code` (as {@link sourceHome}, with its
 * refusal). A kept home thus runs on its own source without the caller
 * naming it again, and without reading another home's config. A source named
 * explicitly or in the environment that differs from the stamp's is still
 * refused by {@link prepareRunHome}.
 */
export function runSourceHome(
  runHome: string | undefined,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = env['KIMI_CODE_HOME_SOURCE'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (runHome !== undefined && runHome.length > 0) {
    const stamp = readHomeStamp(canonicalPath(runHome));
    if (stamp !== undefined) return stamp.source;
  }
  return sourceHome(undefined, env);
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
