import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasInlineHatch, segmentHasInlineHatch } from './inline-hatch.mjs';

test('segmentHasInlineHatch: bare leading VAR=1', () => {
  assert.equal(segmentHasInlineHatch('AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), true);
});

test('segmentHasInlineHatch: env VAR=1 cmd', () => {
  assert.equal(segmentHasInlineHatch('env AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), true);
});

test('segmentHasInlineHatch: wrapper words before the assignment', () => {
  assert.equal(
    segmentHasInlineHatch('nohup AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH=1 git switch main', 'AGENT_HOOKS_ALLOW_WORKTREE_BRANCH_SWITCH'),
    true,
  );
});

test('segmentHasInlineHatch: rtk / rtk proxy prefix', () => {
  assert.equal(segmentHasInlineHatch('rtk AGENT_HOOKS_ALLOW_NPX_FETCH=1 npx cowsay hi', 'AGENT_HOOKS_ALLOW_NPX_FETCH'), true);
  assert.equal(segmentHasInlineHatch('rtk proxy AGENT_HOOKS_ALLOW_NPX_FETCH=1 npx cowsay hi', 'AGENT_HOOKS_ALLOW_NPX_FETCH'), true);
});

test('segmentHasInlineHatch: wrong variable name does not match', () => {
  assert.equal(segmentHasInlineHatch('AGENT_HOOKS_ALLOW_NPX_FETCH=1 git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), false);
});

test('segmentHasInlineHatch: value other than "1" does not match', () => {
  assert.equal(segmentHasInlineHatch('AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=true git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), false);
  assert.equal(segmentHasInlineHatch('AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=0 git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), false);
});

test('segmentHasInlineHatch: assignment AFTER the command word does not count', () => {
  assert.equal(
    segmentHasInlineHatch('git checkout -- a.png AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'),
    false,
  );
});

test('segmentHasInlineHatch: empty / no assignment at all', () => {
  assert.equal(segmentHasInlineHatch('git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), false);
  assert.equal(segmentHasInlineHatch('', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), false);
  assert.equal(segmentHasInlineHatch(undefined, 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'), false);
});

test('segmentHasInlineHatch: multiple leading assignments, target not first', () => {
  assert.equal(
    segmentHasInlineHatch('FOO=bar AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD=1 git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'),
    true,
  );
});

test('hasInlineHatch: token-array form used directly by a guard', () => {
  assert.equal(
    hasInlineHatch(['AGENT_HOOKS_ALLOW_SHARED_CLAIM_ACTOR=1', 'bd', 'update', 'bd-1', '--claim'], 'AGENT_HOOKS_ALLOW_SHARED_CLAIM_ACTOR'),
    true,
  );
  assert.equal(
    hasInlineHatch(['bd', 'update', 'bd-1', '--claim'], 'AGENT_HOOKS_ALLOW_SHARED_CLAIM_ACTOR'),
    false,
  );
});

test('segmentHasInlineHatch: a leading `do` (for-loop body segment) is skipped like other wrappers', () => {
  assert.equal(segmentHasInlineHatch('do AGENT_HOOKS_ALLOW_CLAIM_STEAL=1 bd update $id --claim', 'AGENT_HOOKS_ALLOW_CLAIM_STEAL'), true);
});

test('hasInlineHatch: an assignment on a DIFFERENT segment must not leak in — the caller is responsible for scoping', () => {
  // This module only ever sees the tokens it is handed; scoping to the right
  // segment is the caller's job (each guard already isolates the matched
  // segment before calling in). This test documents that expectation: a
  // segment that does NOT itself carry the assignment reports false, even
  // though "the command line as a whole" might contain it elsewhere.
  assert.equal(
    segmentHasInlineHatch('git checkout -- a.png', 'AGENT_HOOKS_ALLOW_CHECKOUT_DISCARD'),
    false,
  );
});
