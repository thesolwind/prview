import type { FileDiff, LineKind } from './parse';
import { anchorOf, buildRows, toUnified, type Cell, type Row } from './pair';
import type { Span } from './intraline';
import type { Note } from './state';

export type Layout = 'split' | 'unified';

export interface SbsRow {
  t: 'sbs';
  left: Cell | null;
  right: Cell | null;
}
export interface UniRow {
  t: 'uni';
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  spans: Span[];
  noNewline: boolean;
}
export interface HunkViewRow {
  t: 'hunk';
  text: string;
}
export interface MsgViewRow {
  t: 'msg';
  text: string;
}
export interface NoteViewRow {
  t: 'note';
  /** The note this row belongs to; every wrapped line carries it. */
  note: Note;
  /** One rendered line, prefix included. */
  text: string;
}

/** One wrapped line of a generated explanation, shown above the first hunk. */
export interface SummaryViewRow {
  t: 'summary';
  text: string;
  /** True on the first line, which carries the label. */
  first: boolean;
}

export type ViewRow = SbsRow | UniRow | HunkViewRow | MsgViewRow | NoteViewRow | SummaryViewRow;

export interface Anchor {
  side: 'old' | 'new';
  line: number;
}

export function anchor(row: ViewRow | undefined): Anchor | null {
  if (!row) return null;
  if (row.t === 'sbs') return anchorOf({ type: 'pair', left: row.left, right: row.right } as Row);
  if (row.t === 'uni') {
    if (row.newNo != null) return { side: 'new', line: row.newNo };
    if (row.oldNo != null) return { side: 'old', line: row.oldNo };
  }
  return null;
}

/** True when the cursor should be able to land here. */
export function selectable(row: ViewRow | undefined): boolean {
  return !!row && (row.t === 'sbs' || row.t === 'uni' || row.t === 'hunk');
}

function keyOf(a: Anchor): string {
  return `${a.side}:${a.line}`;
}

/** Greedy wrap; the pane clips anything that still does not fit. */
export function wrapText(text: string, width: number): string[] {
  if (width < 8) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Render one note as however many lines it needs.
 *
 * A note used to be a single row clipped at the pane edge, which silently ate
 * the end of anything worth writing down — the part that says what to do about
 * the line is usually last. The `╭ │ │` gutter brackets the note down to the
 * code it is about.
 */
export function wrapNote(note: Note, width: number): string[] {
  const head = `  ╭ L${note.line}${note.side === 'old' ? ' (old)' : ''} ${note.author ? `[${note.author}] ` : ''}`;
  const cont = '  │ ';
  const body = note.body.replace(/\s+/g, ' ').trim();

  const out: string[] = [];
  let prefix = head;
  let room = Math.max(8, width - prefix.length);
  let line = '';

  for (const word of body.split(' ').filter(Boolean)) {
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= room) line += ` ${word}`;
    else {
      out.push(prefix + line);
      prefix = cont;
      room = Math.max(8, width - prefix.length);
      line = word;
    }
  }
  out.push(prefix + line);
  return out;
}

export interface ViewOptions {
  summary?: string;
  /** Width available for wrapped summary text. */
  summaryWidth?: number;
  /** A summary is being fetched for this file; say so rather than show nothing. */
  summaryPending?: boolean;
}

export function buildView(
  file: FileDiff,
  notes: Note[],
  layout: Layout,
  options: ViewOptions = {},
): ViewRow[] {
  const base = buildRows(file);
  const rows: ViewRow[] =
    layout === 'split'
      ? base.map((r) =>
          r.type === 'pair'
            ? ({ t: 'sbs', left: r.left, right: r.right } satisfies SbsRow)
            : r.type === 'hunk'
              ? ({ t: 'hunk', text: r.text } satisfies HunkViewRow)
              : ({ t: 'msg', text: (r as { text: string }).text } satisfies MsgViewRow),
        )
      : toUnified(base).map((r) =>
          r.type === 'unified'
            ? ({
                t: 'uni',
                kind: r.kind,
                oldNo: r.oldNo,
                newNo: r.newNo,
                text: r.text,
                spans: r.spans,
                noNewline: r.noNewline,
              } satisfies UniRow)
            : r.type === 'hunk'
              ? ({ t: 'hunk', text: r.text } satisfies HunkViewRow)
              : ({ t: 'msg', text: (r as { text: string }).text } satisfies MsgViewRow),
        );

  const noteWidth = Math.max(20, (options.summaryWidth ?? 80) - 2);
  const summaryText = options.summary ?? (options.summaryPending ? 'explaining…' : undefined);
  const summaryRows: ViewRow[] = summaryText
    ? wrapText(summaryText, Math.max(8, (options.summaryWidth ?? 80) - 6)).map((text, i) => ({
        t: 'summary' as const,
        text,
        first: i === 0,
      }))
    : [];

  const mine = notes.filter((n) => n.path === file.path);
  if (!mine.length) return [...summaryRows, ...rows];

  const byAnchor = new Map<string, Note[]>();
  for (const n of mine) {
    const k = keyOf({ side: n.side, line: n.line });
    const list = byAnchor.get(k) ?? [];
    list.push(n);
    byAnchor.set(k, list);
  }

  // Notes go *above* the line they are about, so you read the remark and then
  // the code it is about rather than the other way round. This is the opposite
  // of the web review tools' convention, and deliberate.
  const out: ViewRow[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const a = anchor(row);
    if (a) {
      const k = keyOf(a);
      const attached = placed.has(k) ? undefined : byAnchor.get(k);
      if (attached) {
        placed.add(k);
        for (const note of attached) {
          for (const text of wrapNote(note, noteWidth)) out.push({ t: 'note', note, text });
        }
      }
    }
    out.push(row);
  }
  out.unshift(...summaryRows);

  // Notes whose line vanished from the diff still deserve to be visible.
  const orphans = mine.filter((n) => !placed.has(keyOf({ side: n.side, line: n.line })));
  if (orphans.length) {
    out.push({ t: 'msg', text: 'Notes on lines no longer in this diff:' });
    for (const note of orphans) {
      for (const text of wrapNote(note, noteWidth)) out.push({ t: 'note', note, text });
    }
  }
  return out;
}

