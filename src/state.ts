import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** The text of a note's line and its neighbours, as they were when it was written. */
export interface LineSnapshot {
  text: string;
  before: string | null;
  after: string | null;
}

export interface Note {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  body: string;
  createdAt: string;
  /**
   * What the line said, so the note can follow it when later edits shift the
   * numbering (see `anchor.ts`). Absent on notes from before this existed and
   * on notes written against a line the diff did not show.
   */
  snapshot?: LineSnapshot;
  /**
   * Who wrote it. Absent means you did, at the keyboard; a value means it came
   * in through `--annotate`. Only used to keep the two apart — in the pane, in
   * the export, and when deciding whose notes a rewrite may replace.
   */
  author?: string;
}

/** A generated one-line explanation of one file's change. */
export interface Summary {
  /** Patch hash it was written for, so a changed file re-explains. */
  hash: string;
  body: string;
  model: string;
  createdAt: string;
}

export interface ReviewState {
  /** path -> patch hash the file was marked viewed at. */
  viewed: Record<string, string>;
  notes: Note[];
  /** path -> generated explanation. Kept apart from `notes`, which are yours. */
  summaries: Record<string, Summary>;
  /** Where the reviewer was, so a relaunch resumes instead of restarting. */
  last?: { path: string };
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  reviews: Record<string, ReviewState>;
}

const empty = (): ReviewState => ({
  viewed: {},
  notes: [],
  summaries: {},
  updatedAt: new Date().toISOString(),
});

/**
 * Review state lives under the git dir, not the work tree: it is personal
 * scratch, it must never show up in `git status`, and it disappears with the
 * clone it describes.
 */
export class Store {
  private file: string;
  private data: StoreFile = { version: 1, reviews: {} };
  private writing: Promise<void> = Promise.resolve();
  /**
   * The most recent write failure, if any. `save` swallows it so a transient
   * failure mid-session (disk full, file briefly locked by an indexer) does
   * not throw out of a fire-and-forget call while the TUI owns the terminal;
   * `flush` and `drop` — only ever called once the terminal is not mid-render
   * — are where a caller actually asking "did this save" gets to find out.
   */
  private writeError: unknown = null;

  constructor(gitDir: string, private key: string) {
    this.file = join(gitDir, 'prview', 'reviews.json');
  }

