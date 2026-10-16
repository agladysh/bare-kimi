#!/usr/bin/env bun
/**
 * Optional native probe: what does an installed kimi (written against 2.1.0)
 * do with the model and effort selections bare-kimi's contract rests on?
 * Answered without credentials, without a model provider, and without
 * network beyond one loopback port. It is NOT part of `bun test`. Run it
 * deliberately, from an unsandboxed shell (sandbox-exec cannot start inside
 * another sandbox):
 *
 *   bun probe/model-effort-loopback.ts \
 *     --kimi-bin /abs/kimi --expect-version 2.1.0 \
 *     --custody /abs/fresh-empty-dir --max-custody-mib 256 \
 *     --deny-read /abs/real/.kimi-code [--deny-read /abs/real/.kimi ...] \
 *     --bare-claude-lifecycle /abs/bare-claude/src/lifecycle.ts \
 *     --bare-claude-lifecycle-sha256 <hex> \
 *     [--kimi-bundle /abs/kimi-code/dist/main.mjs] [--cases id,id,...]
 *
 * Every path is the caller's: nothing is looked up on PATH, no real home or
 * credential store is inferred, and no real configuration is read. The
 * `--deny-read` paths (the real native homes, named by the caller) are
 * denied to every sandboxed process; the probe never reads them itself.
 *
 * Questions (cases N0-N8 of the independent contract reception):
 * - n0-options (N0): kimi's declared options, for a thinking/effort flag.
 * - n1-no-thinking (N1): an effort on an openai model declared
 *   `capabilities = ["image_in"]`.
 * - n2-undeclared (N2): effort `max` on an openai model with no thinking
 *   metadata, which bare-kimi takes as `undeclared`.
 * - n3-unlisted, n3-forced-new, n3-forced-resume (N3): a kimi-type model
 *   with `support_efforts`: an unlisted effort; `KIMI_MODEL_THINKING_EFFORT`
 *   set to `low`, `max`, `''` and `' '` on a new session (2.1.0 binds it as
 *   `thinking.forcedEffort` through `envBindings`, whose trimming is not in
 *   the excerpts read); forced on a resume; configured against stored effort
 *   on a kimi-type resume.
 * - n4-resume (N4): configured against stored effort and model on resume,
 *   and `--model A|B --session S`.
 * - n5-overlay (N5): the env model. As read from the 2.1.0 bundle, only a
 *   non-empty (trimmed) `KIMI_MODEL_NAME` switches the default model to
 *   `__kimi_env_model__`, on provider `__kimi_env__` built from
 *   `KIMI_MODEL_API_KEY`, `KIMI_MODEL_PROVIDER_TYPE` (default `kimi`) and
 *   `KIMI_MODEL_BASE_URL`; without the base URL one path falls back to the
 *   type's default host and the other to `KIMI_BASE_URL` first. Without the
 *   name, `KIMI_MODEL_THINKING_KEEP` (and temperature, top-p, max tokens)
 *   still become model overrides. Which path `-p` takes is observed here,
 *   not assumed. Every overlay step names a loopback base URL, so no step
 *   directs kimi off the host; the sandbox would deny it regardless.
 * - n6-secondary (N6): `KIMI_SECONDARY_MODEL`/`KIMI_SECONDARY_EFFORT` in
 *   `-p` with no `[secondary_model]`, naming a configured alias (which 2.1.0
 *   derives `__secondary__` from) and an unconfigured one.
 * - n8-always (N8): `[thinking] enabled = false` on a model with the field
 *   `always_thinking = true` against the capability string
 *   `"always_thinking"`, with no off effort declared. Its off control may
 *   fail before any request, which leaves the comparison unknown.
 * - n8b-off (N8): the same comparison against a working off control, a
 *   thinking model declaring `off_effort = "none"`; and `off` on models
 *   declaring thinking by capability only, by `support_efforts` only, or not
 *   at all, none declaring an off effort. Open: what `off` sends once an off
 *   effort is declared; whether the field and the capability string differ
 *   from that control; which declarations make kimi fail before sending; and
 *   how that failure ends (the known thinking-plus-support-efforts failure has the one long
 *   deadline; the other no-off steps are short and show only kimi's first
 *   retry reports).
 * - n2-kimi-undeclared (N2): efforts `high` and `max` on a kimi-type model
 *   declaring thinking but no `support_efforts`, natively and through
 *   bare-kimi (which takes it as `undeclared`). Open: whether strict
 *   validation sends either as configured.
 *
 * - n8c-kimi-off (N8): thinking off on the strict kimi type, on ctl-kimi's
 *   model without an off effort (the one long step), the same with
 *   `off_effort = "none"`, and capability-only thinking; plus bare-kimi's
 *   `off` on the first. Open: whether the kimi type needs a declared off
 *   effort for `off` as the openai type does, or sends a disabled thinking
 *   type without one; and what it sends with one.
 *
 * A turn with thinking off counts as off honored when it sent no `enabled`
 * thinking type and no effort, or only the off effort that same step's
 * config declared; an `enabled` type contradicts off. kimi's own
 * `turn.step.retrying` reports, in a step that sent no request of any kind,
 * are read as a client-side failure observed before the step ended; the
 * answer says whether a deadline cut it short and claims no exit not seen.
 * - ctl-openai, ctl-kimi: controls showing the configured effort on the
 *   wire for each provider type. A case that depends on one runs it first,
 *   also when only that case is selected; its effort answers are `unknown`
 *   unless the control was observed.
 *
 * Each case runs steps of two kinds, every one inside the same sandbox:
 * - `library`: bare-kimi's own `spawnKimi` (this checkout's `src/index.ts`),
 *   driven by a small script, against a synthetic source home. It records
 *   whether bare-kimi refuses (before any effect) or launches, and what it
 *   assembled; when it launches, the kimi it starts is observed like any
 *   other. Whether that matched what the step expected is a recorded fact,
 *   never a pass.
 * - `native`: kimi itself, with `KIMI_CODE_HOME` set to a home whose
 *   config.toml the probe writes, for what bare-kimi refuses to set up (or
 *   to compare). Production code is not changed to run anything.
 *
 * How:
 * - A loopback HTTP server stands in for an OpenAI-compatible provider. Each
 *   case's provider lives under `/s/<case>/v1`; a request is attributed to
 *   its case by path and to the step running at the time. Steps run one at
 *   a time: the next starts only after the step's own process group reads
 *   empty. That group is not every descendant: one that started a session of
 *   its own would be outside it, and a late request from it would be
 *   attributed to the next step of the same case. A request outside its
 *   case's steps makes that case `unknown`. Every request is answered with
 *   plain text and appended, with the reply, to `evidence/requests.jsonl` as
 *   it arrives. Credential-shaped headers are never stored verbatim: the
 *   probe's dummy key is logged as `dummy`, anything else as `other:<8 hex of
 *   its SHA-256>`, and anything else stops dispatch. The device-name header
 *   is logged as a hash.
 * - Effort is read from the request kimi sent: every value outside
 *   `messages` and `tools` under a key matching /effort|think|reason/i (the
 *   kimi type sends `thinking: { type, effort, keep }`). The step's own turn
 *   is the request carrying the probe's prompt; several that disagree, or
 *   an effort value outside the known names, make the answer `unknown`.
 * - A step cannot answer for kimi (its answers are `unknown`) when it was
 *   stopped (deadline, signal, or members left in its group), when kimi
 *   reported a dropped config section, when a request of it could not be
 *   logged or carried an unexpected credential, when it fetched the model
 *   catalog (`/models`), when a config.toml it was given changed during it,
 *   or when kimi exited without a request with a sandbox-like error.
 * - Isolation (probe/isolation.ts) extends the contract of
 *   probe/native-loopback.ts: macOS `sandbox-exec` allows outbound network
 *   only to the provider port and writes only under `<custody>/root`, denies
 *   reads of the `--deny-read` paths and of a synthetic decoy home, and here
 *   also denies executing `/usr/bin/open`, `/usr/bin/security` and
 *   `/usr/bin/osascript` and looking up the LaunchServices and SecurityServer
 *   Mach services. Paired preflight runs (unsandboxed, sandboxed,
 *   unsandboxed) must show the network, write, read and exec denials before
 *   kimi starts, or the probe refuses. The Mach denial is in the profile but
 *   not shown by the preflight.
 * - Process groups: every child leads its own group and is supervised and
 *   stopped through bare-claude's published lifecycle module
 *   (`superviseSignals`, `stopClaude`, `readProcessGroup`), which bare-kimi
 *   does not depend on. The caller names the module file and its SHA-256;
 *   the verified bytes are written into custody and imported from there. A
 *   group's state is `empty`, `occupied` or `not-permitted` as that module
 *   reads it, or `unknown` when it could not be read. Anything but `empty`
 *   stops all further dispatch, as does a child that does not lead its own
 *   group. Each child's pid is appended to `evidence/progress.jsonl` as soon
 *   as it is spawned, so a probe killed outright still names what it left.
 *
 * Custody: everything the probe and the runs write lives under `--custody`,
 * which must be an existing, empty directory of the caller's, outside every
 * denied path, with no AGENTS.md or Git repository above it:
 * - `root/` (sandbox-writable): synthetic HOME/TMPDIR/caches and, per case,
 *   `cases/<case>/` with its source home, run and native homes, work dir and
 *   one directory per step (stdout, stderr, config written, driver result);
 * - `decoy-home/` (read-denied) and `write-check/` (write-denied), the
 *   preflight's paired targets;
 * - `evidence/`: `report.json`, `requests.jsonl`, `progress.jsonl` (one line
 *   per finished step), the preflight runs, the sandbox profile and the
 *   verified lifecycle copy.
 * Nothing is removed except what bare-kimi's own dispose removes (the
 * ephemeral homes it made in `root/tmp`). `--max-custody-mib` is a budget for
 * the whole run: the custody tree is measured before each step, and at or
 * over it (or unmeasurable) dispatch stops. Free space is the owner's to
 * check before running. Expected allocation is small: session files,
 * request bodies of tens of KiB each, runtime caches.
 *
 * Outcomes: each case is `observed` (every question answered from evidence),
 * `unknown` (some answer not established, each saying why), `failed` (a
 * harness fault in a step) or `not-run` (no step dispatched, with the
 * reason). Nothing is reported as passed. Exit codes:
 *   0  every selected case observed
 *   1  report written; some case unknown, failed or not run
 *   2  refused before kimi was launched (options, custody, lifecycle,
 *      isolation preflight)
 *   3  kimi's `--version` did not show --expect-version; no case dispatched
 *   4  dispatch stopped: a process group not shown empty or not led by its
 *      child, an unexpected credential in a request, a progress-log write
 *      failure, or the custody budget reached or unmeasurable
 *   5  the probe failed after kimi was launched
 *   128+n  interrupted by signal n; cases not reached are `not-run`
 *
 * The report names the denied paths and the custody directory; keep it
 * private. This is one observation of one installed kimi under one sandbox
 * profile, not a claim about kimi in general and not an OS-level guarantee.
 * Direct socket isolation does not cover IPC delegation to system services.
 */

import { createHash } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isMetaSessionResumeHint, isMetaSystemVersion, isMetaTurnStepRetrying, parseStreamJson } from '../src/events.ts';
import { DELEGATION_EXEC, DELEGATION_MACH, EXEC_CONTROL, PREFLIGHT, droppedSections, judgeIsolation, sandboxProfile } from './isolation.ts';

const SCHEMA = 'bare-kimi/model-effort-loopback/1';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SOURCE_ROOT = resolve(import.meta.dir, '..');
const BARE_KIMI_INDEX = join(SOURCE_ROOT, 'src', 'index.ts');
/** Hashed into the report, so root can tie the run to the source it inspected. */
const SOURCE_FILES = [
  'probe/model-effort-loopback.ts',
  'probe/isolation.ts',
  'src/index.ts',
  'src/home.ts',
  'src/events.ts',
  'src/preload.ts',
  'package.json',
  'bun.lock',
];
const DUMMY_KEY = 'probe-dummy-not-a-secret';
const PROMPT = 'Reply with one word.';
const REPLY = 'probe-done';
const ENV_MODEL = 'probe-env-model';
const KEEP_VALUE = 'probe-keep';
const FORCED_ENV = 'KIMI_MODEL_THINKING_EFFORT';
const ENV_MARKER = '__kimi_env_model__';
const SECONDARY_MARKER = '__secondary__';
const MARKERS = [ENV_MARKER, SECONDARY_MARKER] as const;
const STEP_DEADLINE_MS = 120_000;
const PREFLIGHT_DEADLINE_MS = 30_000;
const GRACE_MS = 5_000;
const MARKER_FILE_LIMIT = 8 * 1024 * 1024;
const THINKING_KEY = /effort|think|reason/i;
const EFFORT_NAMES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** The probe cannot run safely here; kimi was not launched. */
class Refusal extends Error {}

