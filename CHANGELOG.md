# Changelog

## Unreleased — repair candidate

Written by Claude (an AI coding agent) after recovery. Its author did not
run the typecheck, the tests or kimi itself. No result is claimed for this
candidate until those checks have been run.

### Fixed

- **Thinking configuration was dropped.** `assembleHome` wrote only
  `default_model`, the provider section and the model section, so a run used
  the model's default effort, not the configured one. The source's
  `[thinking]` table (with any `[thinking.*]` sub-tables) is now carried
  verbatim. Thinking set in the root table (e.g. `thinking.effort = …`) is
  refused instead of silently dropped. Derived from a reviewed downstream
  patch; its test is included unchanged.
- **Relative paths.** Link-mode symlinks stored a relative source path, which
  resolves against the link's own directory, so the links could dangle.
  `KIMI_CODE_HOME` was passed through relative, so a child running in another
  `cwd` used a different directory. Home and source paths are now made
  absolute once, against the calling process's working directory.
- **Caller-owned symlinks were replaced.** Any existing symlink at
  `credentials` or `oauth` was unlinked and re-pointed. A symlink is now kept
  only when it already points at the intended target. Otherwise donation is
  refused and the symlink is left as it is.
- **Credentials were re-pointed before the `oauth` refusal.** Link donation
  swapped `credentials` (removing a marked copy) before finding that `oauth`
  was caller-owned. Donation is now planned in full before any effect. Every
  refusal leaves the source home, the run home and the run home's mode
  untouched.
- **Alias check, then chmod through the alias.** The same-directory check
  compared lexically resolved paths. A run home reached through a symlink to
  the source home passed the check, and the source home was then set to
  0700, or used directly as a prepared run home. Identity is now decided
  after resolving symlinks and by filesystem identity. A dangling symlink as
  run home is refused.

### Changed

- A marker-stamped credential copy is replaced, overwritten, shredded or
  removed with its ephemeral home only while it still matches the source
  home byte for byte. A changed copy may hold the only current refresh token
  after a refresh. It is kept, and the operation throws (`dispose` rejects
  and the CLI exits 2). `shredCopiedCredentials` and `removeHome` take an
  optional `srcHome` for this check; without it they behave as before.
- In link mode, `ensureAuth` restores a missing `oauth` link next to its own
  `credentials` link, so refreshes keep the shared lock.
- `config.toml` in the run home is refused when it exists but is not a
  regular file. Writing through a symlink would change its target.
- A copy now gets its marker before its files, so an interrupted copy is
  still recognizable and shreddable.
- New export: `assertDistinctHomes`.
- `runPreloaded` treats an empty `home` as omitted, as `spawnKimi` does.

### Tests

- Fixed a typecheck error in `test/helpers.ts`: `subprocess.stdin` was
  possibly undefined.
- `isKimiStreamEvent` table cases now use one-element rows. A bare `[]` row
  was spread into zero arguments, and the test was taken to want a done
  callback and timed out.
- The leading-dash CLI test checked for the library's message. Under
  `bun bin/bare-kimi.ts -- -x` the CLI parser sees `-x` as an unknown option
  and refuses it with its own message. The test now checks that both routes
  exit 2 without starting kimi or creating a home, and checks the library's
  message on the piped-prompt route.
- One test was renamed from "re-points a stale link and upgrades a marked
  copy" to "upgrades an unchanged marked copy to a link". Re-pointing is now
  refused, and a separate test covers that.
- New regression tests cover: the real source file reached through links
  made from relative paths, a relative `--home`/`--src-home` with a different
  `--cwd`, refusal ordering, symlink aliases of the source home (library and
  CLI), caller-owned symlinks, a `config.toml` symlink, a dangling run-home
  symlink, changed copies, and `oauth` link restoration.

### Known limits

- Kimi Code's source was not available to this repair. The `[thinking]` table
  name and contents are carried, not interpreted. No effort override is
  offered, because the native keys and accepted values were not verified.
- Other root-table settings of the source `config.toml` are still not
  carried. Which of them matter to a headless run has not been established.
- Checks and effects are not atomic against a concurrent writer to the same
  homes.
- A copy that differs from the source because the *source* was refreshed is
  also kept and reported. Byte comparison cannot tell which side changed.
- Not hermetic: AGENTS.md files and skills still load, the parent environment
  is inherited unless `noProcessEnv`, and link mode writes refreshed tokens
  into the source home by design.
