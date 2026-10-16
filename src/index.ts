import { mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  assertDistinctHomes,
  makeEphemeralHome,
  prepareRunHome,
  previewRunHome,
  removeHome,
  runSourceHome,
  shredCopiedCredentials,
  type AssembledHome,
  type AuthMode,
} from './home.ts';
import {
  parseStreamJson,
  sessionIdFromEvents,
  type KimiStreamEvent,
} from './events.ts';

export {
  ADOPTION_RECORD,
  assembleHome,
  assertDistinctHomes,
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
  CREDENTIALS_MARKER,
  EPHEMERAL_MARKER,
  HOME_STAMP,
  type AssembledHome,
  type AuthMode,
  type EffortSupport,
  type Migration,
  type MigrationBasis,
  type RunHomeOptions,
} from './home.ts';
export {
  parseStreamJson,
  sessionIdFromEvents,
  isAssistantEvent,
  isKimiStreamEvent,
  isMetaEvent,
  isMetaSessionResumeHint,
  isMetaSystemVersion,
  isMetaTurnStepRetrying,
  isToolEvent,
  type AssistantEvent,
  type KimiStreamEvent,
  type MetaOtherEvent,
  type MetaSessionResumeHint,
  type MetaSystemVersion,
  type MetaTurnStepRetrying,
  type ParsedStream,
  type ToolCall,
  type ToolEvent,
} from './events.ts';

/** kimi's non-interactive output formats (kimi 2.0.1 `--output-format` choices). */
export type OutputFormat = 'text' | 'stream-json';

