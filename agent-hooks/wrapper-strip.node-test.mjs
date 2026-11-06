// Tests for wrapper-strip.mjs: the wrapper and shell-keyword stripping shared by the
// guards in the `guards` set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipCommandPrefix, stripGroupingParens } from './wrapper-strip.mjs';

const words = (s) => s.trim().split(/\s+/).filter(Boolean);
const commandWord = (s, opts) => {
  const toks = words(s);
  return toks[skipCommandPrefix(toks, opts)];
};

test('skips assignments, sudo/nice/command/time/nohup/exec, rtk [proxy] and env [-u X] [-i] [VAR=]', () => {
  assert.equal(commandWord('FOO=1 BAR=2 git status'), 'git');
  assert.equal(commandWord('sudo nice nohup time command exec git status'), 'git');
  assert.equal(commandWord('rtk git status'), 'git');
  assert.equal(commandWord('rtk proxy git status'), 'git');
  assert.equal(commandWord('env -u GITHUB_TOKEN -i - A=1 git status'), 'git');
  assert.equal(commandWord('env --unset X --ignore-environment git status'), 'git');
});

test('skips timeout with its options and duration', () => {
  assert.equal(commandWord('timeout 90 bd update X'), 'bd');
  assert.equal(commandWord('timeout -s KILL -k 5 --foreground 90 bd update X'), 'bd');
});

test('skips the keywords a `;` split leaves at the front of a segment', () => {
  for (const kw of ['do', 'then', 'else', '{', '(', '!']) {
    assert.equal(commandWord(`${kw} git checkout -- f`), 'git', kw);
  }
  assert.equal(commandWord('do FOO=1 rtk git status'), 'git');
});

test('does NOT skip keywords that introduce a condition or list rather than a command body', () => {
  // `for f in a` / `while cond` / `if cond` segments start with the keyword itself;
  // their command word is the keyword, which no guard matches.
  assert.equal(commandWord('for f in a'), 'for');
  assert.equal(commandWord('done'), 'done');
});

test('cd is only skipped on request', () => {
  assert.equal(commandWord('cd /x git status'), 'cd');
  assert.equal(commandWord('cd /x git status', { skipCd: true }), 'git');
  assert.equal(commandWord('then cd /x'), 'cd');
});

test('extraWrappers adds bare wrapper words (PowerShell &)', () => {
  assert.equal(commandWord('& npx prettier'), '&');
  assert.equal(commandWord('& npx prettier', { extraWrappers: ['&'] }), 'npx');
});

test('returns toks.length when everything is a prefix', () => {
  assert.equal(skipCommandPrefix(words('FOO=1 sudo')), 2);
  assert.equal(skipCommandPrefix([]), 0);
});

test('stripGroupingParens detaches a glued leading ( and trailing )', () => {
  assert.deepEqual(stripGroupingParens(words('(git checkout -- f.txt)')), ['(', 'git', 'checkout', '--', 'f.txt']);
  assert.deepEqual(stripGroupingParens(words('(cd x')), ['(', 'cd', 'x']);
  assert.deepEqual(stripGroupingParens(words('git checkout -- f.txt))')), ['git', 'checkout', '--', 'f.txt']);
  assert.deepEqual(stripGroupingParens(words('( git checkout -- f.txt )')), ['(', 'git', 'checkout', '--', 'f.txt']);
});

test('stripGroupingParens leaves balanced parens, $( and (( alone', () => {
  assert.deepEqual(stripGroupingParens(words('git checkout -- f(1).txt')), ['git', 'checkout', '--', 'f(1).txt']);
  assert.deepEqual(stripGroupingParens(words('cd $(pwd)')), ['cd', '$(pwd)']);
  assert.deepEqual(stripGroupingParens(words('((i++))')), ['((i++))']);
  assert.deepEqual(stripGroupingParens([]), []);
});
