import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPlausibleBase, rankCandidates, type Candidate } from '../src/base';

const c = (name: string, ahead: number, behind: number, isRemote = false): Candidate => ({
  name,
  ahead,
  behind,
  isRemote,
});

const pick = (cands: Candidate[], def: string | null = null) => rankCandidates(cands, def)?.name ?? null;

test('the branch I diverged from least wins', () => {
  // main -> develop -> feature/x, standing on feature/x.
  assert.equal(pick([c('main', 2, 0), c('develop', 1, 0)]), 'develop');
});

test('a base that has moved on since the fork is still the base', () => {
  // develop gained a commit after I branched, so its tip is no longer my
  // ancestor. main still is — and is still the wrong answer.
  assert.equal(pick([c('main', 2, 0), c('develop', 1, 1)]), 'develop');
});

test('a sibling forked at the same commit loses to the real base', () => {
  // Same distance, but develop's tip is behind me and the sibling's is not.
  assert.equal(pick([c('develop', 1, 0), c('feature/sibling', 1, 1)]), 'develop');
});

test('a child branch is never a base', () => {
  // feature/y was cut from me and contains everything I have.
  assert.equal(pick([c('main', 2, 0), c('feature/y', 0, 3)]), 'main');
});

test('standing on a trunk, a recent feature branch does not become the base', () => {
  // The regression this tier exists for: on develop, `feature/x` forked more
  // recently than `main` diverged, so distance alone would choose it.
  assert.equal(pick([c('main', 2, 0), c('feature/x', 1, 1), c('origin/feature/x', 1, 0, true)]), 'main');
});

test('a branch and its remote copy collapse to the nicer name', () => {
  assert.equal(pick([c('develop', 1, 1), c('origin/develop', 1, 0, true)]), 'develop');
});

test('a remote copy wins when it is the closer fork point', () => {
  // Stale local develop, current origin/develop: the remote is the real fork.
  assert.equal(pick([c('develop', 5, 0), c('origin/develop', 1, 0, true)]), 'origin/develop');
});

test('an unconventional base is still found when nothing is base-shaped', () => {
  assert.equal(pick([c('release/2024-06', 1, 0), c('feature/other', 4, 2)]), 'release/2024-06');
});

test('the remote default branch counts as base-shaped', () => {
  assert.equal(pick([c('integration', 3, 0), c('origin/trunk', 1, 0, true)], 'origin/trunk'), 'origin/trunk');
});

test('distance still decides between two base-shaped refs', () => {
  // Even with origin/HEAD pointing at main, a nearer develop wins.
  assert.equal(pick([c('main', 2, 0), c('develop', 1, 0)], 'origin/main'), 'develop');
});

test('nothing to pick when every branch already contains HEAD', () => {
  assert.equal(rankCandidates([c('develop', 0, 2), c('feature/x', 0, 5)], null), null);
  assert.equal(rankCandidates([], null), null);
});

test('the reason explains the choice', () => {
  assert.equal(rankCandidates([c('develop', 1, 0)], null)?.reason, '1 commit ahead');
  assert.equal(rankCandidates([c('develop', 3, 2)], null)?.reason, '3 commits ahead, 2 behind');
});

test('ranking is deterministic regardless of input order', () => {
  const cands = [c('main', 2, 0), c('develop', 1, 0), c('feature/sibling', 1, 1)];
  const forward = pick(cands);
  const backward = pick([...cands].reverse());
  assert.equal(forward, backward);
  assert.equal(forward, 'develop');
});

test('my own branch and its remote copy are never candidates', () => {
  assert.equal(isPlausibleBase('feature/x', 'feature/x'), false);
  assert.equal(isPlausibleBase('origin/feature/x', 'feature/x'), false);
  assert.equal(isPlausibleBase('upstream/feature/x', 'feature/x'), false);
  assert.equal(isPlausibleBase('origin/HEAD', 'feature/x'), false);
  assert.equal(isPlausibleBase('develop', 'feature/x'), true);
  assert.equal(isPlausibleBase('origin/develop', 'feature/x'), true);
});
