#!/usr/bin/env node
// Tests for the warn-only pre-push dropped-file check .
//
// Every test asserts `status === 0` as well as its own subject. That is not
// belt-and-braces padding: warn-only is the whole design, and a check that can
// fail a push is a different (declined) feature. The exit code is therefore an
// assertion in its own right on every path, including the paths that DO warn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { removeTempDir } from './test-cleanup.mjs';

const hook = fileURLToPath(new URL('./warn-dropped-files.mjs', import.meta.url));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runHook(cwd) {
  return spawnSync(process.execPath, [hook], { cwd, encoding: 'utf8' });
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

// A repo with a synthetic refs/remotes/origin/main. No network and no real
// remote: the check only ever reads that ref, so update-ref is a faithful
// stand-in (the usual approach for a check that only reads that ref).
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hooks-dropped-files-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  // diff.renames defaults to TRUE, which would make the check's explicit -M
  // redundant and the rename test vacuous — removing -M from the source passes
  // it either way. Turning renames off in config is what makes -M load-bearing,
  // and it is also the config a real contributor can have set globally.
  git(root, ['config', 'diff.renames', 'false']);
  write(root, 'README.md', 'base\n');
  write(root, 'src/lib/tracking/tracker.ts', 'export const tracked = true;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  setOriginMain(root);
  return root;
}

function setOriginMain(root, sha) {
  git(root, ['update-ref', 'refs/remotes/origin/main', sha ?? git(root, ['rev-parse', 'HEAD'])]);
}

// Move origin/main forward WITHOUT moving the working branch, exactly as a
// `git fetch` would. Used to prove the baseline is the merge-base and not the
// remote tip.
function advanceOriginMain(root, mutate, message = 'main moves on') {
  const here = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', '--detach']);
  mutate(root);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
  setOriginMain(root);
  git(root, ['checkout', '-q', 'main']);
  assert.equal(git(root, ['rev-parse', 'HEAD']), here, 'the working branch must not have moved');
}

function commitOn(root, mutate, message) {
  mutate(root);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
}

test('a branch that drops nothing says nothing and exits 0', () => {
  const root = repo();
  try {
    commitOn(root, (r) => write(r, 'src/new-feature.ts', 'export const x = 1;\n'), 'add a feature');
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(r.stderr.trim(), '');
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});

test('a file present at the merge-base and absent from the tip is listed', () => {
  const root = repo();
  try {
    commitOn(
      root,
      (r) => rmSync(path.join(r, 'src/lib/tracking/tracker.ts')),
      'rebase onto origin/main',
    );
    const r = runHook(root);
    assert.equal(r.status, 0, 'warn-only: the check must never fail a push');
    assert.match(r.stderr, /\[dropped-files\]/);
    assert.match(r.stderr, /src\/lib\/tracking\/tracker\.ts/);
    assert.match(r.stderr, /1 file present at the merge-base with origin\/main is ABSENT from HEAD/);
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});

// The chosen rule, asserted explicitly: a deletion made by a commit on this
// branch is STILL listed. Filtering it out would be vacuous — the merge-base is
// an ancestor of HEAD, so EVERY drop in the range is recorded by some commit in
// the range, the incident's own included. What the branch commit buys is
// attribution, not suppression.
test('a file deleted by a commit on the branch is listed, attributed to that commit', () => {
  const root = repo();
  try {
    commitOn(
      root,
      (r) => rmSync(path.join(r, 'src/lib/tracking/tracker.ts')),
      'chore: retire the streamer tracker on purpose',
    );
    const r = runHook(root);
    assert.equal(r.status, 0, 'warn-only: the check must never fail a push');
    assert.match(r.stderr, /src\/lib\/tracking\/tracker\.ts/);
    assert.match(r.stderr, /removed by [0-9a-f]+ "chore: retire the streamer tracker on purpose"/);
    assert.doesNotMatch(r.stderr, /no commit in this range records the deletion/);
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});

// The baseline test. A file main gained AFTER the branch point is legitimately
// absent from the tip and must NOT be reported; against origin/main's TIP it
// would be, and that is the noise the merge-base baseline exists to cut.
test('a file main gained after the branch point is NOT reported', () => {
  const root = repo();
  try {
    commitOn(root, (r) => write(r, 'src/mine.ts', 'export const mine = 1;\n'), 'my work');
    advanceOriginMain(root, (r) => write(r, 'src/lib/campaigns/brand-new-on-main.ts', 'export const y = 2;\n'));

    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '', 'files main gained after the branch point are not drops');
    assert.doesNotMatch(r.stderr, /brand-new-on-main/);
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});

test('a renamed file is not reported as dropped', () => {
  const root = repo();
  try {
    commitOn(
      root,
      (r) => {
        git(r, [
          'mv',
          'src/lib/tracking/tracker.ts',
          'src/lib/tracking/progress.ts',
        ]);
      },
      'rename the tracker',
    );
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '', 'a file that MOVED is not a file that vanished');
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});

test('with no origin/main ref the check is silent and exits 0', () => {
  const root = repo();
  try {
    commitOn(
      root,
      (r) => rmSync(path.join(r, 'src/lib/tracking/tracker.ts')),
      'delete something',
    );
    git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const r = runHook(root);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});

// Signal quality: a legitimate mass delete must never become a wall of text.
test('a large drop is capped, not dumped, and still exits 0', () => {
  const root = repo();
  try {
    const paths = [];
    for (let i = 0; i < 30; i += 1) paths.push(`src/lib/monsters/bulk-${i}.ts`);
    commitOn(root, (r) => paths.forEach((p) => write(r, p, 'export const v = 1;\n')), 'add bulk');
    setOriginMain(root);
    commitOn(root, (r) => paths.forEach((p) => rmSync(path.join(r, p))), 'remove bulk');

    const r = runHook(root);
    assert.equal(r.status, 0, 'warn-only: the check must never fail a push');
    assert.match(r.stderr, /30 files present at the merge-base/);
    assert.match(r.stderr, /… and 10 more/);
    const listed = r.stderr.split('\n').filter((l) => /bulk-\d+\.ts/.test(l));
    assert.equal(listed.length, 20, 'exactly MAX_LISTED paths are printed');
  } finally {
    removeTempDir(root, 'warn-dropped-files.node-test');
  }
});
