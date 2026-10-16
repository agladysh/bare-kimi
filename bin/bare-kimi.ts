#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ADOPTION_RECORD,
  checkLaunchOptions,
  EPHEMERAL_MARKER,
  exitCodeOf,
  KimiCustodyError,
  KimiSpawnError,
  makeEphemeralHome,
  removeHome,
  spawnKimi,
  type AssembledHome,
  type LaunchOptions,
  type MigrationBasis,
  type OutputFormat,
} from '../src/index.ts';
import {
  checkPreloadOptions,
  PrimerNoSessionError,
  readPreloadItem,
  runPreloaded,
} from '../src/preload.ts';

const USAGE = `Usage: bare-kimi [options] -- "call to action"
       bare-kimi [options]            # prompt from stdin when piped

Runs kimi -p (Kimi Code CLI) against an isolated KIMI_CODE_HOME on the
operator's own login. Library first; this CLI is its worked example.

Home and auth:
  --home DIR            Use DIR as the run home (kept). DIR must be missing,
                        empty, or a home bare-kimi assembled from the same
                        source (it carries .bare-kimi-home); anything else
                        is refused, even with a config.toml in it (but see
                        --adopt-legacy-home). An existing DIR keeps its
                        permissions. Its config.toml follows the source:
                        kept as is (comments too) while the settings agree,
                        rewritten when the source changed, refused when
                        edited to something else. Refused when it is,
                        contains or lies inside the source home.
  --adopt-legacy-home   Adopt --home DIR when it is a home kept by bare-kimi
                        before 0.2 (no .bare-kimi-home), and only when its
                        config.toml, its credentials (links into the source,
                        or a bare-kimi copy) and its sessions/ show it was
                        assembled from the source. Its sessions are not
                        changed; its original config.toml and a manifest of
                        its session files are kept in .bare-kimi-adopted/.
                        Its config.toml is then rewritten from the source,
                        so the source's [permission] and [[hooks]] apply.
  --src-home DIR        Assemble/donate from DIR (default:
                        $KIMI_CODE_HOME_SOURCE, else the source a kept --home
                        was assembled from, else ~/.kimi-code, refused when
                        KIMI_CODE_HOME names another home). Also re-donates
                        credentials in full.
                        Relative --home/--src-home resolve against the
                        current directory, not --cwd.
  --auth link|copy      How the run home receives credentials. Default link:
                        credentials/ and oauth/ are directory symlinks into
                        the source home — no token replication, refresh and
                        its cross-process lock stay shared. copy duplicates
                        token files and forks the refresh lineage. Existing
                        entries that bare-kimi did not make (including
                        symlinks into another home) are never replaced.
  --keep-credentials    Copy mode: keep the donated copy after the run. A
                        copy changed since it was copied (a refresh may
                        have left the only current token in it) is always
                        kept, and the run exits 4.
  --keep-home           Keep even an ephemeral (mkdtemp'd) home.

Model and effort:
  -m, --model ALIAS     Model alias the run home carries (default: the
                        source's default_model); it must be configured in
                        the source. Only it and its provider are carried,
                        never the source's other models or providers. A
                        kept --home is pinned to its model: it stays on it
                        when the source's default changes, and refuses
                        another, since kimi binds each session to the
                        alias it was created with. A home kept by 0.2 or
                        adopted is pinned to the alias its config.toml
                        named then; sessions it created under an earlier
                        alias are not covered.
  --effort EFFORT       Thinking effort for sessions the run home creates:
                        one of the model's support_efforts, or off. Written
                        into the run home's [thinking] and pinned like the
                        model. Checked before any effect against the source
                        config's table for the model, which is what kimi
                        2.1.0 -p reads (kimi's login and interactive
                        refresh write a managed model's support_efforts
                        there from the provider's catalog). Refused: an
                        effort the model does not list; on a kimi-type
                        provider, any effort but off for a model listing
                        no support_efforts (kimi then sends no level); off
                        for a model listing support_efforts without
                        off_effort, except on a kimi-type provider, or
                        listing the capability always_thinking. Some of
                        these refusals rest on observed kimi behaviour,
                        others are library policy (see src/home.ts). On
                        another provider type, an effort for a model
                        listing no support_efforts is taken unchecked and
                        a notice says so; kimi decides at run time. With
                        --preload no notice is printed. A resumed session
                        keeps the effort it was created with. When the
                        source's table for a kept home's model stops
                        accepting its pinned effort (a login may rewrite a
                        managed model's support_efforts), only --resume ID
                        still runs there; the routing line reports the
                        effort as withdrawn.
  Every run prints one "routed to model" line on stderr: the alias, its
  provider type and model id, the effort pinned or configured for new
  sessions and its support, and where each came from (selected, the
  source's default, pinned, adopted, or how a bare-kimi 0.2 home's alias was
  established when its stamp was upgraded).

Run shape:
  --cwd DIR             Working directory (default: current). A resume must
                        happen in the session's own cwd — kimi refuses
                        cross-cwd resume.
  --resume ID           Resume a session.
  --continue            Resume the most recent session for this cwd.
  --json                stream-json on stdout (NDJSON events).
  --output-format FMT   text | stream-json (same as native kimi).
  --skills-dir DIR      Load skills only from DIR (repeatable; REPLACES
                        native user/project skill discovery).
  --no-skills           Load no file-based skills (empty --skills-dir).
  --add-dir DIR         Additional workspace directory (repeatable).
  --kimi-bin PATH       kimi binary (default: $KIMI_BIN ?? kimi on PATH).
                        A relative PATH resolves against the current
                        directory.
  --kimi-arg ARG        Forward ARG verbatim to kimi (repeatable), after
                        bare-kimi's own flags and before its -p. Refused
                        when kimi would read it as selecting a model or a
                        session (-m, --model, -S, --session, -r, --resume,
                        -c, --continue, -C), as setting the output format
                        or the prompt (--output-format, -p, --prompt), in
                        any spelling (-mX, --model=X, a cluster such as
                        -yc), or when it is --: use -m, --resume,
                        --continue, --output-format and the prompt itself.
                        The last ARG may not be a flag still waiting for
                        its value (--add-dir, --skills-dir, --agent,
                        --agent-file): kimi would take bare-kimi's -p.
                        --skills-dir, --add-dir and --kimi-arg go to kimi
                        verbatim; kimi resolves relative paths in --cwd.
  --no-process-env      Do not inherit the parent environment.
  --preload FILE        Give the run FILE's contents as synthetic past
                        (repeatable; see README — costs input tokens on
                        every resumed turn, it is not free).
  --prime TEXT          Primer prompt for --preload (default "Acknowledged.").
                        --preload always starts a fresh session, so it
                        cannot be combined with --resume or --continue.
  -v, --version         Print bare-kimi version.
  -h, --help            This text.

The prompt (and --prime) may not start with "-": kimi could read it as a
flag. Every option check happens before any home is made or kimi starts.

Ambient boundary (measured, not a bug): AGENTS.md files (run home,
~/.agents, git-root → cwd walk) and skills still load in print mode. For a
fully bare run use a cwd with no AGENTS.md up its git root.

Environment: the child inherits this environment (unless --no-process-env)
minus KIMI_CODE_BASE_URL, KIMI_CODE_OAUTH_HOST, KIMI_OAUTH_HOST,
KIMI_DISABLE_OAUTH_LOCK, every KIMI_MODEL_* variable (including the
thinking-effort overrides; use --effort), every KIMI_SECONDARY_* variable
(subagent model and effort overrides) and any KIMI_CODE_HOME. bare-kimi
then sets KIMI_CODE_HOME to the run home and KIMI_CODE_HOME_SOURCE to the
source home, and KIMI_DISABLE_TELEMETRY=1 and KIMI_CODE_NO_AUTO_UPDATE=1
unless already set. A dropped variable cannot be restored from the CLI (the
library's extraEnv can, except KIMI_CODE_HOME; an env-model variable, any
KIMI_MODEL_* but KIMI_MODEL_THINKING_EFFORT, KIMI_MODEL_THINKING_KEEP and
KIMI_MODEL_OUTPUT_FORMAT, only on an ephemeral run without a model or
effort). bare-kimi always passes --output-format, which kimi takes over
KIMI_MODEL_OUTPUT_FORMAT.

Permissions: -p forces kimi's native auto permission mode; -y/--yolo,
--auto and --plan conflict with -p and cannot be used. bare-kimi passes no
permission flags. A run home carries the source config's [permission] and
[[hooks]] tables verbatim, with no rule added, removed or reinterpreted.
That is all bare-kimi promises, and it is not protection: in a native test
of kimi 2.1.0 in -p mode, a valid deny rule for Bash was accepted without a
section-drop warning but did not stop a Bash call. To contain a run, confine
it from outside (an OS sandbox, a container, a restricted account). Hooks
are loaded and run. kimi drops a whole config section that fails its
schema, with only a warning: one invalid [[hooks]] entry disables every
hook. A source config that fails TOML parsing, or whose permission, hooks,
thinking, model or provider settings cannot be carried verbatim, is refused
before any effect.

Exit codes: the child's exit code (128+N on signal); 127 when kimi cannot
be spawned; 2 for bare-kimi usage/setup errors; 3 when a primer run
produced no session id; 4 when the run ended but cleanup kept something,
e.g. a credentials copy holding a refreshed token. A child that itself
exits 2, 3 or 4 is passed through unchanged; bare-kimi's own outcomes are
always named on stderr ("bare-kimi: ..."), which tells them apart.`;

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
      'adopt-legacy-home': { type: 'boolean', default: false },
      'src-home': { type: 'string' },
      auth: { type: 'string', default: 'link' },
      'keep-credentials': { type: 'boolean', default: false },
      'keep-home': { type: 'boolean', default: false },
      cwd: { type: 'string' },
      model: { type: 'string', short: 'm' },
      effort: { type: 'string' },
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
      adoptLegacyHome: values['adopt-legacy-home'],
      srcHome: values['src-home'],
      authMode: auth,
      keepCredentials: values['keep-credentials'],
      model: values.model,
      effort: values.effort,
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

  // The library's own checks, before this CLI makes anything (--keep-home).
  try {
    if (cli.preload.length > 0) {
      checkPreloadOptions(options, cli.prime);
    } else {
      checkLaunchOptions(options);
    }
  } catch (error) {
    console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let items;
  try {
    items = cli.preload.map(readPreloadItem);
  } catch (error) {
    console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // --keep-home: make the ephemeral home caller-supplied so the SDK keeps it.
  let madeHome: string | undefined;
  if (cli.keepHome && options.home === undefined) {
    madeHome = makeEphemeralHome();
    options = { ...options, home: madeHome };
  }

  if (items.length > 0) {
    try {
      const run = await runPreloaded(options, items, cli.prime);
      process.stdout.write(run.stdout);
      process.stderr.write(run.stderr);
      if (run.assembled !== undefined) console.error(describeRouting(run.assembled, options, 'preload'));
      report(run.code, run.home, options);
      return run.code;
    } catch (error) {
      if (error instanceof PrimerNoSessionError) {
        process.stderr.write(error.primer.stderr);
        console.error('bare-kimi: primer run produced no session id');
        return 3;
      }
      if (error instanceof KimiCustodyError && error.run !== undefined) {
        process.stdout.write(error.run.stdout);
        process.stderr.write(error.run.stderr);
        if (error.run.assembled !== undefined) console.error(describeRouting(error.run.assembled, options, 'preload'));
        report(error.run.code, error.run.home, options);
        return custodyKept(error);
      }
      console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
      discardUnusedHome(madeHome);
      return 2;
    }
  }

  let launched;
  try {
    launched = spawnKimi(options, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  } catch (error) {
    console.error(`bare-kimi: ${error instanceof Error ? error.message : String(error)}`);
    discardUnusedHome(madeHome);
    return error instanceof KimiSpawnError ? 127 : 2;
  }
  const { subprocess, dispose, assembled } = launched;
  if (assembled.action === 'adopt') {
    console.error(
      `bare-kimi: adopted ${assembled.home} as a run home; its original config.toml and a manifest ` +
        `of its session files are kept in ${ADOPTION_RECORD}/`,
    );
  }
  console.error(
    describeRouting(assembled, options, options.resume !== undefined || options.continueRecent === true ? 'resume' : 'new'),
  );
  if (assembled.effort !== null && assembled.effortSupport === 'undeclared') {
    console.error(
      `bare-kimi: effort "${assembled.effort}" is unchecked: the source config lists no ` +
        `support_efforts for model "${assembled.modelAlias}" (provider type ` +
        `${assembled.providerType ?? 'unset'}), so kimi decides at run time whether it is sent as given`,
    );
  }
  const forward = (signal: NodeJS.Signals): void => {
    subprocess.kill(signal);
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let code = 1; // replaced once the child has exited
  let cleanup: unknown;
  try {
    await subprocess.exited;
    code = exitCodeOf(subprocess).code;
    report(code, launched.home, options);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    cleanup = await dispose().then(
      () => undefined,
      (error: unknown) => error ?? new Error('cleanup failed'),
    );
  }
  if (cleanup instanceof KimiCustodyError) return custodyKept(cleanup);
  if (cleanup !== undefined) throw cleanup;
  return code;
}

/**
 * A --keep-home home that a refusal left holding nothing but its ephemeral
 * marker has no custody to keep; remove it rather than leak it. Anything
 * more in it (an assembled home, a run's sessions) stays, as asked.
 */
function discardUnusedHome(home: string | undefined): void {
  if (home === undefined) return;
  try {
    if (readdirSync(home).every((entry) => entry === EPHEMERAL_MARKER)) removeHome(home);
  } catch {
    // best effort: a leftover empty temp dir is harmless
  }
}

/** Where a 0.2 home's pinned alias came from when its stamp was upgraded. */
const MIGRATION_ORIGIN: Readonly<Record<MigrationBasis, string>> = {
  config: 'the alias its config.toml held, as bare-kimi 0.2 last wrote it',
  digest: "the one alias whose source config reproduces the 0.2 stamp's digest",
  caller: 'the alias the caller named; the home could not show it',
  'source-default': "the source's default_model at the upgrade",
};

/**
 * One stderr line naming what this run was routed to, from what bare-kimi
 * prepared: the model alias the run home carries and where it came from, the
 * provider type and model id, and the effort pinned or configured for new
 * sessions with its support. It names no path, credential, URL or key. A
 * resumed session keeps the effort it stored (observed in kimi 2.1.0 -p);
 * --model makes it run on the named alias, else it keeps its own. For a
 * pinned effort the source no longer accepts (`withdrawn`), it says so, and
 * that whether the resumed session keeps that effort is unknown.
 */
function describeRouting(assembled: AssembledHome, options: LaunchOptions, run: 'new' | 'resume' | 'preload'): string {
  const pinned = assembled.adopted ? 'pinned when the home was adopted' : 'pinned by the home';
  const modelOrigin =
    assembled.migrated !== null
      ? `pinned at the upgrade of a bare-kimi 0.2 home: ${MIGRATION_ORIGIN[assembled.migrated.basis]}`
      : assembled.action === 'adopt'
        ? "named by the adopted home's config.toml"
        : assembled.action === 'reuse'
          ? pinned
          : options.model !== undefined
            ? 'selected'
            : "the source's default_model";
  const provider = `provider type ${assembled.providerType ?? 'unset'}${
    assembled.modelId === undefined ? '' : `, model id ${assembled.modelId}`
  }`;
  let effort: string;
  if (assembled.effort !== null) {
    const effortOrigin =
      assembled.action === 'adopt'
        ? "named by the adopted home's [thinking]"
        : assembled.action === 'reuse'
          ? pinned
          : 'selected';
    effort =
      assembled.effortSupport === 'withdrawn'
        ? `effort "${assembled.effort}" (${effortOrigin}, withdrawn: the source's declaration for this alias no ` +
          'longer accepts it; kept only to resume a session)'
        : `effort "${assembled.effort}" (${effortOrigin}, ${assembled.effortSupport ?? 'unchecked'})`;
  } else {
    const configured =
      assembled.configuredEffort === null ? "the model's default effort" : `effort "${assembled.configuredEffort}"`;
    effort = `no effort pinned; config.toml gives new sessions ${configured} from the source's [thinking]`;
  }
  const alias = options.model === undefined ? 'the alias it stored' : 'runs on this alias, which --model names';
  // Observed: a resume keeps its stored effort over a changed [thinking]. Not observed: over a changed model table.
  const kept =
    assembled.effortSupport === 'withdrawn'
      ? `keeps ${alias}; whether kimi keeps its stored effort, now that the model's table no longer lists it, is unknown`
      : `keeps the effort it stored and ${alias}`;
  const resume =
    run === 'resume'
      ? `; this run resumes a session, which ${kept}`
      : run === 'preload'
        ? `; with --preload a primer run creates the session here and the call to action resumes it, which ${kept}`
        : '';
  return `bare-kimi: routed to model "${assembled.modelAlias}" (${modelOrigin}; ${provider}), ${effort}${resume}`;
}

/** The run ended, but cleanup kept something on purpose; say what and where. */
function custodyKept(error: KimiCustodyError): number {
  console.error(`bare-kimi: ${error.message}`);
  return 4;
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
