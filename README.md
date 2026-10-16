# bare-kimi

Run `kimi` (Kimi Code CLI) headless against an isolated `KIMI_CODE_HOME`, on
the operator's own login. Library first; the CLI (`bin/bare-kimi.ts`) is its
worked example.

**Status: unfinished.** This repository restores custody of an incomplete
source tree. It is not a release and is not published to any package
registry. The recovered source has known defects in home assembly,
authentication handling and thinking handling. A repair candidate for them
is described in [CHANGELOG.md](CHANGELOG.md). It has not been run against a
real kimi yet, only against the fake child in `test/`. See
[RECOVERY.md](RECOVERY.md) for how the history was reconstructed, what the
checks on the recovered tree showed, and what is not known.

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
  `[permission]` is all that is promised: a static reading of kimi 2.1.0
  found no code that loads configured permission rules, so their enforcement
  is unproven. Hooks are loaded. kimi drops a config section that fails its
  schema as a whole, so one invalid `[[hooks]]` entry disables every hook.
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
`sandbox-exec`: network only to that provider's port, writes confined to a
temp root, and reads of the real native homes denied. The isolation is
shown by comparing unsandboxed controls with the sandboxed run: a live
decoy loopback listener, a read in a synthetic decoy home, and a write in a
separate readable directory outside the root all work unsandboxed and must be
refused sandboxed. All three directories are left for inspection. Network
isolation covers direct socket connects, not IPC delegation to external services. It refuses before launching kimi when
that isolation cannot be shown, or when the kimi executable is not named
explicitly. Each finding rests on its own scenario's evidence, gated on a
positive control, and is otherwise reported as inconclusive. Enforcement
counts only on kimi's exact rule-refusal message:
- whether a schema-shaped deny rule stops a scripted tool call;
- whether a string-form rule is dropped;
- whether hooks fire;
- whether an invalid hook drops the hooks section;
- whether preload reaches the model;
- where the thinking effort is sent.

No result from it is recorded here yet.

A nested bare-kimi (started from a hook or tool inside a run) donates from
the same source home: the child environment carries
`KIMI_CODE_HOME_SOURCE`.

## License

MIT — see [LICENSE](LICENSE).
