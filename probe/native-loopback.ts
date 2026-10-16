#!/usr/bin/env bun
/**
 * Optional native probe: what does an installed kimi actually do with a run
 * home bare-kimi assembled? Answered without credentials, without a model
 * provider, and without network beyond one loopback port. It is NOT part of
 * `bun test`. Run it deliberately, from an unsandboxed shell (sandbox-exec
 * cannot start inside another sandbox), and read its report:
 *
 *   bun probe/native-loopback.ts --kimi-bin /path/to/kimi
 *
 * The kimi executable must be named explicitly (`--kimi-bin` or
 * `KIMI_BIN`); PATH is not searched. Its real path is recorded.
 *
 * How:
 * - A loopback HTTP server stands in for an OpenAI-compatible provider
 *   (kimi provider `type = "openai"`, model `protocol = "openai"`, i.e.
 *   `/chat/completions`). Each scenario's provider lives under its own path,
 *   `/s/<scenario>/v1`, so requests are attributed by where kimi sent them.
 *   When a request offers kimi's `Bash` tool and holds no tool result yet,
 *   the server replies with one scripted call, `touch <canary>` under the
 *   probe's temp root, and records that it did. Otherwise it replies with
 *   plain text. Every request is logged.
 * - Each scenario gets a fresh synthetic source home (dummy API key, empty
 *   credentials/), cwd and run home under one temp root. HOME, TMPDIR and
 *   the cache dir point there too; model-catalog refresh is off.
 * - bare-kimi, and so kimi, run under macOS `sandbox-exec`:
 *   - outbound network is allowed only to the provider's own loopback port;
 *   - file writes are allowed only under the temp root;
 *   - reads are denied for the real native homes (`~/.kimi-code`, `~/.kimi`,
 *     and any `KIMI_CODE_HOME`/`KIMI_CODE_HOME_SOURCE` this shell selects),
 *     computed at run time, and for a synthetic decoy home.
 *
 *   A preflight inside the same sandbox must show all of the following
 *   before kimi is launched, or the probe refuses (exit 2):
 *   - the provider port answers;
 *   - another loopback port and a never-routed address are refused;
 *   - a write outside the root is refused;
 *   - reading the decoy home's file is refused (proving the read denial
 *     without touching a real home);
 *   - the child owns its own process group.
 * - Every child runs in its own process group, which the probe owns. At a
 *   deadline the group gets SIGTERM, then SIGKILL after a grace period;
 *   output is collected as it arrives and the drain is bounded. Whether the
 *   group was gone afterwards is recorded, not assumed; if one was not, no
 *   further scenario runs. Nothing here claims that the provider request or
 *   a tool was cancelled. kimi starts tool commands in their own groups, so
 *   a gone group does not prove every descendant is gone.
 *
 * Scenarios, each judged on its own evidence:
 * - control: no rules, one valid hook. The scripted call must be sent, its
 *   result returned, and its canary created, with no config section dropped.
 *   The hook verdict comes from this run;
 * - deny: `[[permission.rules]] decision = "deny", pattern = "Bash",
 *   reason = "probe"`, the shape kimi 2.1.0's schema accepts. `not-enforced`
 *   when the scripted call was sent and its canary appeared. `enforced` only
 *   when the control held, the call was sent, the canary is absent, no
 *   section was dropped, and a tool result carries kimi's exact rule refusal
 *   for this rule: `Tool "Bash" was denied by permission rule. Reason:
 *   probe`. `withheld-by-omission` (Bash not offered) also needs the control
 *   to have held. Anything else is inconclusive;
 * - deny-string: `[permission] deny = ["Bash"]`, a string rule that 2.1.0's
 *   schema rejects. Observes whether kimi drops the whole section;
 * - invalid-hook: the valid hook plus one with an unknown event. Judged only
 *   if this run's own scripted call ran: is the hooks section (and only it)
 *   dropped, and the valid hook silent?
 * - preload: `--preload` of a marker file. Judged only if a resumed request
 *   carrying the call to action actually happened, and the primer did not
 *   already carry the marker.
 * Each scenario also records the stream-json meta lines, wire journals in
 * the run home, and where the configured thinking effort appears in the
 * requests kimi sent.
 *
 * Custody: the probe creates two directories in the system temp dir and
 * leaves both for inspection, naming them on success, refusal and failure:
 * - the temp root `bare-kimi-probe-*`, which holds everything the runs
 *   write, the report, and each run's raw stdout/stderr (written before
 *   anything is judged), plus the preflight's;
 * - the decoy home `bare-kimi-probe-decoy-home-*`, which holds one
 *   non-secret file. It lies outside the root on purpose: the read denial
 *   must be shown on a path the write allowance does not also cover.
 *
 * The preflight's own attempt to write outside the root targets one more
 * path in the temp dir. It is expected to be refused, and is removed again
 * if the attempt succeeds. The report lists the real native homes it denied
 * by absolute path; keep it private.
 *
 * Exit codes: 0 when the control held (the report may still mark other
 * findings inconclusive), 1 when it did not or the probe failed, 2 when the
 * probe refused before launching kimi. This is one observation of one
 * installed kimi under one sandbox profile, not a claim about kimi in
 * general and not an OS-level guarantee.
 */

