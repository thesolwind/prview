import React from 'react';
import { Box } from 'ink';
import { Row, type Seg } from './segments';
import type { Theme } from '../theme';
import { placeTip, type Flow, type FlowCell, type FlowKind, type FlowLayout, type TipBox } from '../flow';
import { RULE } from './DiffPane';
import { Working } from './Working';

/** Title, legend, rule above; rule and detail line below. App sizes the body from this. */
export const FLOW_CHROME_HEIGHT = 5;


export type FlowStatus =
  | { kind: 'ready' }
  | { kind: 'loading'; startedAt: number; model: string; files: number }
  | { kind: 'error'; message: string }
  /** No flow stored and no permission to make one. */
  | { kind: 'off' };

interface Props {
  theme: Theme;
  width: number;
  height: number;
  flow: Flow | null;
  layout: FlowLayout | null;
  status: FlowStatus;
  /** Drawn for an earlier version of the diff. */
  stale: boolean;
  /** Who drew it: a model id, or an annotating agent. */
  author: string | null;
  selected: number;
  panX: number;
  panY: number;
  tick: number;
  /**
   * What the focused step does. `note` is the diagram's own word on the step;
   * `summary` is the --explain line for its file, a fallback that describes
   * the file's change rather than the step, so it is labelled as such.
   */
  tip?: { text: string; source: 'note' | 'summary' } | null;
}

function kindColor(theme: Theme, kind: FlowKind): string {
  if (kind === 'added') return theme.addSign;
  if (kind === 'removed') return theme.delSign;
  if (kind === 'changed') return theme.accent;
  return theme.gutter;
}

function cellStyle(theme: Theme, flow: Flow, cell: FlowCell, selected: number): Omit<Seg, 'text'> {
  if (cell.node !== undefined) {
    const node = flow.nodes[cell.node];
    const kind = node?.kind ?? 'context';
    const isSel = cell.node === selected;
    const bg = isSel ? theme.cursorBg : undefined;
    if (cell.role === 'text') {
      return { color: kind === 'context' ? theme.dim : theme.plain, bold: isSel || kind !== 'context', bg };
    }
    return { color: isSel ? theme.gutterActive : kindColor(theme, kind), bold: isSel || cell.role === 'tag', bg };
  }
  if (cell.role === 'arrow') return { color: theme.plain };
  if (cell.role === 'edgeLabel') return { color: theme.noteFg };
  return { color: theme.gutter };
}

/** The tip's glyph at a canvas cell, with its title set into the top border. */
function tipCell(tip: TipBox, title: string, x: number, y: number): { ch: string; text: boolean } | null {
  if (x < tip.x || x >= tip.x + tip.w || y < tip.y || y >= tip.y + tip.h) return null;
  const cx = x - tip.x;
  const cy = y - tip.y;
  const last = tip.w - 1;
  if (cy === 0) {
    if (cx === 0) return { ch: '╭', text: false };
    if (cx === last) return { ch: '╮', text: false };
    const t = ` ${title} `;
    const at = cx - 2;
    return { ch: at >= 0 && at < t.length && t.length <= tip.w - 4 ? t[at]! : '─', text: false };
  }
  if (cy === tip.h - 1) return { ch: cx === 0 ? '╰' : cx === last ? '╯' : '─', text: false };
  if (cx === 0 || cx === last) return { ch: '│', text: false };
  const line = tip.lines[cy - 1] ?? '';
  return { ch: line[cx - 2] ?? ' ', text: true };
}

/** One visible row of the canvas, with runs of equal style merged. */
function canvasRow(
  theme: Theme,
  flow: Flow,
  layout: FlowLayout,
  y: number,
  panX: number,
  width: number,
  selected: number,
  tip: { box: TipBox; title: string } | null,
): Seg[] {
  const row = layout.cells[y];
  const segs: Seg[] = [];
  for (let x = panX; x < panX + width; x++) {
    const over = tip ? tipCell(tip.box, tip.title, x, y) : null;
    const cell = row?.[x];
    const style: Omit<Seg, 'text'> = over
      ? { color: over.text ? theme.plain : theme.noteFg, bg: theme.noteBg }
      : cell
        ? cellStyle(theme, flow, cell, selected)
        : {};
    const ch = over?.ch ?? cell?.ch ?? ' ';
    const last = segs[segs.length - 1];
    if (last && last.color === style.color && last.bold === style.bold && last.bg === style.bg) last.text += ch;
    else segs.push({ text: ch, ...style });
  }
  return segs;
}

function centred(width: number, height: number, lines: Seg[][]): React.ReactElement {
  const above = Math.max(0, Math.floor((height - lines.length) / 2));
  return (
    <Box flexDirection="column" width={width} height={height}>
      {Array.from({ length: height }, (_, i) => {
        const line = lines[i - above];
        return <Row key={i} width={width} segments={line ? [{ text: '  ' }, ...line] : []} />;
      })}
    </Box>
  );
}

