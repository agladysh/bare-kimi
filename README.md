# bare-kimi

bare-kimi runs Kimi Code CLI (`kimi -p`) headless in a run home of its own
(`KIMI_CODE_HOME`), on the login of an existing Kimi Code home, the source
home. Each run gets its own configuration and sessions, and the login is
shared. bare-kimi selects the model alias and thinking effort that a run home
carries, and keeps a kept home on that model and effort. Before it changes
anything, it refuses selections that kimi was observed not to honour, and
arguments or environment variables that would silently override them. Some
further refusals are stated policy where kimi's behaviour was not observed.
It is a Bun library first. The CLI
(`bin/bare-kimi.ts`) is its worked example.

**Status: 0.3.0, early (pre-1.0).** Each release is a Git tag of this
repository. Nothing is published to a package registry. 0.3.0 adds model and
effort selection, pins each kept home to its model and effort, upgrades homes
kept by 0.2 and, when asked, adopts homes kept before 0.2. Some of these
changes break existing uses; see [CHANGELOG.md](CHANGELOG.md).
[RECOVERY.md](RECOVERY.md) records how the project was recovered into Git
before 0.2.0. [What has been observed](#what-has-been-observed) separates
behaviour seen with an installed kimi from behaviour that has not been
checked.

## Containment: what bare-kimi does not do

bare-kimi gives kimi a run home of its own, with its own configuration and
sessions. It does not give kimi a login of its own. In link mode, the
default, the run shares the source home's login by design, and a token
refresh writes into the source home. Nor does bare-kimi limit what kimi
does. In `-p` mode kimi runs in its auto permission mode, which approves
tool calls. bare-kimi copies the source home's `[permission]` rules into the
run home unchanged. In a probe run of installed kimi 2.1.0 in `-p` mode,
kimi accepted a valid deny rule for `Bash` without a section-drop warning
and still ran the `Bash` call. A carried rule is therefore no protection, at
least for that version and mode. Nothing here is promised for other
versions, modes or the interactive UI. A run is contained only from outside,
by an OS sandbox, a container or a restricted account. A fix for the rules
themselves belongs in kimi, not in this wrapper.

## Installation

Bun 1.3 or later and a separately installed Kimi Code CLI are required. The
release contains the TypeScript source. No package registry or machine-wide
installation is needed.

From a checkout:

```sh
git clone --branch v0.3.0 https://github.com/agladysh/bare-kimi.git
cd bare-kimi
bun install --frozen-lockfile
bun bin/bare-kimi.ts --help
```

As a Git dependency of a Bun project:

```sh
bun add github:agladysh/bare-kimi#v0.3.0
```

The package exports its TypeScript files as they are and calls Bun's APIs,
so it runs only under Bun. A consumer that type-checks it with `tsc` needs
settings like this repository's `tsconfig.json`, in particular
`allowImportingTsExtensions` and Bun's types.

## Running

Three CLI runs show the common shapes. `ALIAS` stands for a model alias
configured in the source home's `config.toml`, and `SESSION_ID` for the
session id that kimi reports.

```sh
# A fresh run in a temporary home, on the source's default model and [thinking].
bun bin/bare-kimi.ts -- "List the TODO comments under src/."

# A kept home, created on a selected model and effort.
bun bin/bare-kimi.ts --home runs/review --model ALIAS --effort high --json \
  -- "Review the uncommitted changes."

# A resumed session in that home, from the same working directory.
bun bin/bare-kimi.ts --home runs/review --json --resume SESSION_ID \
  -- "Which of those changes carries the most risk?"
```

With `--json`, stdout carries kimi's stream-json events. The session id is in
its `session.resume_hint` line. Every CLI run also prints one line on stderr
that names what the run was routed to, for example:

```text
bare-kimi: routed to model "ALIAS" (selected; provider type kimi, model id ID), effort "high" (selected, declared)
```

The line gives the model alias and where it came from, the provider type and
model id, and either the pinned effort with its origin and support or the
effort that `config.toml` gives new sessions. On a resume it also says that
the session keeps its stored effort and alias. It names no path, URL or
credential. `--help` lists every option and exit code.

The library takes the same choices:

```ts
import { KimiCustodyError, runKimi } from '@agladysh/bare-kimi';

try {
  const run = await runKimi({
    prompt: 'Review the uncommitted changes.',
    cwd: '/path/to/project',
    home: '/path/to/runs/review',
    model: 'ALIAS',
    effort: 'high',
    outputFormat: 'stream-json',
  });
  console.log(run.code, run.sessionId, run.assembled?.modelAlias, run.assembled?.effort);
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
afterwards. The source home is `srcHome`, else `KIMI_CODE_HOME_SOURCE`, else
the source that a kept home's stamp records, else `~/.kimi-code`. The last
fallback is refused when an ambient `KIMI_CODE_HOME` names another home. A
source named explicitly that differs from a kept home's stamp is refused.
Credentials are linked unless `authMode: 'copy'`. Setup refusals throw, and a
`kimi` that cannot be started resolves with code 127. `run.assembled`, and
`assembled` on the subprocess handle, report how the run home was prepared:
its model alias, provider type, model id, pinned and configured effort,
effort support, whether it was created, reused or adopted, and how a 0.2
home's alias was established. For the subprocess itself, `spawnKimi` is the
entry point, and for preload, `runPreloaded` from
`@agladysh/bare-kimi/preload`. `previewRunHome` answers what preparing a
home would do, and refuses what preparing would refuse, without any effect
on either home. The options are documented in `src/index.ts` and
`src/home.ts`.

## Choosing a model and an effort

**Model.** `model` (CLI `-m`, `--model`) names the model alias the run home
carries as its `default_model`. The alias must be configured in the source
home's `config.toml`. The run home receives only that model's table and its
provider's tables. The source's other models and providers are not copied,
because their tables may hold keys that the run does not use. Without
`model`, a new home carries the source's `default_model`.

**Effort.** `effort` (CLI `--effort`) chooses the thinking effort for the
sessions that the run home creates: one of the model's `support_efforts`, or
`off`. bare-kimi writes it into the run home's `[thinking]` table, as
`enabled = false` for `off` and as `enabled = true` with `effort` otherwise.
The source's other `[thinking]` keys, such as `keep`, are kept when they are
plain strings or booleans. A source `[thinking]` that sets a forced effort,
or holds another kind of value, is refused beside a selected effort. Without
`effort`, a new home carries the source's `[thinking]` table verbatim.

The effort is checked against what the source `config.toml` declares for the
model, with its `[models."…".overrides]` applied as kimi applies them, and
against its provider's `type`. That file is what kimi 2.1.0 reads in `-p`
mode. The checks refuse, before any effect:

- an effort missing from the model's `support_efforts`. On a `kimi`-type
  provider, kimi was observed to replace such an effort with a listed one;
- on a `kimi`-type provider, any effort but `off` for a model that lists no
  `support_efforts`. kimi was observed to send no level for such a model;
- `off` for a model that lists `support_efforts` without an `off_effort`,
  except on a `kimi`-type provider. On an `openai`-type provider kimi was
  observed to fail before sending any request;
- `off` for a model whose capabilities list `always_thinking`. On an
  `openai`-type provider kimi was observed to send an effort anyway;
- an effort for a model declared without thinking. This refusal is policy:
  on an `openai`-type provider kimi was observed to send the effort, and
  whether a provider applies it is unknown.

Where a refusal rests on an observation of one provider type and is applied
to another, it is policy there; the observations were made only on `kimi`
and `openai` types, for models that set no `protocol`. `checkEffort` in
[`src/home.ts`](src/home.ts) states the basis of each refusal. An effort
that the configuration says nothing about, for example on an `openai`-type
model that lists no `support_efforts`, is taken and reported as
`undeclared`, and kimi decides at run time what to send. The CLI prints a
notice for it. bare-kimi does not take missing information for missing
support.

**Managed models.** For a model of the managed Kimi Code provider, kimi
itself writes the model's table, including any `support_efforts`, from the
provider's model catalog: at login and in the interactive UI's refresh, and
only when the catalog lists efforts. kimi `-p` does not refresh the catalog,
and neither does bare-kimi. bare-kimi judges the table as the source
`config.toml` holds it and adds no declarations of its own. If a managed
model's table lists no efforts, an effort other than `off` is refused. The
run can then go ahead without an effort, or kimi's own refresh can update
the table. Writing `support_efforts` into a managed model's table by hand
would declare support that the provider never stated, and kimi's next
refresh may replace it.

## Fresh, kept and resumed runs

A session's model alias and effort are fixed when kimi creates the session,
and stored with it. A resume keeps them, whatever `config.toml` says later.
bare-kimi arranges its run homes around that native behaviour.

- **Fresh runs.** Without `home`, every run gets a new temporary home and a
  new session on the selected or default model and effort. The home is
  removed afterwards, unless cleanup has to keep a credentials copy (see
  [What a run touches](#what-a-run-touches)). `--keep-home` keeps it.
- **Kept homes.** A home that the caller names is stamped with the model
  alias and effort it was created with, and is pinned to them. It stays on
  its alias when the source's `default_model` changes. It refuses another
  `model` or `effort` before any effect, so a different model or effort
  needs another home. The alias's own tables, `[permission]`, `[[hooks]]`
  and, when no effort is pinned, `[thinking]` still follow the source. A
  source that no longer configures the pinned alias makes the home refused,
  not switched. A kept home created without an effort has no effort pin.
  New sessions in it take whatever `[thinking]` the source carries at the
  time.
- **Resumed sessions.** `resume` (`--resume`) or `continueRecent`
  (`--continue`) resumes a session in its own working directory; kimi
  refuses a resume from another one. The session keeps the effort it
  stored. bare-kimi passes `--model` only when `model` is given, and on a
  kept home only the pinned alias, so a session created on the pin stays on
  it. On a loopback provider, kimi 2.1.0 was observed to switch a resumed
  session to whatever alias `--model` named. A session created in a 0.2 or
  adopted home under an earlier alias is therefore switched to the pin when
  `model` is given. Without `model`, kimi looks up the session's own alias in
  `config.toml`. That file carries only the pin, so kimi cannot resume such a
  session.
- **Preload.** `--preload` and `runPreloaded` start a fresh session in a
  primer run, append the preloaded files to its journal, and resume it with
  the call to action. Both runs use the same home, so they share its model
  and effort. Preload refuses `resume` and `continueRecent`. The preloaded
  content is sent as input tokens on every resumed turn. It saves tool
  round-trips, not tokens.

A forced effort in the environment would override even a resumed session's
stored effort, so bare-kimi refuses one on a home pinned to an effort (see
[Environment](#environment)).

## Upgrading from 0.2

A home kept by bare-kimi 0.2 carries a version-1 stamp, which pinned no
model. Such a home followed the source's `default_model`. The first 0.3 run
on it pins it to an alias, writes a version-2 stamp, and records in the
stamp how the alias was established. That record, the basis, is one of:

- `config`: the `default_model` of the home's `config.toml`, which still
  held the settings that 0.2 last wrote;
- `digest`: `config.toml` was missing, and exactly one alias, as the source
  yields it now, reproduces the settings digest in the 0.2 stamp;
- `caller`: `config.toml` was missing, no alias reproduced the digest, and
  the caller named the alias with `model`. That is the caller's assertion,
  not evidence from the home;
- `source-default`: the source's `default_model` at the upgrade. This basis
  applies when `config.toml` held other settings than the stamp records but
  exactly what the source yields for that alias, or when `config.toml` was
  missing from a home with no sessions.

A 0.2 home with sessions, no `config.toml`, and no alias that reproduces its
digest is refused until the caller names the alias. A `config.toml` that
was edited to something the source does not yield is refused, as in 0.2.
The CLI's routing line names the basis, and `assembled.migrated` reports it.
`previewRunHome` shows the basis before anything is written. No basis shows
which alias older sessions are bound to: sessions created before
`default_model` last changed may be on another alias (see Resumed sessions
above).

**The upgrade is one-way.** bare-kimi 0.2.0 and 0.2.1 read only version-1
stamps, and they refuse a home once 0.3 has rewritten its stamp. 0.3 has no
path that writes a version-1 stamp again. A consumer that has to keep
running 0.2 on a home must keep that home away from 0.3.

Other changes that can break a 0.2 consumer are listed in
[CHANGELOG.md](CHANGELOG.md): the model pin itself, arguments refused in
`extraArgs`, environment variables refused in `extraEnv`, newly scrubbed
variables, and the routing line on stderr.

## Adopting a home kept before 0.2

A home kept by bare-kimi before 0.2 has no stamp. 0.2 refused such homes.
0.3 adopts one only when the caller asks for it, with `adoptLegacyHome`
(CLI `--adopt-legacy-home`) on a caller-supplied home, and only when the
home's own shape shows that it was assembled from this source:

- the run-home path is not a symlink, and the home is neither the source
  home nor nested with it;
- its `config.toml` parses and names a `default_model` whose model and
  provider tables it holds; the source configures the same alias on the same
  provider, and that provider's table is identical in both, because the
  credential slot depends on it;
- its `credentials` is a link into this source, with `oauth` absent or the
  paired link; or a bare-kimi credentials copy; or, in copy mode only,
  absent;
- its `sessions`, when present, is a real directory.

Adoption writes `.bare-kimi-adopted/` into the home first. That directory
holds the home's original `config.toml`, byte for byte, and a
`manifest.json` that records the source, the alias, any effort that the old
file configured for new sessions, how credentials were held, and the
SHA-256 of every file under `sessions/`. bare-kimi then stamps the home and
rewrites `config.toml` from the source. From then on the source's
`[permission]` and `[[hooks]]` apply to the home, and its other settings are
gone from the live file. `sessions/` is never changed. bare-kimi provides no
command that undoes an adoption. The original file stays in the record for
inspection or manual restore.

An adopted home is pinned to the alias that its found `config.toml` named.
When the found `[thinking]` differed from the source's and named an effort,
the home is pinned to that effort too, and the effort is checked like a
selected one. Those pins describe what the found file configured for new
sessions. They say nothing about the alias or effort with which existing
sessions were created. An interrupted adoption is completed by the next
adoption request, or, once the stamp has been written, by the next run.

## Environment

The child inherits the parent environment, unless `noProcessEnv`
(`--no-process-env`), minus:

- `KIMI_CODE_BASE_URL`, `KIMI_CODE_OAUTH_HOST` and `KIMI_OAUTH_HOST`, which
  would move the managed provider's endpoints and with them the credential
  slot;
- `KIMI_DISABLE_OAUTH_LOCK`, which would opt out of the shared refresh lock;
- every `KIMI_MODEL_*` variable, including the thinking-effort overrides;
- every `KIMI_SECONDARY_*` variable, the secondary (subagent) model and
  effort overrides;
- any `KIMI_CODE_HOME`.

bare-kimi then sets `KIMI_CODE_HOME` to the run home, which cannot be
overridden, and `KIMI_CODE_HOME_SOURCE` to the source home, so that a
bare-kimi started inside the run donates from the same login. It also sets
`KIMI_DISABLE_TELEMETRY=1` and `KIMI_CODE_NO_AUTO_UPDATE=1` unless they are
already set.

The CLI cannot restore a dropped variable. The library's `extraEnv`, and
the `env` of Bun's spawn options, can, with these limits:

- **`KIMI_MODEL_THINKING_EFFORT`** forces an effort on every request of the
  process, resumed sessions included, on provider types that drive thinking
  through kimi's thinking trait (the `kimi` type does). kimi 2.1.0 was
  observed to send a forced value even when the model does not list it. A
  non-blank value is refused beside `effort` and on a home pinned to an
  effort. A blank value is treated as unset, as kimi treated it. On a home
  that follows the source's `[thinking]` the variable stays available.
- **`KIMI_MODEL_THINKING_KEEP`** is taken on any launch. In kimi 2.1.0 it
  did not switch the model, and on a `kimi`-type provider it reached the
  request as `thinking.keep`.
- **Any other `KIMI_MODEL_*` variable** can feed kimi's env-model overlay,
  which replaces the configured model with an environment-defined one. A
  non-blank `KIMI_MODEL_NAME`, with a base URL and key, was observed to switch
  a new session to that model and to send no configured effort. Such
  variables are taken only by an ephemeral launch without `model` and
  `effort`, and never by preload. That launch's `modelOverlay` names the
  variable, and `assembled` then does not establish which model kimi runs.
  Every other use is refused before any effect.
- **`KIMI_SECONDARY_MODEL` and `KIMI_SECONDARY_EFFORT`** can be set again on
  purpose. Their effect in `-p` without a `[secondary_model]` table has not
  been established beyond one tool-free turn, in which they changed nothing
  observed.

## Arguments passed to kimi

`extraArgs` (CLI `--kimi-arg`, repeatable) are passed to kimi verbatim,
before `-p`. Arguments that kimi 2.1.0's parser reads as selecting a model or
a session are refused: `-m`, `--model`, `-S`, `--session`, `-r`, `--resume`,
`-c`, `--continue` and `-C`, in every spelling that parser accepts, such as
`--model=X`, `-mX` or a cluster like `-yc`. A model belongs in `model`, so
that the run home carries it. A session belongs in `resume` or
`continueRecent`, so that their exclusivity and preload's fresh session
hold. An argument meant as the value of the one before it is read the same
way, so a value that looks like one of these flags is refused too. Other
arguments are not checked. bare-kimi does not check whether they conflict
with its own `-p` and `--output-format`, or whether an agent profile chosen
through `--agent` selects a model.

The prompt, and the preload primer, may not start with `-`, because kimi
could read it as a flag.

## What a run touches

- **The run home** (`KIMI_CODE_HOME`) is created with mode 0700 when it is
  missing. An existing directory is used only when it is empty, already a run
  home, or adopted on request, and it keeps its permissions. Its
  `config.toml` carries `default_model` naming the selected or pinned alias,
  that model's `[models."…"]` table, its provider's `[providers."…"]`
  tables, and the source's `[permission]` and `[[hooks]]` tables, verbatim.
  It carries the source's `[thinking]` verbatim, or the selected effort's
  `[thinking]` in its place. The source config is checked with smol-toml,
  the TOML parser family that kimi uses, pinned to a release without the
  known denial-of-service defects of the version that kimi 2.1.0 bundles.
  The source config is refused before anything is written if the parser
  rejects it, or if any carried table is written in a form that cannot be
  carried verbatim. kimi drops a config section that fails its schema as a
  whole, with only a warning. In kimi 2.1.0 a string rule such as
  `deny = ["Bash"]` drops all of `[permission]`, and one invalid
  `[[hooks]]` entry disables every hook. Hooks are loaded and run.
- **Ownership.** A run home that bare-kimi assembled carries
  `.bare-kimi-home`. That stamp records the canonical source home, the
  pinned model alias and effort, a digest of the settings in the
  `config.toml` it wrote, and, where they apply, adoption and the 0.2
  upgrade basis. Anything else is refused, including another tool's
  directory that happens to hold a `config.toml`. A reused home's
  `config.toml` is kept byte for byte while its settings match what the
  source yields, comments included. It is rewritten when the source changed,
  and refused when it was edited to something else. kimi creates a
  `device_id` in every new run home and sends it to the provider, so each
  ephemeral run appears there as a new device.
- **The source home**, in link mode (the default): `credentials/` and
  `oauth/` are shared through directory symlinks. When kimi refreshes a
  token it writes the new token into the source's `credentials/` (temporary
  file, then rename), sets that directory to 0700, and takes its refresh
  lock under the source's `oauth/`. bare-kimi creates the source's `oauth/`
  when it is missing.
- **Copy mode** copies the token files and stamps them with their SHA-256.
  Cleanup discards a copy only when it is provably unchanged, or identical
  to the source. A changed copy may hold the only current refresh token, so
  it is kept, and the CLI exits 4.
- **Not hermetic.** AGENTS.md files and skills still load, the parent
  environment is inherited unless `--no-process-env`, and hooks from the
  source config run as configured.

## What has been observed

bare-kimi runs whatever `kimi` it is given and does not check its version.
Its checks were written against installed Kimi Code 2.1.0 and observed with
it. Code comments that cite kimi 2.1.0 come from reading the installed 2.1.0
npm bundle, not the upstream repository. Comments that cite kimi-code
`6451f1e` or kimi 2.0.1 are the original author's statements and were not
re-verified during recovery.

**Loopback probes.** Two optional probes run an installed kimi under macOS
`sandbox-exec` against a loopback stand-in for a model provider, with
synthetic homes and dummy credentials. They are not part of `bun test`.
[`probe/native-loopback.ts`](probe/native-loopback.ts) covers how kimi
treats a run home's permission rules, hooks, invalid sections, preload and
carried thinking effort.
[`probe/model-effort-loopback.ts`](probe/model-effort-loopback.ts) covers
model and effort selection, resume, the forced effort, the env-model overlay
and the secondary-model variables. It also needs the path and SHA-256 of
bare-claude's lifecycle module, which it uses to supervise process groups.
Both share the isolation checks in [`probe/isolation.ts`](probe/isolation.ts).
Each probe's header states its method and limits. Their reports name
private paths and must stay private. With kimi 2.1.0 in `-p` mode, on one
macOS machine, with one prompt per case and scripted provider replies, the
probes observed:

- `--help` declares no thinking or effort option; hidden options were not
  covered;
- on an `openai`-type provider, kimi sent a configured effort as given, also
  for a model declared without thinking;
- on a `kimi`-type provider, kimi sent a listed effort, replaced an unlisted
  one with a listed one, sent no level for a model that lists no
  `support_efforts`, and sent a disabled thinking type for `off`;
- a session kept its stored effort over a later `config.toml` on both
  provider types, and its stored alias over a changed `default_model` on the
  `openai` type. `--model` on a resume switched the request to the named
  alias;
- the forced effort, the env-model overlay, `KIMI_MODEL_THINKING_KEEP` and
  the secondary-model variables behaved as described under
  [Environment](#environment);
- a schema-valid deny rule did not stop a tool call, and carried hooks fired.

**A real managed login.** bare-kimi 0.3.0 was also run against the managed
Kimi Code provider, on an existing login in link mode, with installed kimi
2.1.0. The model was the source's default managed alias, of the `kimi` type,
whose table listed both `low` and `high`. Three calls were made. One kept
home was created with `--model` naming that alias and `--effort low`, and
another with `--effort high`. Each answered its prompt and exited 0. The
first home's session was then resumed without `--model` or `--effort`. It
recalled the earlier turn and exited 0. In each fresh session, kimi's own
session records (`profile.bind`, and the metadata of each `llm.request` in
the session journal) named the alias and the selected effort. The resumed
turn's request metadata still named `low`, and the home's `config.toml` did
not change across the resume.

**Not established:**

- whether a provider applies the effort that kimi sends; the observations
  are of what kimi recorded or sent, not of the model's reasoning;
- a token refresh against a real account, a forced refresh, or a refresh
  race under the shared lock;
- other kimi versions, other modes and output formats, the interactive UI,
  subagents and hidden flags;
- provider types other than `kimi` and `openai`, and models that set
  `protocol`;
- whether any consumer has adopted 0.3.0.

A nested bare-kimi, started from a hook or tool inside a run, donates from
the same source home, because the child environment carries
`KIMI_CODE_HOME_SOURCE`.

## Contents

- `src/home.ts`: assembles, reuses, upgrades and adopts run homes from a
  source home's `config.toml`; pins model and effort and checks the effort;
  gives a home credentials by directory symlink (`link`, the default) or by
  stamped copy (`copy`); removes ephemeral homes under guard. Its header
  comment states who owns which files, what each step changes, and that
  every refusal happens before the first change.
- `src/index.ts`: `spawnKimi` and `runKimi`, which build the argv and the
  child environment and check the environment and forwarded arguments.
- `src/events.ts`: types and guards for `kimi -p --output-format stream-json`
  output.
- `src/preload.ts`: experimental preload of a synthetic past into a fresh
  session.
- `bin/bare-kimi.ts`: the CLI; `--help` lists options and exit codes.
- `src/*.test.ts`, `test/`: black-box tests against a fake `kimi` child and
  synthetic homes. They contain no real credentials.
- `probe/`: the optional native probes described above.

## License

MIT — see [LICENSE](LICENSE).
