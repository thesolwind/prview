import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff, expandTabs } from '../src/parse';
import { buildRows, toUnified } from '../src/pair';
import { intralineSpans, similarity } from '../src/intraline';
import { buildRuns } from '../src/ui/segments';
import { notesToMarkdown, newNote } from '../src/state';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ header text
 const a = 1;
-const b = 2;
+const b = 22;
+const c = 3;
 const d = 4;
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 333..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/img.png b/img.png
index 444..555 100644
Binary files a/img.png and b/img.png differ
`;

test('parses files, statuses and counts', () => {
  const files = parseDiff(SAMPLE);
  assert.equal(files.length, 4);

  const [a, gone, renamed, binary] = files;
  assert.equal(a!.path, 'src/a.ts');
  assert.equal(a!.status, 'modified');
  assert.equal(a!.additions, 2);
  assert.equal(a!.deletions, 1);
  assert.equal(a!.hunks.length, 1);
  assert.equal(a!.hunks[0]!.section, 'header text');

  assert.equal(gone!.path, 'gone.txt');
  assert.equal(gone!.status, 'deleted');
  assert.equal(gone!.deletions, 2);

  assert.equal(renamed!.status, 'renamed');
  assert.equal(renamed!.oldPath, 'old.txt');
  assert.equal(renamed!.path, 'new.txt');

  assert.equal(binary!.binary, true);
});

test('assigns the line numbers git implies', () => {
  const file = parseDiff(SAMPLE)[0]!;
  const lines = file.hunks[0]!.lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldNo, l.newNo]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ],
  );
});

test('gives every file a hash that tracks its patch', () => {
  const first = parseDiff(SAMPLE)[0]!;
  const changed = parseDiff(SAMPLE.replace('const b = 22;', 'const b = 23;'))[0]!;
  assert.notEqual(first.hash, changed.hash);
  assert.equal(first.hash, parseDiff(SAMPLE)[0]!.hash);
});

test('single-line hunk headers default to a count of one', () => {
  const files = parseDiff(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -7 +7 @@
-a
+b
`);
  const hunk = files[0]!.hunks[0]!;
  assert.equal(hunk.oldStart, 7);
  assert.equal(hunk.oldCount, 1);
  assert.equal(hunk.newCount, 1);
});

