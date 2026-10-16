# bare-kimi

Run `kimi` (Kimi Code CLI) headless against an isolated `KIMI_CODE_HOME`, on
the operator's own login. Library first; the CLI (`bin/bare-kimi.ts`) is its
worked example.

**Status: 0.2.0, the first maintained release; early (pre-1.0).** Not
published to any package registry. The source was recovered from an
unfinished tree (see [RECOVERY.md](RECOVERY.md)) and then repaired;
[CHANGELOG.md](CHANGELOG.md) lists what changed and on what evidence. What
has been exercised:
- the test suite, against a fake `kimi` child and synthetic homes;
- one run of the optional probe below: five scenarios, each running an
  installed kimi 2.1.0 in `-p` mode (the preload scenario twice, primer and
  resume) against a loopback test provider with a dummy API key.

Not yet exercised: a real login. That means the managed Kimi Code provider,
OAuth, and link-mode token refresh and its shared lock against a real
account.

## Containment: what bare-kimi does not do

bare-kimi gives kimi a run home of its own: its own configuration and
sessions. It does not give it a login of its own: in link mode, the default,
the login is shared with the source home by design, and a token refresh
writes there. Nor does it limit what kimi does. In `-p` mode kimi runs in
its auto permission mode, which approves tool calls. bare-kimi copies the source home's `[permission]`
rules into the run home unchanged. In the probe run noted above, kimi
2.1.0 accepted a valid deny rule for `Bash` without a section-drop warning,
and still ran the `Bash` call. A carried rule is therefore no protection,
at least for installed kimi 2.1.0 in `-p` mode. That was one observed case; nothing here
is promised for other versions, modes or the interactive UI. To contain a
run, confine it from outside: an OS sandbox, a container, or a restricted
account. A fix for the rules themselves belongs in kimi, not in this
wrapper.

## Use from a checkout

Bun 1.3 or later and a separately installed Kimi Code CLI are required.
The Git release contains the TypeScript source; no package registry or
machine-wide installation is needed to run its worked CLI:

```sh
git clone --branch v0.2.0 https://github.com/agladysh/bare-kimi.git
cd bare-kimi
bun install --frozen-lockfile
bun bin/bare-kimi.ts --help
```

An actual run uses the existing source-home login. The containment and
login-sharing conditions above apply to both the library and the CLI.

## Library use

```ts
import { KimiCustodyError, runKimi } from '@agladysh/bare-kimi';

try {
  const run = await runKimi({
    prompt: 'List the TODO comments under src/.',
    cwd: '/path/to/project',
    outputFormat: 'stream-json',
  });
  console.log(run.code, run.sessionId, run.events.length);
} catch (error) {
  // The run finished, but cleanup kept something (named in the message).
  if (error instanceof KimiCustodyError && error.run !== undefined) {
    console.error(error.message, error.run.code);
  } else {
    throw error;
  }
}
```

Without `home`, `runKimi` assembles an ephemeral run home and removes it
afterwards. The source home is `srcHome`, else `KIMI_CODE_HOME_SOURCE`,
else `~/.kimi-code` (refused when an ambient `KIMI_CODE_HOME` names another
home). Credentials are linked unless `authMode: 'copy'`. Setup refusals
throw; a `kimi` that cannot be started resolves with code 127. For the
subprocess itself, use `spawnKimi`; for preload, `runPreloaded` from
`@agladysh/bare-kimi/preload`. The options are documented in
`src/index.ts`.

## What a run touches

- **The run home** (`KIMI_CODE_HOME`): created with mode 0700 when missing.
  An existing directory is used only when it is empty or already a run home,
  and it keeps its permissions. Its `config.toml` carries, verbatim:
  `default_model`, that model's `[models."…"]` table, its provider's
  `[providers."…"]` tables, and the source's `[thinking]`, `[permission]`
  and `[[hooks]]` tables. The source config is checked with smol-toml, the
  TOML parser family kimi uses, pinned to a release without the known
  denial-of-service defects of the version kimi 2.1.0 bundles. It is refused
  before anything is written if the parser rejects it, or if any of these
  tables is written in a form that cannot be carried verbatim. Carrying
  `[permission]` is all that is promised; see Containment above. Hooks are
  loaded and run. kimi drops a config section that fails its schema as a
  whole, with only a warning. In kimi 2.1.0 a string rule such as
  `deny = ["Bash"]` drops all of `[permission]`, and one invalid
  `[[hooks]]` entry disables every hook.
- **Ownership:** a run home bare-kimi assembled carries `.bare-kimi-home`,
  which records its source home and the settings it wrote. A missing or empty
  directory is assembled; a stamped home from the same source is reused.
  Anything else is refused, including another tool's directory that happens
  to hold a `config.toml`. A reused home's `config.toml` is kept while its
  settings match the source (comments survive), rewritten when the source
  changed, and refused when it was edited to something else.
  kimi itself creates a `device_id` in every new run home and sends it to
  the provider, so each ephemeral run appears there as a new device.
