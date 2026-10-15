# bare-kimi

Run `kimi` (Kimi Code CLI) headless against an isolated `KIMI_CODE_HOME`, on
the operator's own login. Library first; the CLI (`bin/bare-kimi.ts`) is its
worked example.

**Status: unfinished.** This repository restores custody of an incomplete
source tree. It is not a release and is not published to any package
registry. The recovered source has known defects in home assembly,
authentication handling and thinking handling. A repair candidate for them
is described in [CHANGELOG.md](CHANGELOG.md). Its author did not run its
typecheck or tests, and no live run against kimi has been made with it.
See [RECOVERY.md](RECOVERY.md) for how the history was reconstructed, what
the checks on the recovered tree showed, and what is not known.

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

Requires Bun ≥ 1.3. Code comments that describe verification against
particular kimi / kimi-code versions are the original author's statements and
were not re-verified during recovery.

## License

MIT — see [LICENSE](LICENSE).