export interface LaunchOptions {
  /**
   * The call to action. Must not start with `-` (see {@link assertSafePrompt}).
   */
  readonly prompt: string;
  /** Working directory of the run. Sessions bind to it: a resume must happen in the same cwd. */
  readonly cwd?: string;
  /**
   * Run home. When omitted, a fresh ephemeral home is mkdtemp'd and removed
   * by dispose(). A caller-supplied home is kept. It must be missing, empty,
   * or a home bare-kimi assembled from the same source (it carries
   * {@link HOME_STAMP}), or, with {@link adoptLegacyHome}, a home bare-kimi
   * kept before 0.2; anything else is refused before any effect. Its
   * config.toml follows the source's settings: kept byte for byte (comments
   * included) while they agree, rewritten when the source changed, refused
   * when it was edited to something else. A kept home stays on the model and
   * effort it is pinned to. See {@link prepareRunHome}. A relative path
   * resolves against this process's working directory, not against `cwd`.
   */
  readonly home?: string;
  /**
   * Source home to assemble/donate from. Passing it also re-donates
   * authentication in full (an unchanged bare-kimi credential copy may be
   * replaced). Default: `KIMI_CODE_HOME_SOURCE`, else the source a stamped
   * `home` was assembled from, else `~/.kimi-code`, the latter refused when
   * an ambient `KIMI_CODE_HOME` names another home (see {@link runSourceHome}).
   * A relative path resolves like `home`.
   */
  readonly srcHome?: string;
  /**
   * How the run home receives credentials. Default `link`: `credentials/`
   * and `oauth/` are directory symlinks into the source home — no token
   * replication, refresh writes and the cross-process refresh lock stay
   * shared with native runs. `copy` duplicates token files (marker-stamped,
   * shredded on dispose unless `keepCredentials`) and forks the refresh
   * lineage; see {@link AuthMode}.
   */
  readonly authMode?: AuthMode;
  /** Copy mode only: keep the donated credential copy after the run (e.g. to drive the home with native `kimi` directly). */
  readonly keepCredentials?: boolean;
  /**
   * Model alias the run home carries, and kimi's `--model`. It must be
   * configured in the source config (`[models."<alias>"]`); only it and its
   * provider are carried, never the source's other models or providers,
   * whose tables may hold keys. Omitted: the alias a kept home is pinned to,
   * else the source's default_model. A kept home is pinned to the alias it
   * was assembled with, or, for a home kept by bare-kimi 0.2 or adopted, the
   * alias its config.toml named then (see {@link AssembledHome.migrated}),
   * because native kimi binds every session to the alias it was created
   * with and looks the alias up again on resume: the home stays on it when
   * the source's default_model changes, and a different alias is refused
   * before any effect (use another home). Sessions such a home created under
   * an earlier alias are not covered by the pin.
   */
  readonly model?: string;
  /**
   * Thinking effort for the sessions this run home creates: one of the
   * selected model's `support_efforts` (a `[models."…".overrides]` list
   * wins, as in kimi), or `off`. Written into the run home's `[thinking]`
   * (`enabled`, `effort`; the source's other `[thinking]` keys, such as
   * `keep`, are kept) and recorded in its stamp; a kept home is pinned to it
   * like the model. Omitted: a new home carries the source's `[thinking]`, a
   * kept home keeps its pin.
   *
   * Native semantics (kimi 2.1.0 `-p`): a session's effort is fixed when it
   * is created and stored with it; a resume keeps it, whatever config.toml
   * says later. Refused before any effect, on what the source config
   * declares for the model: an effort missing from its `support_efforts`, a
   * model declared without thinking, and `off` for a model declared
   * always-thinking. Also refused: a `KIMI_MODEL_THINKING_EFFORT` in
   * `extraEnv` or the spawn env, which overrides every request of the
   * process, resumed ones included. An effort the config declares nothing
   * about is taken, and the run's `assembled.effortSupport` is `undeclared`.
   * kimi then decides at run time (see {@link AssembledHome.effortSupport}).
   */
  readonly effort?: string;
  /**
   * Allow `home` to be adopted when it is an unstamped home kept by
   * bare-kimi before 0.2 and its shape shows it was assembled from the
   * source. Its sessions are never changed; its original config.toml is
   * kept in {@link ADOPTION_RECORD}. See {@link prepareRunHome}. Requires a
   * caller-supplied `home`.
   */
  readonly adoptLegacyHome?: boolean;
  /**
   * Session id to resume (`--session`). The native CLI refuses a cross-cwd
   * resume, so `cwd` must match the session's own cwd.
   */
  readonly resume?: string;
  /** Resume the most recent session for this cwd (`--continue`). Mutually exclusive with `resume`. */
  readonly continueRecent?: boolean;
  /** Non-interactive output format. Default `text`. */
  readonly outputFormat?: OutputFormat;
  /**
   * Skill directories (`--skills-dir`, repeatable). Native semantics: this
   * REPLACES user and project skill discovery, it does not add to it.
   * Passed to kimi verbatim, so a relative path is kimi's to resolve, in the
   * child's `cwd` (likewise `addDir` and `extraArgs`).
   */
  readonly skillsDir?: string[];
  /**
   * Point `--skills-dir` at a fresh empty directory inside the run home, so
   * no file-based skills load at all. (Plugin/builtin catalog skills are a
   * separate native source and still load; there is no native off switch.)
   */
  readonly noSkills?: boolean;
  /** Additional workspace directories (`--add-dir`, repeatable). */
  readonly addDir?: string[];
  /**
   * kimi binary. Default: `KIMI_BIN` env ?? `kimi` (PATH). A bare name is
   * looked up on PATH; a path containing `/` is this wrapper's own input and
   * resolves against this process's working directory, like `home`.
   */
  readonly kimiBin?: string;
  /** Drop the inherited process environment entirely (see {@link buildEnv} for what still gets set). */
  readonly noProcessEnv?: boolean;
  /**
   * Extra environment, applied over the inherited layer. May re-add a
   * scrubbed variable explicitly, and may override the telemetry/auto-update
   * defaults; may NOT override `KIMI_CODE_HOME`. A non-empty
   * `KIMI_MODEL_THINKING_EFFORT` (here or in the spawn env) is refused
   * beside `effort` and on a run home pinned to an effort. Any other
   * `KIMI_MODEL_*` variable, here or in the spawn env and even empty, may
   * switch kimi to its env model (see {@link isModelOverlayVar}): it is
   * refused before any effect beside `model`, with a caller-supplied `home`,
   * and in a preloaded run. Only an ephemeral launch without `model` takes
   * it; {@link KimiSubprocess.modelOverlay} then names it, and
   * `assembled.modelAlias` is not established as the model kimi runs.
   */
  readonly extraEnv?: Record<string, string>;
  /**
   * Extra arguments forwarded verbatim to kimi, just before `-p`. They may
   * not select a model (`--model`, `-m`): use `model`, so the run home
   * carries it.
   */
  readonly extraArgs?: string[];
}