test('notices "no newline at end of file"', () => {
  const files = parseDiff(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
`);
  const lines = files[0]!.hunks[0]!.lines;
  assert.equal(lines[0]!.noNewline, true);
  assert.equal(lines[1]!.noNewline, undefined);
});

test('unquotes and de-prefixes awkward paths', () => {
  const files = parseDiff(`diff --git "a/with space.txt" "b/with space.txt"
--- "a/with space.txt"
+++ "b/with space.txt"
@@ -1 +1 @@
-a
+b
`);
  assert.equal(files[0]!.path, 'with space.txt');
});

test('expands tabs to the next stop, not a fixed width', () => {
  assert.equal(expandTabs('\tx', 4), '    x');
  assert.equal(expandTabs('ab\tx', 4), 'ab  x');
  assert.equal(expandTabs('abc\tx', 4), 'abc x');
  assert.equal(expandTabs('abcd\tx', 4), 'abcd    x');
});

test('pairs a del run against an add run positionally', () => {
  const file = parseDiff(SAMPLE)[0]!;
  const rows = buildRows(file);
  assert.equal(rows[0]!.type, 'hunk');
  const pairs = rows.filter((r) => r.type === 'pair');
  assert.deepEqual(
    pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null]),
    [
      ['const a = 1;', 'const a = 1;'],
      ['const b = 2;', 'const b = 22;'],
      [null, 'const c = 3;'],
      ['const d = 4;', 'const d = 4;'],
    ],
  );
});

test('unified view keeps one row per source line', () => {
  const rows = toUnified(buildRows(parseDiff(SAMPLE)[0]!));
  assert.deepEqual(
    rows.filter((r) => r.type === 'unified').map((r) => [r.kind, r.oldNo, r.newNo]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ],
  );
});

test('word-level spans cover only what changed', () => {
  const spans = intralineSpans('const b = 2;', 'const b = 22;');
  assert.ok(spans);
  const slice = (text: string, s: { start: number; end: number }[]) =>
    s.map((x) => text.slice(x.start, x.end));
  assert.deepEqual(slice('const b = 2;', spans!.old), ['2']);
  assert.deepEqual(slice('const b = 22;', spans!.new), ['22']);
});

test('word-level spans mark deletions on the old side', () => {
  const oldLine = 'call(a, b, c);';
  const newLine = 'call(a, c);';
  const spans = intralineSpans(oldLine, newLine);
  assert.ok(spans);
  assert.equal(spans!.new.length, 0);
  assert.equal(oldLine.slice(spans!.old[0]!.start, spans!.old[0]!.end).includes('b'), true);
});

test('unrelated lines get no misleading emphasis', () => {
  assert.equal(intralineSpans('import fs from "fs";', 'export class Wildly Different {}'), null);
  assert.ok(similarity('const x = 1;', 'const x = 2;') > 0.7);
  assert.ok(similarity('aaa', 'zzz') < 0.1);
});

test('runs carry syntax colour and diff background on the same character', () => {
  const runs = buildRuns({
    text: 'ab',
    width: 4,
    offset: 0,
    tokens: [{ text: 'a', color: '#ff0000' }, { text: 'b', color: '#00ff00' }],
    bg: '#111111',
    emphBg: '#222222',
    spans: [{ start: 1, end: 2 }],
    fallback: '#cccccc',
  });
  assert.deepEqual(runs, [
    { text: 'a', color: '#ff0000', bg: '#111111' },
    { text: 'b', color: '#00ff00', bg: '#222222' },
    { text: '  ', bg: '#111111' },
  ]);
});

test('horizontal scroll drops leading columns and still pads', () => {
  const runs = buildRuns({ text: 'abcdef', width: 3, offset: 2, bg: '#000000', fallback: '#ffffff' });
  assert.equal(runs.map((r) => r.text).join(''), 'cde');
  const short = buildRuns({ text: 'ab', width: 5, offset: 0, bg: '#000000', fallback: '#ffffff' });
  assert.equal(short.map((r) => r.text).join('').length, 5);
});

test('notes export as markdown grouped by file and line', () => {
  const notes = [
    newNote('b.ts', 'new', 10, 'second file'),
    newNote('a.ts', 'new', 5, 'later line'),
    newNote('a.ts', 'old', 2, 'earlier line'),
  ];
  const md = notesToMarkdown(notes, 'main...HEAD');
  const lines = md.split('\n').filter(Boolean);
  assert.equal(lines[0], '## Review notes — main...HEAD');
  assert.deepEqual(lines.slice(1), [
    '### `a.ts`',
    '- **L2 (old)** — earlier line',
    '- **L5** — later line',
    '### `b.ts`',
    '- **L10** — second file',
  ]);
  assert.equal(notesToMarkdown([], 'x'), '');
});

test('the diff\'s trailing newline does not become a phantom line', () => {
  // `@@ -0,0 +1 @@` plus one addition is the whole file; anything after it is
  // an artifact of splitting on newlines.
  const files = parseDiff(`diff --git a/f2.ts b/f2.ts
new file mode 100644
--- /dev/null
+++ b/f2.ts
@@ -0,0 +1 @@
+hotfix
`);
  const lines = files[0]!.hunks[0]!.lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text]),
    [['add', null, 1, 'hotfix']],
  );
  assert.equal(files[0]!.additions, 1);
  assert.equal(files[0]!.deletions, 0);
});

test('a blank context line in the middle is still tolerated', () => {
  // Written without the leading space, as a whitespace-stripping pipeline
  // would leave it.
  const files = parseDiff(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+c', ''].join('\n'));
  const lines = files[0]!.hunks[0]!.lines;
  assert.deepEqual(lines.map((l) => l.kind), ['context', 'context', 'del', 'add']);
  assert.equal(lines[1]!.text, '');
  assert.equal(lines[3]!.newNo, 3);
});

test('the store keeps other ranges and fields it was not told about', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/state');

  const dir = await mkdtemp(join(tmpdir(), 'prview-store-'));

  // Two ranges reviewed independently, as two prview processes would.
  const a = new Store(dir, 'main...aaaa');
  const b = new Store(dir, 'main...bbbb');
  await a.load();
  await a.save({ viewed: { 'x.ts': 'h1' }, notes: [], summaries: {} });
  await b.load();
  await b.save({ viewed: { 'y.ts': 'h2' }, notes: [], summaries: {} });
  await b.flush();

  const raw = JSON.parse(await readFile(join(dir, 'prview', 'reviews.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw.reviews).sort(), ['main...aaaa', 'main...bbbb']);
  assert.deepEqual(raw.reviews['main...aaaa'].viewed, { 'x.ts': 'h1' });

  // A caller that knows nothing of summaries must not erase them.
  const c = new Store(dir, 'main...aaaa');
  await c.load();
  await c.save({
    summaries: { 'x.ts': { hash: 'h1', body: 'does a thing', model: 'm', createdAt: 't' } },
  });
  await c.save({ viewed: { 'x.ts': 'h1' }, notes: [] });
  await c.flush();

  const after = JSON.parse(await readFile(join(dir, 'prview', 'reviews.json'), 'utf8'));
  assert.equal(after.reviews['main...aaaa'].summaries['x.ts'].body, 'does a thing');
  assert.deepEqual(Object.keys(after.reviews).sort(), ['main...aaaa', 'main...bbbb']);
});
