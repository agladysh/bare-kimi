/**
 * Isolation shared by the optional native probes (probe/native-loopback.ts
 * and probe/model-effort-loopback.ts): the macOS `sandbox-exec` profile, the
 * preflight script that checks it, the judgement of the three preflight runs
 * (unsandboxed, sandboxed, unsandboxed), and kimi's warning for a dropped
 * config section. Nothing here spawns a process or touches the filesystem;
 * the preflight script runs only where a probe runs it.
 *
 * What differs between the probes is passed in, not assumed. Both deny
 * outbound network except the provider port, writes outside the probe root,
 * and reads of named paths. model-effort-loopback.ts also denies executing
 * {@link DELEGATION_EXEC} and looking up {@link DELEGATION_MACH}, and has the
 * preflight show the exec denial; native-loopback.ts passes neither, so its
 * profile and preflight are as before.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ProfileOptions {
  /** The only tree the sandboxed process may write. */
  readonly root: string;
  /** The only loopback port it may connect to. */
  readonly port: number;
  /** Trees it may not read. */
  readonly deniedReads: readonly string[];
  /** Executables it may not start. */
  readonly deniedExec?: readonly string[];
  /** Mach services it may not look up. */
  readonly deniedMach?: readonly string[];
}

export function sandboxProfile(options: ProfileOptions): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    `(allow network-outbound (remote ip "localhost:${options.port}"))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(options.root)})`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...options.deniedReads.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
  ];
  const exec = options.deniedExec ?? [];
  if (exec.length > 0) lines.push(`(deny process-exec ${exec.map((path) => `(literal ${JSON.stringify(path)})`).join(' ')})`);
  const mach = options.deniedMach ?? [];
  if (mach.length > 0) lines.push(`(deny mach-lookup ${mach.map((name) => `(global-name ${JSON.stringify(name)})`).join(' ')})`);
  return lines.join('\n');
}

/** An executable to deny, and the arguments the sandboxed preflight tries it with. */
export interface ExecProbe {
  readonly path: string;
  /** Harmless if the denial failed and the program ran: usage text, help, an empty script. */
  readonly args: readonly string[];
}

/**
 * Programs that hand work to services outside the sandbox: `open`
 * (LaunchServices, e.g. a browser for a login), `security` (keychain) and
 * `osascript` (Apple events).
 */
export const DELEGATION_EXEC: readonly ExecProbe[] = [
  { path: '/usr/bin/open', args: [] },
  { path: '/usr/bin/security', args: ['help'] },
  { path: '/usr/bin/osascript', args: ['-e', 'return'] },
];

/** The LaunchServices and SecurityServer Mach services. Denied in the profile; the preflight does not show it. */
export const DELEGATION_MACH: readonly string[] = ['com.apple.coreservices.launchservicesd', 'com.apple.SecurityServer'];

/** Started in every preflight run, so a denied exec is told apart from exec failing altogether. */
export const EXEC_CONTROL = '/usr/bin/true';

/**
 * The isolation check, run three times with the same environment: it
 * reports, for the provider port and a live decoy listener on another
 * loopback port, the outcome of the same raw TCP connect; whether it could
 * write `PROBE_WRITE_TARGET` (outside the root) and read `PROBE_DECOY_FILE`
 * (a denied path). Only the sandboxed run also tries TEST-NET-1 (RFC 5737,
 * never routed). An unsandboxed run never connects off the host.
 *
 * With `PROBE_EXEC_TARGETS` (a JSON list of {@link ExecProbe}) and
 * `PROBE_EXEC_CONTROL`, every run also starts the control executable; the
 * unsandboxed runs only check that each target exists and is executable,
 * and never start it; the sandboxed run tries to start each target.
 */
