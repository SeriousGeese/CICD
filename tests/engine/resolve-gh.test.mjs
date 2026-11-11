import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// engine/resolve-gh.sh is run for real against stub gh binaries in a temp dir.
// The case that motivated the probe (2026-11-11, artemis-promptci-pr-review): an
// executable gh that dies on launch with a glibc symbol error was accepted by the
// old `[ -x ]` check, and every review on that runner then held its PR.
const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'engine',
  'resolve-gh.sh',
);

/** Bash-facing (forward-slash) form of a Windows path. */
const posix = (p) => p.split(path.sep).join('/');

let dir;
let working;
let broken;
let impostor;
let notExecutable;

function stub(name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cicd-resolve-gh-'));
  working = stub('gh-working', 'echo "gh version 2.103.3 (2026-10-26)"; echo "https://github.com/cli/cli/releases/tag/v2.103.3"');
  broken = stub(
    'gh-broken',
    'echo "/home/linuxbrew/.linuxbrew/bin/gh: symbol lookup error: /run/host/usr/lib64/libc.so.6: undefined symbol: __pointer_chk_guard, version GLIBC_PRIVATE" >&2; exit 127',
  );
  impostor = stub('gh-impostor', 'echo "hello from something else"');
  notExecutable = path.join(dir, 'gh-plain');
  writeFileSync(notExecutable, 'not a program', 'utf8');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run({ hint = '', candidates = [], download = false, extraEnv = {} } = {}) {
  const envFile = path.join(dir, `github-env-${Math.random().toString(36).slice(2)}`);
  writeFileSync(envFile, '', 'utf8');
  const env = {
    ...process.env,
    GITHUB_ENV: posix(envFile),
    RUNNER_NAME: 'artemis-promptci-pr-review',
    GH_CLI_HINT: hint ? posix(hint) : '',
    RESOLVE_GH_CANDIDATES: candidates.map(posix).join('\n'),
    ...(download ? {} : { RESOLVE_GH_NO_DOWNLOAD: '1' }),
    ...extraEnv,
  };
  const res = spawnSync('bash', [posix(script)], { env, encoding: 'utf8' });
  const exported = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, exported };
}

describe('resolve-gh.sh', () => {
  it('skips an executable gh that crashes on launch and takes the next one that runs', () => {
    const r = run({ candidates: [broken, working] });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(working));
    expect(r.stdout).toContain('gh version 2.103.3');
  });

  it('a broken hint is not fatal', () => {
    const r = run({ hint: broken, candidates: [working] });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(working));
  });

  it('a working hint wins over later candidates', () => {
    const r = run({ hint: working, candidates: [impostor] });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(working));
  });

  it('rejects a binary whose --version does not identify gh', () => {
    const r = run({ candidates: [impostor, working] });
    expect(r.exported.GH_CLI).toBe(posix(working));
  });

  it('exports RUNNER_HOST without the -pr-review suffix', () => {
    const r = run({ candidates: [working] });
    expect(r.exported.RUNNER_HOST).toBe('artemis-promptci');
  });

  it('fails loudly, listing why each candidate was refused, when nothing runs', () => {
    const r = run({ candidates: [broken, impostor, notExecutable, path.join(dir, 'missing')] });
    expect(r.status).toBe(1);
    expect(r.exported.GH_CLI).toBeUndefined();
    expect(r.stdout).toContain("::error::No working gh CLI on runner 'artemis-promptci-pr-review'");
    expect(r.stdout).toContain('symbol lookup error');
    expect(r.stdout).toContain('did not identify gh');
    expect(r.stdout).toContain('pinned download: disabled');
  });

  // The download path needs Linux (uname, sha256sum, the linux tarball names).
  // CI's ubuntu job runs it; the Windows gate skips this case only.
  it.skipIf(process.platform !== 'linux')(
    'refuses a downloaded tarball whose sha256 does not match the pin',
    () => {
      const base = path.join(dir, 'fake-release');
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      mkdirSync(path.join(base, 'v2.103.3'), { recursive: true });
      writeFileSync(
        path.join(base, 'v2.103.3', `gh_2.103.3_linux_${arch}.tar.gz`),
        'tampered bytes',
        'utf8',
      );
      const cache = path.join(dir, 'tool-cache');
      const r = run({
        candidates: [broken],
        download: true,
        extraEnv: { RESOLVE_GH_DOWNLOAD_BASE: `file://${base}`, RUNNER_TOOL_CACHE: cache },
      });
      expect(r.status).toBe(1);
      expect(r.exported.GH_CLI).toBeUndefined();
      expect(r.stdout).toContain('sha256 mismatch');
      expect(r.stdout).toContain('refusing to run it');
    },
  );
});
