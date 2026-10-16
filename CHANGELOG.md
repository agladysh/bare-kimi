# Changelog

## Unreleased — repair candidate

Written by Claude (an AI coding agent) after recovery, in three rounds. An
earlier state of this candidate passed its typecheck and test suite when
those were run separately. The second round, which an independent review
prompted, failed one test there: Bun's built-in TOML parser accepted a
config ending in an unterminated table header. The third round replaced that
validator and has not been run by its author. Nothing here has been run
against a real kimi.

### Native evidence

Native behavior cited below was checked by reading the installed Kimi Code
2.1.0 npm package (`dist/main.mjs`), not its upstream repository. Nothing
here claims that upstream is current or unchanged.

Read in that bundle:
- the `[thinking]` keys `enabled`, `effort` and `keep`, and the env-only
  `KIMI_MODEL_THINKING_EFFORT` and `KIMI_MODEL_THINKING_KEEP`;
- the `[permission]` section (`rules`, `deny`, `allow`, `ask`,
  `dangerousCommandGuard`) and the non-interactive policy order, which checks
  user-configured deny rules before auto-approval and skips the
  dangerous-command guard;
- `[[hooks]]` (`event`, `matcher`, `command`, `timeout`), loaded from config;
- the token store's tmp-file-and-rename save, which also chmods
  `credentials/` to 0700;
- the refresh lock at `oauth/<slot>.lock`;
- the per-home `device_id`;
- the TOML parser: smol-toml 1.6.1, called with default options on every
  read of `config.toml`. On invalid TOML, loading fails with a config error,
  and at least one load path ignores the file instead.

Not found: the code path that loads configured permission rules into the
policy's rule state. bare-kimi therefore carries those rules faithfully but
does not claim that kimi 2.1.0 enforces them in `-p` mode.

### Fixed

- **Thinking configuration was dropped.** The source's `[thinking]` table is
  now carried verbatim. Derived from a reviewed downstream patch; its test is
  included unchanged.
- **Permission rules and hooks were dropped.** The minimal config kept only
  the model and provider. `[permission]` (including `[[permission.rules]]`)
  and `[[hooks]]` are now carried verbatim, in source order. The CLI help no
  longer claims that configured policy is never weakened. It says what is
  carried and what is refused.
- **Config extraction matched text, not structure.** `default_model` was
  taken from the first matching line anywhere, even inside another table.
  Headers matched only one quoting style. The source config is now parsed
  with smol-toml, pinned to 1.6.1, the parser kimi 2.1.0 itself uses.
  `default_model` comes from the root table, and tables are selected by their
  parsed key path. Tables are still copied as text. Splitting at header-like
  lines is not a TOML parser, so the assembled text is parsed back with the
  same parser and must equal the source on everything it carries, and contain
  nothing else. What this guarantees:
  - a source config kimi 2.1.0 cannot parse is refused before any effect,
    even if the malformed part would not be carried (unterminated headers or
    strings, duplicate keys, redefined tables, trailing junk);
  - the carried tables mean the same to that parser in the run home as in
    the source. Dotted keys or inline tables in the root, or a header-like
    line inside a multi-line string, are refused rather than dropped or
    altered.

  Not guaranteed: that kimi's schema accepts the carried values, or that a
  different kimi version parses the same way. Bun's built-in TOML parser is
  not used for validation; it accepted an unterminated table header.
- **Preload checked the real request only after the primer.** A leading-dash
  prompt or primer, or `resume`/`continueRecent` (which preload used to
  override silently), are now refused before any home is made or any child
  starts. The CLI runs the same library checks before `--keep-home` creates
  a home.
- **Relative paths.** Home and source paths are made absolute once, against
  the calling process's working directory. Before, link targets could
  dangle, and the child could read `KIMI_CODE_HOME` against its own cwd. A
  `kimiBin` containing `/` resolves the same way. `--skills-dir`, `--add-dir`
  and `extraArgs` are kimi's own arguments; they are passed verbatim and kimi
  resolves them in the child's cwd.
- **Caller-owned symlinks were replaced.** An existing `credentials` or
  `oauth` symlink is kept only when it points at the intended source.
  Otherwise the run is refused.
- **Mismatched links in a reused home.** `ensureAuth` checks that the
  `credentials` and `oauth` links pair with the intended source. It refuses
  links into another home, a per-home `oauth/` next to a linked
  `credentials/`, a linked `oauth/` next to the home's own `credentials/`,
  and linked credentials when copy mode was requested. It restores a missing
  `oauth` link.
- **Credentials were re-pointed before the `oauth` refusal.** Donation is
  planned in full before any effect.