export const PREFLIGHT = `
const { connect } = await import('node:net');
const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
const attempt = (host, port) => new Promise((done) => {
  const started = Date.now();
  const finish = (result) => done({ result, ms: Date.now() - started });
  const socket = connect({ host, port });
  const timer = setTimeout(() => { socket.destroy(); finish('timeout'); }, 3000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); finish('connected'); });
  socket.on('error', (error) => { clearTimeout(timer); finish(error.code ?? String(error)); });
});
const sandboxed = process.env.PROBE_MODE === 'sandboxed';
const out = { mode: process.env.PROBE_MODE };
try {
  const response = await fetch('http://127.0.0.1:' + process.env.PROBE_PORT + '/health');
  out.provider = (await response.text()) === 'ok';
} catch (error) {
  out.provider = false;
  out.providerError = String(error);
}
out.providerTcp = await attempt('127.0.0.1', Number(process.env.PROBE_PORT));
out.otherLoopback = await attempt('127.0.0.1', Number(process.env.PROBE_DECOY_PORT));
if (sandboxed) out.egress = await attempt('192.0.2.1', 80);
try {
  writeFileSync(process.env.PROBE_WRITE_TARGET, 'x');
  rmSync(process.env.PROBE_WRITE_TARGET, { force: true });
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
const execTargets = process.env.PROBE_EXEC_TARGETS === undefined ? [] : JSON.parse(process.env.PROBE_EXEC_TARGETS);
if (execTargets.length > 0) {
  const { spawnSync } = await import('node:child_process');
  const { accessSync, constants } = await import('node:fs');
  const run = (path, args) => {
    const result = spawnSync(path, args, { stdio: 'ignore', timeout: 5000 });
    return result.error ? (result.error.code ?? String(result.error)) : 'ran:' + String(result.status);
  };
  out.execControl = run(process.env.PROBE_EXEC_CONTROL, []);
  out.execTargets = {};
  for (const target of execTargets) {
    if (sandboxed) {
      out.execTargets[target.path] = run(target.path, target.args);
    } else {
      try {
        accessSync(target.path, constants.X_OK);
        out.execTargets[target.path] = 'executable';
      } catch (error) {
        out.execTargets[target.path] = error.code ?? String(error);
      }
    }
  }
}
console.log(JSON.stringify(out));
`;

export const DENIED: ReadonlySet<string> = new Set(['EPERM', 'EACCES']);

function connectResult(report: Json, key: string): string | undefined {
  const value = report[key];
  return isRecord(value) && typeof value['result'] === 'string' ? value['result'] : undefined;
}

function execResult(report: Json, path: string): string | undefined {
  const targets = report['execTargets'];
  return isRecord(targets) && typeof targets[path] === 'string' ? targets[path] : undefined;
}

export interface IsolationOptions {
  /** Executables the sandbox must be shown to deny (empty: no exec check). */
  readonly execTargets?: readonly string[];
}

export interface IsolationVerdict {
  /** Why isolation is not shown; empty when it is. */
  readonly failures: readonly string[];
  /** How the sandbox refused the live decoy listener, when it did. */
  readonly networkDenial: string | undefined;
  /** `errno` when that code is a permission error; `contrast` when only the paired controls make it one. */
  readonly networkDenialBasis: 'errno' | 'contrast' | undefined;
  /** What each exec target gave in the sandbox; undefined without an exec check. */
  readonly execDenial: Readonly<Record<string, string>> | undefined;
}

/**
 * Judge the three preflight reports.
 *
 * The unsandboxed controls, before and after, must reach both loopback
 * listeners, write in the separate write-check directory and read the decoy
 * file. Otherwise the harness itself is broken and no sandboxed failure can
 * be attributed to the sandbox.
 *
 * Sandboxed, the provider must answer over HTTP and over the same raw
 * connect, and the write and the read must fail with EPERM or EACCES. The
 * live decoy listener must fail to connect: with EPERM or EACCES (a sandbox
 * denial by its error code), or with ECONNREFUSED only through the contrast
 * (the same listener accepted the same connect unsandboxed just before and
 * after, and the allowed port connected from inside the sandbox). TEST-NET-1
 * must fail with EPERM/EACCES, or with the very code the decoy got.
 *
 * With exec targets: every run must start the control executable (exit 0);
 * the controls must find each target executable; sandboxed, each target
 * must fail to start with EPERM or EACCES.
 */