export type LaunchConfig = Required<Omit<LaunchOptions, 'model' | 'resume' | 'effort'>> &
  Pick<LaunchOptions, 'model' | 'resume' | 'effort'>;

/** kimi 2.1.0's per-process forced effort (`thinking.forcedEffort`). */
const FORCED_EFFORT_ENV = 'KIMI_MODEL_THINKING_EFFORT';

/** A forced effort the child would see, and the layer that sets it. */
interface ForcedEffort {
  readonly layer: string;
  readonly value: string;
}

/**
 * The forced effort the child's environment will carry, by the layering of
 * {@link buildEnv}: the inherited value is scrubbed, `extraEnv` wins over the
 * spawn env, and a blank value is taken as unset. That last reading comes
 * from kimi 2.1.0's env-model overlay (`trimmed$2`); whether the separate
 * binding of this variable (`envBindings`) trims it too is not established.
 */
function forcedEffort(
  extraEnv: Record<string, string> | undefined,
  spawnEnv: Record<string, string | undefined> | undefined,
): ForcedEffort | undefined {
  const fromExtra = extraEnv !== undefined && Object.hasOwn(extraEnv, FORCED_EFFORT_ENV);
  const layer = fromExtra ? 'extraEnv' : 'the spawn env';
  const value = (fromExtra ? extraEnv?.[FORCED_EFFORT_ENV] : spawnEnv?.[FORCED_EFFORT_ENV])?.trim();
  return value === undefined || value.length === 0 ? undefined : { layer, value };
}

function forcedEffortConflict(layer: string): Error {
  return new Error(
    `effort conflicts with ${FORCED_EFFORT_ENV} in ${layer}: that variable forces an effort on every ` +
      'request of the process, resumed sessions included; choose one',
  );
}

/**
 * Whether `name` may feed kimi 2.1.0's env-model overlay. When active, the
 * overlay adds a provider `__kimi_env__` and a model `__kimi_env_model__`
 * built from `KIMI_MODEL_*` variables and makes that model the default, so
 * a new session runs it instead of the run home's alias and is bound to it.
 * Which variable activates the overlay is not in the bundle excerpts read,
 * so every `KIMI_MODEL_*` name counts except {@link FORCED_EFFORT_ENV},
 * which kimi binds separately and {@link spawnKimi} checks on its own.
 * `KIMI_MODEL_THINKING_KEEP` counts: the overlay collects it as a model
 * override.
 */
export function isModelOverlayVar(name: string): boolean {
  return name.startsWith('KIMI_MODEL_') && name !== FORCED_EFFORT_ENV;
}

/** A variable the child will see, and the layer that sets it. */
interface ChildVariable {
  readonly name: string;
  readonly layer: string;
}

/**
 * The first variable that may feed the env-model overlay and that the
 * child's environment will carry, by the layering of {@link buildEnv}: the
 * inherited layer is scrubbed, a name `extraEnv` sets is decided there, and
 * a spawn-env value of `undefined` deletes. An empty value counts: how kimi
 * reads the activating variable is not established.
 */
function modelOverlay(
  extraEnv: Record<string, string> | undefined,
  spawnEnv: Record<string, string | undefined> | undefined,
): ChildVariable | undefined {
  const fromExtra = Object.keys(extraEnv ?? {}).find(isModelOverlayVar);
  if (fromExtra !== undefined) return { name: fromExtra, layer: 'extraEnv' };
  const fromSpawn = Object.entries(spawnEnv ?? {}).find(([name, value]) => value !== undefined && isModelOverlayVar(name));
  return fromSpawn === undefined ? undefined : { name: fromSpawn[0], layer: 'the spawn env' };
}

/**
 * Refuse, before any effect, an env-model variable beside `model` or on a
 * caller-supplied (kept) home: a new session there could run another model
 * than the one asked for or pinned, and be bound to `__kimi_env_model__`,
 * which a later run without the variable could not resume.
 */
function checkModelOverlay(variable: ChildVariable | undefined, model: string | undefined, kept: boolean): void {
  if (variable === undefined) return;
  const why = model !== undefined ? `beside model "${model}"` : kept ? 'on a kept run home' : undefined;
  if (why === undefined) return;
  throw new Error(
    `${variable.name} in ${variable.layer} may switch kimi to its env model (__kimi_env_model__) instead of ` +
      `the run home's alias; refused ${why} (only an ephemeral launch without model may set it)`,
  );
}

