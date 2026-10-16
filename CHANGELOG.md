# Changelog

## 0.2.0 — 16 October 2026, the first maintained release

The recovered tree on `main` (package version 0.1.0) was never released:
no earlier Git tag or registry package was found. This is the first
release. It is a Git release; it is not published to a package registry.

### Release notes

bare-kimi runs Kimi Code (`kimi -p`) against a run home of its own, using
the operator's existing login. This release repairs the recovered source
and changes how run homes are owned:

- **Faithful configuration.** A run home's `config.toml` carries, verbatim:
  the default model and its provider, and the source's `[thinking]`,
  `[permission]` and `[[hooks]]` tables. A source config is checked with
  smol-toml 1.9.1 and parsed back after assembly. Anything that cannot be
  carried without change is refused before any effect.
- **Explicit home ownership.** Run homes are stamped (`.bare-kimi-home`).
  Only missing, empty or stamped directories are used. A reused home follows
  source changes and refuses local edits to its settings.
- **Credential custody.** Link mode shares `credentials/` and `oauth/` with
  the source home. Copy mode stamps copies with file digests, and never
  discards a copy that may hold the only current refresh token.
- **Safer runs.** All refusals happen before the first effect: aliases,
  nesting, ambient-environment mismatches, preload misuse and caller-owned
  entries. A cleanup refusal keeps the finished run (`KimiCustodyError`,
  CLI exit 4).

**Behavior of kimi itself, observed in one probe run (installed kimi 2.1.0,
`-p` mode, an `openai`-protocol loopback test provider with a dummy API key,
synthetic homes, on macOS):**
- carried `[[hooks]]` ran;
- the carried thinking effort was sent to that provider as
  `reasoning_effort` (the managed Kimi provider's request format was not
  observed);
- preloaded text reached the resumed request;
- in every scenario the stream-json `system.version` and
  `session.resume_hint` lines parsed (other line types were not judged);
- each scenario left one wire journal in its run home, and no `sessions/`
  directory appeared in its synthetic source home.

A carried, schema-valid deny rule for `Bash` did **not** stop a `Bash` call.
Carried permission rules are not protection. Confine a run from outside (see
the README's Containment section). Invalid sections are dropped whole: a
string rule drops all of `[permission]`, and one invalid hook drops every
hook.

**Not covered by this release's evidence:**
- a real login: the managed Kimi Code provider, OAuth, and link-mode refresh
  and its lock against a real account;
- other kimi versions, other modes, and the interactive UI;
- any consumer's adoption. Publishing this release adopts it nowhere.

**Breaking against the recovered tree:**
- a directory holding a `config.toml` is no longer taken as a run home;
- a home kept by earlier states has no stamp and is refused (remove it);
- `isAssembledHome` throws on an unreadable stamp;
- the exit code 4 is new.

**Authorship.** Kimi Code (an AI coding agent) wrote the original source.
Codex (an AI agent) recovered it into Git. Claude (an AI coding agent) wrote
the repairs and the probe, in rounds prompted by independent reviews. Codex,
as root, applied one reviewer's prescription to the probe (the separate
write-control directory below), ran the checks and the native probe, and
kept the evidence. The record below keeps each round, including probe
versions that were rejected or refused.

## Change record

Earlier states of this candidate, including the fifth round's library
changes, passed their typecheck and test suite when those were run
separately. Later rounds changed only the optional native probe, the
documentation and the CLI help text; the released tree passed its typecheck
and test suite.

### Write-control correction (applied by root)

Independent reception found that a write in the read-denied decoy home could
fail on read permission alone. Before the fourth probe version was run, root
replaced that write target with a third owned, readable directory outside
the root and every denied-read path. All three directories are retained.
The descriptions of the second and third versions below, with two
directories, are historical. Network isolation covers direct socket
connections, not IPC delegation to external services.

### Native evidence