  async load(): Promise<ReviewState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as StoreFile;
      if (parsed && parsed.version === 1 && parsed.reviews) this.data = parsed;
    } catch {
      // No state yet, or it was corrupted; either way start clean.
    }
    const state = this.data.reviews[this.key];
    // `summaries` postdates the first version of the store file.
    return state ? { ...empty(), ...state } : empty();
  }

  /**
   * Serialised, atomic, read-modify-write.
   *
   * Re-reading before each write matters because the store holds *every* range
   * you have reviewed: another prview on another range must not lose its
   * progress because this one happened to save last. Within our own range the
   * incoming state is merged over what is there, so a field this caller does
   * not know about — a summary written by a newer version, say — survives
   * instead of being silently dropped.
   */
  save(state: Partial<ReviewState>): Promise<void> {
    const incoming = { ...state, updatedAt: new Date().toISOString() };
    this.writing = this.writing
      .then(async () => {
        let onDisk: StoreFile = this.data;
        try {
          const parsed = JSON.parse(await readFile(this.file, 'utf8')) as StoreFile;
          if (parsed && parsed.version === 1 && parsed.reviews) onDisk = parsed;
        } catch {
          // No readable store yet; ours becomes the first.
        }
        const merged: StoreFile = {
          version: 1,
          reviews: {
            ...onDisk.reviews,
            [this.key]: { ...empty(), ...onDisk.reviews[this.key], ...incoming },
          },
        };
        this.data = merged;
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
        await rename(tmp, this.file);
      })
      .catch((err) => {
        this.writeError = err;
      });
    return this.writing;
  }

  /** Resolves once every queued write has settled; throws if the most recent one failed. */
  async flush(): Promise<void> {
    await this.writing;
    if (this.writeError) {
      const err = this.writeError;
      this.writeError = null;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Every range this store holds, newest first. */
  async keys(): Promise<Array<{ key: string; updatedAt: string; notes: number; summaries: number }>> {
    await this.load();
    return Object.entries(this.data.reviews)
      .map(([key, review]) => ({
        key,
        updatedAt: review.updatedAt ?? '',
        notes: review.notes?.length ?? 0,
        summaries: Object.keys(review.summaries ?? {}).length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Remove whole ranges. Returns how many were actually there. */
  async drop(keys: string[]): Promise<number> {
    await this.load();
    const before = Object.keys(this.data.reviews).length;
    for (const key of keys) delete this.data.reviews[key];
    const removed = before - Object.keys(this.data.reviews).length;
    if (removed) {
      const snapshot = JSON.stringify(this.data, null, 2);
      this.writing = this.writing
        .then(async () => {
          await mkdir(dirname(this.file), { recursive: true });
          const tmp = `${this.file}.${process.pid}.tmp`;
          await writeFile(tmp, snapshot, 'utf8');
          await rename(tmp, this.file);
        })
        .catch((err) => {
          this.writeError = err;
        });
      await this.flush();
    }
    return removed;
  }
}

/**
 * How a stored range key was opened, so a review holding work can point at the
 * one that holds it. Reviews are keyed per range, which means notes written
 * against the working tree are invisible from `--pr` and vice versa — correct,
 * and baffling unless something says where they went.
 */
export function describeRangeKey(key: string): { label: string; command: string } | null {
  const paths = key.includes(' :: ') ? ` -- ${key.split(' :: ')[1] ?? ''}` : '';
  const bare = key.split(' :: ')[0] ?? key;

  if (bare.startsWith('worktree:')) return { label: 'working tree vs HEAD', command: `prview${paths}` };
  if (bare.startsWith('index:')) return { label: 'staged vs HEAD', command: `prview --staged${paths}` };

  const branch = /^(.+?)\.\.\.[0-9a-f]{7,40}$/.exec(bare);
  if (branch) return { label: `${branch[1]}...HEAD`, command: `prview ${branch[1]}${paths}` };

  return { label: bare, command: `prview ${bare}${paths}` };
}

export type ResetScope = 'summaries' | 'viewed' | 'notes' | 'all';

export const RESET_SCOPES: ResetScope[] = ['summaries', 'viewed', 'notes', 'all'];

/**
 * Clear part of a review. Split by kind on purpose: generated summaries are
 * cheap to rebuild, viewed marks are a few keystrokes, and notes are writing
 * you cannot get back — lumping them under one switch would make losing the
 * third the price of refreshing the first.
 */
export function resetState(state: ReviewState, scope: ResetScope): { state: ReviewState; removed: string[] } {
  const removed: string[] = [];
  const next: ReviewState = { ...state };
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

  if (scope === 'summaries' || scope === 'all') {
    removed.push(count(Object.keys(state.summaries ?? {}).length, 'summary').replace('summarys', 'summaries'));
    next.summaries = {};
  }
  if (scope === 'viewed' || scope === 'all') {
    removed.push(count(Object.keys(state.viewed ?? {}).length, 'viewed mark'));
    next.viewed = {};
  }
  if (scope === 'notes' || scope === 'all') {
    removed.push(count(state.notes?.length ?? 0, 'note'));
    next.notes = [];
  }
  return { state: next, removed };
}

export const newNote = (
  path: string,
  side: 'old' | 'new',
  line: number,
  body: string,
  snapshot?: LineSnapshot,
): Note => ({
  id: randomUUID(),
  path,
  side,
  line,
  body,
  createdAt: new Date().toISOString(),
  ...(snapshot ? { snapshot } : {}),
});

/** Markdown summary printed on exit, ready to paste into a PR review. */
/**
 * Markdown summary, ready to paste into a PR review. Generated explanations
 * are labelled as such and kept visually separate from your own notes — they
 * are context for you, not something to pass off as review comments.
 */
export function notesToMarkdown(
  notes: Note[],
  label: string,
  summaries: Record<string, Summary> = {},
): string {
  const paths = new Set([...notes.map((n) => n.path), ...Object.keys(summaries)]);
  if (!paths.size) return '';

  const byPath = new Map<string, Note[]>();
  for (const n of notes) {
    const list = byPath.get(n.path) ?? [];
    list.push(n);
    byPath.set(n.path, list);
  }

  const out = [`## Review notes — ${label}`, ''];
  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    out.push(`### \`${path}\``);
    const summary = summaries[path];
    if (summary) out.push(`> _What changed (generated by ${summary.model}):_ ${summary.body}`);
    for (const n of (byPath.get(path) ?? []).sort((a, b) => a.line - b.line)) {
      const marker = n.side === 'old' ? `L${n.line} (old)` : `L${n.line}`;
      const by = n.author ? ` _(${n.author})_` : '';
      out.push(`- **${marker}**${by} — ${n.body.replace(/\n/g, '\n  ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}