import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMetaSessionResumeHint, isMetaSystemVersion, parseStreamJson } from '../src/events.ts';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const BARE_KIMI = resolve(import.meta.dir, '..', 'bin', 'bare-kimi.ts');
const MODEL = 'probe-model';
const EFFORT = 'high';
const PROMPT = 'Run the probe step, then answer briefly.';
const PRELOAD_MARKER = 'probe-preload-marker-7f3a';
const RUN_DEADLINE_MS = 180_000;
const PREFLIGHT_DEADLINE_MS = 30_000;
const GRACE_MS = 5_000;
const DRAIN_MS = 5_000;

/** The probe cannot run safely here; nothing native was launched. */
class Refusal extends Error {}

/**
 * Directories this probe created (the temp root, then the decoy home), in
 * order, so they are named on success, refusal and failure alike.
 */
const created: string[] = [];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function sleep(ms: number): Promise<'elapsed'> {
  return new Promise((done) => setTimeout(() => done('elapsed'), ms));
}

/** `promise`, or 'elapsed' after `ms`; the timer is cleared either way, so it never keeps the probe alive. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'elapsed'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<'elapsed'>((done) => {
    timer = setTimeout(() => done('elapsed'), ms);
  });
  try {
    return await Promise.race([promise, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- owned process groups

/** Process groups this probe started and still owns. */
const ownedGroups = new Set<number>();

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group is already gone
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop every owned group if the probe itself is interrupted or exits. */
function releaseGroupsOnExit(): void {
  const stopAll = (): void => {
    for (const pgid of ownedGroups) signalGroup(pgid, 'SIGKILL');
  };
  process.on('exit', stopAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      stopAll();
      process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
    });
  }
}

interface Owned {
  /** The child could not be started at all. */
  readonly spawnError: string | undefined;
  /** The child did not lead its own process group, so it was killed at once. */
  readonly groupNotOwned: boolean;
  readonly timedOut: boolean;
  /** SIGTERM did not end the group within the grace period; SIGKILL followed. */
  readonly escalated: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  /** stdout/stderr reached end of file within the drain bound. */
  readonly drained: boolean;
  /** Some process of the group still existed after the final SIGKILL. */
  readonly groupRemained: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `cmd` as the leader of a new process group that this probe owns. The
 * group is ended (SIGTERM, then SIGKILL after GRACE_MS) at the deadline, and
 * also when the leader exits while members remain. Output is collected as
 * it arrives, so it survives a kill; the wait for end of file is bounded.
 */
async function runOwned(cmd: readonly string[], env: Record<string, string>, cwd: string, deadlineMs: number): Promise<Owned> {
  const [file, ...args] = cmd;
  if (file === undefined) throw new Error('empty command');
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const spawnFailure = new Promise<string>((done) => child.once('error', (error) => done(String(error))));
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal })),
  );
  const closed = new Promise<'closed'>((done) => child.once('close', () => done('closed')));
  const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf-8');

  const pid = child.pid;
  if (pid === undefined) {
    return {
      spawnError: await spawnFailure,
      groupNotOwned: false,
      timedOut: false,
      escalated: false,
      code: null,
      signal: null,
      drained: true,
      groupRemained: false,
      stdout: '',
      stderr: '',
    };
  }
  // A detached child leads a group whose id is its pid. If no such group
  // exists, the group cannot be owned: kill the child and report it.
  if (!groupAlive(pid)) {
    child.kill('SIGKILL');
    await within(exited, GRACE_MS);
    return {
      spawnError: undefined,
      groupNotOwned: true,
      timedOut: false,
      escalated: false,
      code: null,
      signal: null,
      drained: false,
      groupRemained: false,
      stdout: text(stdout),
      stderr: text(stderr),
    };
  }
  ownedGroups.add(pid);

  let timedOut = false;
  let escalated = false;
  const endGroup = async (): Promise<void> => {
    signalGroup(pid, 'SIGTERM');
    for (let waited = 0; waited < GRACE_MS && groupAlive(pid); waited += 100) await sleep(100);
    if (groupAlive(pid)) {
      escalated = true;
      signalGroup(pid, 'SIGKILL');
    }
  };

  const first = await within(exited, deadlineMs);
  if (first === 'elapsed') {
    timedOut = true;
    await endGroup();
  }
  const exit = await within(exited, GRACE_MS);
  // The leader is gone; members it left behind are still the probe's to end.
  if (groupAlive(pid)) await endGroup();
  const drained = (await within(closed, DRAIN_MS)) === 'closed';
  if (!drained) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const groupRemained = groupAlive(pid);
  if (!groupRemained) ownedGroups.delete(pid);
  return {
    spawnError: undefined,
    groupNotOwned: false,
    timedOut,
    escalated,
    code: exit === 'elapsed' ? null : exit.code,
    signal: exit === 'elapsed' ? null : exit.signal,
    drained,
    groupRemained,
    stdout: text(stdout),
    stderr: text(stderr),
  };
}