Native behavior cited below was checked by reading the installed Kimi Code
2.1.0 npm package (`dist/main.mjs`), not its upstream repository. Nothing
here claims that upstream is current or unchanged.

Read in that bundle:
- the `[thinking]` keys `enabled`, `effort` and `keep`, and the env-only
  `KIMI_MODEL_THINKING_EFFORT` and `KIMI_MODEL_THINKING_KEEP`;
- the `[permission]` section (`rules`, `deny`, `allow`, `ask`,
  `dangerousCommandGuard`) and the non-interactive policy order, which checks
  rule-state deny rules before auto-approval and skips the dangerous-command
  guard;
- `[[hooks]]` (`event`, `matcher`, `command`, `timeout`), loaded from config;
- section validation: a config section that fails its schema is dropped
  whole, with only the warning `Ignored invalid config section '<name>'`.
  One invalid `[[hooks]]` entry disables every hook;
- the token store's tmp-file-and-rename save, which also chmods
  `credentials/` to 0700;
- the refresh lock at `oauth/<slot>.lock`;
- the per-home `device_id`;
- the TOML parser: smol-toml 1.6.1, called with default options on every
  read of `config.toml`. On invalid TOML, loading fails with a config error,
  and at least one load path ignores the file instead.

**Rule shapes.** 2.1.0 accepts a rule as a table: `[[permission.rules]]`
with `decision` and `pattern` (e.g. `pattern = "Bash(rm *)"`), or a
`deny`/`allow`/`ask` entry with `tool` and optional `match` (e.g.
`deny = [{ tool = "Bash", match = "rm *" }]`). A bare string entry such as
`deny = ["Bash"]` is passed through untransformed, fails the rule schema,
and makes 2.1.0 drop the whole `[permission]` section with only a warning.
That happens natively too; bare-kimi carries such text as written. Earlier
tests in this candidate used string entries while calling them
schema-shaped; their fixtures are corrected.

**Permission rules are carried, and were observed not to be enforced.** By
static reading, the rule state that the policy chain checks changes only
through one method, and nothing in the 2.1.0 bundle calls it. The native
probe then observed the same thing: in installed kimi 2.1.0 `-p` mode, a
schema-valid deny rule for `Bash`, accepted without a section-drop warning,
did not stop a scripted `Bash` call. Its tool result read "Command executed
successfully." This is one case in one version and mode, matching the
static reading. It is not a statement about other versions, modes or the
interactive UI. bare-kimi promises only a faithful carry, and must not be
relied on for containment. Fixing rule enforcement is kimi's concern, not
this wrapper's.

### Fixed

- **Thinking configuration was dropped.** The source's `[thinking]` table is
  now carried verbatim. Derived from a reviewed downstream patch; its test is
  included unchanged.
- **Permission rules and hooks were dropped.** `[permission]` (including
  `[[permission.rules]]`) and `[[hooks]]` are now carried verbatim, in source
  order. The CLI help says what is carried and refused, and that carried
  permission rules are not protection. An earlier source comment in this
  candidate claimed enforcement. It was corrected first to "unproven", and
  then, after the native run, to what was observed.
- **A `config.toml` was taken as proof of ownership.** That file name is
  common to many tools. Any directory holding one was reused as a run home:
  credentials were linked into it, its config was used or overwritten, and a
  reused home kept stale policy after the source changed. Run homes are now
  stamped:
  - `.bare-kimi-home` records the canonical source home and a digest of the
    settings in the `config.toml` that bare-kimi wrote;
  - only a missing, empty or stamped directory is used. Anything else is
    refused before any effect, even with a `config.toml` in it;
  - a stamped home from another source, a stamp that does not read as one,
    and a `config.toml` that is not a regular file are refused;
  - a reused home's `config.toml` follows the source. While its settings
    equal what the source yields, it is kept byte for byte, comments
    included. When it still holds what bare-kimi last wrote and the source
    changed, it is rewritten from the source (tmp file + rename). When it was
    edited to something else, it is refused, neither run nor overwritten.

  **Migration:** a run home kept by an earlier state of this candidate has
  no stamp and is refused. Remove it and let bare-kimi assemble it again.