export function LaunchConfig(o: LaunchOptions): LaunchConfig {
  if (o.resume !== undefined && o.continueRecent === true) {
    throw new Error('resume and continueRecent are mutually exclusive');
  }
  if (o.model !== undefined && o.model.length === 0) throw new Error('model must not be empty');
  if (o.effort !== undefined && o.effort.length === 0) throw new Error('effort must not be empty');
  if (o.effort !== undefined && forcedEffort(o.extraEnv, undefined) !== undefined) {
    throw forcedEffortConflict('extraEnv');
  }
  checkModelOverlay(modelOverlay(o.extraEnv, undefined), o.model, o.home !== undefined && o.home.length > 0);
  if ((o.extraArgs ?? []).some((arg) => arg === '--model' || arg === '-m' || arg.startsWith('--model='))) {
    throw new Error('pass the model as the model option, not in extraArgs: the run home must carry it');
  }
  if (o.adoptLegacyHome === true && (o.home === undefined || o.home.length === 0)) {
    throw new Error('adoptLegacyHome needs a caller-supplied home');
  }
  return {
    prompt: o.prompt,
    cwd: o.cwd ?? '',
    home: o.home ?? '',
    srcHome: o.srcHome ?? '',
    authMode: o.authMode ?? 'link',
    keepCredentials: o.keepCredentials ?? false,
    model: o.model,
    effort: o.effort,
    adoptLegacyHome: o.adoptLegacyHome ?? false,
    resume: o.resume,
    continueRecent: o.continueRecent ?? false,
    outputFormat: o.outputFormat ?? 'text',
    skillsDir: o.skillsDir ?? [],
    noSkills: o.noSkills ?? false,
    addDir: o.addDir ?? [],
    kimiBin: o.kimiBin ?? '',
    noProcessEnv: o.noProcessEnv ?? false,
    extraEnv: o.extraEnv ?? {},
    extraArgs: o.extraArgs ?? [],
  };
}

/**
 * Refuse a prompt starting with `-`. Whether kimi's parser would take such
 * a value after `-p` as a flag was not re-verified for 2.1.0; refusing is
 * the conservative choice. Called before any filesystem work, so a refusal
 * leaves nothing behind.
 */
export function assertSafePrompt(prompt: string): void {
  if (prompt.startsWith('-')) {
    throw new Error('prompt starts with "-": kimi could parse it as a flag');
  }
}

/**
 * Every check on launch options that needs no filesystem: prompt shape,
 * option conflicts, and the selection checks that need no config (an empty
 * model or effort, an effort beside a forced one in `extraEnv`, an env-model
 * variable in `extraEnv` beside `model` or a `home`, a model in `extraArgs`,
 * adoption without a home). spawnKimi runs it first; a caller
 * that does its own setup (the CLI's --keep-home) runs it before that setup.
 * Checks against the source config are {@link previewRunHome}'s.
 */
export function checkLaunchOptions(options: LaunchOptions): LaunchConfig {
  assertSafePrompt(options.prompt);
  return LaunchConfig(options);
}

/**
 * The command vector handed to Bun.spawn. `-p <prompt>` is always last:
 * kimi's flag parser accepts flags after the prompt, but keeping the prompt
 * terminal means a prompt that looks like a value can never be swallowed by
 * a trailing flag. Flags verified 2026-09-24 against kimi-code @ 6451f1e
 * `apps/kimi-code/src/cli/commands.ts` (installed kimi 2.0.1).
 */
export function buildArgv(config: LaunchConfig, kimiBin: string): string[] {
  const argv: string[] = [kimiBin];
  if (config.model !== undefined) argv.push('--model', config.model);
  if (config.resume !== undefined) argv.push('--session', config.resume);
  if (config.continueRecent) argv.push('--continue');
  for (const dir of config.skillsDir) argv.push('--skills-dir', dir);
  for (const dir of config.addDir) argv.push('--add-dir', dir);
  if (config.outputFormat === 'stream-json') argv.push('--output-format', 'stream-json');
  argv.push(...config.extraArgs);
  argv.push('-p', config.prompt);
  return argv;
}

