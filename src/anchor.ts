/**
 * Keeping a note on its line when the code moves underneath it.
 *
 * A note is stored against `path:side:line`, and a line number is only true
 * for the diff it was taken from. The usual sequence — an agent annotates its
 * change, is asked for one more edit, and inserts twenty lines near the top —
 * leaves every note below the insertion pointing at a number that now belongs
 * to some other line, or to none in the diff at all.
 *
 * So a note also remembers what its line said, and is moved back onto that
 * text when the number stops matching. Text rather than a recomputed offset:
 * the store has no record of the diff the note was written against, and the
 * line's content is the thing the note is actually about.
 */
import type { FileDiff } from './parse';
import type { LineSnapshot, Note } from './state';

type Side = 'old' | 'new';

/** Indentation is ignored: wrapping a line in a block should not lose its note. */
const norm = (text: string | null | undefined): string | null => (text == null ? null : text.trim());

/** line number -> text, for every line of one side that the diff shows. */
function linesOf(file: FileDiff, side: Side): Map<number, string> {
  const lines = new Map<number, string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const no = side === 'old' ? line.oldNo : line.newNo;
      if (no != null) lines.set(no, line.text);
    }
  }
  return lines;
}

/** What to remember about a line at the moment a note is attached to it. */
export function snapshotOf(file: FileDiff, side: Side, line: number): LineSnapshot | undefined {
  const lines = linesOf(file, side);
  const text = lines.get(line);
  if (text === undefined) return undefined;
  return { text, before: lines.get(line - 1) ?? null, after: lines.get(line + 1) ?? null };
}

function relocate(note: Note, snapshot: LineSnapshot, lines: Map<number, string>): number {
  const want = norm(snapshot.text);
  if (norm(lines.get(note.line)) === want) return note.line;

  let best: { no: number; score: number } | null = null;
  let candidates = 0;
  for (const [no, text] of lines) {
    if (norm(text) !== want) continue;
    candidates++;
    const score =
      (norm(lines.get(no - 1)) === norm(snapshot.before) ? 1 : 0) +
      (norm(lines.get(no + 1)) === norm(snapshot.after) ? 1 : 0);
    const closer = best && Math.abs(no - note.line) < Math.abs(best.no - note.line);
    if (!best || score > best.score || (score === best.score && closer)) best = { no, score };
  }
  // `echo`, `}` and blank lines repeat. With several matches and no neighbour
  // agreeing with any of them, picking one is a guess, and a note confidently
  // attached to the wrong line is worse than one listed as having lost its.
  if (!best || (candidates > 1 && best.score === 0)) return note.line;
  return best.no;
}

/**
 * Move notes whose line number no longer holds the text they were written on.
 * Notes without a snapshot (written before snapshots existed, or on a line the
 * diff did not show) and notes whose text is gone are left exactly as they are.
 * Returns the same array when nothing moved, so it is safe in a state setter.
 */
export function reanchorNotes(notes: Note[], files: FileDiff[]): Note[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const cache = new Map<string, Map<number, string>>();
  let moved = false;

  const next = notes.map((note) => {
    const file = byPath.get(note.path);
    if (!note.snapshot || !file) return note;
    const key = `${note.path}:${note.side}`;
    let lines = cache.get(key);
    if (!lines) cache.set(key, (lines = linesOf(file, note.side)));
    const line = relocate(note, note.snapshot, lines);
    if (line === note.line) return note;
    moved = true;
    return { ...note, line };
  });
  return moved ? next : notes;
}
