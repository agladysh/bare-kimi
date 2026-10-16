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

/** kimi's non-interactive output formats (the `--output-format` choices of the installed kimi 2.1.0 bundle's `createProgram`). */
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
   *
   * On a resume, as observed in kimi 2.1.0 `-p` with `--session` on an
   * openai-type loopback provider (`--continue` takes the same path in the
   * bundle, `resolveNativeSession`):
   * without `--model` the session keeps the alias it stored; with `--model`
   * the resumed session's requests use the named alias instead. bare-kimi
   * passes `--model` only when this option is set, and only the alias the
   * home is pinned to, so a session the home created on its pin stays on
   * it. A session a 0.2 or adopted home created under an earlier alias is
   * switched to the pin when `model` is given; without it, its own alias is
   * looked up in config.toml, which carries only the pin, so kimi cannot
   * resume it.
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
   * Native semantics (kimi 2.1.0 `-p`, observed on a loopback provider): a
   * session's effort is fixed when it is created and stored with it; a
   * resume keeps it, whatever config.toml says later. Refused before any
   * effect, on what the source config declares for the model and its
   * provider's `type` (the full list, and which refusals are observed and
   * which are policy, is at `checkEffort` in `home.ts`): an effort missing
   * from its `support_efforts`; on a `kimi`-type provider, an effort for a
   * model listing no `support_efforts` and setting no `protocol`, which kimi
   * was observed not to send;
   * an effort for a model declared without thinking (policy); `off` for a
   * model listing the capability `always_thinking`; and, except on a
   * `kimi`-type provider, `off` for a model listing `support_efforts` without
   * `off_effort`. Also refused: a `KIMI_MODEL_THINKING_EFFORT` in `extraEnv`
   * or the spawn env, which overrides every request of the process, resumed
   * ones included; and an env-model variable (see {@link LaunchOptions.extraEnv}). An
   * effort the config declares nothing about is otherwise taken, and the
   * run's `assembled.effortSupport` is `undeclared`. kimi then decides at run
   * time (see {@link AssembledHome.effortSupport}).
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
   * resume, so `cwd` must match the session's own cwd. On a kept home pinned
   * to an effort that the source's declaration for the model has since
   * stopped accepting, only a resume by id is prepared; the effort is then
   * reported `withdrawn` (see {@link RunHomeOptions.resumingSession}), and a
   * launch without `resume`, `continueRecent` included, is refused.
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
   * defaults; may NOT override `KIMI_CODE_HOME`. A non-blank
   * `KIMI_MODEL_THINKING_EFFORT` (here or in the spawn env) is refused
   * beside `effort` and on a run home pinned to an effort.
   * `KIMI_MODEL_THINKING_KEEP` is taken on any launch: in kimi 2.1.0 it did
   * not switch the model, and on a `kimi`-type provider it reached the
   * request as `thinking.keep`. `KIMI_MODEL_OUTPUT_FORMAT` is taken too, and
   * has no effect: bare-kimi always passes `--output-format`, which kimi
   * takes over it. Any other `KIMI_MODEL_*` variable, here or in
   * the spawn env and even blank, is an env-model variable (see
   * {@link isModelOverlayVar}): it is refused before any effect beside
   * `model` or `effort`, with a caller-supplied `home`, and in a preloaded
   * run. Only an ephemeral launch without `model` and `effort` takes it;
   * {@link KimiSubprocess.modelOverlay} then names it,
   * `assembled.modelAlias` is not established as the model kimi runs, and
   * `assembled.configuredEffort` is null.
   */
  readonly extraEnv?: Record<string, string>;
  /**
   * Extra arguments forwarded verbatim to kimi, after bare-kimi's own flags
   * and just before its `-p`. Refused (see {@link reservedArg}), in any
   * spelling kimi 2.1.0's parser takes (`--model=x`, `-mx`, a cluster such
   * as `-yc`):
   * - a model or session selection (`-m`/`--model`, `-S`/`--session`, the
   *   hidden `-r`/`--resume`, `-c`/`--continue`, the hidden `-C`): use
   *   `model`, so the run home carries it, and `resume` or `continueRecent`,
   *   so their exclusivity and preload's fresh session hold;
   * - `--output-format` and `-p`/`--prompt`, which bare-kimi passes itself:
   *   kimi keeps the last value of a flag, so a forwarded one would replace
   *   the output format `runKimi` parses, and bare-kimi's trailing `-p` would
   *   silently drop a forwarded prompt;
   * - `--`, after which kimi reads no flag, bare-kimi's `-p` included;
   * - a last argument that is a flag taking a value (`--add-dir`,
   *   `--skills-dir`, `--agent`, `--agent-file`): kimi's parser would take
   *   bare-kimi's `-p` as that value.
   * A flag taking a value earlier in the list takes the forwarded argument
   * after it, whatever it looks like; that pairing is the caller's.
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
 * spawn env, and a blank value is taken as unset. kimi 2.1.0 was observed to
 * do the same: on a `kimi`-type provider, an empty or single-space value,
 * natively and through bare-kimi, left the configured effort on the wire,
 * where `low` and `max` replaced it.
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

/** kimi 2.1.0's env-model name, the variable observed to switch the model. */
const ENV_MODEL_NAME = 'KIMI_MODEL_NAME';