/**
 * Environment variables stripped from the inherited layer before a bare run:
 *
 * - `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` —
 *   override the managed provider's endpoints at runtime, which re-derives
 *   the credential slot (`kimi-code-env-<sha256>`) away from the one the
 *   assembled config points at. The run would resolve — and possibly
 *   refresh/tombstone — a different credential than the one donated.
 *   (kimi-code @ 6451f1e `packages/oauth/src/managed-kimi-code.ts:363-383`.)
 * - `KIMI_DISABLE_OAUTH_LOCK` — opts out of the cross-process refresh lock;
 *   link mode's shared-lineage guarantee depends on that lock.
 * - `KIMI_MODEL_*` — the engine's env overlay can inject a whole
 *   provider+model+default_model over the assembled config. The prefix also
 *   covers `KIMI_MODEL_THINKING_EFFORT` and `KIMI_MODEL_THINKING_KEEP`
 *   (kimi 2.1.0 env-only overrides of the thinking effort and keep), so an
 *   ambient value cannot silently replace the `[thinking]` table the run
 *   home carries.
 * - `KIMI_SECONDARY_*` — kimi 2.1.0 reads `KIMI_SECONDARY_MODEL` and
 *   `KIMI_SECONDARY_EFFORT` as overrides of the secondary (subagent) model
 *   and its effort. The run home carries no `[secondary_model]`; what the
 *   variables do in `-p` without it is not established.
 *
 * All of these can be re-added deliberately via {@link LaunchOptions.extraEnv},
 * except that a `KIMI_MODEL_*` variable that may switch kimi to its env model
 * ({@link isModelOverlayVar}) is taken only by an ephemeral launch without
 * `model`, and refused before any effect otherwise.
 * To choose an effort, use {@link LaunchOptions.effort}: it is written into
 * the run home and stored with each new session. `KIMI_MODEL_THINKING_EFFORT`
 * in `extraEnv` instead forces an effort on every request of that process,
 * resumed sessions included, only on provider types that drive thinking
 * through a trait (the `kimi` type does), and not when thinking is off
 * (kimi 2.1.0 `resolveForcedThinkingEffort`). It stays available on purpose
 * for a run home that follows the source's `[thinking]`. Beside `effort`, or
 * on a run home pinned to an effort (whether or not this launch names it),
 * it would silently override the pin, so it is refused there before any
 * effect.
 */
export function isScrubbedEnvVar(name: string): boolean {
  return (
    name === 'KIMI_CODE_BASE_URL' ||
    name === 'KIMI_CODE_OAUTH_HOST' ||
    name === 'KIMI_OAUTH_HOST' ||
    name === 'KIMI_DISABLE_OAUTH_LOCK' ||
    name.startsWith('KIMI_MODEL_') ||
    name.startsWith('KIMI_SECONDARY_')
  );
}

export interface EnvContext {
  /** The resolved run home; forced as `KIMI_CODE_HOME`, never overridable. */
  readonly home: string;
  /** Environment inherited by the child. Defaults to `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** A spawn-options env layer, applied between the inherited layer and extraEnv. */
  readonly spawnEnv?: Record<string, string | undefined>;
  /**
   * The source home this run donated from. Exported to the child as
   * `KIMI_CODE_HOME_SOURCE`, so a bare-kimi started inside the run (from a
   * hook or a tool) donates from the same login. Without it that nested
   * bare-kimi would see `KIMI_CODE_HOME` (this run home) next to the
   * `~/.kimi-code` fallback and refuse (see sourceHome). kimi itself does not
   * read the variable.
   */
  readonly source?: string;
}

/**
 * Layered child environment, later wins:
 *
 * 1. inherited `parentEnv` (unless `noProcessEnv`), minus the scrubbed
 *    variables and any inherited `KIMI_CODE_HOME`;
 * 2. `spawnEnv`;
 * 3. `KIMI_CODE_HOME_SOURCE` = `source`, when given — replacing an
 *    inherited value, which may name a different home than the one this run
 *    actually used;
 * 4. `extraEnv` (which may set `KIMI_CODE_HOME_SOURCE` on purpose);
 * 5. defaults, only when still unset: `KIMI_DISABLE_TELEMETRY=1`,
 *    `KIMI_CODE_NO_AUTO_UPDATE=1` — the update preflight can otherwise spawn
 *    a global package-manager install from a headless run
 *    (kimi-code @ 6451f1e `apps/kimi-code/src/cli/update/preflight.ts`);
 * 6. `KIMI_CODE_HOME` = the run home — forced, never empty, never
 *    overridable: pointing the child at the run home is what makes it bare.
 *    (An empty value would be adopted by the engine but treated as unset by
 *    the CLI/OAuth paths; this function never emits one.)
 */
