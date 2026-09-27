import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff } from '../src/parse';
import {
  anchor,
  anchorNear,
  autoScrollTarget,
  buildView,
  columnLabels,
  firstCodeRow,
  firstEmphasisStart,
  remapCursor,
  wrapNote,
} from '../src/view';
import { newNote } from '../src/state';

const DIFF = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 22;
+const c = 3;
 const d = 4;
`;

const file = () => parseDiff(DIFF)[0]!;

test('the cursor starts on a code line, not the hunk header', () => {
  const rows = buildView(file(), [], 'split');
  assert.equal(rows[0]!.t, 'hunk');
  assert.equal(firstCodeRow(rows), 1);
});

test('a hunk header borrows the nearest real line for a note', () => {
  const rows = buildView(file(), [], 'split');
  assert.equal(anchor(rows[0]), null);
  assert.deepEqual(anchorNear(rows, 0), { side: 'new', line: 1 });
});

test('notes render immediately above the line they annotate', () => {
  const notes = [newNote('x.ts', 'new', 2, 'why 22?')];
  const rows = buildView(file(), notes, 'split');
  const noteIndex = rows.findIndex((r) => r.t === 'note');
  assert.ok(noteIndex >= 0);
  // The row that follows is the one it is about — read the remark, then the code.
  assert.deepEqual(anchor(rows[noteIndex + 1]), { side: 'new', line: 2 });
});

test('several notes on one line keep their order, all above it', () => {
  const notes = [
    newNote('x.ts', 'new', 2, 'first'),
    newNote('x.ts', 'new', 2, 'second'),
  ];
  const rows = buildView(file(), notes, 'split');
  const noteRows = rows.filter((r) => r.t === 'note');
  assert.deepEqual(noteRows.map((r) => (r.t === 'note' ? r.note.body : '')), ['first', 'second']);
  const last = rows.findIndex((r) => r.t === 'note' && r.note.body === 'second');
  assert.deepEqual(anchor(rows[last + 1]), { side: 'new', line: 2 });
});

test('a note on a line no longer in the diff is still listed', () => {
  const notes = [newNote('x.ts', 'new', 999, 'stale')];
  const rows = buildView(file(), notes, 'split');
  const noteRows = rows.filter((r) => r.t === 'note');
  assert.equal(noteRows.length, 1);
  assert.equal(rows[rows.length - 2]!.t, 'msg');
});

test('switching layout keeps the cursor on the same source line', () => {
  const split = buildView(file(), [], 'split');
  const unified = buildView(file(), [], 'unified');

  // The pair holding "const d = 4;" sits at a different index in each layout.
  const splitIndex = split.findIndex((r) => anchor(r)?.line === 4 && anchor(r)?.side === 'new');
  const target = anchor(split[splitIndex]);
  assert.deepEqual(target, { side: 'new', line: 4 });

  const remapped = remapCursor(unified, target, splitIndex);
  assert.deepEqual(anchor(unified[remapped]), target);
  assert.notEqual(remapped, splitIndex);
});

test('remap falls back to a clamped index when the line is gone', () => {
  const rows = buildView(file(), [], 'split');
  assert.equal(remapCursor(rows, { side: 'new', line: 999 }, 3), 3);
  assert.equal(remapCursor(rows, null, 9999), rows.length - 1);
});

test('column labels name the revision behind each side', () => {
  assert.deepEqual(columnLabels(file(), 'main', 'feature/auth'), {
    was: 'main',
    now: 'feature/auth',
  });
});

test('column labels spell out a rename, because the columns differ', () => {
  const renamed = parseDiff(`diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
`)[0]!;
  assert.deepEqual(columnLabels(renamed, 'main', 'HEAD'), {
    was: 'main — old.txt',
    now: 'HEAD — new.txt',
  });
});

test('column labels spell out an absent side', () => {
  const added = parseDiff(`diff --git a/n.ts b/n.ts
new file mode 100644
--- /dev/null
+++ b/n.ts
@@ -0,0 +1 @@
+hi
`)[0]!;
  const deleted = parseDiff(`diff --git a/g.ts b/g.ts
