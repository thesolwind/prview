import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff, type FileDiff } from '../src/parse';
import { mergeAnnotations, parsePayload, PayloadError } from '../src/annotate';
import { describeRangeKey, newNote, resetState, type ReviewState } from '../src/state';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
`;

const files = (): FileDiff[] => parseDiff(DIFF);

const blank = (): ReviewState => ({
  viewed: {},
  notes: [],
  summaries: {},
  updatedAt: 't',
});

test('a payload must actually ask for something', () => {
  assert.throws(() => parsePayload('{}'), PayloadError);
  assert.throws(() => parsePayload('[]'), PayloadError);
  assert.throws(() => parsePayload('nonsense'), PayloadError);
  assert.throws(() => parsePayload('{"summaries":[]}'), PayloadError);
});

test('every note field is checked, with a message naming the field', () => {
  const bad = (json: string, needle: string) => {
    try {
      parsePayload(json);
      assert.fail(`expected a rejection for ${json}`);
    } catch (err) {
      assert.ok(err instanceof PayloadError);
      assert.match(err.message, new RegExp(needle));
    }
  };
  bad('{"notes":[{"path":"a","body":"b"}]}', 'notes\\[0\\]\\.line');
  bad('{"notes":[{"path":"a","line":0,"body":"b"}]}', 'notes\\[0\\]\\.line');
  bad('{"notes":[{"path":"a","line":1.5,"body":"b"}]}', 'notes\\[0\\]\\.line');
  bad('{"notes":[{"path":"","line":1,"body":"b"}]}', 'notes\\[0\\]\\.path');
  bad('{"notes":[{"path":"a","line":1,"body":"  "}]}', 'notes\\[0\\]\\.body');
  bad('{"notes":[{"path":"a","line":1,"body":"b","side":"left"}]}', 'notes\\[0\\]\\.side');
  bad('{"notes":{}}', 'notes must be an array');
  bad('{"summaries":{"a":""}}', 'summaries\\[a\\]');
  bad('{"notes":[{"path":"a","line":1,"body":"b"}],"replace":"yes"}', 'replace must be a boolean');
});

test('the new side is the default, because that is what you mean', () => {
  const payload = parsePayload('{"notes":[{"path":"src/a.ts","line":2,"body":"x"}]}');
  assert.equal(payload.notes?.[0]?.side, 'new');
});

test('summaries are stamped with the current patch hash and the author', () => {
  const { state, report } = mergeAnnotations(
    blank(),
    { author: 'model-x', summaries: { 'src/a.ts': 'Bumps b, adds c.' } },
    files(),
  );
  assert.equal(report.summaries, 1);
  assert.equal(state.summaries['src/a.ts']?.body, 'Bumps b, adds c.');
  assert.equal(state.summaries['src/a.ts']?.model, 'model-x');
  assert.equal(state.summaries['src/a.ts']?.hash, files()[0]!.hash);
});

test('re-running replaces its own notes and leaves the reader\'s alone', () => {
  const mine = { ...newNote('src/a.ts', 'new', 2, 'first pass'), author: 'model-x' };
  const theirs = newNote('src/a.ts', 'new', 3, 'a human wrote this');
  const someoneElse = { ...newNote('src/a.ts', 'new', 4, 'another tool'), author: 'model-y' };
  const start: ReviewState = { ...blank(), notes: [mine, theirs, someoneElse] };

  const { state, report } = mergeAnnotations(
    start,
    { author: 'model-x', notes: [{ path: 'src/a.ts', line: 2, body: 'second pass' }] },
    files(),
  );

  assert.equal(report.replaced, 1);
  const bodies = state.notes.map((n) => n.body).sort();
  assert.deepEqual(bodies, ['a human wrote this', 'another tool', 'second pass']);
  assert.equal(state.notes.find((n) => n.body === 'second pass')?.author, 'model-x');
});

test('replace:false adds without clearing', () => {
  const mine = { ...newNote('src/a.ts', 'new', 2, 'first pass'), author: 'model-x' };
  const { state, report } = mergeAnnotations(
    { ...blank(), notes: [mine] },
    { author: 'model-x', replace: false, notes: [{ path: 'src/a.ts', line: 3, body: 'also this' }] },
    files(),
  );
  assert.equal(report.replaced, 0);
  assert.equal(state.notes.length, 2);
});

test('only the written paths are cleared, not every note by the author', () => {
  const here = { ...newNote('src/a.ts', 'new', 2, 'on the touched file'), author: 'model-x' };
  const elsewhere = { ...newNote('other.ts', 'new', 1, 'on a different file'), author: 'model-x' };
  const { state } = mergeAnnotations(
    { ...blank(), notes: [here, elsewhere] },
    { author: 'model-x', notes: [{ path: 'src/a.ts', line: 2, body: 'replacement' }] },
    files(),
  );
  assert.deepEqual(
    state.notes.map((n) => n.body).sort(),
    ['on a different file', 'replacement'],
  );
});

test('a path outside the diff is refused, not silently stored', () => {
  const { state, report } = mergeAnnotations(
    blank(),
    {
      summaries: { 'gone.ts': 'x' },
      notes: [{ path: 'gone.ts', line: 1, body: 'y' }],
    },
    files(),
  );
  assert.equal(report.summaries, 0);
  assert.equal(report.notes, 0);
  assert.equal(state.notes.length, 0);
  assert.equal(report.warnings.length, 2);
  assert.ok(report.warnings.every((w) => w.includes('gone.ts')));
});

test('an unchanged line warns but is kept, since losing the text is worse', () => {
  const { state, report } = mergeAnnotations(
    blank(),
    { notes: [{ path: 'src/a.ts', line: 900, body: 'off the end' }] },
    files(),
  );
  assert.equal(report.notes, 1);
  assert.equal(state.notes.length, 1);
  assert.match(report.warnings[0] ?? '', /not a changed line/);
});

test('context and deleted lines are valid anchors on their own side', () => {
  const ok = (line: number, side: 'old' | 'new') =>
    mergeAnnotations(blank(), { notes: [{ path: 'src/a.ts', line, side, body: 'x' }] }, files())
      .report.warnings.length === 0;
  assert.equal(ok(1, 'new'), true); // context line
  assert.equal(ok(1, 'old'), true); // ...is an anchor on both sides
  assert.equal(ok(2, 'new'), true); // first addition
  assert.equal(ok(3, 'new'), true); // second addition
  assert.equal(ok(2, 'old'), true); // the deleted line
  assert.equal(ok(3, 'old'), false); // the old side stops at 2
  assert.equal(ok(4, 'new'), false); // the new side stops at 3
});

test('reset clears one kind at a time, so refreshing summaries cannot cost notes', () => {
  const start: ReviewState = {
    viewed: { 'a.ts': 'h1', 'b.ts': 'h2' },
    notes: [newNote('a.ts', 'new', 2, 'mine'), newNote('b.ts', 'new', 1, 'also mine')],
    summaries: {
      'a.ts': { hash: 'h1', body: 'generated', model: 'm', createdAt: 't' },
    },
    updatedAt: 't',
  };

  const summaries = resetState(start, 'summaries');
  assert.deepEqual(summaries.state.summaries, {});
  assert.equal(summaries.state.notes.length, 2, 'notes must survive a summary reset');
  assert.equal(Object.keys(summaries.state.viewed).length, 2);
  assert.deepEqual(summaries.removed, ['1 summary']);

  const viewed = resetState(start, 'viewed');
  assert.deepEqual(viewed.state.viewed, {});
  assert.equal(viewed.state.notes.length, 2);
  assert.equal(Object.keys(viewed.state.summaries).length, 1);
  assert.deepEqual(viewed.removed, ['2 viewed marks']);

  const notes = resetState(start, 'notes');
  assert.deepEqual(notes.state.notes, []);
  assert.equal(Object.keys(notes.state.summaries).length, 1);
  assert.deepEqual(notes.removed, ['2 notes']);

  const all = resetState(start, 'all');
  assert.deepEqual(all.state.notes, []);
  assert.deepEqual(all.state.summaries, {});
  assert.deepEqual(all.state.viewed, {});
  assert.deepEqual(all.removed, ['1 summary', '2 viewed marks', '2 notes']);

  // The original is untouched: callers hold it until the write succeeds.
  assert.equal(start.notes.length, 2);
  assert.equal(Object.keys(start.summaries).length, 1);
});

test('reset counts read correctly when there is nothing to clear', () => {
  const empty: ReviewState = { viewed: {}, notes: [], summaries: {}, updatedAt: 't' };
  assert.deepEqual(resetState(empty, 'all').removed, ['0 summaries', '0 viewed marks', '0 notes']);
});

test('a range key says how to reopen the review it names', () => {
  assert.deepEqual(describeRangeKey('worktree:24b9990'), {
    label: 'working tree vs HEAD',
    command: 'prview',
  });
  assert.deepEqual(describeRangeKey('index:24b9990'), {
    label: 'staged vs HEAD',
    command: 'prview --staged',
  });
  assert.deepEqual(describeRangeKey('main...24b9990'), {
    label: 'main...HEAD',
    command: 'prview main',
  });
  // A base branch with slashes in the name must survive intact.
  assert.deepEqual(describeRangeKey('release/2024-06...abc1234'), {
    label: 'release/2024-06...HEAD',
    command: 'prview release/2024-06',
  });
  // Path-scoped reviews reopen with the same pathspec, or they are a different review.
  assert.deepEqual(describeRangeKey('worktree:24b9990 :: src/,lib/'), {
    label: 'working tree vs HEAD',
    command: 'prview -- src/,lib/',
  });
  // An explicit range is already its own command.
  assert.deepEqual(describeRangeKey('v1.2..v1.3'), { label: 'v1.2..v1.3', command: 'prview v1.2..v1.3' });
});
