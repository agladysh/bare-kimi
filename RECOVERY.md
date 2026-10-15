# Recovery notes

This file was written during recovery and extended afterwards with the
checks below. The original author did not write it.

## Background

bare-kimi was written on 2026-09-24, between 16:22 and 16:48 UTC, in a single
Kimi Code session. The working directory was never under version control.
Work stopped before completion. The source lacked its promised README and
state notes, and no Git repository existed. The progress log listed typechecks,
tests and a live smoke as next steps; that list is not evidence that no
execution attempts occurred. Recovery reconstructs source writes, and has not
re-run builds, tests or a live smoke.

On 2026-10-15 the source was recovered into Git. No original Git history
exists. The commits in this repository are a reconstruction.

## Method

The session made 33 successful native Write/Edit tool calls. These were
replayed offline in order. Every file the session wrote replays to bytes
identical (SHA-256) to the file found on disk.

The commits group those writes by their original order:

| Commit | Content | Original writes (UTC, 2026-09-24) |
| ------ | ------- | --------------------------------- |
| 1 | `package.json`, `tsconfig.json`; `LICENSE` (see below) | 16:22–16:23 |
| 2 | `src/home.ts`, `src/events.ts`, `src/preload.ts`, and `src/index.ts` as it stood before the CLI work | 16:26–16:35 |
| 3 | `bin/bare-kimi.ts` and the final `src/index.ts` | 16:36–16:41 |
| 4 | Tests and the fake `kimi` child | 16:42–16:48 |
| 5 | `.gitignore`, `bun.lock`, `README.md` and this file | — |

- Every source file in commits 1–4 is byte-identical to a replayed state.
  Intermediate edits within a group are not separate commits.
- Commit dates are recovery dates. The times above give the original
  chronology.
- Attribution: Kimi Code (an AI coding agent) wrote the source for Alexander
  Gladysh. Codex carried out the recovery.

## Not recovered, not claimed

- No recovered Write/Edit call wrote `.gitignore` or `bun.lock`. Both are
  included as found on disk. How they were produced was not recovered.
- File modes come from disk, not from replay. The fake `kimi` child is
  executable.
- No test, typecheck or live-run result is claimed for any commit, and
  intermediate commits are not claimed to build.
- The session's progress log is left out of this repository because it
  contains local filesystem paths. It is kept privately, unaltered.
- Live captures that code comments refer to (`runtime/…`) are local and not
  published.
- At the recovered commits, `package.json` lists `CHANGELOG.md` under
  `files`, but no changelog exists. One was added with the later repair
  candidate.
- Known defects in home assembly, authentication handling and thinking
  handling are not fixed in the recovered commits.

## Checks on the recovered tree

These checks ran after recovery, on the final recovered commit, with Bun
1.3.13 and installed dependencies whose relevant versions were checked
against `bun.lock`. They describe the
recovered bytes, not the later repair.

- `bun run check` failed at the typecheck: `test/helpers.ts` lines 106–107,
  `subprocess.stdin` is possibly undefined (TS18048). Tests did not run in
  that invocation.
- `bun test` on its own: 65 passed, 2 failed.
  - The leading-dash prompt test expected the library's refusal message. The
    CLI's argument parser refused `-x` first, with its own message (exit 2).
  - One `isKimiStreamEvent` table case (an empty-array row) was run as a
    test expecting a done callback and timed out.

## After recovery

[CHANGELOG.md](CHANGELOG.md) describes a repair candidate made after
recovery. It is ordinary new work, not recovered history. Its results are
whatever its own checks show when they are run; none are recorded here.

## License provenance

The original session wrote its own license text. That text is not used here.
`LICENSE` is the SPDX MIT text downloaded from
<https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt>.
Only one line was changed: `Copyright (c) <year> <copyright holders>` was
replaced with `Copyright (c) 2026 Alexander Gladysh <agladysh@gmail.com>`.