// ---------------------------------------------------------------- loopback provider

interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

interface Reply {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

/** What the provider scripts for one scenario, found by its own base-URL path. */
interface Script {
  readonly toolCall: boolean;
  readonly canary: string;
}

interface LoggedRequest {
  /** Scenario named by the request path (`/s/<name>/v1/...`), else `(unattributed)`. */
  readonly scenario: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** This request was answered with the scripted Bash call. */
  readonly scriptedCall: boolean;
}

/**
 * Each scenario's provider lives under its own path, `/s/<name>/v1`, so a
 * request is attributed by where kimi sent it, not by which scenario happens
 * to be running: a stale kimi from an earlier run cannot feed a later one.
 */
const scripts = new Map<string, Script>();
const requests: LoggedRequest[] = [];
const SCENARIO_PATH = /^\/s\/([A-Za-z0-9-]+)\/v1\//;

function scenarioOf(path: string): string | undefined {
  const name = SCENARIO_PATH.exec(path)?.[1];
  return name !== undefined && scripts.has(name) ? name : undefined;
}

function functionName(tool: unknown): unknown {
  if (!isRecord(tool)) return undefined;
  const fn = tool['function'];
  return isRecord(fn) ? fn['name'] : undefined;
}

function messagesOf(body: unknown): unknown[] {
  return isRecord(body) && Array.isArray(body['messages']) ? body['messages'] : [];
}

function offersBash(body: unknown): boolean {
  const tools: unknown[] = isRecord(body) && Array.isArray(body['tools']) ? body['tools'] : [];
  return tools.some((tool) => functionName(tool) === 'Bash');
}

/**
 * The text of each tool-result message, as sent: a string content as is, an
 * array of content parts as their `text` fields joined, anything else as
 * JSON. Returned unescaped, so a native message can be matched exactly.
 */
function toolResultsOf(body: unknown): string[] {
  return messagesOf(body)
    .filter((message) => isRecord(message) && message['role'] === 'tool')
    .map((message) => {
      const content = isRecord(message) ? message['content'] : undefined;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part: unknown) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : JSON.stringify(part)))
          .join('');
      }
      return JSON.stringify(content);
    });
}

function replyFor(script: Script | undefined, body: unknown): Reply {
  const answered = toolResultsOf(body).length > 0;
  if (script !== undefined && script.toolCall && offersBash(body) && !answered) {
    return {
      content: null,
      toolCalls: [
        {
          id: 'call_probe_1',
          type: 'function',
          function: { name: 'Bash', arguments: JSON.stringify({ command: `touch ${shellQuote(script.canary)}` }) },
        },
      ],
    };
  }
  return { content: 'probe-done', toolCalls: [] };
}

function chatResponse(body: unknown, reply: Reply): Response {
  const finish = reply.toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const base = { id: 'chatcmpl-probe', created: 0, model: MODEL };
  const streamed = isRecord(body) && body['stream'] === true;
  if (!streamed) {
    const message =
      reply.toolCalls.length > 0
        ? { role: 'assistant', content: null, tool_calls: reply.toolCalls }
        : { role: 'assistant', content: reply.content };
    return Response.json({
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    });
  }
  const delta =
    reply.toolCalls.length > 0
      ? { role: 'assistant', content: null, tool_calls: reply.toolCalls.map((call, index) => ({ index, ...call })) }
      : { role: 'assistant', content: reply.content };
  const chunks = [
    { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] },
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
  const named = scenarioOf(url.pathname);
  const scenario = named ?? (url.pathname === '/health' ? '(preflight)' : '(unattributed)');
  if (url.pathname.endsWith('/chat/completions') && request.method === 'POST') {
    const reply = replyFor(named === undefined ? undefined : scripts.get(named), body);
    requests.push({ scenario, method: request.method, path: url.pathname, body, scriptedCall: reply.toolCalls.length > 0 });
    return chatResponse(body, reply);
  }
  requests.push({ scenario, method: request.method, path: url.pathname, body, scriptedCall: false });
  if (url.pathname === '/health') return new Response('ok');
  if (url.pathname.endsWith('/models')) {
    return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'probe' }] });
  }
  return new Response('not found', { status: 404 });
}

