import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// pr-review.sh is a bash script with no JS-testable surface, so the sanitation
// logic (added for the "HTTP 401 Missing Authentication header despite a
// non-empty OPENROUTER_API_KEY" bug) was extracted into its own file,
// sanitize-secret.sh, specifically to make it reachable from a test. That file
// doubles as a CLI: run directly (not sourced) it prints sanitize_secret()'s
// output for its one argument, which is what these specs invoke.
// Subject lives in engine/, tests in tests/engine/ — in promptci-cloud these were
// co-located under scripts/, so the original resolved its subject as its own dir.
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'engine',
  'sanitize-secret.sh',
);

function sanitize(rawValue) {
  return execFileSync('bash', [scriptPath, rawValue], { encoding: 'utf8' });
}

describe('sanitize_secret (scripts/sanitize-secret.sh)', () => {
  it('leaves an already-clean key unchanged', () => {
    expect(sanitize('sk-or-v1-abc123')).toBe('sk-or-v1-abc123');
  });

  it('strips a trailing newline', () => {
    expect(sanitize('sk-or-v1-abc123\n')).toBe('sk-or-v1-abc123');
  });

  it('strips a trailing CRLF', () => {
    expect(sanitize('sk-or-v1-abc123\r\n')).toBe('sk-or-v1-abc123');
  });

  it('strips a leading newline', () => {
    expect(sanitize('\nsk-or-v1-abc123')).toBe('sk-or-v1-abc123');
  });

  it('strips embedded tabs and surrounding spaces, not just the ends', () => {
    expect(sanitize('  sk-or\tv1-abc123  ')).toBe('sk-orv1-abc123');
  });

  it('normalizes a whitespace-only value to empty', () => {
    expect(sanitize('   \t\n  ')).toBe('');
  });

  it('normalizes an empty value to empty', () => {
    expect(sanitize('')).toBe('');
  });
});