export function judgeIsolation(before: unknown, sandboxed: unknown, after: unknown, options: IsolationOptions = {}): IsolationVerdict {
  const targets = options.execTargets ?? [];
  const failures: string[] = [];
  for (const [label, control] of [
    ['control before', before],
    ['control after', after],
  ] as const) {
    if (!isRecord(control)) {
      failures.push(`${label}: no report`);
      continue;
    }
    if (control['provider'] !== true) failures.push(`${label}: provider did not answer`);
    if (connectResult(control, 'providerTcp') !== 'connected') failures.push(`${label}: provider port did not connect`);
    if (connectResult(control, 'otherLoopback') !== 'connected') failures.push(`${label}: decoy listener did not connect`);
    if (control['write'] !== 'allowed') failures.push(`${label}: could not write in the write-check directory`);
    if (control['decoyRead'] !== 'allowed') failures.push(`${label}: could not read the decoy file`);
    if (targets.length > 0) {
      if (control['execControl'] !== 'ran:0') failures.push(`${label}: the exec control gave ${String(control['execControl'])}`);
      for (const path of targets) {
        const result = execResult(control, path);
        if (result !== 'executable') failures.push(`${label}: ${path} is not an executable to deny (${String(result)})`);
      }
    }
  }
  if (!isRecord(sandboxed)) {
    return { failures: [...failures, 'sandboxed: no report'], networkDenial: undefined, networkDenialBasis: undefined, execDenial: undefined };
  }
  if (sandboxed['provider'] !== true) failures.push('sandboxed: provider did not answer');
  if (connectResult(sandboxed, 'providerTcp') !== 'connected') failures.push('sandboxed: provider port did not connect');
  if (!DENIED.has(String(sandboxed['write']))) failures.push(`sandboxed: write outside the root gave ${String(sandboxed['write'])}`);
  if (!DENIED.has(String(sandboxed['decoyRead']))) failures.push(`sandboxed: decoy read gave ${String(sandboxed['decoyRead'])}`);
  let execDenial: Record<string, string> | undefined;
  if (targets.length > 0) {
    execDenial = {};
    if (sandboxed['execControl'] !== 'ran:0') {
      failures.push(`sandboxed: the exec control gave ${String(sandboxed['execControl'])}, so a denied exec would not be specific`);
    }
    for (const path of targets) {
      const result = execResult(sandboxed, path);
      execDenial[path] = String(result);
      if (result === undefined || !DENIED.has(result)) failures.push(`sandboxed: starting ${path} gave ${String(result)}, not a denial`);
    }
  }
  const controlsHeld = failures.length === 0;
  const decoy = connectResult(sandboxed, 'otherLoopback');
  let networkDenial: string | undefined;
  let networkDenialBasis: 'errno' | 'contrast' | undefined;
  if (decoy !== undefined && DENIED.has(decoy)) {
    networkDenial = decoy;
    networkDenialBasis = 'errno';
  } else if (decoy === 'ECONNREFUSED' && controlsHeld) {
    networkDenial = decoy;
    networkDenialBasis = 'contrast';
  } else {
    failures.push(`sandboxed: decoy listener gave ${String(decoy)}, not shown to be a sandbox denial`);
  }
  const egress = connectResult(sandboxed, 'egress');
  if (egress === undefined || !(DENIED.has(egress) || (networkDenial !== undefined && egress === networkDenial))) {
    failures.push(`sandboxed: TEST-NET-1 gave ${String(egress)}, not the sandbox's shown denial`);
  }
  return { failures, networkDenial, networkDenialBasis, execDenial };
}

/** Config sections kimi announced it dropped as invalid. */
export function droppedSections(output: string): string[] {
  return [...output.matchAll(/Ignored invalid config section '([^']+)'/g)].map((match) => match[1] ?? '');
}
