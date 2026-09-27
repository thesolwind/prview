import type { DiffLine, FileDiff, Hunk, LineKind } from './parse';
import { intralineSpans, similarity, type Span } from './intraline';

export interface Cell {
  no: number | null;
  text: string;
  kind: LineKind;
  spans: Span[];
  noNewline: boolean;
}

export interface PairRow {
  type: 'pair';
  left: Cell | null;
  right: Cell | null;
}

export interface HunkRow {
  type: 'hunk';
  text: string;
}

export interface MessageRow {
  type: 'message';
  text: string;
}

export interface NoteRow {
  type: 'note';
  noteId: string;
  body: string;
  side: 'old' | 'new';
  line: number;
}

export type Row = PairRow | HunkRow | MessageRow | NoteRow;

const cell = (line: DiffLine, side: 'old' | 'new', spans: Span[] = []): Cell => ({
  no: side === 'old' ? line.oldNo : line.newNo,
  text: line.text,
  kind: line.kind,
  spans,
  noNewline: line.noNewline ?? false,
});

/**
 * Pair a run of deletions with a run of additions the way a reviewer reads it:
 * line i on the left against line i on the right, with word-level emphasis when
 * the two are recognisably the same line edited.
 */
function pairRun(dels: DiffLine[], adds: DiffLine[]): PairRow[] {
  const rows: PairRow[] = [];
  const count = Math.max(dels.length, adds.length);
  for (let i = 0; i < count; i++) {
    const d = dels[i];
    const a = adds[i];
    if (d && a) {
      const spans = similarity(d.text, a.text) >= 0.3 ? intralineSpans(d.text, a.text) : null;
      rows.push({
        type: 'pair',
        left: cell(d, 'old', spans?.old ?? []),
        right: cell(a, 'new', spans?.new ?? []),
      });
    } else if (d) {
      rows.push({ type: 'pair', left: cell(d, 'old'), right: null });
    } else if (a) {
      rows.push({ type: 'pair', left: null, right: cell(a, 'new') });
    }
  }
  return rows;
}

function hunkRows(hunk: Hunk): Row[] {
  const rows: Row[] = [
    {
      type: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${
        hunk.section ? ' ' + hunk.section : ''
      }`,
    },
  ];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    if (dels.length || adds.length) rows.push(...pairRun(dels, adds));
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === 'del') dels.push(line);
    else if (line.kind === 'add') adds.push(line);
    else {
      flush();
      rows.push({ type: 'pair', left: cell(line, 'old'), right: cell(line, 'new') });
    }
  }
  flush();
  return rows;
}

export function buildRows(file: FileDiff): Row[] {
  if (file.binary) return [{ type: 'message', text: 'Binary file — not shown' }];
  if (!file.hunks.length) {
    const modes = file.oldMode && file.newMode ? ` (${file.oldMode} → ${file.newMode})` : '';
    return [{ type: 'message', text: `No content change${modes}` }];
  }
  return file.hunks.flatMap(hunkRows);
}

/** Line a note attaches to when the cursor is on this row. */
export function anchorOf(row: Row | undefined): { side: 'old' | 'new'; line: number } | null {
  if (!row || row.type !== 'pair') return null;
  if (row.right?.no != null) return { side: 'new', line: row.right.no };
  if (row.left?.no != null) return { side: 'old', line: row.left.no };
  return null;
}

/** Unified (single-column) view of the same rows, for narrow terminals. */
export interface UnifiedRow {
  type: 'unified';
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  spans: Span[];
  noNewline: boolean;
}

export function toUnified(rows: Row[]): Array<HunkRow | MessageRow | UnifiedRow | NoteRow> {
  const out: Array<HunkRow | MessageRow | UnifiedRow | NoteRow> = [];
  for (const row of rows) {
    if (row.type !== 'pair') {
      out.push(row);
      continue;
    }
    const { left, right } = row;
    if (left && right && left.kind === 'context') {
      out.push({ type: 'unified', kind: 'context', oldNo: left.no, newNo: right.no, text: left.text, spans: [], noNewline: left.noNewline });
      continue;
    }
    if (left) out.push({ type: 'unified', kind: 'del', oldNo: left.no, newNo: null, text: left.text, spans: left.spans, noNewline: left.noNewline });
    if (right) out.push({ type: 'unified', kind: 'add', oldNo: null, newNo: right.no, text: right.text, spans: right.spans, noNewline: right.noNewline });
  }
  return out;
}