export function FlowPane(props: Props): React.ReactElement {
  const { theme, width, height, flow, layout, status, stale, author, selected, panX, panY, tick, tip } = props;
  const body = Math.max(1, height - FLOW_CHROME_HEIGHT);

  const counts = { changed: 0, added: 0, removed: 0, context: 0 };
  for (const node of flow?.nodes ?? []) counts[node.kind]++;

  const header: Seg[] = [
    { text: ' ◆ diff flow', color: theme.accent, bold: true },
    ...(author ? [{ text: `  drawn by ${author}`, color: theme.dim }] : []),
    ...(stale ? [{ text: '  ⚠ diff changed since — R to redraw', color: theme.delSign }] : []),
  ];
  const legend: Seg[] = [
    { text: ' ' },
    { text: '[~]', color: theme.accent, bold: true },
    { text: ` changed ${counts.changed}   `, color: theme.dim },
    { text: '[+]', color: theme.addSign, bold: true },
    { text: ` added ${counts.added}   `, color: theme.dim },
    { text: '[−]', color: theme.delSign, bold: true },
    { text: ` removed ${counts.removed}   `, color: theme.dim },
    { text: '┌─┐', color: theme.gutter },
    { text: ` context ${counts.context}   `, color: theme.dim },
    { text: '▼', color: theme.plain },
    { text: ' calls / leads to', color: theme.dim },
    // Words beside an arrow read like a key hint ("enter") unless something
    // says they belong to the arrow; only worth the room when there are some.
    ...(flow?.edges.some((e) => e.label)
      ? [
          { text: '   ' },
          { text: 'label', color: theme.noteFg },
          { text: ' on an arrow: when it happens, or what is passed', color: theme.dim },
        ]
      : []),
  ];

  let content: React.ReactElement;
  if (status.kind === 'loading') {
    // The same box as a summary batch, so "claude is working" looks one way
    // everywhere. Unlike that one it does not take over the screen: the diff
    // is complete without a flow, so f and esc go back to it while this runs.
    content = (
      <Working
        theme={theme}
        width={width}
        height={body}
        tick={tick}
        total={status.files}
        done={0}
        model={status.model}
        elapsedSeconds={Math.max(0, Math.round((Date.now() - status.startedAt) / 1000))}
        title="DRAWING THE DIFF FLOW"
        stage={`tracing ${status.files} file${status.files === 1 ? '' : 's'}`}
        hint="f or esc: back to the diff, it keeps going · q quits"
      />
    );
  } else if (status.kind === 'error' && !layout) {
    content = centred(width, body, [
      [{ text: `couldn't draw the flow: ${status.message}`, color: theme.delSign }],
      [{ text: 'R to try again · detail in .git/prview/explain.log', color: theme.dim }],
    ]);
  } else if (!flow || !layout) {
    content = centred(width, body, [
      [{ text: 'No flow diagram for this review yet.', color: theme.plain }],
      [],
      [
        { text: 'Run with ', color: theme.dim },
        { text: '--explain', color: theme.noteFg },
        { text: ' to have the claude CLI draw one (it sends the diff),', color: theme.dim },
      ],
      [
        { text: 'or have an agent write one with ', color: theme.dim },
        { text: 'prview --annotate', color: theme.noteFg },
        { text: ' ({"flow": "<mermaid>"}).', color: theme.dim },
      ],
    ]);
  } else {
    // A diagram narrower than the pane sits in the middle; negative columns
    // are simply blank, so centring is just a pan to the left.
    const x = layout.width < width ? -Math.floor((width - layout.width) / 2) : panX;
    const box = layout.boxes.find((b) => b.node === selected);
    const placed = box && tip ? placeTip(box, tip.text, { x, y: panY, w: width, h: body }, layout.boxes) : null;
    const tipDraw = placed
      ? { box: placed, title: tip?.source === 'summary' ? '⌁ change in this file' : 'what it does' }
      : null;
    content = (
      <Box flexDirection="column" width={width} height={body}>
        {Array.from({ length: body }, (_, i) => (
          <Row key={i} width={width} segments={canvasRow(theme, flow, layout, panY + i, x, width, selected, tipDraw)} />
        ))}
      </Box>
    );
  }

  const node = flow?.nodes[selected];
  const detail: Seg[] = node
    ? [
        { text: ' ▸ ', color: kindColor(theme, node.kind), bold: true },
        { text: node.label, color: theme.plain, bold: true },
        { text: `  ${node.kind}`, color: kindColor(theme, node.kind) },
        ...(node.claimed
          ? [{ text: ` (drawn as ${node.claimed.kind}; ${node.claimed.why})`, color: theme.dim }]
          : []),
        node.file
          ? { text: `  ${node.file}  ·  enter opens it`, color: theme.dim }
          : node.missing
            ? { text: `  ${node.missing}  ·  not in this diff — enter shows the whole file, read-only`, color: theme.dim }
            : { text: '  not linked to a file', color: theme.dim },
        // Labels with no unambiguous place on the canvas are read here instead.
        ...(layout?.unlabelled ?? []).flatMap((i): Seg[] => {
          const edge = flow?.edges[i];
          if (!edge?.label || !flow) return [];
          const other = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
          if (edge.to === node.id) {
            return [{ text: '  ·  ', color: theme.dim }, { text: `◂ ${edge.label}`, color: theme.noteFg }, { text: ` from ${other(edge.from)}`, color: theme.dim }];
          }
          if (edge.from === node.id) {
            return [{ text: '  ·  ', color: theme.dim }, { text: `▸ ${edge.label}`, color: theme.noteFg }, { text: ` to ${other(edge.to)}`, color: theme.dim }];
          }
          return [];
        }),
        ...(status.kind === 'error' ? [{ text: `  ·  redraw failed: ${status.message}`, color: theme.delSign }] : []),
      ]
    : [{ text: ' j/k select a step · enter opens its file · R redraw · f back to the diff', color: theme.dim }];

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row width={width} segments={header} />
      <Row width={width} segments={legend} />
      <Row width={width} segments={[{ text: RULE.repeat(width), color: theme.border }]} />
      {content}
      <Row width={width} segments={[{ text: RULE.repeat(width), color: theme.border }]} />
      <Row width={width} segments={detail} />
    </Box>
  );
}
