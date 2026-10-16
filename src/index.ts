import { mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  assembleHome,
  assertDistinctHomes,
  ensureAuth,
  isAssembledHome,
  makeEphemeralHome,
  removeHome,
  shredCopiedCredentials,
  sourceHome,
  type AuthMode,
} from './home.ts';
import {
  parseStreamJson,
  sessionIdFromEvents,
  type KimiStreamEvent,
} from './events.ts';

export {
  assembleHome,
  assertDistinctHomes,
  donateAuth,
  ensureAuth,
  isAssembledHome,
  makeEphemeralHome,
  removeHome,
  shredCopiedCredentials,
  sourceHome,
  CREDENTIALS_MARKER,
  EPHEMERAL_MARKER,
  type AssembledHome,
  type AuthMode,
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
   * The call to action. Must not start with `-`: kimi would parse it as a
   * flag even though it follows `-p`.
   */
  readonly prompt: string;
  /** Working directory of the run. Sessions bind to it: a resume must happen in the same cwd. */
  readonly cwd?: string;
  /**
   * Run home. When omitted, a fresh ephemeral home is mkdtemp'd and removed
   * by dispose(). A caller-supplied home is kept; if it already holds a
   * config.toml it is used as-is (a prepared home is never overwritten),
   * otherwise it is assembled from the source home. A relative path resolves
   * against this process's working directory, not against `cwd`.
   */
  readonly home?: string;
  /**
   * Source home to assemble/donate from. Passing it forces re-assembly of a
   * caller-supplied `home`. Default: `KIMI_CODE_HOME_SOURCE` ?? `~/.kimi-code`.
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
  /** Model alias (`-m`). Defaults to the assembled config's default_model. */
  readonly model?: string;
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
   * defaults; may NOT override `KIMI_CODE_HOME`.
   */
  readonly extraEnv?: Record<string, string>;
  /** Extra arguments forwarded verbatim to kimi, just before `-p`. */
  readonly extraArgs?: string[];
}

export type LaunchConfig = Required<Omit<LaunchOptions, 'model' | 'resume'>> &
  Pick<LaunchOptions, 'model' | 'resume'>;

export function LaunchConfig(o: LaunchOptions): LaunchConfig {
  if (o.resume !== undefined && o.continueRecent === true) {
    throw new Error('resume and continueRecent are mutually exclusive');
  }
  return {
    prompt: o.prompt,
    cwd: o.cwd ?? '',
    home: o.home ?? '',
    srcHome: o.srcHome ?? '',
    authMode: o.authMode ?? 'link',
    keepCredentials: o.keepCredentials ?? false,
    model: o.model,
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
 * Every check on launch options that needs no filesystem: prompt shape and
 * option conflicts. spawnKimi runs it first; a caller that does its own setup
 * (the CLI's --keep-home) runs it before that setup.
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
 *   home carries from the source config.
 *
 * All of these can be re-added deliberately via {@link LaunchOptions.extraEnv}
 * — e.g. `{ KIMI_MODEL_THINKING_EFFORT: 'high' }` to choose an effort for one
 * run.
 */
export function isScrubbedEnvVar(name: string): boolean {
  return (
    name === 'KIMI_CODE_BASE_URL' ||
    name === 'KIMI_CODE_OAUTH_HOST' ||
    name === 'KIMI_OAUTH_HOST' ||
    name === 'KIMI_DISABLE_OAUTH_LOCK' ||
    name.startsWith('KIMI_MODEL_')
  );
}

export interface EnvContext {
  /** The resolved run home; forced as `KIMI_CODE_HOME`, never overridable. */
  readonly home: string;
  /** Environment inherited by the child. Defaults to `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** A spawn-options env layer, applied between the inherited layer and extraEnv. */
  readonly spawnEnv?: Record<string, string | undefined>;
}

/**
 * Layered child environment, later wins:
 *
 * 1. inherited `parentEnv` (unless `noProcessEnv`), minus the scrubbed
 *    variables and any inherited `KIMI_CODE_HOME`;
 * 2. `spawnEnv`;
 * 3. `extraEnv`;
 * 4. defaults, only when still unset: `KIMI_DISABLE_TELEMETRY=1`,
 *    `KIMI_CODE_NO_AUTO_UPDATE=1` — the update preflight can otherwise spawn
 *    a global package-manager install from a headless run
 *    (kimi-code @ 6451f1e `apps/kimi-code/src/cli/update/preflight.ts`);
 * 5. `KIMI_CODE_HOME` = the run home — forced, never empty, never
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
 * the config, prepares the home (assemble or re-donate auth) and spawns.
 *
 * `spawnOptions` is forwarded to `Bun.spawn` except for the fields this
 * function resolves rather than passes through: `cmd`, `cwd`
 * (`launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`), `env` (see
 * {@link buildEnv}), and `stdin` (defaults to `ignore`).
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

  const cwd = config.cwd.length > 0 ? config.cwd : (spawnOptions.cwd ?? process.cwd());
  const ephemeral = config.home.length === 0;
  // Absolute before anything else sees it: the child runs in `cwd` and would
  // read a relative KIMI_CODE_HOME against that directory instead.
  const home = ephemeral ? makeEphemeralHome() : resolvePath(config.home);

  try {
    const src = resolvePath(sourceHome(config.srcHome.length > 0 ? config.srcHome : undefined));
    assertDistinctHomes(src, home);
    if (config.srcHome.length > 0 || !isAssembledHome(home)) {
      assembleHome(src, home, config.authMode);
    } else {
      ensureAuth(src, home, config.authMode);
    }

    let argvConfig = config;
    if (config.noSkills) {
      const emptySkills = resolvePath(home, EMPTY_SKILLS_DIR);
      mkdirSync(emptySkills, { recursive: true });
      argvConfig = { ...config, skillsDir: [...config.skillsDir, emptySkills] };
    }

    const env = buildEnv(config, { home, spawnEnv: spawnOptions.env });
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
