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
let lazyCrash;
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
  // The artemis shape: --version works, the first API call dies (lazy binding,
  // host NSS modules against brew glibc).
  lazyCrash = stub(
    'gh-lazy-crash',
    [
      'if [ "$1" = "--version" ]; then echo "gh version 2.103.3 (2026-10-26)"; exit 0; fi',
      'echo "/home/linuxbrew/.linuxbrew/bin/gh: symbol lookup error: /run/host/usr/lib64/libc.so.6: undefined symbol: __pointer_chk_guard, version GLIBC_PRIVATE" >&2',
      'exit 127',
    ].join('\n'),
  );
  notExecutable = path.join(dir, 'gh-plain');
  writeFileSync(notExecutable, 'not a program', 'utf8');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run({ hint = '', candidates = [], download = false, extraEnv = {} } = {}) {
  const envFile = path.join(dir, `github-env-${Math.random().toString(36).slice(2)}`);
  writeFileSync(envFile, '', 'utf8');
  const runnerTemp = mkdtempSync(path.join(dir, 'runner-temp-'));
  const env = {
    ...process.env,
    GITHUB_ENV: posix(envFile),
    RUNNER_NAME: 'artemis-promptci-pr-review',
    RUNNER_TEMP: posix(runnerTemp),
    GH_CLI_HINT: hint ? posix(hint) : '',
    RESOLVE_GH_TEST: '1',
    RESOLVE_GH_CANDIDATES: candidates.map(posix).join('\n'),
    // The job always has a token; make the API probe deterministic here.
    GH_TOKEN: 'test-token',
    GITHUB_TOKEN: '',
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

  it('skips a gh whose --version works but whose first API call crashes', () => {
    const r = run({ candidates: [lazyCrash, working] });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(working));
  });

  it('reports the API-call crash when it is the only candidate', () => {
    const r = run({ candidates: [lazyCrash] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('runs, but crashed on an API call (rc=127)');
    expect(r.stdout).toContain('__pointer_chk_guard');
  });

  it('a gh that runs but gets an HTTP error back is accepted (the API said no, the binary works)', () => {
    const refused = stub(
      'gh-refused',
      [
        'if [ "$1" = "--version" ]; then echo "gh version 2.103.3 (2026-10-26)"; exit 0; fi',
        'echo "HTTP 502: Bad Gateway (https://api.github.com/rate_limit)" >&2',
        'exit 1',
      ].join('\n'),
    );
    const r = run({ candidates: [refused, working] });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(refused));
    expect(r.stdout).toContain('probe API call was refused (rc=1): HTTP 502');
  });

  it('a loader error with a plain rc=1 still counts as a crash', () => {
    const wrapped = stub(
      'gh-wrapped-crash',
      [
        'if [ "$1" = "--version" ]; then echo "gh version 2.103.3 (2026-10-26)"; exit 0; fi',
        'echo "gh: error while loading shared libraries: libfoo.so: cannot open shared object file" >&2',
        'exit 1',
      ].join('\n'),
    );
    const r = run({ candidates: [wrapped, working] });
    expect(r.exported.GH_CLI).toBe(posix(working));
  });

  it('without a token, --version alone decides (no API call is possible)', () => {
    const r = run({ candidates: [lazyCrash], extraEnv: { GH_TOKEN: '', GITHUB_TOKEN: '' } });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(lazyCrash));
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

  it('accepts a gh that warns on stderr but identifies itself on stdout', () => {
    const noisy = stub('gh-noisy', 'echo "warning: config is old" >&2; echo "gh version 2.103.3 (2026-10-26)"');
    const r = run({ candidates: [noisy] });
    expect(r.status).toBe(0);
    expect(r.exported.GH_CLI).toBe(posix(noisy));
  });

  // The download path needs Linux (uname, sha256sum, the linux tarball names).
  // CI's ubuntu job runs these; the Windows gate skips these cases only.
  describe.skipIf(process.platform !== 'linux')('pinned download (Linux)', () => {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const name = `gh_2.103.3_linux_${arch}`;
    const pinned = readFileSync(script, 'utf8').match(
      new RegExp(`GH_SHA256_LINUX_${arch.toUpperCase()}="([0-9a-f]{64})"`),
    )[1];

    /** A release dir holding a tarball with the official layout: <name>/bin/gh. */
    function fakeRelease(label, ghBody) {
      const base = path.join(dir, `release-${label}`);
      const stage = path.join(dir, `stage-${label}`, name, 'bin');
      mkdirSync(stage, { recursive: true });
      writeFileSync(path.join(stage, 'gh'), `#!/usr/bin/env bash\n${ghBody}\n`, 'utf8');
      chmodSync(path.join(stage, 'gh'), 0o755);
      mkdirSync(path.join(base, 'v2.103.3'), { recursive: true });
      const tar = spawnSync('tar', [
        '-czf',
        path.join(base, 'v2.103.3', `${name}.tar.gz`),
        '-C',
        path.join(dir, `stage-${label}`),
        name,
      ]);
      expect(tar.status).toBe(0);
      return base;
    }

    /** A PATH dir whose sha256sum reports the pinned hash for any file. */
    function trustingSha256sum() {
      const bin = path.join(dir, 'fake-sha-bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, 'sha256sum'),
        `#!/usr/bin/env bash\necho "${pinned}  $1"\n`,
        'utf8',
      );
      chmodSync(path.join(bin, 'sha256sum'), 0o755);
      return `${bin}:${process.env.PATH}`;
    }

    it('refuses a downloaded tarball whose sha256 does not match the pin', () => {
      const base = fakeRelease('tampered', 'echo "gh version 2.103.3 (evil)"');
      const r = run({
        candidates: [broken],
        download: true,
        extraEnv: {
          RESOLVE_GH_DOWNLOAD_BASE: `file://${base}`,
          RUNNER_TOOL_CACHE: path.join(dir, 'cache-tampered'),
        },
      });
      expect(r.status).toBe(1);
      expect(r.exported.GH_CLI).toBeUndefined();
      expect(r.stdout).toContain('sha256 mismatch');
      expect(r.stdout).toContain('refusing to run it');
    });

    it('extracts a verified tarball, caches only the tarball, and reuses it', () => {
      const base = fakeRelease('good', 'echo "gh version 2.103.3 (2026-10-26)"');
      const cache = path.join(dir, 'cache-good');
      const env = {
        RESOLVE_GH_DOWNLOAD_BASE: `file://${base}`,
        RUNNER_TOOL_CACHE: cache,
        PATH: trustingSha256sum(),
      };
      const first = run({ candidates: [broken], download: true, extraEnv: env });
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('using the pinned official release');
      expect(first.exported.GH_CLI).toMatch(new RegExp(`/gh-pinned\\.[^/]+/${name}/bin/gh$`));
      const cachedTarball = path.join(cache, 'gh-pinned', '2.103.3', `${name}.tar.gz`);
      expect(readFileSync(cachedTarball).length).toBeGreaterThan(0);

      // Second run: the release is gone, so only the cached tarball can satisfy it.
      rmSync(base, { recursive: true, force: true });
      const second = run({ candidates: [broken], download: true, extraEnv: env });
      expect(second.status).toBe(0);
      expect(second.exported.GH_CLI).not.toBe(first.exported.GH_CLI);
    });
  });
});