/** kimi 2.1.0's env-only override of `thinking.keep`. */
const THINKING_KEEP_ENV = 'KIMI_MODEL_THINKING_KEEP';

/**
 * kimi 2.1.0's `-p` output format variable. As read from the bundle
 * (`resolveOutputFormat`), kimi reads it only in prompt mode and only when
 * no `--output-format` flag is given, and it is no part of the env-model
 * overlay. bare-kimi always passes the flag (see {@link buildArgv}), so the
 * variable has no effect on a bare-kimi run.
 */
const OUTPUT_FORMAT_ENV = 'KIMI_MODEL_OUTPUT_FORMAT';

/**
 * Whether bare-kimi treats `name` as feeding kimi 2.1.0's env-model overlay,
 * which adds a provider `__kimi_env__` and a model `__kimi_env_model__` and
 * makes that model the default.
 *
 * Observed (kimi 2.1.0 `-p`, loopback provider, one turn each): a non-blank
 * `KIMI_MODEL_NAME` with `KIMI_MODEL_BASE_URL` and `KIMI_MODEL_API_KEY`
 * switched a new session's request to the env model, natively and through
 * bare-kimi, and sent no effort although `[thinking]` configured one.
 * Without the key, kimi bound the session to `__kimi_env_model__` and then
 * exited 1 before any request. An empty or single-space `KIMI_MODEL_NAME`
 * beside the key and base URL left the model and the configured effort as
 * they were.
 *
 * Policy: which other variables feed the overlay is read from the bundle,
 * not observed, so every `KIMI_MODEL_*` name counts, whatever its value,
 * except three: {@link FORCED_EFFORT_ENV}, which {@link spawnKimi} checks on
 * its own; `KIMI_MODEL_THINKING_KEEP`, which alone left the model unchanged
 * and reached a `kimi`-type request as `thinking.keep`; and
 * `KIMI_MODEL_OUTPUT_FORMAT`, which kimi reads only for the output format
 * (see {@link OUTPUT_FORMAT_ENV}).
 */
export function isModelOverlayVar(name: string): boolean {
  return (
    name.startsWith('KIMI_MODEL_') &&
    name !== FORCED_EFFORT_ENV &&
    name !== THINKING_KEEP_ENV &&
    name !== OUTPUT_FORMAT_ENV
  );
}

/** An env-model variable the child will see, and the layer that sets it. */
interface ModelOverlay {
  readonly name: string;
  readonly layer: string;
  /** It is a non-blank `KIMI_MODEL_NAME`, which was observed to switch the model. */
  readonly observed: boolean;
}

/**
 * The env-model variable the child's environment will carry, by the
 * layering of {@link buildEnv}: the inherited layer is scrubbed, a name
 * `extraEnv` sets is decided there, and a spawn-env value of `undefined`
 * deletes. A non-blank `KIMI_MODEL_NAME` is named first; otherwise the first
 * other one, blank or not (see {@link isModelOverlayVar}).
 */