deleted file mode 100644
--- a/g.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`)[0]!;
  assert.equal(columnLabels(added, 'main', 'HEAD').was, 'main — did not exist');
  assert.equal(columnLabels(added, 'main', 'HEAD').now, 'HEAD');
  assert.equal(columnLabels(deleted, 'main', 'HEAD').now, 'HEAD — deleted');
  assert.equal(columnLabels(deleted, 'main', 'HEAD').was, 'main');
});

test('the first emphasis column is found on either layout, preferring the new side', () => {
  const cell = (spans: Array<{ start: number; end: number }>) => ({
    no: 1, text: 'x', kind: 'add' as const, spans, noNewline: false,
  });
  // Split rows: the new side is what you are reading, so it wins.
  assert.equal(firstEmphasisStart({ t: 'sbs', left: cell([{ start: 5, end: 6 }]), right: cell([{ start: 40, end: 44 }]) }), 40);
  // Unless it has none — a deletion with no counterpart still has a column.
  assert.equal(firstEmphasisStart({ t: 'sbs', left: cell([{ start: 5, end: 6 }]), right: cell([]) }), 5);
  // Earliest span, not the first listed.
  assert.equal(firstEmphasisStart({ t: 'sbs', left: null, right: cell([{ start: 40, end: 44 }, { start: 12, end: 14 }]) }), 12);

  assert.equal(
    firstEmphasisStart({ t: 'uni', kind: 'add', oldNo: null, newNo: 1, text: 'x', spans: [{ start: 7, end: 9 }], noNewline: false }),
    7,
  );

  // Nothing to follow.
  assert.equal(firstEmphasisStart({ t: 'sbs', left: cell([]), right: cell([]) }), null);
  assert.equal(firstEmphasisStart({ t: 'hunk', text: '@@' }), null);
  assert.equal(firstEmphasisStart(undefined), null);
});

test('auto-scroll only moves when the change is off-screen', () => {
  const cw = 40;
  // Already visible, at either edge of the window: stay put.
  assert.equal(autoScrollTarget(0, 0, cw), null);
  assert.equal(autoScrollTarget(39, 0, cw), null);
  assert.equal(autoScrollTarget(70, 64, cw), null);
  // Nothing to follow.
  assert.equal(autoScrollTarget(null, 0, cw), null);

  // Off to the right: land it a quarter-pane in, so context stays visible.
  assert.equal(autoScrollTarget(100, 0, cw), 90);
  // Off to the left: same rule, clamped at the start of the line.
  assert.equal(autoScrollTarget(4, 64, cw), 0);
  assert.equal(autoScrollTarget(12, 64, cw), 2);

  // Never write the value it already has.
  assert.equal(autoScrollTarget(90 + 10, 90, cw), null);
});

test('a long note wraps instead of being clipped at the pane edge', () => {
  const long = newNote(
    'x.ts',
    'new',
    27,
    'Taking the lock before reading the counter keeps two concurrent failed logins from both slipping in under the attempt limit.',
  );
  const lines = wrapNote({ ...long, author: 'claude-opus-5' }, 70);

  assert.ok(lines.length > 1, 'should need more than one line');
  assert.ok(lines.every((l) => l.length <= 70), lines.find((l) => l.length > 70));

  // The first line names the anchor; the rest continue the bracket down to it.
  assert.match(lines[0]!, /^ {2}╭ L27 \[claude-opus-5\] Taking/);
  for (const line of lines.slice(1)) assert.match(line, /^ {2}│ /);

  // Every word survives — clipping is what this replaces.
  const rebuilt = lines
    .map((l) => l.replace(/^ {2}(╭ L27 \[claude-opus-5\] |│ )/, ''))
    .join(' ');
  assert.equal(rebuilt, long.body);
});

test('an old-side note says so, and an unauthored one has no attribution', () => {
  assert.match(wrapNote(newNote('x.ts', 'old', 3, 'short'), 60)[0]!, /^ {2}╭ L3 \(old\) short$/);
  assert.match(wrapNote(newNote('x.ts', 'new', 3, 'short'), 60)[0]!, /^ {2}╭ L3 short$/);
});

test('wrapped notes all carry the note, so the cursor can delete from any line', () => {
  const long = newNote('x.ts', 'new', 2, 'x '.repeat(120).trim());
  const rows = buildView(file(), [long], 'split', { summaryWidth: 60 });
  const noteRows = rows.filter((r) => r.t === 'note');
  assert.ok(noteRows.length > 2);
  assert.ok(noteRows.every((r) => r.t === 'note' && r.note.id === long.id));
  // Still immediately above the line it annotates.
  const lastNote = rows.lastIndexOf(noteRows[noteRows.length - 1]!);
  assert.deepEqual(anchor(rows[lastNote + 1]), { side: 'new', line: 2 });
});