- **Config extraction matched text, not structure.** The source config is
  now parsed with smol-toml. `default_model` comes from the root table, and
  tables are selected by their parsed key path. Tables are still copied as
  text, and the assembled text is parsed back and must equal the source on
  everything it carries, and contain nothing else. What this guarantees:
  - a source config that fails to parse is refused before any effect, even
    if the malformed part would not be carried;
  - the carried tables mean the same to the parser in the run home as in the
    source. Dotted keys or inline tables in the root, or a header-like line
    inside a multi-line string, are refused rather than dropped or altered.

  Not guaranteed: that kimi's schema accepts the carried values, or that
  kimi's own parser agrees (see the dependency entry below). Bun's built-in
  TOML parser is not used; it accepted an unterminated table header.
- **Preload checked the real request only after the primer.** A leading-dash
  prompt or primer, or `resume`/`continueRecent` (which preload used to
  override silently), are now refused before any home is made or any child
  starts. The CLI runs the same library checks before `--keep-home` creates
  a home.
- **Preload cleanup was silent.** A failed removal of preload's ephemeral
  home was swallowed. It now throws `KimiCustodyError` with the finished run
  attached and the home named, and the CLI exits 4.
- **Relative paths.** Home and source paths are made absolute once, against
  the calling process's working directory. A `kimiBin` containing `/`
  resolves the same way. `--skills-dir`, `--add-dir` and `extraArgs` are
  kimi's own arguments; they are passed verbatim and kimi resolves them in
  the child's cwd.
- **Ambient `KIMI_CODE_HOME`.** When the environment's `KIMI_CODE_HOME` names
  a different home than `~/.kimi-code`, and no source is given explicitly or
  through `KIMI_CODE_HOME_SOURCE`, the `~/.kimi-code` fallback is refused
  instead of silently donating from a login that environment did not select.
- **Nested runs.** Every bare-kimi child has `KIMI_CODE_HOME` set to its run
  home, so the refusal above would have stopped a bare-kimi started from a
  hook or tool inside a run. The child now also gets
  `KIMI_CODE_HOME_SOURCE`, set to the source this run actually used. That
  replaces any inherited value, which could name a different home. A nested
  bare-kimi therefore donates from the same login. `extraEnv` can still set
  the variable on purpose. kimi itself does not read it.
- **CRLF configs.** A table header with a trailing comment in a CRLF file
  was not recognized (`.` does not match `\r`), so the config was refused.
  It is now carried.
- **`--keep-home` and early refusals.** The CLI makes the kept home before
  the library's setup checks, so a refused setup left an empty home behind.
  A kept home holding nothing but its marker is now removed when setup is
  refused. One with anything more in it stays, as asked.
- **Caller-owned symlinks were replaced.** An existing `credentials` or
  `oauth` symlink is kept only when it points at the intended source.
- **Mismatched links in a reused home.** Reuse checks that the `credentials`
  and `oauth` links pair with the intended source, and refuses mismatches;
  it restores a missing `oauth` link.
- **Credentials were re-pointed before the `oauth` refusal.** Donation and
  config changes are planned in full before any effect.
- **Alias and nesting checks.** Homes are compared after resolving symlinks
  and by filesystem identity, including the identity of a not-yet-existing
  run home's existing ancestors, which also covers case-insensitive
  spellings. A run home inside the source home, or containing it, is
  refused, as is a dangling run-home symlink.
- **Caller directories were chmod'ed.** Only a run home that bare-kimi
  creates is set to 0700. An existing directory keeps its mode.

### Changed

