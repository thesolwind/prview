import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff, wholeFile, type FileDiff } from '../src/parse';
import { buildFlowRequest, checkKinds, DEFAULT_FLOW_MODEL, flowSignature, kindCheckPaths, layoutFlow, linkFiles, parseMermaid, placeTip, stepLine, FlowParseError } from '../src/flow';
import { mergeAnnotations, parsePayload, PayloadError } from '../src/annotate';
import { notesToMarkdown, resetState, type ReviewState } from '../src/state';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"x":1}
`;

const files = (): FileDiff[] => parseDiff(DIFF);
const blank = (): ReviewState => ({ viewed: {}, notes: [], summaries: {}, updatedAt: 't' });

const SAMPLE = `flowchart TD
  cli["parseArgs"] --> app["App: handleKey"]
  app -->|f| flow["FlowPane"]
  app --> diff(DiffPane)
  flow --> layout{{layoutFlow}}
  class app changed
  class flow,layout added
  %% file: app src/ui/App.tsx
  %% file: layout src/flow.ts
`;

test('the supported subset parses into nodes, edges, kinds and files', () => {
  const flow = parseMermaid(SAMPLE);
  assert.deepEqual(
    flow.nodes.map((n) => [n.id, n.label, n.kind, n.file ?? null]),
    [
      ['cli', 'parseArgs', 'context', null],
      ['app', 'App: handleKey', 'changed', 'src/ui/App.tsx'],
      ['flow', 'FlowPane', 'added', null],
      ['diff', 'DiffPane', 'context', null],
      ['layout', 'layoutFlow', 'added', 'src/flow.ts'],
    ],
  );
  assert.deepEqual(flow.edges, [
    { from: 'cli', to: 'app' },
    { from: 'app', to: 'flow', label: 'f' },
    { from: 'app', to: 'diff' },
    { from: 'flow', to: 'layout' },
  ]);
});

test('model noise around the graph is tolerated, and a graph-free reply is not', () => {
  const flow = parseMermaid(
    '```mermaid\nflowchart LR\n  subgraph x\n  a["one --> two"]:::changed -- calls --> b & c\n  end\n  style a fill:#f00\n```',
  );
  assert.deepEqual(flow.nodes.map((n) => [n.id, n.label, n.kind]), [
    ['a', 'one --> two', 'changed'],
    ['b', 'b', 'context'],
    ['c', 'c', 'context'],
  ]);
  assert.deepEqual(flow.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ''}`), ['a>b:calls', 'a>c:calls']);
  assert.throws(() => parseMermaid('Sorry, I cannot draw that.'), FlowParseError);
});

test('chains, duplicate edges and self-loops', () => {
  const flow = parseMermaid('graph TD\n a --> b --> c\n a --> b\n c --> c');
  assert.deepEqual(flow.edges.map((e) => `${e.from}${e.to}`), ['ab', 'bc']);
});

test('file links that name nothing in the diff are dropped, and reported', () => {
  const { flow, unknown } = linkFiles(parseMermaid(SAMPLE), parseDiff(DIFF));
  assert.deepEqual(unknown, ['src/ui/App.tsx', 'src/flow.ts']);
  assert.ok(flow.nodes.every((n) => !n.file));
  // Kept, so Enter can say why rather than claiming the step is in no file.
  assert.deepEqual(flow.nodes.filter((n) => n.missing).map((n) => n.missing), ['src/ui/App.tsx', 'src/flow.ts']);
});

test('layout: every box fits the canvas, none overlap, and every edge ends in an arrow', () => {
  const layout = layoutFlow(parseMermaid(SAMPLE));
  assert.equal(layout.boxes.length, 5);
  for (const b of layout.boxes) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= layout.width && b.y + b.h <= layout.height);
  }
  for (const a of layout.boxes) {
    for (const b of layout.boxes) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `boxes ${a.node} and ${b.node} overlap`);
    }
  }
  const text = layout.cells.map((row) => row.map((c) => c?.ch ?? ' ').join('')).join('\n');
  assert.equal((text.match(/▼/g) ?? []).length, 4);
  // Kinds are spelled out, not only coloured.
  assert.match(text, /\[~\]/);
  assert.match(text, /\[\+\]/);
  // Reading order is top to bottom: the entry point comes first.
  assert.equal(layout.order[0], 0);
});

test('layout survives cycles and edges that skip layers', () => {
  const layout = layoutFlow(parseMermaid('graph TD\n a --> b\n b --> c\n c --> a\n a --> c\n c --> d'));
  assert.equal(layout.boxes.length, 4);
  const text = layout.cells.map((row) => row.map((c) => c?.ch ?? ' ').join('')).join('\n');
  assert.match(text, /▲/, 'the back edge points back up');
});

test('the request skips generated files, and the signature follows the content', () => {
  const request = buildFlowRequest(files());
  assert.match(request, /=== FILE: src\/a\.ts/);
  assert.doesNotMatch(request, /package-lock/);

  const before = flowSignature(files());
  const edited = parseDiff(DIFF.replace('const c = 4;', 'const c = 5;'));
  assert.notEqual(flowSignature(edited), before);
  // A lockfile churning does not make the flow stale.
  assert.equal(flowSignature(parseDiff(DIFF.replace('{"x":1}', '{"x":2}'))), before);
});

test('--annotate takes a flow, validates it, and stamps it with the author', () => {
  assert.throws(() => parsePayload('{"flow": "not mermaid at all"}'), PayloadError);
  const payload = parsePayload(JSON.stringify({ author: 'agent', flow: 'flowchart TD\n a --> b\n %% file: a src/a.ts\n %% file: b nope.ts' }));
  const { state, report } = mergeAnnotations(blank(), payload, files());
  assert.equal(report.flow, true);
  assert.equal(state.flow?.model, 'agent');
  assert.equal(state.flow?.hash, flowSignature(files()));
  assert.deepEqual(report.warnings, ['flow: nope.ts is not in this diff, its node will not link to a file']);
});

test('the flow exports as a mermaid block, and resets with the summaries', () => {
  const flow = { hash: 'h', mermaid: 'flowchart TD\n a --> b', model: 'm', createdAt: 't' };
  const md = notesToMarkdown([], 'main...HEAD', {}, flow);
  assert.match(md, /```mermaid\nflowchart TD\n a --> b\n```/);

  const { state, removed } = resetState({ ...blank(), flow }, 'summaries');
  assert.equal(state.flow, undefined);
  assert.ok(removed.includes('the flow diagram'));
  assert.ok(resetState({ ...blank(), flow }, 'notes').state.flow);
});

test('a file outside the diff opens whole: unchanged as context, untracked as added', () => {
  const text = 'import x from "y";\n\nexport function DiffPane() {\n  return null;\n}\n';
  const ctx = wholeFile('src/ui/DiffPane.tsx', text, 'context');
  assert.equal(ctx?.status, 'modified');
  assert.equal(ctx?.additions, 0);
  assert.equal(ctx?.hunks[0]?.lines.length, 5);
  assert.ok(ctx?.hunks[0]?.lines.every((l) => l.kind === 'context' && l.newNo === l.oldNo));

  const added = wholeFile('src/flow.ts', text, 'added');
  assert.equal(added?.status, 'added');
  assert.equal(added?.additions, 5);
  assert.equal(wholeFile('empty.ts', '', 'context'), null);
});

test('a step lands on its definition, preferring it over an earlier mention', () => {
  const file = wholeFile(
    'src/ui/App.tsx',
    [
      'import { DiffPane } from "./DiffPane";',
      'const openFlow = useCallback(() => {',
      '  handleKey();',
      '});',
      'const handleKey = useCallback((input: string) => {',
      '});',
      'export function DiffPane(props: Props): Element {',
    ].join('\n'),
    'context',
  )!;
  assert.equal(stepLine(file, 'DiffPane'), 7);
  assert.equal(stepLine(file, "App: handleKey 'f'"), 5);
  assert.equal(stepLine(file, 'openFlow'), 2);
  assert.equal(stepLine(file, 'nowhere at all'), null);
});

test('a step can carry a note, which becomes its focus tip', () => {
  const flow = parseMermaid(
    ['flowchart TD', ' a --> b', ' %% note: a Reads the config,   then hands it on.', ' %% tip: b "Second"'].join('\n'),
  );
  assert.equal(flow.nodes[0]?.note, 'Reads the config, then hands it on.');
  assert.equal(flow.nodes[1]?.note, 'Second');
});

test('a tip sits beside its step, falls back left, then below, and never off-screen', () => {
  const view = { x: 0, y: 0, w: 100, h: 30 };
  const text = 'Reads the config and hands it to the parser.';
  const right = placeTip({ node: 0, x: 2, y: 5, w: 12, h: 3 }, text, view)!;
  assert.equal(right.x, 16);
  assert.equal(right.y, 5);
  const left = placeTip({ node: 0, x: 80, y: 5, w: 12, h: 3 }, text, view)!;
  assert.ok(left.x + left.w <= 78);
  const narrow = { x: 0, y: 0, w: 30, h: 30 };
  const below = placeTip({ node: 0, x: 8, y: 5, w: 14, h: 3 }, text, narrow)!;
  assert.equal(below.y, 8);
  assert.ok(below.x + below.w <= 30);
  for (const tip of [right, left, below]) assert.ok(tip.lines.join(' ').startsWith('Reads the config'));
  const above = placeTip({ node: 0, x: 8, y: 26, w: 14, h: 3 }, text, narrow)!;
  assert.equal(above.y + above.h, 26);
  assert.equal(placeTip({ node: 0, x: 8, y: 1, w: 14, h: 3 }, text, { x: 0, y: 0, w: 30, h: 6 }), null);
});

test('a tip steps aside rather than hide a neighbouring step', () => {
  const view = { x: 0, y: 0, w: 100, h: 30 };
  const text = 'Reads the config and hands it to the parser.';
  const focused = { node: 0, x: 60, y: 2, w: 12, h: 3 };
  const neighbour = { node: 1, x: 76, y: 1, w: 16, h: 3 };
  const tip = placeTip(focused, text, view, [focused, neighbour])!;
  const overlaps = !(tip.x + tip.w <= neighbour.x || neighbour.x + neighbour.w <= tip.x || tip.y + tip.h <= neighbour.y || neighbour.y + neighbour.h <= tip.y);
  assert.ok(!overlaps, 'the tip covers the neighbour');
  assert.ok(tip.x + tip.w <= focused.x, 'it moved to the left of its step');
});

test('kinds are held to git: new-file steps are added, steps that existed before are changed', () => {
  const diff = [
    'diff --git a/src/old.ts b/src/old.ts',
    '--- a/src/old.ts',
    '+++ b/src/old.ts',
    '@@ -1,2 +1,6 @@',
    ' export function runClaude(prompt: string) {',
    '+  log(prompt);',
    ' }',
    '+const openFlow = useCallback(() => {',
    '+});',
    '+edit(text);',
    'diff --git a/src/fresh.ts b/src/fresh.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/fresh.ts',
    '@@ -0,0 +1 @@',
    '+export function generateFlow() {}',
    '',
  ].join('\n');
  const files = parseDiff(diff);
  const flow = linkFiles(
    parseMermaid(
      [
        'flowchart TD',
        ' run["runClaude calls CLI"] --> gen["generateFlow() sends diff"]',
        ' gen --> helper["openFlow sets flow tab"]',
        ' helper --> edited["runClaude again"]',
        ' edited --> mention["edit call"]',
        ' class run added',
        ' class gen,helper,edited,mention changed',
        ' %% file: run src/old.ts',
        ' %% file: gen src/fresh.ts',
        ' %% file: helper src/old.ts',
        ' %% file: edited src/old.ts',
        ' %% file: mention src/old.ts',
      ].join('\n'),
    ),
    files,
  ).flow;
  assert.deepEqual(kindCheckPaths(flow, files), ['src/old.ts']);
  // `flow` is defined in the old file, but only the longest name counts.
  const old = 'export function runClaude(prompt: string) {\n}\nconst flow = 1;\n';
  const checked = checkKinds(flow, files, new Map([['src/old.ts', old]]));
  assert.deepEqual(
    checked.nodes.map((n) => [n.id, n.kind, n.claimed?.why ?? null]),
    [
      ['run', 'changed', 'it exists before this change'],
      ['gen', 'added', 'its file is new'],
      // A new definition in an edited file: the model said changed, git says new.
      ['helper', 'added', 'this change defines it'],
      // Existed before and edited: stays changed.
      ['edited', 'changed', null],
      // Only mentioned on an added line, never defined there: left as drawn.
      ['mention', 'changed', null],
    ],
  );
  // Without the old text, an added step in a modified file is left as drawn.
  assert.equal(checkKinds(flow, files, new Map()).nodes[0]?.kind, 'added');
});

test('the flow defaults to its own, larger model', () => {
  assert.equal(DEFAULT_FLOW_MODEL, 'opus');
});

test('labels on edges into one step sit on their own lines, never side by side at the shared arrow', () => {
  const flow = parseMermaid('graph TD\n a -->|first label| c\n b -->|second label| c\n c -->|only way| d');
  const layout = layoutFlow(flow);
  const rows = layout.cells.map((row) => row.map((cell) => cell?.ch ?? ' ').join(''));
  const boxOf = (id: string) => layout.boxes.find((b) => flow.nodes[b.node]?.id === id)!;
  const c = boxOf('c');
  assert.doesNotMatch(rows[c.y - 1]!, /first label|second label/, 'a merge label is beside the shared arrow');
  assert.ok(!rows.some((r) => r.includes('first label') && r.includes('second label')), 'two labels share a row');
  // A label with one way in still goes beside its arrow.
  const d = boxOf('d');
  assert.match(rows[d.y - 1]!, /only way/);
  // Every label is either drawn or reported for the detail line.
  for (const [i, label] of ['first label', 'second label', 'only way'].entries()) {
    assert.ok(rows.some((r) => r.includes(label)) || layout.unlabelled.includes(i), `${label} vanished`);
  }
});