export function buildEnv(config: LaunchConfig, context: EnvContext): Record<string, string> {
  if (context.home.length === 0) {
    throw new Error('run home must not be empty');
  }
  const env: Record<string, string> = {};
  if (!config.noProcessEnv) {
    for (const [name, value] of Object.entries(context.parentEnv ?? process.env)) {
      if (value === undefined) continue;
      if (name === 'KIMI_CODE_HOME') continue;
      if (isScrubbedEnvVar(name)) continue;
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(context.spawnEnv ?? {})) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  if (context.source !== undefined) env['KIMI_CODE_HOME_SOURCE'] = context.source;
  Object.assign(env, config.extraEnv);
  env['KIMI_DISABLE_TELEMETRY'] = env['KIMI_DISABLE_TELEMETRY'] ?? '1';
  env['KIMI_CODE_NO_AUTO_UPDATE'] = env['KIMI_CODE_NO_AUTO_UPDATE'] ?? '1';
  env['KIMI_CODE_HOME'] = context.home;
  return env;
}

export interface KimiSubprocess<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable,
> {
  /** The spawned Bun subprocess. */
  readonly subprocess: Bun.Subprocess<In, Out, Err>;
  /** The resolved, absolute run home (also the child's `KIMI_CODE_HOME`). */
  readonly home: string;
  /** The run home as prepared: its model, effort, source, and whether it was created, reused or adopted. */
  readonly assembled: AssembledHome;
  /**
   * The env-model variable the child sees (see {@link isModelOverlayVar}),
   * which only an ephemeral launch without `model` may set; else null. When
   * set, kimi may run its env model rather than `assembled.modelAlias`.
   */
  readonly modelOverlay: string | null;
  /** Whether spawnKimi created the home (and dispose will remove it). */
  readonly ephemeral: boolean;
  /** Working directory the child runs in. */
  readonly cwd: string;
  /**
   * Kill a still-running child, then clean up: an ephemeral home is removed
   * (guarded by its marker); a kept home assembled in copy mode has its
   * marker-stamped credential copy shredded unless `keepCredentials`.
   * Caller-owned data — a caller-supplied home itself, linked credential
   * directories' targets, session records — is never touched. A copy that
   * may hold something the source lacks (a refresh changed it) is kept, and
   * with it an ephemeral home; dispose then rejects with a
   * {@link KimiCustodyError} naming what it kept. Idempotent.
   */
  readonly dispose: () => Promise<void>;
}

function resolveKimiBin(config: LaunchConfig, parentEnv: NodeJS.ProcessEnv): string {
  const fromEnv = parentEnv['KIMI_BIN'];
  const bin =
    config.kimiBin.length > 0
      ? config.kimiBin
      : fromEnv !== undefined && fromEnv.length > 0
        ? fromEnv
        : 'kimi';
  // Spawned with the child's cwd: a relative path would resolve there.
  return bin.includes('/') ? resolvePath(bin) : bin;
}

/** Fresh empty directory inside the run home that `noSkills` points `--skills-dir` at. */
export const EMPTY_SKILLS_DIR = '.bare-kimi-empty-skills';

/** The kimi binary could not be executed at all (missing, not executable, …). */
export class KimiSpawnError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KimiSpawnError';
  }
}

/**
 * Cleanup did not complete, and something was kept on disk on purpose: a
 * credentials copy that may hold the only current refresh token, and with it
 * an ephemeral home. The message names what was kept. Thrown by dispose()
 * with `run` undefined; thrown by runKimi()/runPreloaded() with the finished
 * run attached, so its output and session id are not lost.
 */
export class KimiCustodyError extends Error {
  constructor(
    message: string,
    readonly run: KimiRun | undefined,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KimiCustodyError';
  }
}