function modelOverlay(
  extraEnv: Record<string, string> | undefined,
  spawnEnv: Record<string, string | undefined> | undefined,
): ModelOverlay | undefined {
  const fromExtra = extraEnv !== undefined && Object.hasOwn(extraEnv, ENV_MODEL_NAME);
  const name = fromExtra ? extraEnv?.[ENV_MODEL_NAME] : spawnEnv?.[ENV_MODEL_NAME];
  if (name !== undefined && name.trim().length > 0) {
    return { name: ENV_MODEL_NAME, layer: fromExtra ? 'extraEnv' : 'the spawn env', observed: true };
  }
  const other = Object.keys(extraEnv ?? {}).find(isModelOverlayVar);
  if (other !== undefined) return { name: other, layer: 'extraEnv', observed: false };
  const fromSpawn = Object.entries(spawnEnv ?? {}).find(([key, value]) => value !== undefined && isModelOverlayVar(key));
  return fromSpawn === undefined ? undefined : { name: fromSpawn[0], layer: 'the spawn env', observed: false };
}

/**
 * Refuse, before any effect, an env-model variable beside `model` or
 * `effort`, or on a caller-supplied (kept) home. What each refusal rests on:
 * - on a kept home: observed, a new session ran the env model instead of
 *   the home's alias, and was bound to it even when kimi then failed;
 *   whether a later run without the variable can resume it was not examined;
 * - beside `effort`: observed, with the env model active kimi sent no
 *   effort although `[thinking]` configured one;
 * - beside `model`: policy. Natively, `--model` beside the overlay requested
 *   the named alias; which model such a session is bound to was not
 *   examined.
 * Any env-model variable but a non-blank `KIMI_MODEL_NAME` is refused on the
 * same terms as policy (see {@link isModelOverlayVar}).
 */
function checkModelOverlay(
  variable: ModelOverlay | undefined,
  model: string | undefined,
  effort: string | undefined,
  kept: boolean,
): void {
  if (variable === undefined) return;
  let why: string;
  let observed: string;
  if (model !== undefined) {
    why = `beside model "${model}"`;
    observed =
      'beside --model, kimi requested the named alias, but which model such a session is bound to was not ' +
      'examined, so this is policy';
  } else if (effort !== undefined) {
    why = `beside effort "${effort}"`;
    observed = 'with the env model active, kimi sent no effort although one was configured';
  } else if (kept) {
    why = 'on a kept run home';
    observed = "a new session ran the env model instead of the home's alias and was bound to it";
  } else {
    return;
  }
  const what = variable.observed
    ? `${variable.name} in ${variable.layer} switches kimi 2.1.0 to its env model (__kimi_env_model__), as ` +
      `observed; ${observed}`
    : `${variable.name} in ${variable.layer} is an env-model variable: only a non-blank ${ENV_MODEL_NAME} was ` +
      'observed to switch kimi to its env model (__kimi_env_model__), and bare-kimi refuses the others as policy';
  throw new Error(`${what}; refused ${why} (only an ephemeral launch without model or effort may set it)`);
}

/** kimi 2.1.0's short flags that take no value (`-c`, `-C`, `-y`, `-h`, `-V`), which a cluster may chain. */
const CHAINABLE_SHORT_FLAGS = new Set(['c', 'C', 'y', 'h', 'V']);

/**
 * kimi 2.1.0's long flags that require a value and are not otherwise
 * reserved (`createProgram`). kimi's parser (commander) takes the next
 * argument as a required value whatever it looks like.
 */
const VALUE_LONG_FLAGS = new Set(['--add-dir', '--skills-dir', '--agent', '--agent-file']);

/** What a reserved forwarded argument would take over; see {@link reservedArg}. */
type ReservedArg = 'model' | 'session' | 'output format' | 'prompt' | 'end of options';

/**
 * Whether `arg` would take over something bare-kimi passes or arranges
 * itself, as kimi 2.1.0's command-line parser (`createProgram`, commander)
 * reads an option argument: `--model`, `--session`, `--resume`,
 * `--continue`, `--output-format` or `--prompt`, alone or with `=value`;
 * `-m`, `-S`, `-r`, `-c`, `-C` or `-p`, alone, with a value attached
 * (`-mx`, `-px`), or reached through a cluster of flags that take no value
 * (`-yc`, `-yp`); or `--`, which ends option parsing. A cluster stops at any
 * other letter: kimi rejects an unknown one. An argument meant as the value
 * of the one before it is read the same way, so such a value is refused when
 * it looks like one of these flags.
 */
