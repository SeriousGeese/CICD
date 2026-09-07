import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tests/engine/**` spawns bash + jq per case (the engine is a 3000-line shell
    // script and is tested by running it, not by reimplementing it). On a loaded
    // machine an individual case drifts past the 5s default even though it finishes
    // fine in isolation, so the ceiling is generous on purpose — it is a guard
    // against a genuinely hung child, not a target.
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
  },
});