/**
 * Spawn a kimi subprocess with the given launch options.
 *
 * The construction is factored out into {@link buildArgv} and {@link
 * buildEnv}, which are pure and individually testable; this function resolves
 * the config and the source home (see {@link runSourceHome}), prepares the
 * home on the selected or pinned model and effort (assemble, reuse, adopt,
 * re-donate auth; see {@link prepareRunHome}) and spawns.
 *
 * `spawnOptions` is forwarded to `Bun.spawn` except for the fields this
 * function resolves rather than passes through: `cmd`, `cwd`
 * (`launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`), `env` (see
 * {@link buildEnv}), and `stdin` (defaults to `ignore`). A non-empty
 * `KIMI_MODEL_THINKING_EFFORT` that the child would see (from `extraEnv` or
 * `spawnOptions.env`) is refused beside `effort` before anything is made. On a
 * run home pinned to an effort it is refused before that home is prepared.
 * Another `KIMI_MODEL_*` variable the child would see is refused beside
 * `model` and on a caller-supplied `home` before anything is made (see
 * {@link LaunchOptions.extraEnv}).
 *
 * @throws {KimiSpawnError} when the binary cannot be executed. Home-assembly
 *   and option errors throw plain Errors before the child starts; a failed
 *   setup never leaves an ephemeral home behind.
 */