function reservedArg(arg: string): ReservedArg | undefined {
  if (arg === '--') return 'end of options';
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=', 1)[0];
    if (name === 'model') return 'model';
    if (name === 'output-format') return 'output format';
    if (name === 'prompt') return 'prompt';
    return name === 'session' || name === 'resume' || name === 'continue' ? 'session' : undefined;
  }
  if (!arg.startsWith('-')) return undefined;
  for (const flag of arg.slice(1)) {
    if (flag === 'm') return 'model';
    if (flag === 'p') return 'prompt';
    if (flag === 'S' || flag === 'r' || flag === 'c' || flag === 'C') return 'session';
    if (!CHAINABLE_SHORT_FLAGS.has(flag)) return undefined;
  }
  return undefined;
}

/** What a forwarded argument of each {@link ReservedArg} kind does, why it is refused, and what to use instead. */
const RESERVED_ARGS: Readonly<Record<ReservedArg, string>> = {
  model: 'selects a model; pass it as the model option: the run home must carry it',
  session: 'selects a session; pass it as resume or continueRecent, which are exclusive and which a preloaded run refuses',
  'output format':
    'sets the output format; pass it as the outputFormat option: bare-kimi passes --output-format itself, kimi ' +
    'keeps the last value, and runKimi parses the format it asked for',
  prompt: "sets the prompt; pass it as the prompt option: bare-kimi's own -p comes last, so kimi would drop this one",
  'end of options': "ends kimi's options: kimi would read no flag after it, bare-kimi's own -p included",
};