/** Dispatch must stop for the safety of what follows, after a child was started. */
class Halt extends Error {}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errno(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

function short(text: string | undefined, max = 200): string {
  const flat = (text ?? '').trim().replaceAll(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function lastLine(text: string | undefined): string {
  const lines = (text ?? '').split('\n').filter((line) => line.trim().length > 0);
  return short(lines.at(-1) ?? '', 240);
}

/** `path` is `dir` or lies inside it (both real, absolute). */
function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A file's text; '' only when it does not exist. Any other error is thrown, not read as empty. */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if (errno(error) === 'ENOENT') return '';
    throw error;
  }
}

// ---------------------------------------------------------------- bare-claude lifecycle, verified

type GroupState = 'empty' | 'occupied' | 'not-permitted';
const GROUP_STATES: readonly string[] = ['empty', 'occupied', 'not-permitted'];

interface StoppableRun {
  readonly subprocess: {
    readonly pid: number;
    readonly exitCode: number | null;
    readonly signalCode: number | NodeJS.Signals | null;
    readonly exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  };
  readonly processGroup: number | null;
}

interface Supervisor {
  attach(run: StoppableRun): void;
  readonly stoppedBy: unknown;
  finish(): Promise<unknown>;
  release(): void;
}

/** The part of bare-claude's `src/lifecycle.ts` this probe uses. */
interface Lifecycle {
  processGroupState(pgid: number): unknown;
  readProcessGroup(pgid: number): Promise<unknown>;
  stopClaude(run: StoppableRun, options: { signal: NodeJS.Signals; graceMs: number }): Promise<unknown>;
  superviseSignals(options: { graceMs: number }): Supervisor;
}

function isLifecycle(value: unknown): value is Lifecycle {
  return (
    isRecord(value) &&
    ['processGroupState', 'readProcessGroup', 'stopClaude', 'superviseSignals'].every(
      (name) => typeof value[name] === 'function',
    )
  );
}

/** Set once the verified module is loaded, so cleanup can use it on any exit path. */
let lifecycle: Lifecycle | undefined;

/**
 * Import the caller's bare-claude lifecycle module, but only the exact bytes
 * whose SHA-256 the caller named: they are read once, checked, written into
 * custody and imported from there, so what runs is what was checked. The
 * published module imports nothing; one that did would fail to load from
 * custody and be refused.
 */
async function loadLifecycle(named: string, expected: string, evidence: string): Promise<{ lc: Lifecycle; identity: Json }> {
  if (!isAbsolute(named)) throw new Refusal('--bare-claude-lifecycle must be an absolute path');
  if (!/^[0-9a-f]{64}$/i.test(expected)) throw new Refusal('--bare-claude-lifecycle-sha256 must be 64 hex digits');
  let real: string;
  let bytes: Buffer;
  try {
    real = realpathSync(named);
    bytes = readFileSync(real);
  } catch (error) {
    throw new Refusal(`cannot read ${named}: ${message(error)}`);
  }
  const digest = sha256(bytes);
  if (digest !== expected.toLowerCase()) {
    throw new Refusal(`${real} has SHA-256 ${digest}, not the named ${expected.toLowerCase()}`);
  }
  const copy = join(evidence, 'bare-claude-lifecycle.ts');
  writeFileSync(copy, bytes, { mode: 0o400 });
  let module: unknown;
  try {
    module = await import(copy);
  } catch (error) {
    throw new Refusal(`the verified lifecycle module does not load on its own: ${message(error)}`);
  }
  if (!isLifecycle(module)) {
    throw new Refusal('the lifecycle module does not export processGroupState, readProcessGroup, stopClaude and superviseSignals');
  }
  return { lc: module, identity: { named, real, sha256: digest, bytes: bytes.length, custodyCopy: copy } };
}

interface GroupReading {
  readonly state: GroupState | 'unknown';
  readonly observations: readonly unknown[];
  readonly error: string | null;
}

/** The lifecycle's reading of a group, checked; a value it should not return, or a throw, is `unknown`. */
async function readGroup(lc: Lifecycle, pgid: number): Promise<GroupReading> {
  try {
    const reading = await lc.readProcessGroup(pgid);
    if (isRecord(reading) && typeof reading['state'] === 'string' && GROUP_STATES.includes(reading['state'])) {
      const observations = Array.isArray(reading['observations']) ? reading['observations'] : [];
      return { state: reading['state'] as GroupState, observations, error: null };
    }
    return { state: 'unknown', observations: [], error: `unexpected reading ${JSON.stringify(reading)}` };
  } catch (error) {
    return { state: 'unknown', observations: [], error: message(error) };
  }
}

function groupStateNow(lc: Lifecycle, pgid: number): GroupState | 'unknown' {
  try {
    const state = lc.processGroupState(pgid);
    return typeof state === 'string' && GROUP_STATES.includes(state) ? (state as GroupState) : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------- owned processes

/** Runs this probe started whose group it has not yet seen empty. */
const owned = new Map<number, StoppableRun>();

/** `evidence/progress.jsonl`: spawns and finished steps, appended as they happen. Set once custody exists. */
let progressPath = '';
/** Progress lines that could not be written. Any stops dispatch: a spawn would go unrecorded. */
const progressFailures: string[] = [];

function logProgress(entry: Json): void {
  const what = `${String(entry['event'])} ${String(entry['label'] ?? entry['case'] ?? '')}`;
  if (progressPath === '') {
    progressFailures.push(`${what}: no progress log yet`);
    return;
  }
  try {
    appendFileSync(progressPath, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    progressFailures.push(`${what}: ${message(error)}`);
  }
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
type StopSignal = keyof typeof SIGNAL_NUMBERS;
const interruption: { signal: StopSignal | null } = { signal: null };

/**
 * A signal to the probe stops the run in progress (its supervisor does that)
 * and, through this flag, any further dispatch. The probe then writes its
 * report and exits 128+n itself.
 */
function watchInterrupts(): void {
  for (const signal of Object.keys(SIGNAL_NUMBERS) as StopSignal[]) {
    process.on(signal, () => {
      interruption.signal ??= signal;
    });
  }
}

export interface ProcessRecord {
  readonly spawnError: string | null;
  readonly pid: number | null;
  /** The group's state just after spawn, as evidence that the child leads it. */
  readonly initialGroupState: GroupState | 'unknown' | null;
  /**
   * `led`: the group read occupied just after spawn. `not-led`: it read
   * empty while the child had not exited, so the child does not lead it.
   * `exited-before-check`: it read empty and the child had already exited.
   * Otherwise the reading itself. Anything but `led` or
   * `exited-before-check` stops dispatch.
   */
  readonly leader: 'led' | 'not-led' | 'exited-before-check' | 'not-permitted' | 'unknown' | null;
  readonly deadlineHit: boolean;
  readonly exitCode: number | null;
  readonly signalCode: number | string | null;
  readonly stoppedBy: unknown;
  readonly stop: unknown;
  /** `never-started` when nothing was spawned; anything but `empty`/`never-started` stops dispatch. */
  readonly groupState: GroupState | 'unknown' | 'never-started';
  readonly groupObservations: readonly unknown[];
  readonly groupError: string | null;
}

/** A detached child (its own session and group) whose output goes straight to files. */
function spawnDetached(cmd: string[], env: Record<string, string>, cwd: string, out: string, err: string): StoppableRun {
  const stdout = openSync(out, 'w', 0o600);
  const stderr = openSync(err, 'w', 0o600);
  try {
    const subprocess = Bun.spawn({ cmd, cwd, env, detached: true, stdin: 'ignore', stdout, stderr });
    return { subprocess, processGroup: subprocess.pid };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

/**
 * One child under bare-claude's supervision: a signal to the probe stops it,
 * the deadline stops it with `stopClaude`, and anything left in its group
 * after a natural exit is stopped the same way. The group's final state is
 * read by `readProcessGroup`, which reads `not-permitted` again for a while
 * and never reports it as `empty`.
 */
async function runOwned(
  lc: Lifecycle,
  label: string,
  cmd: string[],
  env: Record<string, string>,
  cwd: string,
  deadlineMs: number,
  out: string,
  err: string,
): Promise<ProcessRecord> {
  const supervisor = lc.superviseSignals({ graceMs: GRACE_MS });
  let run: StoppableRun;
  try {
    run = spawnDetached(cmd, env, cwd, out, err);
  } catch (error) {
    supervisor.release();
    return {
      spawnError: message(error),
      pid: null,
      initialGroupState: null,
      leader: null,
      deadlineHit: false,
      exitCode: null,
      signalCode: null,
      stoppedBy: null,
      stop: null,
      groupState: 'never-started',
      groupObservations: [],
      groupError: null,
    };
  }
  supervisor.attach(run);
  const pid = run.subprocess.pid;
  owned.set(pid, run);
  const initialGroupState = groupStateNow(lc, pid);
  const leader =
    initialGroupState === 'occupied'
      ? 'led'
      : initialGroupState === 'empty'
        ? run.subprocess.exitCode === null && run.subprocess.signalCode === null
          ? 'not-led'
          : 'exited-before-check'
        : initialGroupState;
  logProgress({ event: 'spawned', label, pid, initialGroupState, leader, at: now() });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((done) => {
    timer = setTimeout(() => done('deadline'), deadlineMs);
  });
  const first = await Promise.race([run.subprocess.exited.then(() => 'exited' as const), deadline]);
  clearTimeout(timer);

  let stop: unknown = null;
  let groupError: string | null = null;
  try {
    if (first === 'deadline') stop = await lc.stopClaude(run, { signal: 'SIGTERM', graceMs: GRACE_MS });
  } catch (error) {
    groupError = message(error);
  }
  const finished = await supervisor.finish().catch((error: unknown) => {
    groupError ??= message(error);
    return null;
  });
  stop ??= finished;
  if (stop === null) {
    const after = await readGroup(lc, pid);
    if (after.state === 'occupied') {
      try {
        stop = await lc.stopClaude(run, { signal: 'SIGTERM', graceMs: GRACE_MS });
      } catch (error) {
        groupError ??= message(error);
      }
    }
  }
  const final = await readGroup(lc, pid);
  if (final.state === 'empty') owned.delete(pid);
  return {
    spawnError: null,
    pid,
    initialGroupState,
    leader,
    deadlineHit: first === 'deadline',
    exitCode: run.subprocess.exitCode,
    signalCode: run.subprocess.signalCode,
    stoppedBy: supervisor.stoppedBy,
    stop,
    groupState: final.state,
    groupObservations: final.observations,
    groupError: groupError ?? final.error,
  };
}

/** The child led its own process group, or had already exited when that was checked. */
function leads(run: ProcessRecord): boolean {
  return run.leader === 'led' || run.leader === 'exited-before-check';
}

/** Where `name` first resolves on this process's PATH, for the record (nothing is run). Null when not found. */
function onPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir.length === 0) continue;
    try {
      const candidate = join(dir, name);
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** On the way out: stop whatever owned group still reads occupied, and say what is left. */
async function releaseOwned(lc: Lifecycle | undefined): Promise<Json[]> {
  const left: Json[] = [];
  for (const [pid, run] of owned) {
    if (lc === undefined) {
      left.push({ pid, state: 'unknown', error: 'no lifecycle module loaded' });
      continue;
    }
    let reading = await readGroup(lc, pid);
    if (reading.state === 'occupied') {
      try {
        await lc.stopClaude(run, { signal: 'SIGTERM', graceMs: GRACE_MS });
      } catch (error) {
        left.push({ pid, stopError: message(error) });
      }
      reading = await readGroup(lc, pid);
    }
    if (reading.state === 'empty') owned.delete(pid);
    else left.push({ pid, state: reading.state, error: reading.error });
  }
  return left;
}

// ---------------------------------------------------------------- loopback provider

export interface Field {
  readonly path: string;
  readonly value: unknown;
}

/** What a chat request showed, kept in memory; the full request is in requests.jsonl. */
export interface ChatSummary {
  readonly seq: number;
  readonly path: string;
  readonly model: string | null;
  /** It carries the probe's prompt: the run's own turn, not some side request. */
  readonly main: boolean;
  /** Values outside `messages`/`tools` under a key matching /effort|think|reason/i. */
  readonly fields: readonly Field[];
}

export type RequestKind = 'chat' | 'models' | 'health' | 'not-found';

interface Attributed {
  readonly seq: number;
  readonly caseId: string;
  readonly step: string;
  readonly kind: RequestKind;
  readonly chat: ChatSummary | null;
  /** Credential-shaped headers that did not carry the probe's dummy key. */
  readonly unexpectedCredentials: readonly string[];
}

interface LogFailure {
  readonly seq: number;
  readonly caseId: string;
  readonly step: string;
  readonly error: string;
}

const knownCases = new Set<string>();
const attributed: Attributed[] = [];
const logFailures: LogFailure[] = [];

/** Header names that may carry a credential; their values are never stored. */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|password|auth/i;
/** Header names whose values identify the machine; stored as a hash. */
const PRIVATE_HEADER = /^x-msh-device-name$/i;

/**
 * Headers as stored in the request log. A credential-shaped header becomes
 * `dummy` when it is the probe's dummy key (bare or as a bearer token) and
 * `other:<first 8 hex of its SHA-256>` otherwise; every `other` is returned
 * in `unexpected`, and the probe stops dispatch on any. A private header
 * becomes `sha256:<first 8 hex>`. Everything else is kept as sent.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): { headers: Record<string, string>; unexpected: string[] } {
  const out: Record<string, string> = {};
  const unexpected: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADER.test(name)) {
      if (value === DUMMY_KEY || value === `Bearer ${DUMMY_KEY}`) {
        out[name] = 'dummy';
      } else {
        out[name] = `other:${sha256(value).slice(0, 8)}`;
        unexpected.push(name);
      }
    } else if (PRIVATE_HEADER.test(name)) {
      out[name] = `sha256:${sha256(value).slice(0, 8)}`;
    } else {
      out[name] = value;
    }
  }
  return { headers: out, unexpected };
}
let requestLog = '';
let sequence = 0;
let active: { caseId: string; stepId: string } | null = null;

function thinkingFields(body: unknown): Field[] {
  const out: Field[] = [];
  const walk = (value: unknown, path: string, hit: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => walk(item, `${path}[${index}]`, hit));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (path === '$' && (key === 'messages' || key === 'tools')) continue;
        walk(item, `${path}.${key}`, hit || THINKING_KEY.test(key));
      }
    } else if (hit) {
      out.push({ path, value });
    }
  };
  walk(body, '$', false);
  return out;
}

function chatResponse(body: unknown): Response {
  const model = isRecord(body) && typeof body['model'] === 'string' ? body['model'] : 'probe';
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const base = { id: 'chatcmpl-probe', created: 0, model };
  if (!(isRecord(body) && body['stream'] === true)) {
    return Response.json({
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
      usage,
    });
  }
  const chunks = [
    { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }] },
    { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, object: 'chat.completion.chunk', choices: [], usage },
  ];
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const text = request.method === 'POST' ? await request.text() : '';
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const named = /^\/s\/([a-z0-9-]+)\//.exec(url.pathname)?.[1];
  const known = named !== undefined && knownCases.has(named);
  const caseId = known ? named : url.pathname === '/health' ? '(preflight)' : '(unattributed)';
  const step = active !== null && active.caseId === caseId ? active.stepId : '(outside-step)';
  const seq = (sequence += 1);

  let response: Response;
  let reply: Json;
  let kind: RequestKind;
  let chat: ChatSummary | null = null;
  if (known && request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    kind = 'chat';
    response = chatResponse(body);
    reply = { status: 200, kind, streamed: isRecord(body) && body['stream'] === true, content: REPLY };
    chat = {
      seq,
      path: url.pathname,
      model: isRecord(body) && typeof body['model'] === 'string' ? body['model'] : null,
      main: JSON.stringify(body ?? null).includes(PROMPT),
      fields: thinkingFields(body),
    };
  } else if (url.pathname === '/health') {
    kind = 'health';
    response = new Response('ok');
    reply = { status: 200, kind };
  } else if (known && url.pathname.endsWith('/models')) {
    // A catalog fetch: answered, and it makes the step unusable (see usable()).
    kind = 'models';
    const data = ['probe-model-a', 'probe-model-b', ENV_MODEL].map((id) => ({ id, object: 'model', owned_by: 'probe' }));
    response = Response.json({ object: 'list', data });
    reply = { status: 200, kind, ids: data.map((item) => item.id) };
  } else {
    kind = 'not-found';
    response = new Response('not found', { status: 404 });
    reply = { status: 404, kind };
  }
  const { headers, unexpected } = redactHeaders(Object.fromEntries(request.headers));
  attributed.push({ seq, caseId, step, kind, chat, unexpectedCredentials: unexpected });
  const entry = { seq, at: now(), case: caseId, step, method: request.method, path: url.pathname, headers, body, reply };
  try {
    appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    logFailures.push({ seq, caseId, step, error: message(error) });
  }
  return response;
}

// ---------------------------------------------------------------- ambient instructions

/** No AGENTS.md or Git repository above `dir` (kimi would load them). An unreadable entry refuses too. */
function assertNoAmbientInstructions(dir: string): void {
  for (let current = dir; ; current = dirname(current)) {
    for (const name of ['AGENTS.md', '.git']) {
      const path = join(current, name);
      try {
        lstatSync(path);
      } catch (error) {
        if (errno(error) === 'ENOENT') continue;
        throw new Refusal(`cannot tell whether ${path} exists: ${message(error)}`);
      }
      throw new Refusal(`${path} exists above the custody directory; kimi would load it`);
    }
    if (dirname(current) === current) return;
  }
}

// ---------------------------------------------------------------- synthetic configs

type ProviderType = 'openai' | 'kimi';

interface ModelDef {
  readonly alias: string;
  readonly id: string;
  readonly lines: readonly string[];
}

interface HomeConfig {
  readonly provider: ProviderType;
  readonly models: readonly ModelDef[];
  readonly defaultModel: string;
  /** `[thinking]` lines, or null for no table. */
  readonly thinking: readonly string[] | null;
}

const THINKS = ['capabilities = ["thinking"]', 'support_efforts = ["low", "high"]'];
const A = (lines: readonly string[] = THINKS): ModelDef => ({ alias: 'probe/a', id: 'probe-model-a', lines });
const B = (lines: readonly string[] = THINKS): ModelDef => ({ alias: 'probe/b', id: 'probe-model-b', lines });
const effortOn = (effort: string): string[] => ['enabled = true', `effort = "${effort}"`];
const OFF = ['enabled = false'];

function cfg(
  provider: ProviderType,
  models: readonly ModelDef[],
  thinking: readonly string[] | null,
  defaultModel = 'probe/a',
): HomeConfig {
  return { provider, models, defaultModel, thinking };
}

function configText(config: HomeConfig, caseId: string, port: number): string {
  const lines = [
    `default_model = "${config.defaultModel}"`,
    '',
    '[providers.probe]',
    `type = "${config.provider}"`,
    `base_url = "http://127.0.0.1:${port}/s/${caseId}/v1"`,
    `api_key = "${DUMMY_KEY}"`,
  ];
  for (const model of config.models) {
    lines.push('', `[models."${model.alias}"]`, 'provider = "probe"', `model = "${model.id}"`, 'max_context_size = 131072');
    if (config.provider === 'openai') lines.push('protocol = "openai"');
    lines.push(...model.lines);
  }
  if (config.thinking !== null) lines.push('', '[thinking]', ...config.thinking);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- cases

interface StepBase {
  readonly id: string;
  readonly purpose: string;
  /** Resume the session an earlier step of this case created (`--session` / `resume`). */
  readonly resumeFrom?: string;
  /** This step's deadline, when not STEP_DEADLINE_MS. */
  readonly deadlineMs?: number;
}

interface NativeStep extends StepBase {
  readonly kind: 'native';
  /** Home directory name inside the case (default `native-home`). */
  readonly home?: string;
  /** Written as the home's config.toml before the step; none for an empty home. */
  readonly config?: HomeConfig;
  /** Arguments before the print flags. */
  readonly args?: readonly string[];
  /** Append `--output-format stream-json --skills-dir <empty> -p <prompt>` (default true). */
  readonly print?: boolean;
  /** Added to the child's environment; `{PORT}` is replaced by the provider port. */
  readonly env?: Readonly<Record<string, string>>;
}

interface LibraryStep extends StepBase {
  readonly kind: 'library';
  /** What bare-kimi is expected to do; recorded against what it did. */
  readonly expect: 'refused' | 'launched';
  /** The source home's config.toml. */
  readonly source: HomeConfig;
  /** Kept run home name inside the case; omitted for an ephemeral home. */
  readonly keptHome?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

type Step = NativeStep | LibraryStep;

export interface CaseDef {
  readonly id: string;
  readonly question: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly steps: readonly Step[];
  readonly judge: (j: Judging) => Record<string, string>;
}

/** The env model on a loopback provider: name, key, and the base URL of this case. */
const OVERLAY = {
  KIMI_MODEL_NAME: ENV_MODEL,
  KIMI_MODEL_API_KEY: DUMMY_KEY,
  KIMI_MODEL_BASE_URL: 'http://127.0.0.1:{PORT}/s/n5-overlay/v1',
};
const SECONDARY_ALIAS = { KIMI_SECONDARY_MODEL: 'probe/a', KIMI_SECONDARY_EFFORT: 'max' };
const SECONDARY_UNKNOWN = { KIMI_SECONDARY_MODEL: 'probe-unconfigured', KIMI_SECONDARY_EFFORT: 'max' };
const FORCED_VALUES: readonly (readonly [string, string])[] = [
  ['low', 'low'],
  ['max', 'max'],
  ['empty', ''],
  ['space', ' '],
];
const N8_BASE = ['capabilities = ["thinking"]', 'support_efforts = ["high"]'];
/**
 * The off effort as config.toml spells it. kimi 2.1.0's model schema field is
 * `offEffort` (`ModelBaseSchema`), and its own error asks to "Declare
 * offEffort (for example 'none')". config.toml keys reach that schema through
 * `modelsFromToml`, the path that turned `support_efforts` into the
 * `supportEfforts` N3 showed honored, so the TOML key is `off_effort`. The
 * converter's body (`transformPlainObject`) is not in the excerpts read; the
 * n8b-off control checks the spelling natively, since a key kimi ignored
 * would leave the off control failing as before.
 */
const OFF_NONE = 'off_effort = "none"';
const N8B_DECLARED = [...N8_BASE, OFF_NONE];
/** Long enough for kimi's off retries (10 attempts, delays reaching about 39 s) to end on their own. */
const TERMINAL_RETRY_DEADLINE_MS = 300_000;
/**
 * Ten times the 1-3 s an ordinary turn took in the extended run: enough for a
 * request, or for kimi's first retry reports; not for their terminal exit.
 */
const SHORT_DEADLINE_MS = 30_000;
const N5_HOME = cfg('openai', [A()], effortOn('high'));

export const CASES: readonly CaseDef[] = [
  {
    id: 'n0-options',
    question: 'N0',
    title: "kimi's declared options: is there a thinking or effort flag beside -p?",
    dependsOn: [],
    steps: [{ kind: 'native', id: 'help', purpose: 'kimi --help in an empty synthetic home', args: ['--help'], print: false }],
    judge: (j) => judgeOptions(j.step('help')),
  },
  {
    id: 'ctl-openai',
    question: 'control',
    title: 'the configured effort is visible on the openai wire, both routes',
    dependsOn: [],
    steps: [
      { kind: 'library', id: 'wrapper', purpose: 'bare-kimi effort "high"', expect: 'launched', source: cfg('openai', [A()], null), effort: 'high' },
      { kind: 'native', id: 'native', purpose: 'kimi, [thinking] effort "high"', config: cfg('openai', [A()], effortOn('high')) },
    ],
    judge: (j) => controlFacts(j, 'high'),
  },
  {
    id: 'n1-no-thinking',
    question: 'N1',
    title: 'an effort on an openai model declared capabilities = ["image_in"]',
    dependsOn: ['ctl-openai'],
    steps: [
      {
        kind: 'library',
        id: 'wrapper',
        purpose: 'bare-kimi effort "high"',
        expect: 'refused',
        source: cfg('openai', [A(['capabilities = ["image_in"]'])], null),
        effort: 'high',
      },
      {
        kind: 'native',
        id: 'native',
        purpose: 'kimi, [thinking] effort "high"',
        config: cfg('openai', [A(['capabilities = ["image_in"]'])], effortOn('high')),
      },
    ],
    judge: (j) => ({ 'effort "high" sent for a model declared ["image_in"]': gate(j, 'ctl-openai') ?? effortAnswer(j.step('native')) }),
  },
  {
    id: 'n2-undeclared',
    question: 'N2',
    title: 'effort "max" on an openai model with no thinking metadata',
    dependsOn: ['ctl-openai'],
    steps: [
      { kind: 'library', id: 'wrapper', purpose: 'bare-kimi effort "max"', expect: 'launched', source: cfg('openai', [A([])], null), effort: 'max' },
    ],
    judge: (j) => ({
      'effort "max" on a model with no thinking metadata': gate(j, 'ctl-openai') ?? effortAnswer(j.step('wrapper')),
    }),
  },
  {
    id: 'ctl-kimi',
    question: 'control',
    title: 'the configured effort is visible on the kimi-type wire, both routes',
    dependsOn: [],
    steps: [
      { kind: 'library', id: 'wrapper', purpose: 'bare-kimi effort "high"', expect: 'launched', source: cfg('kimi', [A()], null), effort: 'high' },
      { kind: 'native', id: 'native', purpose: 'kimi, [thinking] effort "high"', config: cfg('kimi', [A()], effortOn('high')) },
    ],
    judge: (j) => controlFacts(j, 'high'),
  },
  {
    id: 'n3-unlisted',
    question: 'N3',
    title: 'kimi type: effort "max" outside support_efforts ["low", "high"]',
    dependsOn: ['ctl-kimi'],
    steps: [
      { kind: 'library', id: 'wrapper', purpose: 'bare-kimi effort "max"', expect: 'refused', source: cfg('kimi', [A()], null), effort: 'max' },
      { kind: 'native', id: 'native', purpose: 'kimi, [thinking] effort "max"', config: cfg('kimi', [A()], effortOn('max')) },
    ],
    judge: (j) => ({ 'effort "max", unlisted, kimi type': gate(j, 'ctl-kimi') ?? effortAnswer(j.step('native')) }),
  },
  {
    id: 'n3-forced-new',
    question: 'N3',
    title: `kimi type: ${FORCED_ENV} over configured "high" on a new session`,
    dependsOn: ['ctl-kimi'],
    steps: FORCED_VALUES.flatMap(([label, value]): Step[] => [
      {
        kind: 'library',
        id: `w-${label}`,
        purpose: `bare-kimi effort "high", extraEnv ${FORCED_ENV}=${JSON.stringify(value)}`,
        expect: value.trim().length === 0 ? 'launched' : 'refused',
        source: cfg('kimi', [A()], null),
        effort: 'high',
        extraEnv: { [FORCED_ENV]: value },
      },
      {
        kind: 'native',
        id: `n-${label}`,
        purpose: `kimi, [thinking] effort "high", ${FORCED_ENV}=${JSON.stringify(value)}`,
        config: cfg('kimi', [A()], effortOn('high')),
        env: { [FORCED_ENV]: value },
      },
    ]),
    judge: (j) => {
      const g = gate(j, 'ctl-kimi');
      const facts: Record<string, string> = {};
      for (const [label, value] of FORCED_VALUES) {
        facts[`${FORCED_ENV}=${JSON.stringify(value)}, native`] = g ?? effortAnswer(j.step(`n-${label}`));
        const wrapper = j.step(`w-${label}`);
        if (wrapper.wrapper?.phase === 'spawned' || wrapper.wrapper?.phase === 'exited') {
          facts[`${FORCED_ENV}=${JSON.stringify(value)}, through bare-kimi`] = g ?? effortAnswer(wrapper);
        }
      }
      return facts;
    },
  },
  {
    id: 'n3-forced-resume',
    question: 'N3',
    title: 'kimi type: a forced effort on resume, and configured against stored effort on resume',
    dependsOn: ['ctl-kimi'],
    steps: [
      { kind: 'native', id: 'create-f', purpose: 'new session at "high"', config: cfg('kimi', [A()], effortOn('high')) },
      {
        kind: 'native',
        id: 'resume-forced',
        purpose: `resume it with ${FORCED_ENV}=low`,
        config: cfg('kimi', [A()], effortOn('high')),
        resumeFrom: 'create-f',
        env: { [FORCED_ENV]: 'low' },
      },
      { kind: 'native', id: 'create-c', purpose: 'new session at "high"', config: cfg('kimi', [A()], effortOn('high')) },
      {
        kind: 'native',
        id: 'resume-config-low',
        purpose: 'config edited to "low", resume it',
        config: cfg('kimi', [A()], effortOn('low')),
        resumeFrom: 'create-c',
      },
      { kind: 'native', id: 'new-config-low', purpose: 'control: new session under "low"', config: cfg('kimi', [A()], effortOn('low')) },
      {
        kind: 'library',
        id: 'w-create',
        purpose: 'bare-kimi kept home, effort "high"',
        expect: 'launched',
        source: cfg('kimi', [A()], null),
        keptHome: 'kept-home',
        effort: 'high',
      },
      {
        kind: 'library',
        id: 'w-forced-pinned',
        purpose: `bare-kimi same home (pinned "high"), extraEnv ${FORCED_ENV}=low`,
        expect: 'refused',
        source: cfg('kimi', [A()], null),
        keptHome: 'kept-home',
        extraEnv: { [FORCED_ENV]: 'low' },
      },
    ],
    judge: (j) => {
      const blocked = gate(j, 'ctl-kimi') ?? requireEffort(j.step('create-f'), 'high');
      return {
        [`${FORCED_ENV}=low on resume of a session created at "high"`]:
          blocked ?? effortChoice(j.step('resume-forced'), { low: 'forced value applies', high: 'stored effort kept' }),
        'resume after config "high" -> "low" (kimi type)': resumeEffort(j, 'create-c', 'resume-config-low', 'new-config-low', 'high', 'low', 'ctl-kimi'),
      };
    },
  },
  {
    id: 'n4-resume',
    question: 'N4',
    title: 'configured against stored effort and model on resume; --model on resume',
    dependsOn: ['ctl-openai'],
    steps: [
      { kind: 'native', id: 'create-e', purpose: 'new session, default a, "low"', config: cfg('openai', [A(), B()], effortOn('low')) },
      {
        kind: 'native',
        id: 'resume-e',
        purpose: 'config edited to "high", resume',
        config: cfg('openai', [A(), B()], effortOn('high')),
        resumeFrom: 'create-e',
      },
      { kind: 'native', id: 'new-e', purpose: 'control: new session under "high"', config: cfg('openai', [A(), B()], effortOn('high')) },
      { kind: 'native', id: 'create-m', purpose: 'new session, default a', config: cfg('openai', [A(), B()], effortOn('high')) },
      {
        kind: 'native',
        id: 'resume-m',
        purpose: 'default_model edited to b, resume without --model',
        config: cfg('openai', [A(), B()], effortOn('high'), 'probe/b'),
        resumeFrom: 'create-m',
      },
      {
        kind: 'native',
        id: 'new-m',
        purpose: 'control: new session under default b',
        config: cfg('openai', [A(), B()], effortOn('high'), 'probe/b'),
      },
      { kind: 'native', id: 'create-ma', purpose: 'new session, default a', config: cfg('openai', [A(), B()], effortOn('high')) },
      {
        kind: 'native',
        id: 'resume-ma',
        purpose: '--model probe/a --session (what preload passes)',
        config: cfg('openai', [A(), B()], effortOn('high')),
        args: ['--model', 'probe/a'],
        resumeFrom: 'create-ma',
      },
      { kind: 'native', id: 'create-mb', purpose: 'new session, default a', config: cfg('openai', [A(), B()], effortOn('high')) },
      {
        kind: 'native',
        id: 'resume-mb',
        purpose: '--model probe/b --session',
        config: cfg('openai', [A(), B()], effortOn('high')),
        args: ['--model', 'probe/b'],
        resumeFrom: 'create-mb',
      },
      {
        kind: 'library',
        id: 'w-create',
        purpose: 'bare-kimi kept home, model probe/a, effort "low"',
        expect: 'launched',
        source: cfg('openai', [A(), B()], null),
        keptHome: 'kept-home',
        model: 'probe/a',
        effort: 'low',
      },
      {
        kind: 'library',
        id: 'w-effort',
        purpose: 'bare-kimi same home, effort "high", resume',
        expect: 'refused',
        source: cfg('openai', [A(), B()], null),
        keptHome: 'kept-home',
        effort: 'high',
        resumeFrom: 'w-create',
      },
      {
        kind: 'library',
        id: 'w-model',
        purpose: 'bare-kimi same home, model probe/b, resume',
        expect: 'refused',
        source: cfg('openai', [A(), B()], null),
        keptHome: 'kept-home',
        model: 'probe/b',
        resumeFrom: 'w-create',
      },
      {
        kind: 'library',
        id: 'w-resume',
        purpose: 'bare-kimi same home, resume with no selection',
        expect: 'launched',
        source: cfg('openai', [A(), B()], null),
        keptHome: 'kept-home',
        resumeFrom: 'w-create',
      },
    ],
    judge: (j) => {
      const models = { 'probe-model-a': 'stored alias (probe/a)', 'probe-model-b': 'probe/b' };
      return {
        'effort on resume after config "low" -> "high"': resumeEffort(j, 'create-e', 'resume-e', 'new-e', 'low', 'high', 'ctl-openai'),
        'model on resume after default_model a -> b': resumeModel(j, 'create-m', 'resume-m', 'new-m'),
        '--model probe/a --session S (S created with probe/a)': requireModel(j.step('create-ma'), 'probe-model-a') ?? modelAnswer(j.step('resume-ma'), models),
        '--model probe/b --session S (S created with probe/a)':
          requireModel(j.step('create-mb'), 'probe-model-a') ?? modelAnswer(j.step('resume-mb'), { ...models, 'probe-model-b': '--model wins (probe/b)' }),
        'bare-kimi resume of its home pinned to probe/a, "low"': gate(j, 'ctl-openai') ?? turnAnswer(j.step('w-resume')),
      };
    },
  },
  {
    id: 'n5-overlay',
    question: 'N5',
    title: 'what switches kimi to its env model, KIMI_MODEL_THINKING_KEEP alone, and --model beside the overlay',
    dependsOn: ['ctl-kimi'],
    steps: [
      { kind: 'native', id: 'none', purpose: 'control: no KIMI_MODEL_*', home: 'home-none', config: N5_HOME },
      { kind: 'native', id: 'full', purpose: 'KIMI_MODEL_NAME, _API_KEY, _BASE_URL (loopback)', home: 'home-full', config: N5_HOME, env: OVERLAY },
      {
        kind: 'native',
        id: 'name-empty',
        purpose: 'the same with KIMI_MODEL_NAME empty',
        home: 'home-name-empty',
        config: N5_HOME,
        env: { ...OVERLAY, KIMI_MODEL_NAME: '' },
      },
      {
        kind: 'native',
        id: 'name-space',
        purpose: 'the same with KIMI_MODEL_NAME a single space',
        home: 'home-name-space',
        config: N5_HOME,
        env: { ...OVERLAY, KIMI_MODEL_NAME: ' ' },
      },
      {
        kind: 'native',
        id: 'no-key',
        purpose: 'KIMI_MODEL_NAME and _BASE_URL without KIMI_MODEL_API_KEY',
        home: 'home-no-key',
        config: N5_HOME,
        env: { KIMI_MODEL_NAME: ENV_MODEL, KIMI_MODEL_BASE_URL: OVERLAY.KIMI_MODEL_BASE_URL },
      },
      {
        kind: 'native',
        id: 'keep',
        purpose: 'KIMI_MODEL_THINKING_KEEP alone, kimi-type home',
        home: 'home-keep',
        config: cfg('kimi', [A()], effortOn('high')),
        env: { KIMI_MODEL_THINKING_KEEP: KEEP_VALUE },
      },
      {
        kind: 'native',
        id: 'full-model',
        purpose: 'the full overlay with --model probe/a',
        home: 'home-full-model',
        config: N5_HOME,
        env: OVERLAY,
        args: ['--model', 'probe/a'],
      },
      {
        kind: 'library',
        id: 'w-full',
        purpose: 'bare-kimi ephemeral, no model, extraEnv overlay',
        expect: 'launched',
        source: N5_HOME,
        extraEnv: OVERLAY,
      },
      {
        kind: 'library',
        id: 'w-full-model',
        purpose: 'bare-kimi model probe/a, extraEnv overlay',
        expect: 'refused',
        source: N5_HOME,
        model: 'probe/a',
        extraEnv: OVERLAY,
      },
      {
        kind: 'library',
        id: 'w-keep-kept',
        purpose: 'bare-kimi kept home, extraEnv KIMI_MODEL_THINKING_KEEP',
        expect: 'refused',
        source: N5_HOME,
        keptHome: 'kept-home',
        extraEnv: { KIMI_MODEL_THINKING_KEEP: KEEP_VALUE },
      },
    ],
    judge: (j): Record<string, string> => {
      const control = activation(j.step('none'));
      if (!control.startsWith('inactive')) {
        return { 'control (no KIMI_MODEL_*)': control.startsWith('unknown') ? control : U(`control was ${control}`) };
      }
      // The env provider is kimi-typed: an answer that may rest on it needs the kimi-type control.
      const g = gate(j, 'ctl-kimi');
      return {
        'control (no KIMI_MODEL_*)': control,
        'KIMI_MODEL_NAME + _API_KEY + _BASE_URL': g ?? activation(j.step('full')),
        'KIMI_MODEL_NAME empty': g ?? activation(j.step('name-empty')),
        'KIMI_MODEL_NAME whitespace': g ?? activation(j.step('name-space')),
        'KIMI_MODEL_NAME without KIMI_MODEL_API_KEY': g ?? activation(j.step('no-key')),
        'KIMI_MODEL_THINKING_KEEP alone: model': activation(j.step('keep')),
        'KIMI_MODEL_THINKING_KEEP alone: on the kimi-type wire': g ?? keepAnswer(j.step('keep')),
        'model run with the overlay and --model probe/a':
          g ??
          modelAnswer(j.step('full-model'), {
            'probe-model-a': '--model wins (probe/a)',
            [ENV_MODEL]: `overlay wins (${ENV_MODEL})`,
          }),
        'the overlay through bare-kimi (ephemeral, no model)': g ?? activation(j.step('w-full')),
      };
    },
  },
  {
    id: 'n6-secondary',
    question: 'N6',
    title: 'KIMI_SECONDARY_MODEL and KIMI_SECONDARY_EFFORT in -p, no [secondary_model]',
    dependsOn: ['ctl-openai'],
    steps: [
      { kind: 'native', id: 'none', purpose: 'control: no KIMI_SECONDARY_*', home: 'home-none', config: cfg('openai', [A()], effortOn('high')) },
      {
        kind: 'native',
        id: 'alias',
        purpose: 'KIMI_SECONDARY_MODEL=probe/a (configured), KIMI_SECONDARY_EFFORT=max',
        home: 'home-alias',
        config: cfg('openai', [A()], effortOn('high')),
        env: SECONDARY_ALIAS,
      },
      {
        kind: 'native',
        id: 'unconfigured',
        purpose: 'KIMI_SECONDARY_MODEL unconfigured, KIMI_SECONDARY_EFFORT=max',
        home: 'home-unconfigured',
        config: cfg('openai', [A()], effortOn('high')),
        env: SECONDARY_UNKNOWN,
      },
      {
        kind: 'library',
        id: 'w-alias',
        purpose: 'bare-kimi ephemeral, extraEnv KIMI_SECONDARY_* (configured alias)',
        expect: 'launched',
        source: cfg('openai', [A()], effortOn('high')),
        extraEnv: SECONDARY_ALIAS,
      },
    ],
    judge: (j) => {
      const g = gate(j, 'ctl-openai');
      return {
        'main request, KIMI_SECONDARY_MODEL a configured alias': g ?? compareTurns(j.step('none'), j.step('alias')),
        'main request, KIMI_SECONDARY_MODEL unconfigured': g ?? compareTurns(j.step('none'), j.step('unconfigured')),
        'main request, configured alias through bare-kimi': g ?? compareTurns(j.step('none'), j.step('w-alias')),
      };
    },
  },
  {
    id: 'n8-always',
    question: 'N8',
    title: '[thinking] enabled = false: model field always_thinking = true against capability "always_thinking"',
    dependsOn: [],
    steps: [
      { kind: 'native', id: 'on', purpose: 'control: thinking on, "high"', config: cfg('openai', [A(N8_BASE)], effortOn('high')) },
      { kind: 'native', id: 'off', purpose: 'control: thinking off', config: cfg('openai', [A(N8_BASE)], OFF) },
      {
        kind: 'native',
        id: 'field',
        purpose: 'always_thinking = true, thinking off',
        config: cfg('openai', [A([...N8_BASE, 'always_thinking = true'])], OFF),
      },
      {
        kind: 'native',
        id: 'string',
        purpose: 'capabilities ["thinking", "always_thinking"], thinking off',
        config: cfg('openai', [A(['capabilities = ["thinking", "always_thinking"]', 'support_efforts = ["high"]'])], OFF),
      },
      {
        kind: 'library',
        id: 'w-field',
        purpose: 'bare-kimi effort "off", always_thinking = true',
        expect: 'refused',
        source: cfg('openai', [A([...N8_BASE, 'always_thinking = true'])], null),
        effort: 'off',
      },
      {
        kind: 'library',
        id: 'w-string',
        purpose: 'bare-kimi effort "off", capability "always_thinking"',
        expect: 'refused',
        source: cfg('openai', [A(['capabilities = ["thinking", "always_thinking"]', 'support_efforts = ["high"]'])], null),
        effort: 'off',
      },
    ],
    judge: (j) => {
      const on = requireEffort(j.step('on'), 'high');
      const offControl = offAnswer(j.step('off'), null);
      const blocked = on ?? (offControl.startsWith('off honored') ? undefined : U(`the off control was not honored: ${offControl}`));
      return {
        'control: thinking off, no off_effort': offControl,
        'always_thinking = true (model field), thinking off': blocked ?? offAnswer(j.step('field'), null),
        'capability "always_thinking", thinking off': blocked ?? offAnswer(j.step('string'), null),
      };
    },
  },
  {
    id: 'n8b-off',
    question: 'N8',
    title: 'thinking off with a declared off_effort, against always-thinking declarations and models declaring none',
    dependsOn: [],
    steps: [
      {
        kind: 'native',
        id: 'on',
        purpose: 'control: thinking on, "high", off_effort declared',
        config: cfg('openai', [A(N8B_DECLARED)], effortOn('high')),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'off',
        purpose: 'control: thinking off, off_effort "none" declared',
        config: cfg('openai', [A(N8B_DECLARED)], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'field',
        purpose: 'the off control plus always_thinking = true',
        config: cfg('openai', [A([...N8B_DECLARED, 'always_thinking = true'])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'string',
        purpose: 'capabilities ["thinking", "always_thinking"], support_efforts, off_effort "none", off',
        config: cfg('openai', [A(['capabilities = ["thinking", "always_thinking"]', 'support_efforts = ["high"]', OFF_NONE])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'base-no-off',
        purpose: 'thinking plus support_efforts, no off_effort, off; known retry failure, observe terminal exit',
        config: cfg('openai', [A(N8_BASE)], OFF),
        deadlineMs: TERMINAL_RETRY_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'caps-only',
        purpose: 'capabilities ["thinking"] only, no off_effort, off',
        config: cfg('openai', [A(['capabilities = ["thinking"]'])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'efforts-only',
        purpose: 'support_efforts ["high"] only, no off_effort, off',
        config: cfg('openai', [A(['support_efforts = ["high"]'])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'bare',
        purpose: "no thinking metadata, off (bare-kimi's undeclared off)",
        config: cfg('openai', [A([])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
    ],
    judge: (j) => {
      const on = requireEffort(j.step('on'), 'high');
      const offControl = offAnswer(j.step('off'), 'none');
      // The declared off effort must work before an always-thinking declaration can be compared with it.
      const offBlocked = on ?? (offControl.startsWith('off honored') ? undefined : U(`the off control with off_effort "none" was not honored: ${offControl}`));
      return {
        'control: thinking on, "high"': on ?? 'sent "high"',
        'control: thinking off, off_effort "none"': offControl,
        'always_thinking = true (model field), off_effort "none", off': offBlocked ?? offAnswer(j.step('field'), 'none'),
        'capability "always_thinking", off_effort "none", off': offBlocked ?? offAnswer(j.step('string'), 'none'),
        'thinking + support_efforts, no off_effort, off (as n8-always)': on ?? offAnswer(j.step('base-no-off'), null),
        'capabilities ["thinking"] only, no off_effort, off': on ?? offAnswer(j.step('caps-only'), null),
        'support_efforts ["high"] only, no off_effort, off': on ?? offAnswer(j.step('efforts-only'), null),
        'no thinking metadata, off': on ?? offAnswer(j.step('bare'), null),
      };
    },
  },
  {
    id: 'n2-kimi-undeclared',
    question: 'N2',
    title: 'kimi type (strict validation): efforts "high" and "max" on a model declaring thinking but no support_efforts',
    dependsOn: ['ctl-kimi'],
    steps: [
      {
        kind: 'native',
        id: 'high',
        purpose: 'kimi, [thinking] effort "high"',
        config: cfg('kimi', [A(['capabilities = ["thinking"]'])], effortOn('high')),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'max',
        purpose: 'kimi, [thinking] effort "max"',
        config: cfg('kimi', [A(['capabilities = ["thinking"]'])], effortOn('max')),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'library',
        id: 'w-max',
        purpose: 'bare-kimi effort "max" (expected: undeclared)',
        expect: 'launched',
        source: cfg('kimi', [A(['capabilities = ["thinking"]'])], null),
        effort: 'max',
      },
    ],
    judge: (j) => {
      const g = gate(j, 'ctl-kimi');
      const high = j.step('high');
      const max = j.step('max');
      return {
        'effort "high", kimi type, no support_efforts': g ?? effortAnswer(high),
        'effort "max", kimi type, no support_efforts': g ?? effortAnswer(max),
        'effort "max" through bare-kimi': g ?? effortAnswer(j.step('w-max')),
        'high/max contrast': g ?? strictContrast(high, max),
      };
    },
  },
  {
    id: 'n8c-kimi-off',
    question: 'N8',
    title: 'kimi type (strict validation): thinking off with and without a declared off_effort, and on capability-only thinking',
    dependsOn: ['ctl-kimi'],
    steps: [
      {
        kind: 'native',
        id: 'efforts',
        purpose: "ctl-kimi's model (support_efforts low, high), no off_effort, off; the one long step, to see how a failure ends",
        config: cfg('kimi', [A()], OFF),
        deadlineMs: TERMINAL_RETRY_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'efforts-none',
        purpose: 'the same model with off_effort "none", off',
        config: cfg('kimi', [A([...THINKS, OFF_NONE])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'caps-only',
        purpose: 'capabilities ["thinking"] only, off',
        config: cfg('kimi', [A(['capabilities = ["thinking"]'])], OFF),
        deadlineMs: SHORT_DEADLINE_MS,
      },
      {
        kind: 'library',
        id: 'w-off',
        purpose: 'bare-kimi effort "off" on the first model (its current guard takes it as declared)',
        expect: 'launched',
        source: cfg('kimi', [A()], null),
        effort: 'off',
        deadlineMs: SHORT_DEADLINE_MS,
      },
    ],
    judge: (j) => {
      // ctl-kimi is the thinking-on control: the same model sending "high" on this wire.
      const g = gate(j, 'ctl-kimi');
      return {
        'support_efforts ["low", "high"], no off_effort, off': g ?? offAnswer(j.step('efforts'), null),
        'the same with off_effort "none", off': g ?? offAnswer(j.step('efforts-none'), 'none'),
        'capabilities ["thinking"] only, off': g ?? offAnswer(j.step('caps-only'), null),
        'off through bare-kimi on the first model': g ?? offAnswer(j.step('w-off'), null),
      };
    },
  },
  {
    id: 'n8d-off-cross',
    question: 'N8',
    title: 'Exact support_efforts-list cross: kimi high-only and openai low/high, thinking off without off_effort',
    dependsOn: ['ctl-kimi', 'ctl-openai'],
    steps: [
      {
        kind: 'native',
        id: 'kimi-one',
        purpose: 'kimi type, exact high-only declaration that failed on openai, off without off_effort',
        config: cfg('kimi', [A(['capabilities = ["thinking"]', 'support_efforts = ["high"]'])], OFF),
        deadlineMs: TERMINAL_RETRY_DEADLINE_MS,
      },
      {
        kind: 'native',
        id: 'openai-two',
        purpose: 'openai type, exact low/high declaration that succeeded on kimi, off without off_effort',
        config: cfg('openai', [A()], OFF),
        deadlineMs: TERMINAL_RETRY_DEADLINE_MS,
      },
    ],
    judge: (j) => ({
      'kimi high-only, no off_effort, off': gate(j, 'ctl-kimi') ?? offAnswer(j.step('kimi-one'), null),
      'openai low/high, no off_effort, off': gate(j, 'ctl-openai') ?? offAnswer(j.step('openai-two'), null),
    }),
  },
];

// ---------------------------------------------------------------- step records and judging helpers

type MarkerState = 'found' | 'not-found' | 'unreadable';

export interface MarkerSearch {
  readonly state: MarkerState;
  readonly where: readonly string[];
  readonly errors: readonly string[];
}

export interface WrapperResult {
  readonly phase: 'refused' | 'spawn-error' | 'spawned' | 'exited' | 'no-result' | 'unreadable';
  readonly name?: unknown;
  readonly message?: string;
  readonly assembled?: unknown;
  readonly modelOverlay?: unknown;
  readonly exitCode?: number | null;
  readonly signalCode?: unknown;
  readonly cleanup?: unknown;
  /** SHA-256 of the run home's config.toml just after spawnKimi returned, and after kimi exited. */
  readonly configBefore?: unknown;
  readonly configAfter?: unknown;
}

export interface RetryError {
  readonly name: string | null;
  readonly message: string;
  /** Present when the failure carried an HTTP status, i.e. came from a response. */
  readonly statusCode: number | null;
  count: number;
}

export interface RetrySummary {
  readonly events: number;
  readonly lastFailedAttempt: number;
  readonly maxAttempts: number;
  readonly errors: RetryError[];
}

export interface StepRecord {
  readonly id: string;
  readonly via: 'native' | 'library';
  readonly purpose: string;
  status: 'ran' | 'not-run' | 'failed';
  notRunReason?: string;
  failure?: string;
  startedAt?: string;
  endedAt?: string;
  argv?: string[];
  launch?: Json;
  envAdded?: Record<string, string>;
  config?: { path: string; sha256: string };
  resumed?: string;
  process?: ProcessRecord;
  expectWrapper?: 'refused' | 'launched';
  wrapper?: WrapperResult;
  sessionId?: string;
  systemVersion?: string;
  chats: ChatSummary[];
  /** Every request attributed to the step, of any kind. */
  requests: number;
  /** kimi's own retry reports from its stream-json, when it made any. */
  retrying: RetrySummary | null;
  /** `/models` requests during the step: a catalog refresh may have changed what the config declares. */
  catalogRequests: number;
  /** Requests of the step that could not be written to the request log. */
  logFaults: number;
  /** Requests of the step with a credential-shaped header that was not the dummy key. */
  credentialFaults: number;
  /** How a config.toml the step depends on changed during it; null when none did. */
  configChange: string | null;
  droppedSections: string[];
  markers?: Record<string, MarkerSearch>;
  helpFlags: string[];
  dir?: string;
  stdoutTail?: string;
  stderrTail?: string;
  /** Library steps: the driver's own stderr, beside kimi's. */
  driverStderrTail?: string;
}

export type Outcome = 'observed' | 'unknown' | 'failed' | 'not-run';

export interface CaseResult {
  readonly id: string;
  readonly question: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  outcome: Outcome;
  facts: Record<string, string>;
  /** What each step showed, described, not judged. */
  observations: Record<string, string>;
  readonly steps: StepRecord[];
}

export interface Judging {
  step(id: string): StepRecord;
  control(caseId: string): CaseResult | undefined;
}

export const U = (why: string): string => `unknown: ${why}`;

/** Why `s` cannot answer a question about kimi's turn, or undefined when it can. */
export function usable(s: StepRecord): string | undefined {
  if (s.status === 'not-run') return `${s.id} not run: ${s.notRunReason ?? 'no reason recorded'}`;
  if (s.status === 'failed') return `${s.id} failed: ${s.failure ?? 'no reason recorded'}`;
  if (s.process?.deadlineHit === true) return `${s.id} hit its deadline`;
  if (s.process !== undefined && s.process.stop !== null && s.process.stop !== undefined) {
    return `${s.id} was stopped (by ${String(s.process.stoppedBy ?? 'the deadline or members left in its group')})`;
  }
  if (s.via === 'library' && s.wrapper?.phase === 'refused') return `${s.id}: bare-kimi refused, kimi did not run`;
  return evidenceFault(s);
}

/** A fault in what the step's evidence can show, whatever kimi did. */
function evidenceFault(s: StepRecord): string | undefined {
  if (s.droppedSections.length > 0) return `${s.id}: kimi dropped config section(s) ${s.droppedSections.join(', ')}`;
  if (s.logFaults > 0) return `${s.id}: ${s.logFaults} request(s) could not be logged`;
  if (s.credentialFaults > 0) return `${s.id}: ${s.credentialFaults} request(s) carried an unexpected credential`;
  if (s.catalogRequests > 0) return `${s.id}: ${s.catalogRequests} catalog request(s); a refresh may have changed the declared thinking`;
  if (s.configChange !== null) return `${s.id}: ${s.configChange}`;
  return undefined;
}

/**
 * kimi's own report of a failure before it sent anything, when that is all
 * the step can show: it ran, no request of any kind reached the loopback
 * provider, kimi's stream-json reported `turn.step.retrying` with errors that
 * carry no HTTP status, nothing in them or in stderr looks like the
 * sandbox's, and the step's evidence has no fault. It is read from what kimi
 * reported before the step ended, so a deadline or stop does not void it;
 * the text says how the step ended and claims no exit it did not see. No
 * provider is blamed: none was reached. Undefined otherwise.
 */
export function clientFailure(s: StepRecord): string | undefined {
  const retrying = s.retrying;
  if (s.status !== 'ran' || retrying === null || s.requests > 0) return undefined;
  if (s.via === 'library' && s.wrapper?.phase === 'refused') return undefined;
  if (evidenceFault(s) !== undefined || sandboxLike(s) !== undefined) return undefined;
  if (retrying.errors.some((error) => error.statusCode !== null || SANDBOX_LIKE.test(error.message) || TRANSPORT_LIKE.test(error.message))) return undefined;
  if (TRANSPORT_LIKE.test(`${s.stderrTail ?? ''} ${s.driverStderrTail ?? ''}`)) return undefined;
  const first = retrying.errors[0];
  if (first === undefined) return undefined;
  const others = retrying.errors.length > 1 ? ` (+${retrying.errors.length - 1} other error text(s))` : '';
  const ended =
    s.process?.deadlineHit === true
      ? 'the step deadline stopped it; no exit observed'
      : s.process?.stop !== null && s.process?.stop !== undefined
        ? 'the step was stopped; no exit observed'
        : `kimi exited ${String(childExit(s))}`;
  return (
    `client-side failure before any request: ${String(first.name)}: ${short(first.message, 300)}${others}; ` +
    `${retrying.events} retry report(s), last failed attempt ${retrying.lastFailedAttempt} of ${retrying.maxAttempts}; ${ended}`
  );
}

/** kimi's own exit: the native child's, or what bare-kimi's subprocess reported. */
function childExit(s: StepRecord): number | null {
  return s.via === 'native' ? (s.process?.exitCode ?? null) : (s.wrapper?.exitCode ?? null);
}

const SANDBOX_LIKE = /EPERM|operation not permitted|sandbox/i;
const TRANSPORT_LIKE = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|fetch failed|connection error|socket hang up/i;

/** Why a failing exit may be the sandbox's doing rather than kimi's, from the step's stderr; else undefined. */
function sandboxLike(s: StepRecord): string | undefined {
  const lines = `${s.stderrTail ?? ''}\n${s.driverStderrTail ?? ''}`.split('\n').filter((line) => SANDBOX_LIKE.test(line));
  return lines.length === 0 ? undefined : `${s.id}: the exit may be the sandbox's (stderr: ${short(lines.at(-1), 240)})`;
}

export function fieldsText(fields: readonly Field[]): string {
  return fields.length === 0 ? 'none' : fields.map((field) => `${field.path}=${JSON.stringify(field.value)}`).join(', ');
}

/** The step's own turn: the requests carrying the prompt, when they all agree on model and thinking fields. */
export type Turn = { readonly chat: ChatSummary; readonly agreeing: number } | { readonly none: true } | { readonly why: string };

export function turnOf(s: StepRecord): Turn {
  const bad = usable(s);
  if (bad !== undefined) return { why: bad };
  const prompted = s.chats.filter((chat) => chat.main);
  const first = prompted[0];
  if (first === undefined) return { none: true };
  const signature = (chat: ChatSummary): string => `model ${String(chat.model)}, ${fieldsText(chat.fields)}`;
  if (prompted.some((chat) => signature(chat) !== signature(first))) {
    const each = prompted.map((chat) => `#${chat.seq} ${signature(chat)}`).join('; ');
    return { why: `${s.id}: ${prompted.length} prompt-bearing requests disagree (${each})` };
  }
  return { chat: first, agreeing: prompted.length };
}

export function mainChat(s: StepRecord): ChatSummary | undefined {
  const turn = turnOf(s);
  return 'chat' in turn ? turn.chat : undefined;
}

type NoTurn = { readonly exited: number; readonly stderr: string } | { readonly why: string };

/** A step that ran without a turn: kimi's own failing exit, or why that is not known to be kimi's. */
function noTurn(s: StepRecord): NoTurn {
  const exit = childExit(s);
  if (exit === null || exit === 0) return { why: `${s.id}: no request carrying the prompt (kimi exit ${String(exit)})` };
  const sandbox = sandboxLike(s);
  if (sandbox !== undefined) return { why: sandbox };
  return { exited: exit, stderr: lastLine(s.stderrTail) };
}

/**
 * A known effort value: a known effort name, blank, or one of `declared`, the
 * values the step's own config declared (its `off_effort`). A value is never
 * recognized because some other step declared it.
 */
function isEffortField(field: Field, declared: readonly string[]): boolean {
  if (typeof field.value !== 'string') return false;
  return EFFORT_NAMES.has(field.value) || declared.includes(field.value) || field.value.trim().length === 0;
}

/** The field's own key: the last path segment, without array indexes. */
function lastSegment(path: string): string {
  return path.replaceAll(/\[\d+\]/g, '').split('.').at(-1) ?? '';
}

export type EffortRead = { readonly fields: readonly Field[] } | { readonly client: string } | NoTurn;

/**
 * The effort values of the step's own turn; kimi's client-side failure
 * before any request (see clientFailure); kimi's failing exit without a
 * request; or why none of these is known. A value under an effort key that
 * is neither a known effort name, blank, nor one of `declared` (the step's
 * own declared off effort) is not taken as "not sent": what it means is not
 * established, so the answer is unknown.
 */
export function effortRead(s: StepRecord, declared: readonly string[] = []): EffortRead {
  const client = clientFailure(s);
  if (client !== undefined) return { client };
  const turn = turnOf(s);
  if ('why' in turn) return turn;
  if ('none' in turn) return noTurn(s);
  const known = (field: Field): boolean => isEffortField(field, declared);
  const strange = turn.chat.fields.filter((field) => /effort/i.test(lastSegment(field.path)) && !known(field));
  if (strange.length > 0) return { why: `${s.id}: unrecognized effort value ${fieldsText(strange)}` };
  return { fields: turn.chat.fields.filter(known) };
}

export function effortAnswer(s: StepRecord): string {
  const read = effortRead(s);
  if ('client' in read) return read.client;
  if ('why' in read) return U(read.why);
  if ('exited' in read) return `no request; kimi exited ${read.exited}: ${read.stderr}`;
  if (read.fields.length > 0) return `sent ${fieldsText(read.fields)}`;
  return `not sent (thinking fields: ${fieldsText(mainChat(s)?.fields ?? [])})`;
}

/** Undefined when `s` sent `effort`; otherwise why the step cannot serve as that control. */
export function requireEffort(s: StepRecord, effort: string): string | undefined {
  const read = effortRead(s);
  if ('client' in read) return U(`${s.id}: ${read.client}`);
  if ('why' in read) return U(read.why);
  if ('exited' in read) return U(`${s.id}: kimi exited ${read.exited}`);
  return read.fields.some((field) => field.value === effort) ? undefined : U(`${s.id} did not send "${effort}" (${fieldsText(read.fields)})`);
}

/** Name the effort the turn sent by `labels` (key '' for none sent). */
export function effortChoice(s: StepRecord, labels: Record<string, string>): string {
  const read = effortRead(s);
  if ('client' in read) return read.client;
  if ('why' in read) return U(read.why);
  if ('exited' in read) return `no request; kimi exited ${read.exited}: ${read.stderr}`;
  const values = [...new Set(read.fields.map((field) => String(field.value)))];
  const key = values.length === 0 ? '' : values.length === 1 ? (values[0] ?? '') : undefined;
  const label = key === undefined ? undefined : labels[key];
  return `${label ?? 'other'}: ${values.length === 0 ? 'no effort sent' : `sent ${fieldsText(read.fields)}`}`;
}

/**
 * What a turn configured with thinking off sent, from two kinds of thinking
 * field: effort values (see effortRead) and thinking types (a field named
 * `type` under a thinking key, as the kimi type sends `thinking.type`).
 * - `thinks despite off`: an explicit `type: "enabled"` with no effort, or
 *   any known effort other than the step's own declared off effort
 *   (`declaredOff`, null when the step declares none);
 * - `conflicting`: only the declared off effort, but beside `type: "enabled"`;
 *   recorded as sent, not read as off or on;
 * - `off honored`: no `enabled` type (absent or `"disabled"`), and no effort
 *   or only the declared off effort;
 * - unknown: a thinking type other than `enabled`/`disabled`, a blank effort,
 *   an unrecognized effort value, or no usable turn. Other thinking fields
 *   (such as `keep`) do not decide it.
 * A client-side failure or a failing exit is reported as observed.
 */
export function offAnswer(s: StepRecord, declaredOff: string | null): string {
  const read = effortRead(s, declaredOff === null ? [] : [declaredOff]);
  if ('client' in read) return read.client;
  if ('why' in read) return U(read.why);
  if ('exited' in read) return `no request; kimi exited ${read.exited}: ${read.stderr}`;
  const types = (mainChat(s)?.fields ?? []).filter((field) => lastSegment(field.path) === 'type');
  const strangeTypes = types.filter((field) => field.value !== 'enabled' && field.value !== 'disabled');
  if (strangeTypes.length > 0) return U(`${s.id}: unrecognized thinking type ${fieldsText(strangeTypes)}`);
  const blank = read.fields.filter((field) => typeof field.value === 'string' && field.value.trim().length === 0);
  if (blank.length > 0) return U(`${s.id}: blank effort value ${fieldsText(blank)}`);
  const enabled = types.filter((field) => field.value === 'enabled');
  const others = read.fields.filter((field) => field.value !== declaredOff);
  if (others.length > 0) return `thinks despite off: sent ${fieldsText([...enabled, ...others])}`;
  const declared = read.fields.length > 0 ? ` the declared off effort ${fieldsText(read.fields)}` : '';
  if (enabled.length > 0) {
    return declared === ''
      ? `thinks despite off: sent ${fieldsText(enabled)} with no effort`
      : `conflicting: sent${declared} beside ${fieldsText(enabled)}`;
  }
  const disabled = types.length > 0 ? `${declared === '' ? '' : ' and'} ${fieldsText(types)}` : '';
  if (declared === '' && disabled === '') return 'off honored: no effort sent';
  return `off honored: sent${declared}${disabled}`;
}

/**
 * Two turns configured with "high" and "max" on the same undeclared model:
 * which of them sent its configured value. Only captured turns are compared.
 */
export function strictContrast(high: StepRecord, max: StepRecord): string {
  const a = effortRead(high);
  const b = effortRead(max);
  if (!('fields' in a) || !('fields' in b)) return U('one of the pair has no captured turn to compare');
  const highSent = a.fields.some((field) => field.value === 'high');
  const maxSent = b.fields.some((field) => field.value === 'max');
  const detail = `(high: ${fieldsText(a.fields)}; max: ${fieldsText(b.fields)})`;
  if (highSent && maxSent) return `both sent as configured ${detail}`;
  if (!highSent && !maxSent) return `neither sent as configured ${detail}`;
  return `only "${highSent ? 'high' : 'max'}" sent as configured ${detail}`;
}

/** Whether the step's turn carried the keep value, anywhere among its thinking fields. */
export function keepAnswer(s: StepRecord): string {
  const turn = turnOf(s);
  if ('why' in turn) return U(turn.why);
  if ('none' in turn) return U(`${s.id}: no request carrying the prompt (kimi exit ${String(childExit(s))})`);
  const kept = turn.chat.fields.filter((field) => field.value === KEEP_VALUE);
  return kept.length > 0 ? `sent ${fieldsText(kept)}` : `not sent (thinking fields: ${fieldsText(turn.chat.fields)})`;
}

function controlFacts(j: Judging, effort: string): Record<string, string> {
  const show = (id: string): string => {
    const missing = requireEffort(j.step(id), effort);
    if (missing !== undefined) return missing;
    const read = effortRead(j.step(id));
    return 'fields' in read ? `"${effort}" seen at ${fieldsText(read.fields)}` : U('unreadable');
  };
  return { 'effort visible, through bare-kimi': show('wrapper'), 'effort visible, kimi direct': show('native') };
}

export function gate(j: Judging, controlId: string): string | undefined {
  const control = j.control(controlId);
  if (control === undefined) return U(`control ${controlId} was not part of this run`);
  return control.outcome === 'observed' ? undefined : U(`control ${controlId} is ${control.outcome}`);
}

function resumeEffort(
  j: Judging,
  create: string,
  resumed: string,
  control: string,
  stored: string,
  configured: string,
  controlCase: string,
): string {
  const blocked = gate(j, controlCase) ?? requireEffort(j.step(create), stored) ?? requireEffort(j.step(control), configured);
  if (blocked !== undefined) return blocked;
  return effortChoice(j.step(resumed), { [stored]: `stored effort ("${stored}")`, [configured]: `configured effort ("${configured}")` });
}

type ModelRead = { readonly model: string | null } | NoTurn;

function modelRead(s: StepRecord): ModelRead {
  const turn = turnOf(s);
  if ('why' in turn) return turn;
  if ('none' in turn) return noTurn(s);
  return { model: turn.chat.model };
}

function requireModel(s: StepRecord, model: string): string | undefined {
  const read = modelRead(s);
  if ('why' in read) return U(read.why);
  if ('exited' in read) return U(`${s.id}: kimi exited ${read.exited}`);
  return read.model === model ? undefined : U(`${s.id} requested ${String(read.model)}, not ${model}`);
}

export function modelAnswer(s: StepRecord, labels: Record<string, string>): string {
  const read = modelRead(s);
  if ('why' in read) return U(read.why);
  if ('exited' in read) return `no request; kimi exited ${read.exited}: ${read.stderr}`;
  return `${(read.model === null ? undefined : labels[read.model]) ?? 'other'} (requested ${String(read.model)})`;
}

function resumeModel(j: Judging, create: string, resumed: string, control: string): string {
  const blocked = requireModel(j.step(create), 'probe-model-a') ?? requireModel(j.step(control), 'probe-model-b');
  if (blocked !== undefined) return blocked;
  return modelAnswer(j.step(resumed), { 'probe-model-a': 'stored alias (probe/a)', 'probe-model-b': 'new default_model (probe/b)' });
}

/** The model and effort of a step's turn, described. */
function turnAnswer(s: StepRecord): string {
  const model = modelRead(s);
  if ('why' in model) return U(model.why);
  if ('exited' in model) return `no request; kimi exited ${model.exited}: ${model.stderr}`;
  return `requested ${String(model.model)}, effort ${effortAnswer(s)}`;
}

/** The subject's turn against the control's: model and effort, and the secondary marker. */
export function compareTurns(control: StepRecord, subject: StepRecord): string {
  const base = modelRead(control);
  const baseEffort = effortRead(control);
  if ('why' in base) return U(base.why);
  if ('exited' in base || !('fields' in baseEffort)) return U(`control ${control.id} did not complete a turn`);
  const seen = modelRead(subject);
  if ('why' in seen) return U(seen.why);
  if ('exited' in seen) return `no request; kimi exited ${seen.exited}: ${seen.stderr}`;
  const seenEffort = effortRead(subject);
  if (!('fields' in seenEffort)) return U(`${subject.id}: effort unreadable`);
  const marker = subject.markers?.[SECONDARY_MARKER]?.state ?? 'not searched';
  const sameModel = seen.model === base.model;
  const sameEffort = fieldsText(seenEffort.fields) === fieldsText(baseEffort.fields);
  if (sameModel && sameEffort) {
    return `no change to the main request (model ${String(seen.model)}, effort ${fieldsText(seenEffort.fields)}); ${SECONDARY_MARKER} ${marker}`;
  }
  return (
    `main request changed: model ${String(base.model)} -> ${String(seen.model)}, ` +
    `effort ${fieldsText(baseEffort.fields)} -> ${fieldsText(seenEffort.fields)}; ${SECONDARY_MARKER} ${marker}`
  );
}

/**
 * Whether the env model ran in a step, decided by the captured request
 * alone: the model it asked for. The `__kimi_env_model__` marker is reported
 * beside it, as corroboration only. Without a captured request the answer is
 * unknown, whatever the marker or the exit: the env provider is kimi-typed,
 * and a missing request may be the fixture's, not kimi's.
 */
export function activation(s: StepRecord): string {
  const turn = turnOf(s);
  if ('why' in turn) return U(turn.why);
  const marker = s.markers?.[ENV_MARKER];
  const where = marker?.where.length ? ` in ${marker.where.map((path) => relative(s.dir ?? '', path)).join(', ')}` : '';
  const markerText = `${ENV_MARKER} ${marker?.state ?? 'not searched'}${where}`;
  if ('none' in turn) {
    return U(`no request captured (kimi exit ${String(childExit(s))}; ${markerText}; stderr: ${lastLine(s.stderrTail)})`);
  }
  const model = turn.chat.model;
  if (model === ENV_MODEL) return `active (request model ${model}; ${markerText})`;
  if (model === 'probe-model-a') return `inactive (request model probe-model-a; ${markerText})`;
  return `other: request model ${String(model)}; ${markerText}`;
}

function judgeOptions(s: StepRecord): Record<string, string> {
  const bad = usable(s);
  if (bad !== undefined) return { 'declared options': U(bad) };
  if (s.process?.exitCode !== 0) return { 'declared options': U(`kimi --help exited ${String(s.process?.exitCode)}`) };
  if (s.helpFlags.length === 0) return { 'declared options': U('no option parsed from the help output') };
  const pick = (pattern: RegExp): string => s.helpFlags.filter((flag) => pattern.test(flag)).join(' ') || 'none declared';
  return {
    'declared options': s.helpFlags.join(' '),
    'thinking, effort or reasoning options': pick(/think|effort|reason/i),
    'model options': pick(/model/i),
    '-p declared': s.helpFlags.includes('-p') || s.helpFlags.includes('--print') ? 'yes' : 'no',
  };
}

function describeStep(s: StepRecord): string {
  if (s.status !== 'ran') return `${s.status}: ${s.notRunReason ?? s.failure ?? ''}`;
  const parts = [`exit ${String(childExit(s))}`];
  if (s.via === 'library') parts.unshift(`bare-kimi ${s.wrapper?.phase ?? 'no result'}${s.wrapper?.message ? ` (${short(s.wrapper.message, 160)})` : ''}`);
  if (s.process?.deadlineHit) parts.push('deadline hit');
  if (s.sessionId) parts.push(`session ${s.sessionId}`);
  parts.push(`${s.chats.length} chat request(s), ${s.chats.filter((chat) => chat.main).length} carrying the prompt`);
  const turn = turnOf(s);
  if ('chat' in turn) parts.push(`model ${String(turn.chat.model)}`, `thinking fields ${fieldsText(turn.chat.fields)}`);
  else if ('why' in turn) parts.push(`turn not usable: ${turn.why}`);
  if (s.retrying !== null) {
    const first = s.retrying.errors[0];
    parts.push(`${s.retrying.events} retry report(s) up to attempt ${s.retrying.lastFailedAttempt}/${s.retrying.maxAttempts}${first ? `: ${short(first.message, 160)}` : ''}`);
  }
  if (s.catalogRequests > 0) parts.push(`${s.catalogRequests} catalog request(s)`);
  if (s.configChange !== null) parts.push(s.configChange);
  if (s.logFaults > 0) parts.push(`${s.logFaults} unlogged request(s)`);
  if (s.credentialFaults > 0) parts.push(`${s.credentialFaults} unexpected credential(s)`);
  if (s.droppedSections.length > 0) parts.push(`dropped sections ${s.droppedSections.join(', ')}`);
  for (const [marker, found] of Object.entries(s.markers ?? {})) if (found.state !== 'not-found') parts.push(`${marker} ${found.state}`);
  return parts.join('; ');
}

/** Whether bare-kimi did what the step expected; a mismatch is a recorded observation. */
function wrapperFact(s: StepRecord): string {
  if (s.status === 'not-run') return U(`not run: ${s.notRunReason ?? ''}`);
  const w = s.wrapper;
  if (w === undefined) return U('no driver result');
  const actual = w.phase === 'refused' ? 'refused' : w.phase === 'spawned' || w.phase === 'exited' ? 'launched' : undefined;
  if (actual === undefined) return U(`driver ${w.phase}: ${short(w.message)}`);
  const assembled = isRecord(w.assembled) ? w.assembled : {};
  const detail =
    actual === 'refused'
      ? short(w.message, 240)
      : `effortSupport=${String(assembled['effortSupport'])}, modelOverlay=${String(w.modelOverlay)}, kimi exit ${String(w.exitCode)}`;
  return `${actual === s.expectWrapper ? 'as expected' : `MISMATCH (expected ${String(s.expectWrapper)})`}: ${actual}: ${detail}`;
}

/** Options named in kimi's help text. */
function helpFlags(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[\s,[(|])(-{1,2}[A-Za-z][A-Za-z0-9-]*)/gm)].map((match) => match[1] ?? ''))].filter(
    (flag) => flag.length > 0,
  );
}

/**
 * Search files under `roots` for the overlay and secondary markers. A missing
 * root has nothing in it; any other read error makes the marker `unreadable`
 * unless it was found elsewhere. Symlinks are not followed.
 */
function searchMarkers(roots: readonly string[]): Record<string, MarkerSearch> {
  const where = new Map<string, string[]>(MARKERS.map((marker) => [marker, []]));
  const errors: string[] = [];
  const visit = (path: string, top: boolean): void => {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (!(top && errno(error) === 'ENOENT')) errors.push(`${path}: ${message(error)}`);
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(path);
      } catch (error) {
        errors.push(`${path}: ${message(error)}`);
        return;
      }
      for (const name of names) visit(join(path, name), false);
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > MARKER_FILE_LIMIT) {
      errors.push(`${path}: ${stat.size} bytes, not searched`);
      return;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (error) {
      errors.push(`${path}: ${message(error)}`);
      return;
    }
    for (const marker of MARKERS) if (text.includes(marker)) where.get(marker)?.push(path);
  };
  for (const root of roots) visit(root, true);
  return Object.fromEntries(
    MARKERS.map((marker): [string, MarkerSearch] => {
      const found = where.get(marker) ?? [];
      return [marker, { state: found.length > 0 ? 'found' : errors.length > 0 ? 'unreadable' : 'not-found', where: found, errors }];
    }),
  );
}

// ---------------------------------------------------------------- custody

function custodyBytes(dir: string): { bytes: number | null; error: string | null } {
  let total = 0;
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    total += stat.size;
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  try {
    visit(dir);
    return { bytes: total, error: null };
  } catch (error) {
    return { bytes: null, error: message(error) };
  }
}

/** A fresh custody directory: absolute, existing, empty, the caller's own, with the probe's layout made inside. */
function prepareCustody(named: string | undefined): { custody: string; root: string; evidence: string; decoyHome: string; writeCheck: string } {
  if (named === undefined || !isAbsolute(named)) throw new Refusal('--custody must name an absolute, existing, empty directory');
  let custody: string;
  try {
    custody = realpathSync(named);
    const stat = statSync(custody);
    if (!stat.isDirectory()) throw new Refusal(`${custody} is not a directory`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) throw new Refusal(`${custody} is not owned by this user`);
    if (readdirSync(custody).length > 0) throw new Refusal(`${custody} is not empty; name a fresh directory`);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(`--custody ${named}: ${message(error)}`);
  }
  const root = join(custody, 'root');
  const evidence = join(custody, 'evidence');
  const decoyHome = join(custody, 'decoy-home');
  const writeCheck = join(custody, 'write-check');
  for (const dir of [root, evidence, decoyHome, writeCheck]) mkdirSync(dir, { mode: 0o700 });
  for (const sub of ['home', 'tmp', 'cache', 'config', 'data', 'state', 'cases', 'identity-home']) mkdirSync(join(root, sub));
  writeFileSync(join(decoyHome, 'decoy.txt'), 'bare-kimi probe decoy: not a credential\n', { mode: 0o600 });
  return { custody, root, evidence, decoyHome, writeCheck };
}

/** The caller's denied-read paths: absolute, existing, by real path, disjoint from custody and from what must be readable. */
function deniedReads(named: readonly string[], mustRead: readonly string[]): string[] {
  if (named.length === 0) throw new Refusal('name the real native homes to deny with --deny-read (at least one); none is inferred');
  const out: string[] = [];
  for (const path of named) {
    if (!isAbsolute(path)) throw new Refusal(`--deny-read ${path} is not absolute`);
    let real: string;
    try {
      real = realpathSync(path);
    } catch (error) {
      throw new Refusal(`--deny-read ${path}: ${message(error)}`);
    }
    for (const needed of mustRead) {
      if (inside(needed, real) || inside(real, needed)) throw new Refusal(`--deny-read ${real} overlaps ${needed}, which the runs must read`);
    }
    out.push(real);
  }
  return out;
}

function resolveKimi(named: string | undefined): { named: string; real: string; sha256: string } {
  if (named === undefined || !isAbsolute(named)) throw new Refusal('name the kimi executable by absolute path with --kimi-bin; PATH is not searched');
  try {
    const real = realpathSync(named);
    accessSync(real, constants.X_OK);
    return { named, real, sha256: sha256(readFileSync(real)) };
  } catch (error) {
    throw new Refusal(`${named} is not an executable kimi: ${message(error)}`);
  }
}

function sourceEvidence(): Json {
  const files: Record<string, string | null> = {};
  for (const file of SOURCE_FILES) {
    try {
      files[file] = sha256(readFileSync(join(SOURCE_ROOT, file)));
    } catch (error) {
      files[file] = `unreadable: ${message(error)}`;
    }
  }
  let version: unknown = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf-8'));
    version = isRecord(parsed) ? parsed['version'] : null;
  } catch (error) {
    version = `unreadable: ${message(error)}`;
  }
  return { root: SOURCE_ROOT, packageVersion: version, sha256: files };
}

// ---------------------------------------------------------------- dispatch

/** bare-kimi's spawnKimi in the sandbox, as a library caller uses it; kimi's output goes to the step's files. */
const DRIVER = `
const { closeSync, openSync, readFileSync, writeFileSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const { spawnKimi, KimiSpawnError } = await import(process.env.PROBE_BARE_KIMI);
const digest = (path) => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    return 'unreadable: ' + (error?.code ?? String(error));
  }
};
const launch = JSON.parse(process.env.PROBE_LAUNCH);
const record = (value) => writeFileSync(process.env.PROBE_RESULT, JSON.stringify(value) + '\\n');
const text = (error) => (error instanceof Error ? error.message : String(error));
const spawnEnv = {};
for (const name of Object.keys(process.env)) if (name.startsWith('PROBE_')) spawnEnv[name] = undefined;
const stdout = openSync(process.env.PROBE_STDOUT, 'w', 0o600);
const stderr = openSync(process.env.PROBE_STDERR, 'w', 0o600);
let launched;
let refusal;
try {
  launched = spawnKimi(launch, { stdin: 'ignore', stdout, stderr, env: spawnEnv });
} catch (error) {
  refusal = { phase: error instanceof KimiSpawnError ? 'spawn-error' : 'refused', name: error?.name ?? null, message: text(error) };
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
if (refusal !== undefined) {
  record(refusal);
} else {
  // Read as soon as spawnKimi returns: kimi has only just started, so this is
  // the config bare-kimi assembled, though not proven to precede kimi's reads.
  const configBefore = digest(launched.assembled.configPath);
  const base = { assembled: launched.assembled, modelOverlay: launched.modelOverlay, ephemeral: launched.ephemeral, home: launched.home, configBefore };
  record({ phase: 'spawned', ...base });
  await launched.subprocess.exited;
  const configAfter = digest(launched.assembled.configPath);
  let cleanup = null;
  try {
    await launched.dispose();
  } catch (error) {
    cleanup = text(error);
  }
  record({ phase: 'exited', ...base, configAfter, exitCode: launched.subprocess.exitCode, signalCode: launched.subprocess.signalCode, cleanup });
}
`;

const WRAPPER_PHASES: readonly string[] = ['refused', 'spawn-error', 'spawned', 'exited'];

function readWrapperResult(path: string): WrapperResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    return errno(error) === 'ENOENT' ? { phase: 'no-result' } : { phase: 'unreadable', message: message(error) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed['phase'] === 'string' && WRAPPER_PHASES.includes(parsed['phase'])) {
      return {
        phase: parsed['phase'] as WrapperResult['phase'],
        name: parsed['name'],
        message: typeof parsed['message'] === 'string' ? parsed['message'] : undefined,
        assembled: parsed['assembled'],
        modelOverlay: parsed['modelOverlay'],
        exitCode: typeof parsed['exitCode'] === 'number' ? parsed['exitCode'] : null,
        signalCode: parsed['signalCode'],
        cleanup: parsed['cleanup'],
        configBefore: parsed['configBefore'],
        configAfter: parsed['configAfter'],
      };
    }
    return { phase: 'unreadable', message: `unexpected result ${short(text)}` };
  } catch (error) {
    return { phase: 'unreadable', message: message(error) };
  }
}

interface Dispatch {
  readonly lc: Lifecycle;
  readonly kimi: string;
  readonly port: number;
  readonly profile: string;
  readonly baseEnv: Record<string, string>;
  readonly root: string;
  readonly custody: string;
  readonly budgetBytes: number;
  readonly usage: Json[];
}

/** The whole-run budget: why dispatch must stop, if it must. Also records the measurement. */
function checkBudget(d: Dispatch, before: string): string | undefined {
  const used = custodyBytes(d.custody);
  d.usage.push({ at: now(), before, custodyBytes: used.bytes, error: used.error });
  if (used.bytes === null) return `custody size unmeasurable: ${used.error ?? ''}`;
  if (used.bytes >= d.budgetBytes) return `custody holds ${used.bytes} bytes, at or over the run budget of ${d.budgetBytes}`;
  return undefined;
}

function substitute(env: Readonly<Record<string, string>> | undefined, port: number): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([name, value]) => [name, value.replaceAll('{PORT}', String(port))]));
}

function makeHomeDirs(home: string): void {
  mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'oauth'), { recursive: true, mode: 0o700 });
}

/**
 * Dispatch one step and fill in its record. It leaves the record `not-run`
 * (with the reason) when it could not dispatch, `failed` on a harness fault,
 * and `ran` otherwise.
 */
async function runStep(d: Dispatch, def: CaseDef, step: Step, record: StepRecord, sessions: Map<string, string>): Promise<void> {
  const caseDir = join(d.root, 'cases', def.id);
  const work = join(caseDir, 'work');
  const dir = join(caseDir, 'steps', step.id);
  mkdirSync(work, { recursive: true });
  mkdirSync(dir, { recursive: true });
  record.dir = dir;
  let resume: string | undefined;
  if (step.resumeFrom !== undefined) {
    resume = sessions.get(step.resumeFrom);
    if (resume === undefined) {
      record.notRunReason = `no session id from ${step.resumeFrom}`;
      return;
    }
    record.resumed = resume;
  }
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  let cmd: string[];
  let env: Record<string, string>;
  let searchRoots: string[] = [stdoutPath, stderrPath];
  /** The config.toml the step depends on, and the digest it was written with. */
  let watched: { path: string; sha256: string } | undefined;

  if (step.kind === 'native') {
    const home = join(caseDir, step.home ?? 'native-home');
    makeHomeDirs(home);
    if (step.config !== undefined) {
      const text = configText(step.config, def.id, d.port);
      writeFileSync(join(home, 'config.toml'), text, { mode: 0o600 });
      writeFileSync(join(dir, 'config.toml'), text, { mode: 0o600 });
      record.config = { path: join(dir, 'config.toml'), sha256: sha256(text) };
      watched = { path: join(home, 'config.toml'), sha256: sha256(text) };
    }
    const argv = [d.kimi, ...(step.args ?? [])];
    if (resume !== undefined) argv.push('--session', resume);
    if (step.print !== false) {
      const emptySkills = join(home, '.probe-empty-skills');
      mkdirSync(emptySkills, { recursive: true });
      argv.push('--output-format', 'stream-json', '--skills-dir', emptySkills, '-p', PROMPT);
    }
    record.argv = argv;
    record.envAdded = { KIMI_CODE_HOME: home, ...substitute(step.env, d.port) };
    env = { ...d.baseEnv, ...record.envAdded };
    cmd = [SANDBOX_EXEC, '-p', d.profile, ...argv];
    searchRoots = [...searchRoots, home];
  } else {
    const source = join(caseDir, 'source');
    makeHomeDirs(source);
    const text = configText(step.source, def.id, d.port);
    writeFileSync(join(source, 'config.toml'), text, { mode: 0o600 });
    writeFileSync(join(dir, 'source-config.toml'), text, { mode: 0o600 });
    record.config = { path: join(dir, 'source-config.toml'), sha256: sha256(text) };
    watched = { path: join(source, 'config.toml'), sha256: sha256(text) };
    record.expectWrapper = step.expect;
    const kept = step.keptHome === undefined ? undefined : join(caseDir, step.keptHome);
    const launch: Json = {
      prompt: PROMPT,
      cwd: work,
      srcHome: source,
      kimiBin: d.kimi,
      noSkills: true,
      outputFormat: 'stream-json',
      ...(kept === undefined ? {} : { home: kept }),
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.effort === undefined ? {} : { effort: step.effort }),
      ...(resume === undefined ? {} : { resume }),
      ...(step.extraEnv === undefined ? {} : { extraEnv: substitute(step.extraEnv, d.port) }),
    };
    record.launch = launch;
    env = {
      ...d.baseEnv,
      PROBE_BARE_KIMI: BARE_KIMI_INDEX,
      PROBE_LAUNCH: JSON.stringify(launch),
      PROBE_RESULT: join(dir, 'result.json'),
      PROBE_STDOUT: stdoutPath,
      PROBE_STDERR: stderrPath,
    };
    cmd = [SANDBOX_EXEC, '-p', d.profile, process.execPath, '-e', DRIVER];
    if (kept !== undefined) searchRoots = [...searchRoots, kept];
  }

  record.startedAt = now();
  active = { caseId: def.id, stepId: step.id };
  const driverOut = step.kind === 'native' ? stdoutPath : join(dir, 'driver.stdout.txt');
  const driverErr = step.kind === 'native' ? stderrPath : join(dir, 'driver.stderr.txt');
  let processRecord: ProcessRecord;
  try {
    const deadline = step.deadlineMs ?? STEP_DEADLINE_MS;
    processRecord = await runOwned(d.lc, `${def.id}/${step.id}`, cmd, env, work, deadline, driverOut, driverErr);
  } finally {
    active = null;
    record.endedAt = now();
  }
  record.process = processRecord;
  if (processRecord.spawnError !== null) {
    record.status = 'failed';
    record.failure = `could not start: ${processRecord.spawnError}`;
    return;
  }
  record.status = 'ran';
  if (step.kind === 'library') {
    record.wrapper = readWrapperResult(join(dir, 'result.json'));
    record.driverStderrTail = readText(driverErr).slice(-2000);
    if (record.wrapper.phase === 'no-result' || record.wrapper.phase === 'unreadable' || record.wrapper.phase === 'spawn-error') {
      record.status = 'failed';
      record.failure = `driver ${record.wrapper.phase}: ${short(record.wrapper.message ?? record.driverStderrTail)}`;
    }
  }
  const stdout = readText(stdoutPath);
  const stderr = readText(stderrPath);
  record.stdoutTail = stdout.slice(-2000);
  record.stderrTail = stderr.slice(-2000);
  const events = parseStreamJson(stdout).events;
  record.sessionId = events.find(isMetaSessionResumeHint)?.session_id;
  record.systemVersion = events.find(isMetaSystemVersion)?.version;
  if (record.sessionId !== undefined) sessions.set(step.id, record.sessionId);
  record.droppedSections = droppedSections(`${stdout}\n${stderr}`);
  if (step.kind === 'native' && step.print === false) record.helpFlags = helpFlags(`${stdout}\n${stderr}`);
  const mine = attributed.filter((entry) => entry.caseId === def.id && entry.step === step.id);
  record.chats = mine.flatMap((entry) => (entry.chat === null ? [] : [entry.chat]));
  record.requests = mine.length;
  record.retrying = summarizeRetries(events);
  record.catalogRequests = mine.filter((entry) => entry.kind === 'models').length;
  record.credentialFaults = mine.filter((entry) => entry.unexpectedCredentials.length > 0).length;
  record.logFaults = logFailures.filter((failure) => failure.caseId === def.id && failure.step === step.id).length;
  record.configChange = configChange(watched, record.wrapper, dir);
  record.markers = searchMarkers(searchRoots);
}

/**
 * How a config.toml the step depends on changed while it ran, or null: the
 * one the probe wrote (the native home's, or the source's), and for a
 * launched library step the run home's, before and after kimi. A changed
 * file is kept in the step directory. An unreadable digest counts as a
 * change: it cannot be shown unchanged.
 */
function configChange(watched: { path: string; sha256: string } | undefined, wrapper: WrapperResult | undefined, dir: string): string | null {
  const changes: string[] = [];
  if (watched !== undefined) {
    let after: string;
    try {
      const bytes = readFileSync(watched.path);
      after = sha256(bytes);
      if (after !== watched.sha256) writeFileSync(join(dir, 'config-after.toml'), bytes, { mode: 0o600 });
    } catch (error) {
      after = `unreadable: ${errno(error) ?? message(error)}`;
    }
    if (after !== watched.sha256) changes.push(`${watched.path} changed during the step (${watched.sha256.slice(0, 12)} -> ${after.slice(0, 24)})`);
  }
  if (wrapper?.phase === 'exited') {
    const before = String(wrapper.configBefore);
    const after = String(wrapper.configAfter);
    if (before !== after || before.startsWith('unreadable')) changes.push(`run home config.toml ${before.slice(0, 24)} -> ${after.slice(0, 24)}`);
  }
  return changes.length === 0 ? null : changes.join('; ');
}

/** kimi's `turn.step.retrying` meta lines, condensed: how far it got, and each distinct error once. */
function summarizeRetries(events: readonly unknown[]): RetrySummary | null {
  const retries = events.filter(isMetaTurnStepRetrying);
  if (retries.length === 0) return null;
  const errors: RetryError[] = [];
  for (const retry of retries) {
    const name = retry.error_name ?? null;
    const text = retry.error_message ?? '';
    const statusCode = retry.status_code ?? null;
    const seen = errors.find((error) => error.name === name && error.message === text && error.statusCode === statusCode);
    if (seen === undefined) errors.push({ name, message: text, statusCode, count: 1 });
    else seen.count += 1;
  }
  return {
    events: retries.length,
    lastFailedAttempt: Math.max(...retries.map((retry) => retry.failed_attempt)),
    maxAttempts: Math.max(...retries.map((retry) => retry.max_attempts)),
    errors,
  };
}

function newRecord(step: Step): StepRecord {
  return {
    id: step.id,
    via: step.kind,
    purpose: step.purpose,
    status: 'not-run',
    chats: [],
    requests: 0,
    retrying: null,
    catalogRequests: 0,
    logFaults: 0,
    credentialFaults: 0,
    configChange: null,
    droppedSections: [],
    helpFlags: [],
  };
}

function judgeCase(def: CaseDef, result: CaseResult, results: ReadonlyMap<string, CaseResult>): void {
  const byId = new Map(result.steps.map((step) => [step.id, step]));
  const judging: Judging = {
    step: (id) => {
      const found = byId.get(id);
      if (found === undefined) throw new Error(`case ${def.id} has no step ${id}`);
      return found;
    },
    control: (id) => results.get(id),
  };
  const facts: Record<string, string> = {};
  for (const step of result.steps) {
    if (step.via === 'library') facts[`bare-kimi: ${step.id}`] = wrapperFact(step);
    result.observations[step.id] = describeStep(step);
  }
  Object.assign(facts, def.judge(judging));
  const outside = attributed.filter((entry) => entry.caseId === def.id && entry.step === '(outside-step)').length;
  if (outside > 0) facts['request attribution'] = U(`${outside} request(s) for this case arrived outside any of its steps`);
  result.facts = facts;
  const statuses = result.steps.map((step) => step.status);
  result.outcome = statuses.every((status) => status === 'not-run')
    ? 'not-run'
    : statuses.includes('failed')
      ? 'failed'
      : statuses.includes('not-run') || Object.values(facts).some((fact) => fact.startsWith('unknown'))
        ? 'unknown'
        : 'observed';
}

/** The requested cases plus the controls they depend on, in definition order. */
function selectCases(requested: string | undefined): { order: CaseDef[]; requested: string[]; added: string[] } {
  const names = requested === undefined ? CASES.map((def) => def.id) : requested.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !CASES.some((def) => def.id === name));
  if (unknown.length > 0) throw new Refusal(`unknown case(s) ${unknown.join(', ')}; known: ${CASES.map((def) => def.id).join(', ')}`);
  const wanted = new Set(names);
  for (const def of CASES) if (wanted.has(def.id)) for (const dep of def.dependsOn) wanted.add(dep);
  return {
    order: CASES.filter((def) => wanted.has(def.id)),
    requested: names,
    added: [...wanted].filter((name) => !names.includes(name)),
  };
}

function summarize(results: readonly CaseResult[]): Json {
  const mismatches = results.flatMap((result) =>
    Object.entries(result.facts)
      .filter(([, fact]) => fact.startsWith('MISMATCH'))
      .map(([key, fact]) => `${result.id} ${key}: ${fact}`),
  );
  return {
    outcomes: Object.fromEntries(results.map((result) => [result.id, result.outcome])),
    facts: Object.fromEntries(results.map((result) => [result.id, result.facts])),
    wrapperMismatches: mismatches,
    requestLogFailures: logFailures,
    progressLogFailures: progressFailures,
    unattributedRequests: attributed.filter((entry) => entry.caseId === '(unattributed)').map((entry) => entry.seq),
    outsideStepRequests: attributed.filter((entry) => entry.step === '(outside-step)' && entry.caseId !== '(preflight)').map((entry) => entry.seq),
    catalogRequests: attributed.filter((entry) => entry.kind === 'models').map((entry) => entry.seq),
    unexpectedCredentials: attributed.filter((entry) => entry.unexpectedCredentials.length > 0).map((entry) => entry.seq),
    groupScope: "each step's own process group read empty; descendants that left it are not covered",
  };
}

// ---------------------------------------------------------------- main

const EXIT_MEANING: Record<number, string> = {
  0: 'every selected case observed',
  1: 'some case unknown, failed or not run',
  2: 'refused before kimi was launched',
  3: "kimi's --version did not show the expected version; no case dispatched",
  4: 'dispatch stopped: a process group not shown empty or not led, an unexpected credential, a progress-log fault, or the custody budget',
  5: 'probe failure after kimi was launched',
};

/** Everything the report says, filled in as the run goes, so a failure still reports what happened. */
const report: Json = { schema: SCHEMA, startedAt: now() };

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'kimi-bin': { type: 'string' },
      'expect-version': { type: 'string' },
      'kimi-bundle': { type: 'string' },
      custody: { type: 'string' },
      'max-custody-mib': { type: 'string' },
      'deny-read': { type: 'string', multiple: true, default: [] },
      'bare-claude-lifecycle': { type: 'string' },
      'bare-claude-lifecycle-sha256': { type: 'string' },
      cases: { type: 'string' },
    },
    strict: true,
  });
  if (process.platform !== 'darwin') throw new Refusal('loopback isolation is implemented for macOS sandbox-exec only');
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
  } catch {
    throw new Refusal(`${SANDBOX_EXEC} is not available`);
  }
  const expectVersion = values['expect-version'];
  if (expectVersion === undefined || !/^\d+\.\d+\.\d+$/.test(expectVersion)) throw new Refusal('--expect-version X.Y.Z is required');
  const budgetMib = Number(values['max-custody-mib']);
  if (!Number.isInteger(budgetMib) || budgetMib <= 0) throw new Refusal('--max-custody-mib must be a positive integer');
  const lifecyclePath = values['bare-claude-lifecycle'];
  const lifecycleSha = values['bare-claude-lifecycle-sha256'];
  if (lifecyclePath === undefined || lifecycleSha === undefined) {
    throw new Refusal('name the published bare-claude lifecycle module with --bare-claude-lifecycle and --bare-claude-lifecycle-sha256');
  }
  const selection = selectCases(values.cases);
  const kimi = resolveKimi(values['kimi-bin']);
  let bundle: Json | null = null;
  if (values['kimi-bundle'] !== undefined) {
    const path = values['kimi-bundle'];
    if (!isAbsolute(path)) throw new Refusal('--kimi-bundle must be absolute');
    try {
      const bytes = readFileSync(path);
      bundle = { path, real: realpathSync(path), sha256: sha256(bytes), bytes: bytes.length };
    } catch (error) {
      throw new Refusal(`--kimi-bundle ${path}: ${message(error)}`);
    }
  }

  const layout = prepareCustody(values.custody);
  report['custody'] = { ...layout, budgetBytes: budgetMib * 1024 * 1024 };
  requestLog = join(layout.evidence, 'requests.jsonl');
  writeFileSync(requestLog, '');
  progressPath = join(layout.evidence, 'progress.jsonl');
  writeFileSync(progressPath, '');
  report['runtime'] = { bun: Bun.version, execPath: process.execPath, nodeOnPath: onPath('node') };
  assertNoAmbientInstructions(layout.root);
  const denied = [...deniedReads(values['deny-read'], [layout.custody, SOURCE_ROOT, kimi.real, process.execPath]), layout.decoyHome];
  const { lc, identity } = await loadLifecycle(lifecyclePath, lifecycleSha, layout.evidence);
  lifecycle = lc;
  report['lifecycle'] = identity;
  report['kimi'] = { ...kimi, bundle, expectVersion };
  report['source'] = sourceEvidence();
  report['selection'] = { requested: selection.requested, controlsAdded: selection.added, order: selection.order.map((def) => def.id) };
  watchInterrupts();

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
  const decoy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('decoy') });
  try {
    const port = server.port;
    const decoyPort = decoy.port;
    if (port === undefined || decoyPort === undefined) throw new Refusal('a loopback listener has no port');
    const execTargets = DELEGATION_EXEC.map((target) => target.path);
    const profile = sandboxProfile({ root: layout.root, port, deniedReads: denied, deniedExec: execTargets, deniedMach: DELEGATION_MACH });
    writeFileSync(join(layout.evidence, 'sandbox.sb'), `${profile}\n`);
    const baseEnv: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: join(layout.root, 'home'),
      TMPDIR: join(layout.root, 'tmp'),
      XDG_CACHE_HOME: join(layout.root, 'cache'),
      XDG_CONFIG_HOME: join(layout.root, 'config'),
      XDG_DATA_HOME: join(layout.root, 'data'),
      XDG_STATE_HOME: join(layout.root, 'state'),
      LANG: 'C.UTF-8',
      KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
      KIMI_DISABLE_TELEMETRY: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    };
    report['environment'] = baseEnv;

    // Isolation, before kimi starts.
    const preflightEnv = {
      ...baseEnv,
      PROBE_PORT: String(port),
      PROBE_DECOY_PORT: String(decoyPort),
      PROBE_WRITE_TARGET: join(layout.writeCheck, 'write-check'),
      PROBE_DECOY_FILE: join(layout.decoyHome, 'decoy.txt'),
      PROBE_EXEC_TARGETS: JSON.stringify(DELEGATION_EXEC),
      PROBE_EXEC_CONTROL: EXEC_CONTROL,
    };
    const preflightGroups: Json[] = [];
    const preflight = async (name: string, mode: 'control' | 'sandboxed'): Promise<unknown> => {
      const cmd = mode === 'sandboxed' ? [SANDBOX_EXEC, '-p', profile, process.execPath, '-e', PREFLIGHT] : [process.execPath, '-e', PREFLIGHT];
      const out = join(layout.evidence, `preflight-${name}.stdout.txt`);
      const err = join(layout.evidence, `preflight-${name}.stderr.txt`);
      const run = await runOwned(lc, `preflight/${name}`, cmd, { ...preflightEnv, PROBE_MODE: mode }, layout.root, PREFLIGHT_DEADLINE_MS, out, err);
      preflightGroups.push({ name, groupState: run.groupState, leader: run.leader, spawnError: run.spawnError, deadlineHit: run.deadlineHit });
      // Nothing started: a refusal, not a group left behind.
      if (run.spawnError !== null) throw new Refusal(`preflight ${name} could not start: ${run.spawnError}`);
      if (run.groupState !== 'empty') throw new Halt(`preflight ${name}: process group ${String(run.pid)} is ${run.groupState}`);
      if (!leads(run)) throw new Halt(`preflight ${name}: the child does not lead its process group (${String(run.leader)})`);
      try {
        return JSON.parse(readText(out));
      } catch {
        return undefined;
      }
    };
    const before = await preflight('control-before', 'control');
    const sandboxed = await preflight('sandboxed', 'sandboxed');
    const after = await preflight('control-after', 'control');
    const verdict = judgeIsolation(before, sandboxed, after, { execTargets });
    report['isolation'] = { deniedReads: denied, providerPort: port, decoyPort, preflight: { before, sandboxed, after, ...verdict }, preflightGroups };
    if (verdict.failures.length > 0) throw new Refusal(`sandbox preflight did not show isolation (kimi not launched): ${verdict.failures.join('; ')}`);
    if (interruption.signal !== null) return 128 + SIGNAL_NUMBERS[interruption.signal];

    const d: Dispatch = {
      lc,
      kimi: kimi.real,
      port,
      profile,
      baseEnv,
      root: layout.root,
      custody: layout.custody,
      budgetBytes: budgetMib * 1024 * 1024,
      usage: [],
    };
    report['usage'] = d.usage;
    for (const def of selection.order) knownCases.add(def.id);
    const results = new Map<string, CaseResult>();
    for (const def of selection.order) {
      results.set(def.id, {
        id: def.id,
        question: def.question,
        title: def.title,
        dependsOn: def.dependsOn,
        outcome: 'not-run',
        facts: {},
        observations: {},
        steps: def.steps.map(newRecord),
      });
    }
    report['cases'] = [...results.values()];

    // Identity: the named kimi's own --version, in the sandbox.
    const idOut = join(layout.evidence, 'kimi-version.stdout.txt');
    const idErr = join(layout.evidence, 'kimi-version.stderr.txt');
    const idHome = join(layout.root, 'identity-home');
    const idRun = await runOwned(
      lc,
      'identity/version',
      [SANDBOX_EXEC, '-p', profile, kimi.real, '--version'],
      { ...baseEnv, KIMI_CODE_HOME: idHome },
      idHome,
      PREFLIGHT_DEADLINE_MS,
      idOut,
      idErr,
    );
    const versionText = `${readText(idOut)}\n${readText(idErr)}`.trim();
    const escaped = expectVersion.replaceAll('.', '\\.');
    const matched = new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`).test(versionText);
    report['kimi'] = { ...(report['kimi'] as Json), versionOutput: short(versionText, 400), versionMatched: matched, versionRun: idRun };
    if (idRun.spawnError !== null) throw new Refusal(`kimi --version could not start: ${idRun.spawnError}`);
    if (idRun.groupState !== 'empty') throw new Halt(`kimi --version: process group ${String(idRun.pid)} is ${idRun.groupState}`);
    if (!leads(idRun)) throw new Halt(`kimi --version: the child does not lead its process group (${String(idRun.leader)})`);
    if (!matched) {
      for (const result of results.values()) for (const step of result.steps) step.notRunReason = 'kimi version did not match --expect-version';
      report['summary'] = summarize([...results.values()]);
      return 3;
    }

    const halted: { value: { after: string; reason: string } | null } = { value: null };
    const stop = (reason: string, after: string): void => {
      halted.value ??= { after, reason };
    };
    for (const def of selection.order) {
      const result = results.get(def.id);
      if (result === undefined) continue;
      const sessions = new Map<string, string>();
      for (const [index, step] of def.steps.entries()) {
        const record = result.steps[index];
        if (record === undefined) continue;
        if (interruption.signal !== null) {
          record.notRunReason = `interrupted by ${interruption.signal}`;
          continue;
        }
        if (halted.value === null) {
          const over = checkBudget(d, `${def.id}/${step.id}`);
          if (over !== undefined) stop(over, `before ${def.id}/${step.id}`);
        }
        if (halted.value !== null) {
          record.notRunReason = `dispatch stopped: ${halted.value.reason}`;
          continue;
        }
        await runStep(d, def, step, record, sessions);
        logProgress({ event: 'step', case: def.id, ...record });
        const label = `${def.id}/${step.id}`;
        const run = record.process;
        if (run !== undefined && run.groupState !== 'empty' && run.groupState !== 'never-started') {
          stop(`process group ${String(run.pid)} is ${run.groupState}`, label);
        }
        if (run !== undefined && run.spawnError === null && !leads(run)) {
          stop(`the child does not lead its process group (${String(run.leader)})`, label);
        }
        const alarms = attributed.filter((entry) => entry.unexpectedCredentials.length > 0);
        if (alarms.length > 0) {
          stop(`unexpected credential-shaped header(s) in request(s) ${alarms.map((entry) => `#${entry.seq}`).join(', ')}`, label);
        }
        if (progressFailures.length > 0) stop(`progress log not written: ${progressFailures.join('; ')}`, label);
      }
    }
    for (const def of selection.order) {
      const result = results.get(def.id);
      if (result !== undefined) judgeCase(def, result, results);
    }
    const final = checkBudget(d, 'end');
    report['dispatch'] = { stopped: halted.value, interrupted: interruption.signal, budgetAtEnd: final ?? 'within budget' };
    report['summary'] = summarize([...results.values()]);
    if (interruption.signal !== null) return 128 + SIGNAL_NUMBERS[interruption.signal];
    if (halted.value !== null) return 4;
    // A request no case can account for leaves the run's evidence incomplete.
    if (attributed.some((entry) => entry.caseId === '(unattributed)')) return 1;
    return [...results.values()].every((result) => result.outcome === 'observed') ? 0 : 1;
  } finally {
    server.stop(true);
    decoy.stop(true);
  }
}

async function finish(code: number, failure: string | null): Promise<number> {
  const left = await releaseOwned(lifecycle);
  report['finishedAt'] = now();
  report['exit'] = { code, meaning: code >= 128 ? 'interrupted' : (EXIT_MEANING[code] ?? 'unknown'), failure };
  report['ownedGroupsLeft'] = left;
  report['requestLog'] = requestLog;
  report['requestCount'] = sequence;
  const custody = report['custody'];
  const evidence = isRecord(custody) && typeof custody['evidence'] === 'string' ? custody['evidence'] : undefined;
  if (evidence !== undefined) {
    const path = join(evidence, 'report.json');
    try {
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ report: path, exit: report['exit'], summary: report['summary'] ?? null, ownedGroupsLeft: left }, null, 2));
    } catch (error) {
      console.error(`model-effort-loopback: could not write ${path}: ${message(error)}`);
    }
  }
  if (failure !== null) console.error(`model-effort-loopback: ${failure}`);
  if (isRecord(custody)) console.error(`model-effort-loopback: custody left for inspection: ${String(custody['custody'])}`);
  // A group not shown empty makes any lower exit code a claim the run cannot make.
  return left.length > 0 && code < 4 ? 4 : code;
}

// Run only as a program: importing this module (the pure judging tests do) starts nothing.
if (import.meta.main) {
  let code: number;
  try {
    code = await finish(await main(), null);
  } catch (error) {
    const kind = error instanceof Refusal ? 2 : error instanceof Halt ? 4 : 5;
    const prefix = kind === 2 ? 'refused' : kind === 4 ? 'dispatch stopped' : 'failed';
    code = await finish(kind, `${prefix}: ${message(error)}`);
  }
  process.exit(code);
}