/** Keep the cursor on the same source line when the layout or notes change. */
export function remapCursor(rows: ViewRow[], target: Anchor | null, fallback: number): number {
  if (target) {
    const k = keyOf(target);
    const found = rows.findIndex((r) => {
      const a = anchor(r);
      return a && keyOf(a) === k;
    });
    if (found >= 0) return found;
  }
  return Math.min(Math.max(fallback, 0), Math.max(rows.length - 1, 0));
}

export function nextSelectable(rows: ViewRow[], from: number, dir: 1 | -1): number {
  let i = from;
  while (i + dir >= 0 && i + dir < rows.length) {
    i += dir;
    if (selectable(rows[i])) return i;
  }
  return from;
}

/**
 * The nearest line a note can attach to. Hunk headers carry no line of their
 * own, so searching outward keeps `c` from failing on a row the reviewer
 * perfectly reasonably parked on.
 */
export function anchorNear(rows: ViewRow[], cursor: number): Anchor | null {
  const here = anchor(rows[cursor]);
  if (here) return here;
  for (let offset = 1; offset < rows.length; offset++) {
    const ahead = anchor(rows[cursor + offset]);
    if (ahead) return ahead;
    const behind = anchor(rows[cursor - offset]);
    if (behind) return behind;
  }
  return null;
}

/** First row worth putting the cursor on: a code line, not the hunk header. */
export function firstCodeRow(rows: ViewRow[]): number {
  const index = rows.findIndex((r) => r.t === 'sbs' || r.t === 'uni');
  return index < 0 ? 0 : index;
}

/**
 * What each column of the split view is actually showing. The revision alone
 * is enough for most files; a rename or an add/delete needs the path or the
 * absence spelled out, because that is precisely the case where the two
 * columns are not the same file.
 */
export function columnLabels(
  file: FileDiff,
  oldLabel: string,
  newLabel: string,
): { was: string; now: string } {
  const renamed = !!file.oldPath && !!file.newPath && file.oldPath !== file.newPath;
  return {
    was:
      file.status === 'added'
        ? `${oldLabel} — did not exist`
        : renamed
          ? `${oldLabel} — ${file.oldPath}`
          : oldLabel,
    now:
      file.status === 'deleted'
        ? `${newLabel} — deleted`
        : renamed
          ? `${newLabel} — ${file.newPath}`
          : newLabel,
  };
}

/**
 * Column of the first word-level emphasis on a row, or null if it has none.
 *
 * Used to notice that a row's actual change sits beyond the visible columns —
 * a long Docker image tag or import path renders as two lines marked changed
 * with no visible difference, which is worse than useless.
 */
export function firstEmphasisStart(row: ViewRow | undefined): number | null {
  if (!row) return null;
  const spans = row.t === 'sbs' ? (row.right?.spans?.length ? row.right.spans : row.left?.spans) : row.t === 'uni' ? row.spans : undefined;
  if (!spans?.length) return null;
  return spans.reduce((min, span) => Math.min(min, span.start), Infinity);
}

/**
 * Where to scroll so an off-screen change becomes visible, or null to stay put.
 * Returns a column that leaves a quarter-pane of context to the left of the
 * change, rather than putting it hard against the gutter.
 */
export function autoScrollTarget(
  start: number | null,
  hscroll: number,
  codeWidth: number,
): number | null {
  if (start == null) return null;
  // Already on screen: never move the view under someone who can see it.
  if (start >= hscroll && start < hscroll + codeWidth) return null;
  const target = Math.max(0, start - Math.floor(codeWidth / 4));
  return target === hscroll ? null : target;
}
