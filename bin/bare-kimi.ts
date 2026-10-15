#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import {
  exitCodeOf,
  KimiSpawnError,
  makeEphemeralHome,
  spawnKimi,
  type LaunchOptions,
  type OutputFormat,
} from '../src/index.ts';
import {
  PrimerNoSessionError,
  readPreloadItem,
  runPreloaded,
} from '../src/preload.ts';

const USAGE = `Usage: bare-kimi [options] -- "call to action"
       bare-kimi [options]            # prompt from stdin when piped

Runs kimi -p (Kimi Code CLI) against an isolated KIMI_CODE_HOME on the
operator's own login. Library first; this CLI is its worked example.

Home and auth:
  --home DIR            Use DIR as the run home (kept). Reused as-is when it
                        already holds a config.toml; otherwise assembled from
                        the source home.
  --src-home DIR        Assemble/donate from DIR (default:
                        $KIMI_CODE_HOME_SOURCE ?? ~/.kimi-code). Forces
                        re-assembly of --home.
  --auth link|copy      How the run home receives credentials. Default link:
                        credentials/ and oauth/ are directory symlinks into
                        the source home — no token replication, refresh and
                        its cross-process lock stay shared. copy duplicates
                        token files and forks the refresh lineage.
  --keep-credentials    Copy mode: keep the donated copy after the run.
  --keep-home           Keep even an ephemeral (mkdtemp'd) home.

Run shape:
  --cwd DIR             Working directory (default: current). A resume must
                        happen in the session's own cwd — kimi refuses
                        cross-cwd resume.
  -m, --model ALIAS     Model alias (default: the assembled default_model).
  --resume ID           Resume a session.
  --continue            Resume the most recent session for this cwd.
  --json                stream-json on stdout (NDJSON events).
  --output-format FMT   text | stream-json (same as native kimi).
  --skills-dir DIR      Load skills only from DIR (repeatable; REPLACES
                        native user/project skill discovery).
  --no-skills           Load no file-based skills (empty --skills-dir).
  --add-dir DIR         Additional workspace directory (repeatable).
  --kimi-bin PATH       kimi binary (default: $KIMI_BIN ?? kimi on PATH).
  --kimi-arg ARG        Forward ARG verbatim to kimi (repeatable).
  --no-process-env      Do not inherit the parent environment.
  --preload FILE        Give the run FILE's contents as synthetic past
                        (repeatable; see README — costs input tokens on
                        every resumed turn, it is not free).
  --prime TEXT          Primer prompt for --preload (default "Acknowledged.").
  -v, --version         Print bare-kimi version.
  -h, --help            This text.

Ambient boundary (measured, not a bug): AGENTS.md files (run home,
~/.agents, git-root → cwd walk) and skills still load in print mode. For a
fully bare run use a cwd with no AGENTS.md up its git root.

Permissions: -p forces kimi's native auto permission mode; -y/--yolo,
--auto and --plan conflict with -p and cannot be used. bare-kimi passes no
permission flags and never weakens configured policy.

Exit codes: the child's exit code (128+N on signal); 127 when kimi cannot
be spawned; 2 for bare-kimi usage/setup errors; 3 when a primer run
produced no session id.`;

interface Cli {
  options: LaunchOptions;
  json: boolean;
  keepHome: boolean;
  prime: string | undefined;
  preload: string[];
  help: boolean;
  version: boolean;
}