export function LaunchConfig(o: LaunchOptions): LaunchConfig {
  if (o.resume !== undefined && o.continueRecent === true) {
    throw new Error('resume and continueRecent are mutually exclusive');
  }
  if (o.model !== undefined && o.model.length === 0) throw new Error('model must not be empty');
  if (o.effort !== undefined && o.effort.length === 0) throw new Error('effort must not be empty');
  if (o.effort !== undefined && forcedEffort(o.extraEnv, undefined) !== undefined) {
    throw forcedEffortConflict('extraEnv');
  }
  checkModelOverlay(modelOverlay(o.extraEnv, undefined), o.model, o.effort, o.home !== undefined && o.home.length > 0);
  const extraArgs = o.extraArgs ?? [];
  for (const arg of extraArgs) {
    const reserved = reservedArg(arg);
    if (reserved !== undefined) throw new Error(`extraArgs ${JSON.stringify(arg)} ${RESERVED_ARGS[reserved]}`);
  }
  const last = extraArgs.at(-1);
  if (last !== undefined && VALUE_LONG_FLAGS.has(last)) {
    throw new Error(
      `extraArgs ends with ${JSON.stringify(last)}, which takes a value: kimi would take bare-kimi's own -p ` +
        `as that value and lose the prompt; give the value too (${last} VALUE or ${last}=VALUE)`,
    );
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
 * Refuse a prompt starting with `-` as conservative wrapper policy.
 * kimi 2.1.0 takes the next argument after `-p` as its value, including a
 * leading dash. Called before filesystem work, so refusal leaves nothing behind.
 */
export function assertSafePrompt(prompt: string): void {
  if (prompt.startsWith('-')) {
    throw new Error('prompt starts with "-": refused by bare-kimi policy');
  }
}

/**
 * Every check on launch options that needs no filesystem: prompt shape,
 * option conflicts, and the selection checks that need no config (an empty
 * model or effort, an effort beside a forced one in `extraEnv`, an env-model
 * variable in `extraEnv` beside `model`, `effort` or a `home`, a reserved or
 * value-less trailing argument in `extraArgs` (see {@link LaunchOptions.extraArgs}),
 * adoption without a home). spawnKimi runs it first; a caller
 * that does its own setup (the CLI's --keep-home) runs it before that setup.
 * Checks against the source config are {@link previewRunHome}'s.
 */
export function checkLaunchOptions(options: LaunchOptions): LaunchConfig {
  assertSafePrompt(options.prompt);
  return LaunchConfig(options);
}

/**
 * The command vector handed to Bun.spawn. Flags as read from the installed
 * kimi 2.1.0 bundle's `createProgram`: `-m/--model <model>`,
 * `-S/--session [id]`, `-c/--continue`, repeatable `--skills-dir <dir>` and
 * `--add-dir <dir>`, `--output-format <text|stream-json>`,
 * `-p/--prompt <prompt>`.
 *
 * `--output-format` is passed for `text` too: kimi takes the flag over its
 * `KIMI_MODEL_OUTPUT_FORMAT` environment variable (`resolveOutputFormat`),
 * so the format `runKimi` parses is the one asked for. `-p <prompt>` is
 * last. kimi's parser keeps the last value of a repeated flag and takes the
 * argument after a flag that requires a value, whatever it looks like, so
 * the prompt stays bare-kimi's only because {@link LaunchConfig} refuses
 * forwarded arguments that would take it over or end in such a flag (see
 * {@link LaunchOptions.extraArgs}).
 */
export function buildArgv(config: LaunchConfig, kimiBin: string): string[] {
  const argv: string[] = [kimiBin];
  if (config.model !== undefined) argv.push('--model', config.model);
  if (config.resume !== undefined) argv.push('--session', config.resume);
  if (config.continueRecent) argv.push('--continue');
  for (const dir of config.skillsDir) argv.push('--skills-dir', dir);
  for (const dir of config.addDir) argv.push('--add-dir', dir);
  argv.push('--output-format', config.outputFormat);
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
 *   provider+model+default_model over the assembled config (see
 *   {@link isModelOverlayVar}). The prefix also covers
 *   `KIMI_MODEL_THINKING_EFFORT` and `KIMI_MODEL_THINKING_KEEP` (kimi 2.1.0
 *   env-only overrides of the thinking effort and keep, which do not switch
 *   the model), so an ambient value cannot silently replace the `[thinking]`
 *   table the run home carries, and `KIMI_MODEL_OUTPUT_FORMAT`, which kimi
 *   reads only when no `--output-format` flag is given (bare-kimi gives one).
 * - `KIMI_SECONDARY_*` — kimi 2.1.0 reads `KIMI_SECONDARY_MODEL` and
 *   `KIMI_SECONDARY_EFFORT` as overrides of the secondary (subagent) model
 *   and its effort. The run home carries no `[secondary_model]`; what the
 *   variables do in `-p` without it is not established.
 *
 * All of these can be re-added deliberately via {@link LaunchOptions.extraEnv},
 * except that an env-model variable ({@link isModelOverlayVar}) is taken only
 * by an ephemeral launch without `model` and `effort`, and refused before
 * any effect otherwise.
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
  /**
   * The run home as prepared: its model, effort, source, and whether it was
   * created, reused or adopted. With {@link modelOverlay} set, `effort` and
   * `effortSupport` are null (no effort may be selected then) and so is
   * `configuredEffort`: the home's config.toml still carries the source's
   * `[thinking]`, but with the env model active kimi 2.1.0 was observed not
   * to send its effort. `modelAlias` remains the alias that config.toml
   * carries, which kimi then does not run.
   */
  readonly assembled: AssembledHome;
  /**
   * The env-model variable the child sees (see {@link isModelOverlayVar}),
   * which only an ephemeral launch without `model` and `effort` may set; else
   * null. When set, kimi may run its env model rather than
   * `assembled.modelAlias`, as a non-blank `KIMI_MODEL_NAME` was observed to.
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
 * An env-model variable the child would see is refused beside `model` or
 * `effort` and on a caller-supplied `home` before anything is made (see
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
  checkModelOverlay(overlay, config.model, config.effort, !ephemeral);

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
      // Only a resume by id: kimi's --continue may start a fresh session.
      resumingSession: config.resume !== undefined,
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
      assembled:
        overlay === undefined
          ? assembled
          : { ...assembled, effort: null, effortSupport: null, effortWithdrawn: null, configuredEffort: null },
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
  /**
   * The run home as prepared for this run, as {@link KimiSubprocess.assembled}
   * reports it; undefined when the binary could not be spawned.
   */
  readonly assembled: AssembledHome | undefined;
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
      assembled: undefined,
    };
  }
  const { subprocess, home, assembled } = launched;
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
      assembled,
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