- **Dependency:** `smol-toml` (BSD-3-Clause), used as a package, not copied,
  pinned exactly to 1.9.1. kimi 2.1.0 bundles 1.6.1, which is affected by
  GHSA-7w5x-hrqm-74c2 (an endless loop on some malformed input, fixed in
  1.7.1) and GHSA-r4xh-jqrq-34v2 (quadratic time on many ordinary keys,
  fixed in 1.9.0). Native's old version is no reason to keep known defects.
  The cost: bare-kimi now parses with a newer release than kimi 2.1.0 does,
  so a document the two versions read differently is not caught here.
  Whether 1.6.1 to 1.9.1 changed what valid TOML means was not established.
- **Credential copies are stamped.** The copy marker records each copied
  file's SHA-256, and the copy is written from the very bytes that were
  hashed. Before replacing, shredding, or removing a copy with its ephemeral
  home:
  - a file that matches its stamp, or is identical to the source's, is safe
    to discard, even after a source-only refresh;
  - a changed file, a new file or a non-file entry may hold the only current
    refresh token. It is kept and the operation is refused;
  - an empty marker from an earlier version, or one that does not parse,
    proves nothing: such a copy is discarded only while it is identical to
    the source.
- **A cleanup refusal keeps the run.** `dispose()` rejects with
  `KimiCustodyError`. `runKimi()`/`runPreloaded()` throw it with the finished
  `KimiRun` attached (output, exit code, session id). The CLI prints the run's
  output and what was kept, then exits **4**, a new exit code. A child that
  itself exits 2, 3 or 4 is passed through unchanged; bare-kimi's own
  outcomes are always named on stderr.
- New exports: `assertDistinctHomes`, `checkLaunchOptions`,
  `checkPreloadOptions`, `DEFAULT_PRIME`, `HOME_STAMP`, `KimiCustodyError`,
  `prepareRunHome`. `isAssembledHome` now means "carries the stamp", and
  it throws on a stamp that is not a regular file or does not read as one
  this version wrote, instead of guessing.
  `assembleHome` is `prepareRunHome` with a full re-donation.
  `shredCopiedCredentials` and `removeHome` take an optional `srcHome` for
  the copy check.
- `runPreloaded` treats an empty `home` as omitted, as `spawnKimi` does.
- `KIMI_MODEL_*` scrubbing also covers `KIMI_MODEL_THINKING_EFFORT` and
  `KIMI_MODEL_THINKING_KEEP`, documented now. An ambient value cannot
  override the carried `[thinking]` table; `extraEnv` can set one on
  purpose.
- The leading-dash prompt refusal is now described as conservative. Whether
  kimi 2.1.0 would actually parse such a `-p` value as a flag was not
  verified.

### Optional native probe (not part of the test suite)

`probe/native-loopback.ts` checks native behavior without credentials or a
provider. Its third version refused in preflight. Its fourth version, with
root's write-control correction, completed (see the end of this section).

The first version was reviewed, rejected and never run. Its deny scenario
used a string rule that 2.1.0 drops as invalid. It inferred enforcement from
a missing canary alone. And its deadline killed only one process, so a hung
kimi could hang it. The second version:
- uses a schema-shaped rule, and observes the string form separately;
- judges each scenario on its own evidence: the scripted call sent, a tool
  result returned, a refusal reported, and the config sections kimi said it
  dropped. Missing evidence is reported as inconclusive, never as a
  finding;
- runs every child in a process group it owns: SIGTERM, then SIGKILL after
  a grace period, a bounded drain, output kept, and whether the group was
  gone recorded rather than assumed;
- allows only the provider's own loopback port, and denies reads of the
  real native homes, computed at run time;
- requires the kimi executable to be named, and records its real path.