function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean', default: false },
      'output-format': { type: 'string' },
      home: { type: 'string' },
      'src-home': { type: 'string' },
      auth: { type: 'string', default: 'link' },
      'keep-credentials': { type: 'boolean', default: false },
      'keep-home': { type: 'boolean', default: false },
      cwd: { type: 'string' },
      model: { type: 'string', short: 'm' },
      resume: { type: 'string' },
      continue: { type: 'boolean', default: false },
      'skills-dir': { type: 'string', multiple: true, default: [] },
      'no-skills': { type: 'boolean', default: false },
      'add-dir': { type: 'string', multiple: true, default: [] },
      'kimi-bin': { type: 'string' },
      'kimi-arg': { type: 'string', multiple: true, default: [] },
      'no-process-env': { type: 'boolean', default: false },
      preload: { type: 'string', multiple: true, default: [] },
      prime: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  const auth = values.auth;
  if (auth !== 'link' && auth !== 'copy') {
    throw new Error(`--auth must be link or copy, got ${JSON.stringify(auth)}`);
  }
  let outputFormat: OutputFormat = values.json ? 'stream-json' : 'text';
  if (values['output-format'] !== undefined) {
    const fmt = values['output-format'];
    if (fmt !== 'text' && fmt !== 'stream-json') {
      throw new Error(`--output-format must be text or stream-json, got ${JSON.stringify(fmt)}`);
    }
    outputFormat = fmt;
  }

  return {
    options: {
      prompt: positionals.join(' '),
      cwd: values.cwd,
      home: values.home,
      srcHome: values['src-home'],
      authMode: auth,
      keepCredentials: values['keep-credentials'],
      model: values.model,
      resume: values.resume,
      continueRecent: values.continue,
      outputFormat,
      skillsDir: values['skills-dir'],
      noSkills: values['no-skills'],
      addDir: values['add-dir'],
      kimiBin: values['kimi-bin'],
      noProcessEnv: values['no-process-env'],
      extraArgs: values['kimi-arg'],
    },
    json: values.json,
    keepHome: values['keep-home'],
    prime: values.prime,
    preload: values.preload,
    help: values.help,
    version: values.version,
  };
}

async function packageVersion(): Promise<string> {
  const text = await Bun.file(new URL('../package.json', import.meta.url)).text();
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>)['version'] === 'string'
  ) {
    return (parsed as Record<string, string>)['version']!;
  }
  return '0.0.0';
}

async function readStdinPrompt(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const text = await new Response(process.stdin).text();
  return text.trim();
}

async function main(): Promise<number> {
  let cli: Cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }
  if (cli.help) {
    console.error(USAGE);
    return 0;
  }
  if (cli.version) {
    console.log(await packageVersion());
    return 0;
  }

  let options: LaunchOptions = { ...cli.options };
  if (options.prompt.length === 0) {
    options = { ...options, prompt: await readStdinPrompt() };
  }
  if (options.prompt.length === 0) {
    console.error('bare-kimi: no prompt (pass one after -- or pipe it on stdin)');
    console.error(USAGE);
    return 2;
  }

  // --keep-home: make the ephemeral home caller-supplied so the SDK keeps it.
  if (cli.keepHome && options.home === undefined) {
    options = { ...options, home: makeEphemeralHome() };
  }

  if (cli.preload.length > 0) {
    let items;
    try {
      items = cli.preload.map(readPreloadItem);
    } catch (error) {
      console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    try {
      const run = await runPreloaded(options, items, cli.prime);
      process.stdout.write(run.stdout);
      process.stderr.write(run.stderr);
      report(run.code, run.home, options);
      return run.code;
    } catch (error) {
      if (error instanceof PrimerNoSessionError) {
        process.stderr.write(error.primer.stderr);
        console.error('bare-kimi: primer run produced no session id');
        return 3;
      }
      console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  let launched;
  try {
    launched = spawnKimi(options, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  } catch (error) {
    console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof KimiSpawnError ? 127 : 2;
  }
  const { subprocess, dispose } = launched;
  const forward = (signal: NodeJS.Signals): void => {
    subprocess.kill(signal);
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    await subprocess.exited;
    const { code } = exitCodeOf(subprocess);
    report(code, launched.home, options);
    return code;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await dispose();
  }
}

function report(code: number, home: string, options: LaunchOptions): void {
  if (code !== 0) {
    console.error(`bare-kimi: kimi exited ${code}`);
  }
  if (options.home !== undefined) {
    console.error(`bare-kimi: home kept at ${home}`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