- **The source home**, in link mode (the default): `credentials/` and
  `oauth/` are shared through directory symlinks. When kimi refreshes a
  token it writes the new token into the source's `credentials/` (temporary
  file, then rename), sets that directory to 0700, and takes its refresh lock
  under the source's `oauth/`. bare-kimi creates the source's `oauth/` when
  it is missing.
- **Copy mode** copies the token files, stamped with their SHA-256. Cleanup
  discards a copy only when it is provably unchanged, or identical to the
  source. A changed copy may hold the only current refresh token, so it is
  kept and the CLI exits 4.
- **Not hermetic:** AGENTS.md files and skills still load, the parent
  environment is inherited unless `--no-process-env`, and hooks from the
  source config run as configured.

## Contents

- `src/home.ts` — assemble a minimal run home from a source home's
  `config.toml`; give it credentials by directory symlink (`link`, the
  default) or by marker-stamped copy (`copy`); guarded removal of ephemeral
  homes. Its header comment states who owns which files, what each step
  changes, and that every refusal happens before the first change.
- `src/events.ts` — types and guards for `kimi -p --output-format stream-json`
  output.
- `src/index.ts` — `spawnKimi` / `runKimi`: argv and child environment
  construction (strips inherited endpoint, refresh-lock and model overrides;
  forces `KIMI_CODE_HOME`; telemetry and auto-update off by default).
- `src/preload.ts` — experimental "synthetic past": after a primer run,
  append records to the session's wire journal, then resume. Preloaded
  content is sent as input tokens on every resumed turn; it saves tool
  round-trips, not tokens.
- `bin/bare-kimi.ts` — the CLI; `--help` lists options and exit codes.
- `src/*.test.ts`, `test/` — black-box tests against a fake `kimi` child and
  synthetic homes. They contain no real credentials.

Requires Bun ≥ 1.3. Code comments that cite kimi-code `6451f1e` or kimi
2.0.1 are the original author's statements and were not re-verified during
recovery. Comments that cite kimi 2.1.0 come from reading the installed
2.1.0 npm bundle. They say nothing about the current upstream source.

## Optional native probe

`probe/native-loopback.ts` observes an installed kimi without credentials or
a provider. It is not part of `bun test`. It runs bare-kimi against a
loopback stand-in for an OpenAI-compatible provider, under macOS
`sandbox-exec`. The profile allows network only to that provider's port and
writes only under a temp root, and denies reads of the real native homes.
Isolation is shown by comparing unsandboxed controls with the sandboxed run:
a live decoy loopback listener, a read of a synthetic decoy home's file, and
a write in a separate readable directory outside the root all work
unsandboxed and must be refused sandboxed. The read denial is thus shown on
the decoy, not tested on the real home paths. All three directories are left
for inspection; the report names the real home paths it denied, so keep it
private. Network isolation covers direct socket connections, not IPC
delegation to external services. The probe refuses before launching kimi
when that isolation cannot be shown, or when the kimi executable is not
named explicitly. Each finding rests on its own scenario's evidence and is
otherwise reported as inconclusive. Findings that rest on something not
happening ("enforced", "withheld by omission") also require the control to
have held, and enforcement counts only on kimi's exact rule-refusal message.
It reports:
- whether a schema-shaped deny rule stops a scripted tool call;
- whether a string-form rule is dropped;
- whether hooks fire;
- whether an invalid hook drops the hooks section;
- whether preload reaches the model;
- where the thinking effort is sent.

Observed in its one completed run (installed kimi 2.1.0, `-p`, macOS):
- **Isolation:** the controls reached both loopback listeners and could
  write and read. Sandboxed, the provider port connected; the other
  listener and a never-routed address failed with `ECONNREFUSED`, which the
  contrast attributes to the sandbox; the write and the decoy read failed
  with `EPERM`.
- **Control:** the scripted `Bash` call ran, and a configured `PreToolUse`
  hook fired.
- **Deny rule:** a valid `[[permission.rules]]` deny rule for `Bash` was
  accepted without a section-drop warning but did not stop the call. The
  tool result read "Command executed successfully."
- **Invalid sections:** a string `deny = ["Bash"]` rule made kimi drop the
  whole `[permission]` section. One invalid hook made it drop the whole
  hooks section, so the valid hook beside it did not fire.
- **Preload:** the preloaded text was absent from the primer request and
  present in the resumed request.
- **Thinking:** the carried `effort = "high"` was sent as `reasoning_effort`
  to that `openai`-protocol provider; the managed provider's format was not
  observed.
- **Each scenario:** exit 0, a parsed `system.version` and
  `session.resume_hint`, one wire journal in the run home, and no `sessions/`
  in its synthetic source home. The probe reported its groups absent using a
  Boolean helper that maps inspection errors, including EPERM, to absence.
  Their emptiness is therefore unverified pending a typed recheck and replay.
  Kimi starts tool commands in their own groups, which also leaves complete
  descendant cleanup unverified.

These are observations of one installed version with a test provider, not
guarantees. They say nothing about a real login.

A nested bare-kimi (started from a hook or tool inside a run) donates from
the same source home: the child environment carries
`KIMI_CODE_HOME_SOURCE`.

## License

MIT — see [LICENSE](LICENSE).