The second version was also reviewed and not run. It could report
enforcement without evidence. Its "withheld by omission" and "enforced"
verdicts were not gated on the control. "Enforced" matched any
`denied|permission` text, which a shell `Permission denied` would satisfy.
And the read denial of the real homes was declared but never shown to work.
The third version:
- gates "enforced" and "withheld by omission" on the control having held;
- counts "enforced" only on kimi 2.1.0's exact rule refusal for this
  scenario's own rule, `Tool "Bash" was denied by permission rule. Reason:
  probe`, matched against the tool result's text (string content as is,
  content parts joined);
- proves the read denial in the preflight, on a synthetic decoy home created
  outside the temp root and denied like the real homes. No real home is
  read;
- writes each run's raw stdout/stderr (and the preflight's) to disk before
  judging anything, and names both created directories on success, refusal
  and failure;
- attributes requests by a per-scenario provider path (`/s/<name>/v1`), and
  stops running scenarios once a process group outlives SIGKILL;
- clears its timers, so it exits once done, and skips non-directories when
  counting wire journals.

The third version was run once, unsandboxed, against an installed kimi
2.1.0. It refused in its preflight, before launching kimi. Observed in the
sandbox:
- the provider answered;
- the write outside the root and the decoy read were refused with `EPERM`;
- the decoy loopback port and the never-routed address both failed with
  `ECONNREFUSED`, which it did not accept as a denial.

That refusal was correct as far as it went. One hypothesis is that this
platform reports a sandbox network denial as `ECONNREFUSED`, since an
unroutable address refusing at once is not how a real network behaves. But
that run had no unsandboxed comparison, so a harness fault (for example the
decoy listener not accepting) could not be excluded. The fourth version, the
one later run, does not simply accept `ECONNREFUSED`. It runs the same check
unsandboxed before and after the sandboxed run, as positive controls: both
loopback listeners must connect, a write in the separate write-control
directory must succeed, and the decoy file must be readable. Sandboxed, the
provider port must connect over the same raw socket call. Only against that
contrast is `ECONNREFUSED` from the decoy listener taken as this platform's
observed sandbox denial, and the never-routed address must then fail with
the same code. A failing control refuses the run. Each preflight run's raw
output, and the verdict, are written before judging. (As first drafted, this
version wrote in the decoy home; see the write-control correction above.)

In more detail:
- **Isolation:** macOS only, from an unsandboxed shell. The probe runs
  bare-kimi and kimi under `sandbox-exec`:
  - outbound network only to the provider's own loopback port;
  - file writes only under its temp root;
  - reads of the real native homes, and of a synthetic decoy home, denied
    (the denial was shown on the decoy, not tested on the real paths).

  A preflight compares unsandboxed controls (before and after) with the
  sandboxed run. It must show:
  - the provider port connecting in both;
  - a live decoy listener reached by the controls but refused in the
    sandbox;
  - a never-routed address refused in the same way;
  - a write in the write-control directory and a read of the decoy file
    allowed unsandboxed and refused in the sandbox;
  - an owned process group.

  Otherwise the probe refuses before kimi is launched.
- **Custody:** three directories are created in the system temp dir and
  left for inspection: the temp root (runs, raw output, report), the decoy
  home (one non-secret file), and the write-control directory. The report
  lists the real homes it denied by absolute path, so it must stay private.
- **Setup:** a synthetic `openai`-type provider points at a loopback server
  that scripts a `Bash` tool call and records, per scenario, whether it sent
  it. It uses a temporary HOME, cwd and source home and a dummy API key,
  with model-catalog refresh off.
- **Scenarios:**
  - a control, which also judges the hook;
  - a schema-shaped deny rule;
  - the string-form deny rule;
  - an invalid hook, judged only if its own scripted call ran;
  - preload, judged only if a resumed request happened.

  Each scenario also records the thinking effort as sent, the stream-json
  meta lines and the wire journals.

The fourth version completed once, with exit 0, from an unsandboxed shell
against installed kimi 2.1.0. Its preflight showed:
- **Controls (before and after):** both loopback listeners connected, and
  the write and the decoy read succeeded.
- **Sandboxed:**
  - the provider connected over HTTP and over raw TCP;
  - the other listener and the never-routed address failed with
    `ECONNREFUSED`, accepted on the contrast basis;
  - the write and the decoy read failed with `EPERM`.

Then all five scenarios finished with exit 0, each with version 2.1.0, a
session id and one wire journal. No synthetic source home gained
`sessions/`, the probe reported its process groups absent, and no request
was unattributed. **Qualification, 16 October 2026 (UTC+00:00):** that group
check maps every inspection error to absence; it did not establish emptiness.
A typed recheck and replay remain owed. Kimi starts tool commands in their
own groups, which leaves complete descendant cleanup unverified.
Findings:
- **control:** held. The scripted call ran, and the `PreToolUse` hook fired;
- **deny:** not enforced. No section was dropped, the call ran, and the
  canary was created;
- **deny-string:** the whole `[permission]` section was dropped;
- **invalid-hook:** the whole hooks section was dropped, and the valid hook
  did not fire though the tool ran;
- **preload:** the marker was absent from the primer request and present in
  the resumed request;
- **thinking:** `"high"` was sent at `$.reasoning_effort`.

The named executable was the package's `bin/kimi` link. Its real path is the
package's `dist/main.mjs`, the same file with the same digest, not a second
binary. Two metadata fixes followed this run without changing what it
observed:
- the success report and summary now name the write-control directory;
- the source-homes finding now reads `no-sessions-observed`, because only
  the absence of `sessions/` was checked.

### Tests

- Fixed the `test/helpers.ts` typecheck error and the `test.each` row shape.
- The test helper checks that the tracked fake `kimi` is executable instead
  of chmod'ing it.
- The fake `kimi` can simulate a 2.1.0-style refresh. It can also record the
  `config.toml` it started with (`FAKE_KIMI_CONFIG_OUT`).
- The parser-advisory regressions run `assembleHome` in a child process that
  is killed at a deadline. A defective parser therefore fails the test
  instead of hanging the runner.
- Several older tests set up an unstamped directory and relied on
  "`config.toml` means ours". They now stamp the home first, so they still
  test the symlink and donation refusals they were written for.
- Added tests for:
  - another tool's directory with a `config.toml`, refused on reuse and on
    assembly, with nothing planted (library and CLI);
  - a source policy change reaching the child;
  - an edited config refused before the child starts;
  - comment-only edits kept;
  - a stamp from another source, and an unreadable stamp;
  - an ambient `KIMI_CODE_HOME` mismatch;
  - case-insensitive nesting (skipped on case-sensitive volumes);
  - a CRLF config with commented headers;
  - the child receiving the source this run used, replacing an inherited
    `KIMI_CODE_HOME_SOURCE`;
  - no empty `--keep-home` home left by a refused setup;
  - both parser advisories;
  - the earlier coverage: carried policy tables, zero-effect refusals and
    malformed tails, preload refusals, native-style refresh in both modes,
    stale and legacy copies, link pairing, nesting, permissions, relative
    `--kimi-bin`, and `KimiCustodyError` carrying the run.

### Known limits

- Other root-table settings of the source `config.toml` are not carried.
  Which of them matter to a headless run has not been established.
- Carried permission rules are not protection. In installed kimi 2.1.0
  `-p` mode, a valid deny rule was observed not to be enforced. Carried hooks
  do run. Containment must come from outside the process.
- No real login has been exercised: the managed provider, OAuth, and
  link-mode refresh and its shared lock against a real account.
- The native probe did not exercise copy mode or temporary run homes (it
  used kept homes), did not compare a real home before and after, did not
  test the read denial on real home paths, and proves only that its own
  process groups ended, not every descendant.
- Checks and effects are not atomic against a concurrent writer to the same
  homes.
- A copy and its source refreshed independently cannot both be kept current.
  bare-kimi only refuses to discard the copy.
- Not hermetic, and not an OS sandbox: AGENTS.md files and skills still load,
  the parent environment is inherited unless `noProcessEnv`, carried hooks
  run, and link mode writes refreshed tokens into the source home by design.
