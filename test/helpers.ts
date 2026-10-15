import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fake OAuth token value that must never appear in argv, env or output. */
export const FAKE_TOKEN = 'fake-access-token-0123456789abcdef';

/**
 * A synthetic source home mirroring a managed global-region login: verbatim
 * provider + model sections (env-scoped credential slot), one credential
 * file, and an empty oauth/ lock dir.
 */
export function makeSourceHome(dir: string): string {
  const src = join(dir, 'src-home');
  mkdirSync(join(src, 'credentials'), { recursive: true, mode: 0o700 });
  mkdirSync(join(src, 'oauth'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(src, 'credentials', 'kimi-code-env-0e4f99c69cc27850.json'),
    `${JSON.stringify(
      {
        access_token: FAKE_TOKEN,
        refresh_token: 'fake-refresh-token',
        expires_at: 4_000_000_000,
        expires_in: 3600,
        scope: 'kimi-code',
        token_type: 'Bearer',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(src, 'config.toml'),
    `default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"
api_key = ""

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0e4f99c69cc27850"
oauth_host = "https://auth.kimi.ai"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 262144

[unrelated]
keep = "me"
`,
    { mode: 0o600 },
  );
  return src;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliEnv {
  readonly srcHome: string;
  /** Extra env layered over the safe baseline. */
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly stdin?: string;
}

const BIN = resolve(import.meta.dir, '..', 'bin', 'bare-kimi.ts');
const FAKE_BIN_DIR = resolve(import.meta.dir, 'fake-kimi');

/**
 * Run the real bin/bare-kimi.ts as a subprocess — never imported, never
 * mocked. The baseline env isolates the test from the operator's machine:
 * PATH is shimmed with the fake kimi, HOME and KIMI_CODE_HOME_SOURCE point
 * at synthetic homes, and KIMI_BIN is unset so PATH resolution is exercised.
 */
export async function runCli(args: string[], options: CliEnv): Promise<CliRun> {
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${FAKE_BIN_DIR}:${process.env['PATH'] ?? ''}`,
    HOME: options.srcHome,
    KIMI_CODE_HOME_SOURCE: options.srcHome,
    ...options.env,
  } as Record<string, string>;
  delete env['KIMI_BIN'];
  delete env['KIMI_CODE_HOME'];
  const subprocess = Bun.spawn({
    cmd: ['bun', BIN, ...args],
    cwd: options.cwd ?? process.cwd(),
    env,
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.stdin !== undefined) {
    const sink = subprocess.stdin;
    if (sink === undefined) throw new Error('stdin was requested as a pipe but none was opened');
    sink.write(options.stdin);
    sink.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  const code = await subprocess.exited;
  return { code, stdout, stderr };
}

/** Make the fake child executable once per checkout. */
export function ensureFakeExecutable(): void {
  chmodSync(join(FAKE_BIN_DIR, 'kimi'), 0o755);
}
