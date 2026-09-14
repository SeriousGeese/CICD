import { configDefaults, defineConfig } from 'vitest/config';

// The extension is required: vitest bundles a config file with rolldown, which
// does not resolve an extensionless relative import the way the test runner's
// own resolver does.
import base from './vitest.config.mts';

/**
 * The Windows gate — `pnpm test:win`.
 *
 * `pnpm test` is red on a Windows dev box and green on CI, and always has been.
 * Four `tests/engine/**` suites assert on Linux-host behaviour; nine cases in
 * them fail on Windows for host reasons that have nothing to do with the code
 * under review. A contributor on Windows therefore cannot tell a regression
 * they caused from the standing baseline without first running `pnpm test` on
 * `main` and diffing the two failure lists by hand — which is what happened on
 * 2026-09-13 (#27, DnD-5xtq6), where the red had to be explained away in the PR
 * body.
 *
 * This config is the defined green a Windows contributor can reach: everything
 * `pnpm test` runs, minus the suites that cannot pass off Linux. It is NOT the
 * project gate. CI stays on `pnpm test` and keeps running all 30 files, so
 * nothing here removes coverage from the only host that votes on a merge.
 *
 * LINUX_ONLY_SUITES is a shrink-only list: an entry may be removed once its
 * suite is made host-agnostic, and one may be added only with a host reason
 * recorded beside it. `tests/contract/windows-gate.test.ts` fails if an entry
 * names a file that no longer exists, so the list cannot rot into a silent
 * exclusion of tests somebody renamed or deleted.
 *
 * Measured on the Windows dev box at `e843500` (main, before any change):
 * `pnpm test` reported Test Files 4 failed | 26 passed, Tests 9 failed | 418
 * passed. Those four files are exactly the four below, so excluding them leaves
 * the 26 that already pass there.
 */
export const LINUX_ONLY_SUITES = [
  // `symlinkSync` throws EPERM without the Windows symlink privilege, and the
  // absolute-path rejection case expects a POSIX absolute path.
  'tests/engine/apply-fixes-containment.test.ts',
  // The bash engine run through Git Bash resolves `$RUNNER_TEMP`-style paths in
  // the Windows form, so the loader prints a `C:/Users/...` path where the
  // assertion expects a `LOADED strict=…` line.
  'tests/engine/feature-flags.test.ts',
  // Bash-engine self-check whose expected output differs when the inline `jq` /
  // `gh` stubs run under MSYS.
  'tests/engine/check-ci-status-equivalence.test.ts',
  // Same class as check-ci-status-equivalence: inline stubs under MSYS.
  'tests/engine/sweep-stranded-reviews.test.ts',
];

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // `exclude` REPLACES vitest's defaults rather than extending them, so the
    // defaults are spread back in explicitly. Dropping them would hand vitest
    // `node_modules/**` to walk.
    exclude: [...configDefaults.exclude, ...LINUX_ONLY_SUITES],
  },
});