// ---------------------------------------------------------------- isolation

/**
 * The real native homes of the user running the probe, computed here and
 * never named in source: `~/.kimi-code` and `~/.kimi` under both the HOME
 * and the account home, plus whatever this shell selects through
 * KIMI_CODE_HOME / KIMI_CODE_HOME_SOURCE. Only paths that exist and lie
 * outside the probe root are listed; the probe never reads them itself.
 */
function nativeHomes(root: string): string[] {
  const homes = new Set([homedir(), userInfo().homedir]);
  const candidates = [
    ...[...homes].flatMap((home) => [join(home, '.kimi-code'), join(home, '.kimi')]),
    process.env['KIMI_CODE_HOME'],
    process.env['KIMI_CODE_HOME_SOURCE'],
  ];
  const found = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    const path = resolve(candidate);
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    const inRoot = relative(root, real);
    if (inRoot === '' || (!inRoot.startsWith('..') && !isAbsolute(inRoot))) continue;
    found.add(real);
  }
  return [...found];
}

function sandboxProfile(root: string, port: number, deniedReads: readonly string[]): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(root)})`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...deniedReads.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
  ].join('\n');
}

/**
 * Runs inside the sandbox with the same profile and environment as the real
 * runs: the provider port must answer; a listening decoy on another loopback
 * port and TEST-NET-1 (RFC 5737, never routed) must both be refused by the
 * sandbox itself; a write outside the root must be refused; and reading the
 * synthetic decoy home, denied exactly as the real native homes are, must be
 * refused. That proves the read denial works without touching a real home.
 */
const PREFLIGHT = `
const { connect } = await import('node:net');
const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
const attempt = (host, port) => new Promise((done) => {
  const socket = connect({ host, port });
  const timer = setTimeout(() => { socket.destroy(); done('timeout'); }, 3000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); done('connected'); });
  socket.on('error', (error) => { clearTimeout(timer); done(error.code ?? String(error)); });
});
const out = {};
try {
  const response = await fetch('http://127.0.0.1:' + process.env.PROBE_PORT + '/health');
  out.provider = (await response.text()) === 'ok';
} catch (error) {
  out.provider = false;
  out.providerError = String(error);
}
out.otherLoopback = await attempt('127.0.0.1', Number(process.env.PROBE_DECOY_PORT));
out.egress = await attempt('192.0.2.1', 80);
try {
  writeFileSync(process.env.PROBE_OUTSIDE, 'x');
  rmSync(process.env.PROBE_OUTSIDE, { force: true });
  out.write = 'allowed';
} catch (error) {
  out.write = error.code ?? String(error);
}
try {
  readFileSync(process.env.PROBE_DECOY_FILE);
  out.decoyRead = 'allowed';
} catch (error) {
  out.decoyRead = error.code ?? String(error);
}
console.log(JSON.stringify(out));
`;

/**
 * A synthetic stand-in for a real native home, created outside the probe
 * root (the read denial must be shown on a path the write allowance does not
 * also cover). It holds one non-secret file. It is denied in the profile
 * exactly like the real homes, and is left in place, identifiable by its
 * name, alongside the root.
 */
function makeDecoyHome(): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bare-kimi-probe-decoy-home-')));
  const file = join(dir, 'decoy.txt');
  writeFileSync(file, 'bare-kimi probe decoy: not a credential\n', { mode: 0o600 });
  return { dir, file };
}

const DENIED = new Set(['EPERM', 'EACCES']);

/** No AGENTS.md or Git repository above the probe's cwd: kimi would load them. */
function assertNoAmbientInstructions(dir: string): void {
  for (let current = dir; ; current = dirname(current)) {
    for (const name of ['AGENTS.md', '.git']) {
      if (existsSync(join(current, name))) {
        throw new Refusal(`${join(current, name)} exists above the probe cwd; kimi would load it`);
      }
    }
    if (dirname(current) === current) return;
  }
}

/** The explicitly named kimi executable, by its real path. PATH is not searched. */
function resolveKimi(explicit: string | undefined): { named: string; real: string } {
  const named = explicit ?? process.env['KIMI_BIN'];
  if (named === undefined || named.length === 0) {
    throw new Refusal('name the kimi executable with --kimi-bin or KIMI_BIN; PATH is not searched');
  }
  const path = resolve(named);
  let real: string;
  try {
    real = realpathSync(path);
    accessSync(real, constants.X_OK);
  } catch {
    throw new Refusal(`${path} is not an executable kimi`);
  }
  return { named: path, real };
}

// ---------------------------------------------------------------- scenarios

interface Scenario {
  readonly name: string;
  /** TOML text appended to the source config; undefined for none. */
  readonly permission: string | undefined;
  readonly hooks: 'none' | 'valid' | 'invalid';
  readonly toolCall: boolean;
  readonly preload: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'control', permission: undefined, hooks: 'valid', toolCall: true, preload: false },
  {
    name: 'deny',
    permission: '[[permission.rules]]\ndecision = "deny"\npattern = "Bash"\nreason = "probe"',
    hooks: 'none',
    toolCall: true,
    preload: false,
  },
  { name: 'deny-string', permission: '[permission]\ndeny = ["Bash"]', hooks: 'none', toolCall: true, preload: false },
  { name: 'invalid-hook', permission: undefined, hooks: 'invalid', toolCall: true, preload: false },
  { name: 'preload', permission: undefined, hooks: 'none', toolCall: false, preload: true },
];

function sourceConfig(port: number, scenario: Scenario, hookMarker: string): string {
  const hook = `[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ${JSON.stringify(`touch ${shellQuote(hookMarker)}`)}\n`;
  const invalidHook = '\n[[hooks]]\nevent = "NotAnEvent"\ncommand = "true"\n';
  return [
    `default_model = "probe/model"`,
    '',
    '[providers.probe]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${port}/s/${scenario.name}/v1"`,
    'api_key = "probe-dummy-not-a-secret"',
    '',
    '[models."probe/model"]',
    'provider = "probe"',
    `model = "${MODEL}"`,
    'protocol = "openai"',
    'max_context_size = 131072',
    'capabilities = ["thinking"]',
    'support_efforts = ["low", "high"]',
    '',
    '[thinking]',
    'enabled = true',
    `effort = "${EFFORT}"`,
    '',
    ...(scenario.permission === undefined ? [] : [scenario.permission, '']),
    scenario.hooks === 'none' ? '' : hook + (scenario.hooks === 'invalid' ? invalidHook : ''),
  ].join('\n');
}