- **Alias and nesting checks.** Homes are compared after resolving symlinks
  and by filesystem identity. A run home inside the source home, or
  containing it, is refused, as is a dangling run-home symlink.
- **Caller directories were chmod'ed.** Only a run home that bare-kimi
  creates is set to 0700. An existing directory keeps its mode, and is used
  only when it is empty, holds just the ephemeral marker, or already holds a
  `config.toml`.

### Changed

- **Credential copies are stamped.** The copy marker now records each copied
  file's SHA-256, and the copy is written from the very bytes that were
  hashed. Before replacing, shredding, or removing a copy with its ephemeral
  home:
  - a file that matches its stamp, or is identical to the source's, is safe
    to discard, even after a source-only refresh;
  - a changed file, a new file or a non-file entry may hold the only current
    refresh token. It is kept and the operation is refused;
  - an empty marker from the earlier version, or one that does not parse,
    proves nothing: such a copy is discarded only while it is identical to
    the source.
- **A cleanup refusal keeps the run.** `dispose()` rejects with
  `KimiCustodyError`. `runKimi()`/`runPreloaded()` throw it with the finished
  `KimiRun` attached (output, exit code, session id). The CLI prints the run's
  output and what was kept, then exits **4**, a new exit code.
- `config.toml` in the run home is refused when it exists but is not a
  regular file.
- New exports: `assertDistinctHomes`, `checkLaunchOptions`,
  `checkPreloadOptions`, `DEFAULT_PRIME`, `KimiCustodyError`.
  `shredCopiedCredentials` and `removeHome` take an optional `srcHome` for
  the copy check.
- `runPreloaded` treats an empty `home` as omitted, as `spawnKimi` does.
- New runtime dependency: `smol-toml` (BSD-3-Clause), pinned exactly to
  1.6.1 to match kimi 2.1.0. It is used as a package, not copied.
- `KIMI_MODEL_*` scrubbing also covers `KIMI_MODEL_THINKING_EFFORT` and
  `KIMI_MODEL_THINKING_KEEP`, documented now. An ambient value cannot
  override the carried `[thinking]` table; `extraEnv` can set one on
  purpose.
- The leading-dash prompt refusal is now described as conservative. Whether
  kimi 2.1.0 would actually parse such a `-p` value as a flag was not
  verified.

### Tests

- Fixed the `test/helpers.ts` typecheck error and the `test.each` row shape
  (a bare `[]` row was taken for a done callback).
- The test helper checks that the tracked fake `kimi` is executable instead
  of chmod'ing it.
- The fake `kimi` can simulate a 2.1.0-style refresh: a lock dir under
  `oauth/`, chmod of `credentials/`, then a tmp file renamed over the token.
  Fake token values only.
- The leading-dash CLI test checks that both routes exit 2 without starting
  kimi or creating a home.
- Renamed one test ("upgrades an unchanged marked copy to a link").
  Re-pointing a foreign link is now refused, and a separate test covers that.
- One existing test now expects `ensureAuth` to refuse a foreign
  `credentials` link instead of leaving it in use.
- Added tests for:
  - `[permission]`, `[[permission.rules]]` and `[[hooks]]` carried verbatim,
    in order, with nothing from between them;
  - zero-effect refusals: dotted-key, inline-table and multi-line-string
    configs, `default_model` only inside a table, and invalid TOML;
  - malformed tails that a permissive parser may accept: duplicate keys, a
    redefined table, trailing junk, a key-less line, an unterminated string
    and an unterminated array-of-tables header;
  - other spellings of table headers;
  - preload refusals, with a recorder file proving no child started;
  - link-mode refresh landing in the source, with its lock;
  - copy-mode refresh kept with exit 4, output intact, for kept and
    ephemeral homes;
  - a stale copy discarded after a source-only refresh;
  - legacy markers;
  - link pairing;
  - nesting, run-home occupancy and preserved permissions;
  - relative `--kimi-bin`;
  - `KimiCustodyError` carrying the run.

### Known limits

- Other root-table settings of the source `config.toml` are not carried.
  Which of them matter to a headless run has not been established.
- A home reused as-is runs with its own `config.toml`. It is not
  re-checked against the source's policy.
- Checks and effects are not atomic against a concurrent writer to the same
  homes.
- A copy and its source refreshed independently cannot both be kept current.
  bare-kimi only refuses to discard the copy.
- Not hermetic: AGENTS.md files and skills still load, the parent environment
  is inherited unless `noProcessEnv`, carried hooks run, and link mode writes
  refreshed tokens into the source home by design.
