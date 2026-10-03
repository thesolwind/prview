/**
 * Non-interactive write path into the review store.
 *
 * The point is that something other than a human at the keyboard can leave
 * review material: an agent that just made a change describing what it did,
 * so the next person to open `prview` reads the reasoning next to the lines
 * instead of reconstructing it from the diff.
 *
 * It writes through the same range key and patch hashes the TUI uses, so
 * annotations land on exactly the review the reader will open, and go stale
 * the same way everything else does when the code moves underneath them.
 */
import { snapshotOf } from './anchor';
import type { FileDiff } from './parse';
import { newNote, type Note, type ReviewState, type Summary } from './state';

export const DEFAULT_AUTHOR = 'claude';

export interface Annotation {
  path: string;
  line: number;
  /** Defaults to the new side, which is what you almost always mean. */
  side?: 'old' | 'new';
  body: string;
}

export interface AnnotatePayload {
  /** Stamped on everything written, so a later run can replace its own work. */
  author?: string;
  /** path -> one line on what changed in that file and why. */
  summaries?: Record<string, string>;
  notes?: Annotation[];
  /**
   * Drop this author's existing notes on the paths being written before
   * adding the new ones. On by default: re-running after another edit should
   * refresh the annotations, not stack duplicates. Never touches notes
   * without this author — a human's notes are not ours to remove.
   */
  replace?: boolean;
}

export class PayloadError extends Error {}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PayloadError(`${what} must be a non-empty string`);
  return value.trim();
}

export function parsePayload(raw: string): AnnotatePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PayloadError(`not valid JSON — ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PayloadError('expected a JSON object');
  }
  const input = parsed as Record<string, unknown>;

  const payload: AnnotatePayload = {};
  if (input.author !== undefined) payload.author = asString(input.author, 'author');
  if (input.replace !== undefined) {
    if (typeof input.replace !== 'boolean') throw new PayloadError('replace must be a boolean');
    payload.replace = input.replace;
  }

  if (input.summaries !== undefined) {
    if (!input.summaries || typeof input.summaries !== 'object' || Array.isArray(input.summaries)) {
      throw new PayloadError('summaries must be an object of path -> text');
    }
    payload.summaries = Object.fromEntries(
      Object.entries(input.summaries as Record<string, unknown>).map(([path, body]) => [
        asString(path, 'a summary path'),
        asString(body, `summaries[${path}]`),
      ]),
    );
  }

  if (input.notes !== undefined) {
    if (!Array.isArray(input.notes)) throw new PayloadError('notes must be an array');
    payload.notes = input.notes.map((entry, i) => {
      if (!entry || typeof entry !== 'object') throw new PayloadError(`notes[${i}] must be an object`);
      const note = entry as Record<string, unknown>;
      const line = note.line;
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        throw new PayloadError(`notes[${i}].line must be a positive integer`);
      }
      const side = note.side ?? 'new';
      if (side !== 'old' && side !== 'new') throw new PayloadError(`notes[${i}].side must be "old" or "new"`);
      return {
        path: asString(note.path, `notes[${i}].path`),
        line,
        side,
        body: asString(note.body, `notes[${i}].body`),
      };
    });
  }

  if (!payload.summaries && !payload.notes) {
    throw new PayloadError('nothing to write: give "summaries", "notes", or both');
  }
  return payload;
}

export interface AnnotateReport {
  summaries: number;
  notes: number;
  replaced: number;
  /** Things worth telling the caller about, but not worth refusing over. */
  warnings: string[];
}

/** Line numbers a note can attach to, per side, for one file. */
function anchorsOf(file: FileDiff): { old: Set<number>; new: Set<number> } {
  const anchors = { old: new Set<number>(), new: new Set<number>() };
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.oldNo != null) anchors.old.add(line.oldNo);
      if (line.newNo != null) anchors.new.add(line.newNo);
    }
  }
  return anchors;
}

/**
 * Fold a payload into review state. Pure, so the awkward parts — which notes
 * get replaced, what counts as a stale anchor — are testable without a repo.
 */
export function mergeAnnotations(
  state: ReviewState,
  payload: AnnotatePayload,
  files: FileDiff[],
): { state: ReviewState; report: AnnotateReport } {
  const author = payload.author ?? DEFAULT_AUTHOR;
  const replace = payload.replace ?? true;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const warnings: string[] = [];

  const summaries: Record<string, Summary> = { ...state.summaries };
  let summaryCount = 0;
  for (const [path, body] of Object.entries(payload.summaries ?? {})) {
    const file = byPath.get(path);
    if (!file) {
      warnings.push(`${path}: not in this diff, summary skipped`);
      continue;
    }
    summaries[path] = { hash: file.hash, body, model: author, createdAt: new Date().toISOString() };
    summaryCount++;
  }

  const incoming = payload.notes ?? [];
  const touched = new Set(incoming.map((n) => n.path));
  const before = state.notes.length;
  // Only ever drop our own: a note without this author belongs to a person.
  const kept = replace
    ? state.notes.filter((n) => !(n.author === author && touched.has(n.path)))
    : [...state.notes];
  const replaced = before - kept.length;

  let noteCount = 0;
  for (const entry of incoming) {
    const file = byPath.get(entry.path);
    if (!file) {
      warnings.push(`${entry.path}: not in this diff, note skipped`);
      continue;
    }
    if (!anchorsOf(file)[entry.side ?? 'new'].has(entry.line)) {
      // Kept anyway: the view lists notes whose line has gone, and losing the
      // text would be worse than showing it in the wrong place.
      warnings.push(`${entry.path}:${entry.line} is not a changed line on the ${entry.side ?? 'new'} side`);
    }
    const side = entry.side ?? 'new';
    kept.push({ ...newNote(entry.path, side, entry.line, entry.body, snapshotOf(file, side, entry.line)), author });
    noteCount++;
  }

  return {
    state: { ...state, notes: kept, summaries },
    report: { summaries: summaryCount, notes: noteCount, replaced, warnings },
  };
}