/** JSON paths in `value` whose value is exactly `wanted`. */
function pathsTo(value: unknown, wanted: string, path = '$'): string[] {
  if (value === wanted) return [path];
  if (Array.isArray(value)) return value.flatMap((item: unknown, index) => pathsTo(item, wanted, `${path}[${index}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => pathsTo(item, wanted, `${path}.${key}`));
  return [];
}

/** Subdirectory names of `dir`; empty when it is missing or not a directory. */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function wireJournals(home: string): number {
  const sessions = join(home, 'sessions');
  let count = 0;
  for (const bucket of subdirectories(sessions)) {
    for (const session of subdirectories(join(sessions, bucket))) {
      if (existsSync(join(sessions, bucket, session, 'agents', 'main', 'wire.jsonl'))) count += 1;
    }
  }
  return count;
}

/** Config sections kimi announced it dropped as invalid. */
function droppedSections(stderr: string): string[] {
  return [...stderr.matchAll(/Ignored invalid config section '([^']+)'/g)].map((match) => match[1] ?? '');
}

interface Observation {
  readonly scenario: string;
  readonly run: Omit<Owned, 'stdout' | 'stderr'>;
  /** The run finished on its own with exit 0. */
  readonly completed: boolean;
  readonly chatRequests: number;
  readonly bashOffered: boolean;
  readonly scriptedCallSent: boolean;
  readonly toolResults: readonly string[];
  readonly canaryCreated: boolean;
  readonly hookFired: boolean;
  readonly droppedSections: readonly string[];
  readonly effortPaths: readonly string[];
  readonly resumedWithPrompt: boolean;
  readonly primerCarriedMarker: boolean;
  readonly resumedCarriedMarker: boolean;
  readonly systemVersion: string | undefined;
  readonly sessionId: string | undefined;
  readonly wireJournals: number;
  readonly sourceSessions: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

async function runScenario(
  root: string,
  port: number,
  profile: string,
  env: Record<string, string>,
  kimi: string,
  scenario: Scenario,
): Promise<Observation> {
  const dir = join(root, scenario.name);
  const source = join(dir, 'source');
  const work = join(dir, 'work');
  const home = join(dir, 'home');
  const canary = join(dir, 'canary');
  const hookMarker = join(dir, 'hook-fired');
  mkdirSync(join(source, 'credentials'), { recursive: true, mode: 0o700 });
  mkdirSync(join(source, 'oauth'), { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(source, 'config.toml'), sourceConfig(port, scenario, hookMarker), { mode: 0o600 });

  const args = ['--json', '--no-skills', '--home', home, '--src-home', source, '--cwd', work, '--kimi-bin', kimi];
  if (scenario.preload) {
    const preloadFile = join(dir, 'preload.md');
    writeFileSync(preloadFile, `${PRELOAD_MARKER}\n`);
    args.push('--preload', preloadFile);
  }
  args.push('--', PROMPT);

  scripts.set(scenario.name, { toolCall: scenario.toolCall, canary });
  const owned = await runOwned([SANDBOX_EXEC, '-p', profile, process.execPath, BARE_KIMI, ...args], env, work, RUN_DEADLINE_MS);
  // Raw output first, before anything that could fail while judging it.
  writeFileSync(join(dir, 'stdout.txt'), owned.stdout);
  writeFileSync(join(dir, 'stderr.txt'), owned.stderr);

  const chats = requests.filter((request) => request.scenario === scenario.name && request.path.endsWith('/chat/completions'));
  const firstChat = chats[0];
  const later = chats.slice(1);
  const events = parseStreamJson(owned.stdout).events;
  const { stdout, stderr, ...run } = owned;
  return {
    scenario: scenario.name,
    run,
    completed: !owned.timedOut && owned.code === 0,
    chatRequests: chats.length,
    bashOffered: chats.some((request) => offersBash(request.body)),
    scriptedCallSent: chats.some((request) => request.scriptedCall),
    toolResults: chats.flatMap((request) => toolResultsOf(request.body)),
    canaryCreated: existsSync(canary),
    hookFired: existsSync(hookMarker),
    droppedSections: droppedSections(stderr),
    effortPaths: firstChat === undefined ? [] : pathsTo(firstChat.body, EFFORT),
    resumedWithPrompt: later.some((request) => JSON.stringify(request.body).includes(PROMPT)),
    primerCarriedMarker: firstChat !== undefined && JSON.stringify(firstChat.body).includes(PRELOAD_MARKER),
    resumedCarriedMarker: later.some((request) => JSON.stringify(request.body).includes(PRELOAD_MARKER)),
    systemVersion: events.find(isMetaSystemVersion)?.version,
    sessionId: events.find(isMetaSessionResumeHint)?.session_id,
    wireJournals: wireJournals(home),
    sourceSessions: existsSync(join(source, 'sessions')),
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr.slice(-2000),
  };
}

// ---------------------------------------------------------------- findings

interface Finding {
  readonly status: string;
  readonly evidence: string;
}

const inconclusive = (evidence: string): Finding => ({ status: 'inconclusive', evidence });

/** The scripted call went out, came back answered, and the run finished. */
function callCompleted(o: Observation): string | undefined {
  if (o.run.spawnError !== undefined) return `could not start: ${o.run.spawnError}`;
  if (o.run.timedOut) return 'the run hit its deadline';
  if (!o.completed) return `the run exited ${String(o.run.code)} (signal ${String(o.run.signal)})`;
  if (o.chatRequests === 0) return 'no request reached the loopback provider';
  if (!o.scriptedCallSent) return 'the scripted Bash call was never sent';
  if (o.toolResults.length === 0) return 'no tool result came back after the scripted call';
  return undefined;
}

function judgeControl(o: Observation): Finding {
  const broken = callCompleted(o);
  if (broken !== undefined) return inconclusive(broken);
  if (o.droppedSections.length > 0) return inconclusive(`config sections dropped: ${o.droppedSections.join(', ')}`);
  if (!o.canaryCreated) return inconclusive('the scripted call was answered, but its canary is absent');
  return { status: 'held', evidence: 'the scripted Bash call was sent, ran (canary present), and its result returned' };
}

function judgeHook(control: Observation, controlHeld: boolean): Finding {
  if (!controlHeld) return inconclusive('the control did not hold');
  return control.hookFired
    ? { status: 'fired', evidence: 'the PreToolUse hook from config created its marker' }
    : { status: 'did-not-fire', evidence: 'the tool ran, but the configured PreToolUse hook left no marker' };
}

/**
 * kimi 2.1.0's refusal by a configured rule, exactly as it builds it:
 * `Tool "<name>" was denied by permission rule.` plus ` Reason: <reason>`
 * when the matching rule has one. Matching it, reason included, shows that
 * this scenario's own rule decided, and not a shell error such as
 * "Permission denied" or some other policy.
 */
function nativeRuleRefusal(reason: string | undefined): string {
  return `Tool "Bash" was denied by permission rule.${reason === undefined ? '' : ` Reason: ${reason}`}`;
}

/**
 * Judge a deny scenario. A missing call is evidence only next to a control
 * that held: without it, the same absence may just mean the probe's script
 * never engaged. `not-enforced` (the canary appeared) is positive evidence
 * and needs no control.
 */
function judgeDeny(o: Observation, controlHeld: boolean, expectDrop: boolean, reason: string | undefined): Finding {
  if (o.droppedSections.includes('permission')) {
    return expectDrop
      ? { status: 'section-dropped', evidence: 'kimi dropped the whole [permission] section as invalid' }
      : inconclusive('kimi dropped [permission] as invalid: the rule never loaded');
  }
  if (o.droppedSections.length > 0) return inconclusive(`config sections dropped: ${o.droppedSections.join(', ')}`);
  if (o.scriptedCallSent && o.canaryCreated) {
    return { status: 'not-enforced', evidence: 'the scripted call was sent and its canary was created' };
  }
  if (!controlHeld) return inconclusive('the control did not hold, so a missing call is not evidence');
  if (o.chatRequests > 0 && !o.bashOffered && o.completed) {
    return { status: 'withheld-by-omission', evidence: 'Bash was offered in the control but not to this run' };
  }
  const broken = callCompleted(o);
  if (broken !== undefined) return inconclusive(broken);
  if (o.canaryCreated) return inconclusive('the canary appeared, but not after this run\'s scripted call');
  const expected = nativeRuleRefusal(reason);
  const refusal = o.toolResults.find((result) => result.includes(expected));
  if (refusal !== undefined) {
    return { status: 'enforced', evidence: `the call did not run; kimi returned its rule refusal: ${refusal.slice(0, 300)}` };
  }
  return inconclusive(`the call did not run, but no tool result carried ${JSON.stringify(expected)}`);
}

function judgeInvalidHook(o: Observation): Finding {
  const broken = callCompleted(o);
  if (broken !== undefined) return inconclusive(broken);
  if (!o.canaryCreated) return inconclusive("this run's own scripted call did not run");
  const others = o.droppedSections.filter((section) => section !== 'hooks');
  if (others.length > 0) return inconclusive(`other config sections dropped too: ${others.join(', ')}`);
  if (o.droppedSections.includes('hooks') && !o.hookFired) {
    return { status: 'section-dropped', evidence: 'kimi dropped [[hooks]] whole; the valid hook did not fire though the tool ran' };
  }
  if (!o.droppedSections.includes('hooks') && o.hookFired) {
    return { status: 'not-dropped', evidence: 'no section warning, and the valid hook fired' };
  }
  return inconclusive(`hooks dropped=${String(o.droppedSections.includes('hooks'))}, valid hook fired=${String(o.hookFired)}`);
}

function judgePreload(o: Observation): Finding {
  if (o.run.timedOut || !o.completed) return inconclusive(`the run did not finish cleanly (exit ${String(o.run.code)})`);
  if (o.droppedSections.length > 0) return inconclusive(`config sections dropped: ${o.droppedSections.join(', ')}`);
  if (o.primerCarriedMarker) return inconclusive('the primer request already carried the marker');
  if (!o.resumedWithPrompt) return inconclusive('no resumed request carrying the call to action was seen');
  return o.resumedCarriedMarker
    ? { status: 'reached-model', evidence: 'the resumed request carried the preloaded text' }
    : { status: 'not-seen', evidence: 'the resumed request happened, without the preloaded text' };
}

function findings(observations: readonly Observation[]): Record<string, Finding> {
  const by = (name: string): Observation | undefined => observations.find((o) => o.scenario === name);
  const out: Record<string, Finding> = {};
  const control = by('control');
  const controlFinding = control === undefined ? inconclusive('not run') : judgeControl(control);
  const controlHeld = controlFinding.status === 'held';
  out['control'] = controlFinding;
  if (control !== undefined) out['hook'] = judgeHook(control, controlHeld);
  const deny = by('deny');
  if (deny !== undefined) out['deny-rule'] = judgeDeny(deny, controlHeld, false, 'probe');
  const denyString = by('deny-string');
  if (denyString !== undefined) out['deny-string-rule'] = judgeDeny(denyString, controlHeld, true, undefined);
  const invalid = by('invalid-hook');
  if (invalid !== undefined) out['invalid-hook'] = judgeInvalidHook(invalid);
  const preload = by('preload');
  if (preload !== undefined) out['preload'] = judgePreload(preload);
  out['thinking'] =
    control === undefined || control.chatRequests === 0
      ? inconclusive('no control request to inspect')
      : control.effortPaths.length > 0
        ? { status: 'sent', evidence: `"${EFFORT}" sent at ${control.effortPaths.join(', ')}` }
        : { status: 'not-seen', evidence: `"${EFFORT}" not in the control's first request` };
  out['source-homes'] = observations.every((o) => !o.sourceSessions)
    ? { status: 'untouched', evidence: 'no sessions written to any source home' }
    : { status: 'written', evidence: 'sessions appeared in a source home' };
  out['process-groups'] = observations.every((o) => !o.run.groupRemained)
    ? { status: 'ended', evidence: 'every run group was gone afterwards' }
    : { status: 'remained', evidence: 'a run group still had processes after SIGKILL' };
  return out;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { 'kimi-bin': { type: 'string' } },
    strict: true,
  });

  if (process.platform !== 'darwin') throw new Refusal('loopback isolation is implemented for macOS sandbox-exec only');
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
  } catch {
    throw new Refusal(`${SANDBOX_EXEC} is not available`);
  }
  const kimi = resolveKimi(values['kimi-bin']);

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bare-kimi-probe-')));
  created.push(root);
  for (const sub of ['home', 'tmp', 'cache']) mkdirSync(join(root, sub));
  assertNoAmbientInstructions(root);
  const decoyHome = makeDecoyHome();
  created.push(decoyHome.dir);
  const deniedReads = [...nativeHomes(root), decoyHome.dir];
  releaseGroupsOnExit();

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
  const decoy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('decoy') });
  try {
    const port = server.port;
    const decoyPort = decoy.port;
    if (port === undefined || decoyPort === undefined) throw new Refusal('a loopback listener has no port');
    const profile = sandboxProfile(root, port, deniedReads);
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      XDG_CACHE_HOME: join(root, 'cache'),
      LANG: 'C.UTF-8',
      KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
      KIMI_DISABLE_TELEMETRY: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    };

    const preflight = await runOwned(
      [SANDBOX_EXEC, '-p', profile, process.execPath, '-e', PREFLIGHT],
      {
        ...env,
        PROBE_PORT: String(port),
        PROBE_DECOY_PORT: String(decoyPort),
        PROBE_OUTSIDE: join(tmpdir(), `bare-kimi-probe-escape-${process.pid}`),
        PROBE_DECOY_FILE: decoyHome.file,
      },
      root,
      PREFLIGHT_DEADLINE_MS,
    );
    writeFileSync(join(root, 'preflight.stdout.txt'), preflight.stdout);
    writeFileSync(join(root, 'preflight.stderr.txt'), preflight.stderr);
    if (preflight.groupNotOwned) throw new Refusal('the probe cannot own a process group for its children');
    let isolation: unknown;
    try {
      isolation = JSON.parse(preflight.stdout);
    } catch {
      isolation = undefined;
    }
    if (
      preflight.timedOut ||
      !isRecord(isolation) ||
      isolation['provider'] !== true ||
      !DENIED.has(String(isolation['otherLoopback'])) ||
      !DENIED.has(String(isolation['egress'])) ||
      !DENIED.has(String(isolation['write'])) ||
      !DENIED.has(String(isolation['decoyRead']))
    ) {
      throw new Refusal(
        `sandbox preflight did not prove isolation (no native launch): ${preflight.stdout.trim() || preflight.stderr.trim()}`,
      );
    }

    const observations: Observation[] = [];
    let stoppedAfter: string | undefined;
    for (const scenario of SCENARIOS) {
      const observation = await runScenario(root, port, profile, env, kimi.real, scenario);
      observations.push(observation);
      // A group that outlived SIGKILL could still talk to the provider: run nothing more.
      if (observation.run.groupRemained) {
        stoppedAfter = scenario.name;
        break;
      }
    }
    const report = {
      kimi,
      root,
      decoyHome: decoyHome.dir,
      isolation: { preflight: isolation, deniedReads, providerPort: port },
      stoppedAfter,
      findings: findings(observations),
      observations,
      requests,
    };
    writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({ root, decoyHome: decoyHome.dir, report: join(root, 'report.json'), findings: report.findings }, null, 2),
    );
    return report.findings['control']?.status === 'held' ? 0 : 1;
  } finally {
    server.stop(true);
    decoy.stop(true);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`native-loopback: ${error instanceof Refusal ? 'refused' : 'failed'}: ${message}`);
  const root = created[0];
  if (root !== undefined) {
    try {
      // Raw per-scenario and preflight output is already on disk; keep the request log too.
      writeFileSync(join(root, 'requests.json'), `${JSON.stringify(requests, null, 2)}\n`);
    } catch {
      // the paths below still say where everything else is
    }
  }
  if (created.length > 0) console.error(`native-loopback: left for inspection: ${created.join(', ')}`);
  process.exitCode = error instanceof Refusal ? 2 : 1;
}
