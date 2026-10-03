import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff } from '../src/parse';
import { reanchorNotes, snapshotOf } from '../src/anchor';
import { newNote, type Note } from '../src/state';

const BEFORE = `diff --git a/backup.sh b/backup.sh
--- a/backup.sh
+++ b/backup.sh
@@ -1,4 +1,6 @@
 #!/bin/sh
 echo
+trap restart EXIT
+echo
 tar -cz /data
 echo done
`;

// The same change after three more lines were added above it.
const AFTER = `diff --git a/backup.sh b/backup.sh
--- a/backup.sh
+++ b/backup.sh
@@ -1,4 +1,9 @@
 #!/bin/sh
+STEP=init
+log() { echo "$1"; }
+
 echo
+  trap restart EXIT
+echo
 tar -cz /data
 echo done
`;

const noteOn = (line: number, body = 'x'): Note => {
  const file = parseDiff(BEFORE)[0];
  assert.ok(file);
  return newNote('backup.sh', 'new', line, body, snapshotOf(file, 'new', line));
};

test('a snapshot records the line and its neighbours', () => {
  const file = parseDiff(BEFORE)[0];
  assert.ok(file);
  assert.deepEqual(snapshotOf(file, 'new', 3), { text: 'trap restart EXIT', before: 'echo', after: 'echo' });
  assert.equal(snapshotOf(file, 'new', 1)?.before, null);
  assert.equal(snapshotOf(file, 'new', 99), undefined);
});

test('a note follows its line when lines are inserted above, indentation aside', () => {
  const [moved] = reanchorNotes([noteOn(3)], parseDiff(AFTER));
  assert.equal(moved?.line, 6);
});

test('a repeated line is told apart by its neighbours', () => {
  // Two `echo`s: line 2 is preceded by the shebang, line 4 by the trap.
  const moved = reanchorNotes([noteOn(2), noteOn(4)], parseDiff(AFTER));
  assert.deepEqual(moved.map((n) => n.line), [5, 7]);
});

test('nothing moves, and the array is reused, when the numbers still hold', () => {
  const notes = [noteOn(3), noteOn(5)];
  assert.equal(reanchorNotes(notes, parseDiff(BEFORE)), notes);
});

test('a note is left alone when its text is gone, ambiguous, or was never recorded', () => {
  const files = parseDiff(AFTER);
  const gone = { ...noteOn(3), snapshot: { text: 'rm -rf /', before: null, after: null } };
  const ambiguous = { ...noteOn(3), snapshot: { text: 'echo', before: 'nope', after: 'nope' } };
  const legacy = newNote('backup.sh', 'new', 3, 'x');
  const elsewhere = { ...noteOn(3), path: 'other.sh' };
  const notes = [gone, ambiguous, legacy, elsewhere];
  assert.equal(reanchorNotes(notes, files), notes);
});