export function spawnKimi<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable,
>(
  launchOptions: LaunchOptions,
  spawnOptions: Bun.Spawn.SpawnOptions<In, Out, Err> = {} as Bun.Spawn.SpawnOptions<In, Out, Err>,
): KimiSubprocess<In, Out, Err> {
  const config = checkLaunchOptions(launchOptions); // before any filesystem work
  const forced = forcedEffort(config.extraEnv, spawnOptions.env);
  if (config.effort !== undefined && forced !== undefined) throw forcedEffortConflict(forced.layer);
  const ephemeral = config.home.length === 0;
  const overlay = modelOverlay(config.extraEnv, spawnOptions.env);
  checkModelOverlay(overlay, config.model, !ephemeral);

  const cwd = config.cwd.length > 0 ? config.cwd : (spawnOptions.cwd ?? process.cwd());
  // Absolute before anything else sees it: the child runs in `cwd` and would
  // read a relative KIMI_CODE_HOME against that directory instead.
  const home = ephemeral ? makeEphemeralHome() : resolvePath(config.home);

  try {
    const src = resolvePath(
      runSourceHome(ephemeral ? undefined : home, config.srcHome.length > 0 ? config.srcHome : undefined),
    );
    assertDistinctHomes(src, home);
    const homeOptions = {
      reassemble: config.srcHome.length > 0,
      model: config.model,
      effort: config.effort,
      adoptLegacyHome: config.adoptLegacyHome,
    };
    if (forced !== undefined) {
      // The pin may come from the home's stamp, not this launch: look before any effect.
      const pinned = previewRunHome(src, home, config.authMode, homeOptions).effort;
      if (pinned !== null) {
        throw new Error(
          `run home ${home} is pinned to effort "${pinned}"; ${FORCED_EFFORT_ENV} in ${forced.layer} ` +
            `("${forced.value}") would override it on every request of the process, resumed sessions ` +
            'included; refusing (drop the variable, or use a home without a pinned effort)',
        );
      }
    }
    const assembled = prepareRunHome(src, home, config.authMode, homeOptions);

    let argvConfig = config;
    if (config.noSkills) {
      const emptySkills = resolvePath(home, EMPTY_SKILLS_DIR);
      mkdirSync(emptySkills, { recursive: true });
      argvConfig = { ...config, skillsDir: [...config.skillsDir, emptySkills] };
    }

    const env = buildEnv(config, { home, spawnEnv: spawnOptions.env, source: src });
    const cmd = buildArgv(argvConfig, resolveKimiBin(config, process.env));

    let subprocess: Bun.Subprocess<In, Out, Err>;
    try {
      subprocess = Bun.spawn({
        ...spawnOptions,
        cmd,
        cwd,
        env,
        stdin: (spawnOptions.stdin ?? 'ignore') as In,
      } as Bun.Spawn.SpawnOptions<In, Out, Err> & { cmd: string[] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KimiSpawnError(`failed to spawn ${cmd[0] ?? 'kimi'}: ${message}`, error);
    }

    let disposed = false;
    return {
      subprocess,
      home,
      assembled,
      modelOverlay: overlay?.name ?? null,
      ephemeral,
      cwd,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        if (subprocess.exitCode === null && subprocess.signalCode === null) {
          subprocess.kill();
          await subprocess.exited.catch(() => {});
        }
        try {
          if (ephemeral) {
            removeHome(home, src);
          } else if (config.authMode === 'copy' && !config.keepCredentials) {
            shredCopiedCredentials(home, src);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new KimiCustodyError(`cleanup of run home ${home} did not complete: ${reason}`, undefined, error);
        }
      },
    };
  } catch (error) {
    if (ephemeral) {
      try {
        removeHome(home);
      } catch {
        // best effort; the setup error is the one that matters
      }
    }
    throw error;
  }
}

export interface KimiRun {
  /**
   * Child exit code; 127 when the binary could not be spawned; 128+signum
   * when the child died on a signal (`signal` is then set).
   */
  readonly code: number;
  /** Signal name (e.g. `SIGTERM`) when the child was killed by one. */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The run home (removed already when it was ephemeral, unless cleanup had to keep it). */
  readonly home: string;
  /** Session id parsed from the stream-json resume hint, when available. */
  readonly sessionId: string | undefined;
  /** Parsed stream-json events; empty unless `outputFormat: 'stream-json'`. */
  readonly events: KimiStreamEvent[];
  /** Non-JSON stdout lines, when stream-json was requested. */
  readonly unparsed: string[];
  /** Spawn error message, when `code` is 127. */
  readonly spawnError: string | undefined;
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Resolve a finished subprocess to an exit code: the child's own code, or
 * 128+signum when it died on a signal (1 for an unrecognized signal).
 */
export function exitCodeOf(subprocess: {
  exitCode: number | null;
  signalCode: string | null;
}): { code: number; signal: string | null } {
  const signal = subprocess.signalCode;
  if (subprocess.exitCode !== null) return { code: subprocess.exitCode, signal };
  if (signal !== null) return { code: 128 + (SIGNAL_NUMBERS[signal] ?? 0), signal };
  return { code: 1, signal: null };
}

async function readStream(stream: ReadableStream | number | undefined): Promise<string> {
  if (stream === undefined || typeof stream === 'number') return '';
  return new Response(stream).text();
}

/**
 * Run kimi to completion with piped stdout/stderr and report a structured
 * result: exit code, signal, captured output, parsed stream-json events and
 * the session id. The run home is disposed per the same rules as
 * {@link spawnKimi}'s dispose (ephemeral removed, copy-mode credentials
 * shredded) before this resolves — pass a `home` to keep session records.
 *
 * A binary that cannot be executed resolves to `code: 127` with
 * `spawnError` set. Home-assembly and option errors are thrown, not
 * converted: they are caller mistakes, not run results. When the run
 * finished but cleanup kept something, a {@link KimiCustodyError} carrying
 * the run is thrown instead of returning it.
 */
export async function runKimi(launchOptions: LaunchOptions): Promise<KimiRun> {
  let launched: KimiSubprocess<'ignore', 'pipe', 'pipe'>;
  try {
    launched = spawnKimi(launchOptions, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    if (!(error instanceof KimiSpawnError)) throw error;
    return {
      code: 127,
      signal: null,
      stdout: '',
      stderr: `bare-kimi: ${error.message}`,
      home:
        launchOptions.home !== undefined && launchOptions.home.length > 0
          ? resolvePath(launchOptions.home)
          : '',
      sessionId: undefined,
      events: [],
      unparsed: [],
      spawnError: error.message,
    };
  }
  const { subprocess, home } = launched;
  let run: KimiRun;
  try {
    const [stdout, stderr] = await Promise.all([
      readStream(subprocess.stdout),
      readStream(subprocess.stderr),
    ]);
    await subprocess.exited;
    const { code, signal } = exitCodeOf(subprocess);
    const parsed =
      launchOptions.outputFormat === 'stream-json'
        ? parseStreamJson(stdout)
        : { events: [], unparsed: [] };
    run = {
      code,
      signal,
      stdout,
      stderr,
      home,
      sessionId: sessionIdFromEvents(parsed.events),
      events: parsed.events,
      unparsed: parsed.unparsed,
      spawnError: undefined,
    };
  } catch (error) {
    // The run's own failure is the one reported; whatever cleanup keeps
    // stays on disk regardless.
    await launched.dispose().catch(() => {});
    throw error;
  }
  try {
    await launched.dispose();
  } catch (error) {
    if (error instanceof KimiCustodyError) throw new KimiCustodyError(error.message, run, error.cause);
    throw error;
  }
  return run;
}
