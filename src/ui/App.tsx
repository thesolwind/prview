import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout, type Key } from 'ink';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileList } from './FileList';
import { DiffPane, DIFF_HEADER_HEIGHT, DIVIDER, codeWidthFor, type TokenMaps } from './DiffPane';
import { StatusBar } from './StatusBar';
import { NoteInput } from './NoteInput';
import { Help } from './Help';
import { Working } from './Working';
import { FlowPane, FLOW_CHROME_HEIGHT, type FlowStatus } from './FlowPane';
import type { Theme } from '../theme';
import { wholeFile, type FileDiff } from '../parse';
import { Highlighter, langFor } from '../highlight';
import { reanchorNotes, snapshotOf } from '../anchor';
import { newNote, notesToMarkdown, type Note, type ReviewState, type Store, type Summary } from '../state';
import { readSide, type Range, type Repo } from '../git';
import {
  anchor,
  anchorNear,
  autoScrollTarget,
  buildView,
  firstCodeRow,
  firstEmphasisStart,
  remapCursor,
  type Layout,
} from '../view';
import { explainAll, ExplainAborted, ExplainUnavailable, skipReason, type Explainer } from '../explain';
import {
  checkKinds,
  DEFAULT_FLOW_MODEL,
  flowSignature,
  generateFlow,
  kindCheckPaths,
  layoutFlow,
  linkFiles,
  parseMermaid,
  type Flow,
  type FlowBox,
  type FlowLayout,
  stepLine,
  type StoredFlow,
} from '../flow';

type KeyPress = Key;

/** Bulk edits to the viewed marks. Both throw away work, so both ask first. */
interface BulkAction {
  prompt: string;
  done: string;
  apply: (files: FileDiff[]) => Record<string, string>;
}

const MARK_ALL: BulkAction = {
  prompt: 'mark every file viewed?',
  done: 'all files marked viewed',
  apply: (files) => Object.fromEntries(files.map((f) => [f.path, f.hash])),
};

const CLEAR_ALL: BulkAction = {
  prompt: 'clear every viewed mark?',
  done: 'viewed marks cleared',
  apply: () => ({}),
};

const MIN_SPLIT_COLS = 108;
const HIGHLIGHT_LIMIT = 1_500_000;

export interface OpenRequest {
  path: string;
  line: number;
}

interface Props {
  repo: Repo;
  range: Range;
  branch: string;
  files: FileDiff[];
  initial: ReviewState;
  store: Store;
  theme: Theme;
  highlighter: Highlighter;
  reload: () => Promise<FileDiff[]>;
  onOpenRequest: (req: OpenRequest) => void;
  preferredLayout: Layout;
  /** How often to re-read the diff in the background; 0 means only on `r`. */
  watchMs: number;
  /** Set only when reviewing a branch that is not yours; null disables it. */
  explain: Explainer | null;
  /** Shown sticky on open: things true about the repo that this review hides. */
  initialMessage?: string | null;
}

interface Scroll {
  cursor: number;
  scroll: number;
  hscroll: number;
  /**
   * Set once you scroll sideways yourself, which stops the view following
   * changes for this file — having asked for a column, you keep it. Per-file,
   * so moving to another file starts following again.
   */
  manualH?: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * The smallest pan that brings a box into view, so moving the selection
 * scrolls only when it has to and a pan you chose survives moves within it.
 * A box larger than the view keeps its top-left corner visible.
 */
function fitPan(box: FlowBox, pan: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  const axis = (start: number, size: number, at: number, view: number) => {
    if (start < at) return start;
    if (start + size > at + view) return Math.min(start, start + size - view);
    return at;
  };
  return { x: Math.max(0, axis(box.x - 2, box.w + 4, pan.x, w)), y: Math.max(0, axis(box.y - 1, box.h + 2, pan.y, h)) };
}

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 120,
    rows: stdout.rows || 40,
  });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 120, rows: stdout.rows || 40 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

export function App(props: Props): React.ReactElement {
  const { repo, range, branch, store, theme, highlighter, reload, onOpenRequest, preferredLayout, watchMs, explain } =
    props;
  const { exit } = useApp();
  const { columns, rows: termRows } = useTerminalSize();

  const [files, setFiles] = useState(props.files);
  const [fileIndex, setFileIndex] = useState(() => {
    const last = props.initial.last?.path;
    const found = last ? props.files.findIndex((f) => f.path === last) : -1;
    return found >= 0 ? found : 0;
  });
  const [viewedMap, setViewedMap] = useState<Record<string, string>>(props.initial.viewed);
  const [notes, setNotes] = useState<Note[]>(() => reanchorNotes(props.initial.notes, props.files));
  const [summaries, setSummaries] = useState<Record<string, Summary>>(props.initial.summaries);
  const [positions, setPositions] = useState<Record<string, Scroll>>({});
  const [layout, setLayout] = useState<Layout>(preferredLayout);
  const [mode, setMode] = useState<'browse' | 'note' | 'help' | 'confirm'>('browse');
  // Which page is showing; separate from `mode` so help opens over either.
  const [tab, setTab] = useState<'diff' | 'flow'>('diff');
  const [storedFlow, setStoredFlow] = useState<StoredFlow | undefined>(props.initial.flow);
  const [flowStatus, setFlowStatus] = useState<FlowStatus>({ kind: 'ready' });
  const [flowSel, setFlowSel] = useState(0);
  const [flowPan, setFlowPan] = useState({ x: 0, y: 0 });
  // A tip can cover a neighbouring step, so it can be put away.
  const [flowTips, setFlowTips] = useState(true);
  const flowAbortRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [buffer, setBuffer] = useState('');
  const [message, setMessage] = useState<{ text: string; sticky?: boolean } | null>(
    props.initialMessage ? { text: props.initialMessage, sticky: true } : null,
  );
  const [tokenCache, setTokenCache] = useState<Record<string, TokenMaps>>({});
  const [explainProgress, setExplainProgress] = useState<{
    done: number;
    total: number;
    startedAt: number;
  } | null>(null);
  const [tick, setTick] = useState(0);
  // Bumped by startup and by `r`, never by the watch timer: see the explain effect.
  const [explainGen, setExplainGen] = useState(0);
  const explainAbortRef = useRef<AbortController | null>(null);

  /**
   * A file shown from the flow that the diff does not contain: an unchanged
   * step drawn for context, or a new file git does not track. Read-only and
   * outside the file list — viewed marks and notes belong to the review, and
   * this file is not in it. Cleared by moving to any real file.
   */
  const [peek, setPeek] = useState<FileDiff | null>(null);
  const file = peek ?? files[fileIndex];
  const filesRef = useRef(files);
  filesRef.current = files;
  const fileIndexRef = useRef(fileIndex);
  fileIndexRef.current = fileIndex;

  // A peeked file has one side worth showing, so it never splits.
  const effectiveLayout: Layout = columns < MIN_SPLIT_COLS || peek ? 'unified' : layout;

  const promptHeight = mode === 'note' || mode === 'confirm' ? 2 : 0;
  // A theme that owns the screen gets a painted right-hand gutter. It costs a
  const contentHeight = Math.max(3, termRows - 2 - promptHeight);
  const listWidth = clamp(Math.floor(columns * 0.28), 26, 46);
  const diffWidth = Math.max(20, columns - listWidth - 1);
  const bodyHeight = Math.max(1, contentHeight - DIFF_HEADER_HEIGHT);

  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;

  const bodyHeightRef = useRef(bodyHeight);
  bodyHeightRef.current = bodyHeight;

  const viewed = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) if (viewedMap[f.path] === f.hash) set.add(f.path);
    return set;
  }, [files, viewedMap]);

  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) counts.set(n.path, (counts.get(n.path) ?? 0) + 1);
    return counts;
  }, [notes]);

  const summary = file && summaries[file.path]?.hash === file.hash ? summaries[file.path]?.body : undefined;

  const viewRows = useMemo(
    () =>
      file
        ? buildView(file, notes, effectiveLayout, {
            summary,
            summaryWidth: diffWidth,
            summaryPending: !!explainProgress,
          })
        : [],
    [file, notes, effectiveLayout, summary, diffWidth, explainProgress],
  );

  const firstCode = useMemo(() => firstCodeRow(viewRows), [viewRows]);
  const defaultPos: Scroll = { cursor: firstCode, scroll: 0, hscroll: 0 };
  const defaultPosRef = useRef(defaultPos);
  defaultPosRef.current = defaultPos;

  const pos = (file && positions[file.path]) || defaultPos;
  const cursor = clamp(pos.cursor, 0, Math.max(0, viewRows.length - 1));
  const maxScroll = Math.max(0, viewRows.length - bodyHeight);
  let top = clamp(pos.scroll, 0, maxScroll);
  if (cursor < top) top = cursor;
  if (cursor > top + bodyHeight - 1) top = cursor - bodyHeight + 1;
  top = clamp(top, 0, maxScroll);

  const setPos = useCallback(
    (path: string, patch: (prev: Scroll) => Scroll) => {
      setPositions((prev) => ({ ...prev, [path]: patch(prev[path] ?? defaultPosRef.current) }));
    },
    [],
  );

  const flash = useCallback((text: string) => setMessage({ text }), []);
  /** Failures stay until you acknowledge them; 2.6 seconds is not reading time. */
  const raise = useCallback((text: string) => setMessage({ text, sticky: true }), []);

  useEffect(() => {
    if (!message || message.sticky) return;
    const t = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(t);
  }, [message]);

  // Persist whenever review state changes; the store serialises the writes.
  useEffect(() => {
    void store.save({
      viewed: viewedMap,
      notes,
      summaries,
      flow: storedFlow,
      // The list position, not a peek: a peeked file is not in the list to resume at.
      last: files[fileIndex] ? { path: files[fileIndex]!.path } : undefined,
      updatedAt: new Date().toISOString(),
    });
  }, [store, viewedMap, notes, summaries, storedFlow, files, fileIndex]);

  // --- diff flow -----------------------------------------------------------

  // Parsed and laid out from the stored source every time, never stored drawn:
  // the file links must follow the current diff, and so must any layout fix.
  const linkedFlow = useMemo((): Flow | null => {
    if (!storedFlow) return null;
    try {
      return linkFiles(parseMermaid(storedFlow.mermaid), files).flow;
    } catch {
      return null;
    }
  }, [storedFlow, files]);

  // The old side of each modified file with a step the diagram calls new, so
  // checkKinds can tell "added" from "changed" by what git has rather than
  // by what the model guessed. Read once per drawing; until it arrives the
  // diagram shows as claimed.
  const [oldTexts, setOldTexts] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    setOldTexts(new Map());
    const oldRev = range.oldRev;
    if (!linkedFlow || !oldRev) return;
    const paths = kindCheckPaths(linkedFlow, files);
    if (!paths.length) return;
    let live = true;
    void (async () => {
      const read = new Map<string, string>();
      for (const path of paths) {
        const file = files.find((f) => f.path === path);
        const text = await readSide(repo, { kind: 'rev', rev: oldRev }, file?.oldPath ?? path);
        if (text != null) read.set(path, text);
      }
      if (live) setOldTexts(read);
    })();
    return () => {
      live = false;
    };
  }, [linkedFlow, files, repo, range.oldRev]);

  const flowGraph = useMemo((): { flow: Flow; layout: FlowLayout } | null => {
    if (!linkedFlow) return null;
    const flow = checkKinds(linkedFlow, files, oldTexts);
    return { flow, layout: layoutFlow(flow) };
  }, [linkedFlow, files, oldTexts]);
  const flowStale = !!storedFlow && storedFlow.hash !== flowSignature(files);
  const flowBodyHeight = Math.max(1, contentHeight - FLOW_CHROME_HEIGHT);
  const flowViewRef = useRef({ w: columns, h: flowBodyHeight });
  flowViewRef.current = { w: columns, h: flowBodyHeight };

  // A fresh drawing starts on the first changed step: that is what the tab is
  // for, and the entry point above it is usually one `k` away. Keyed on the
  // stored source, not the graph: `--watch` re-links the graph on every edit,
  // and the selection should not jump back each time.
  useEffect(() => {
    if (!flowGraph) return;
    const { flow, layout } = flowGraph;
    const first = layout.order.find((i) => flow.nodes[i]?.kind !== 'context') ?? layout.order[0] ?? 0;
    setFlowSel(first);
    const box = layout.boxes.find((b) => b.node === first);
    setFlowPan(box ? fitPan(box, { x: 0, y: 0 }, flowViewRef.current.w, flowViewRef.current.h) : { x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedFlow]);

  /**
   * One request for the whole review. Never on startup and never from the
   * watch timer: only when the tab is opened with nothing to show, or on `R`
   * -- so a review that never looks at the flow never pays for one.
   */
  const requestFlow = useCallback(() => {
    if (!explain) {
      // With a diagram on screen the 'off' state draws nothing new, so R
      // would look like it did nothing; say why instead.
      setFlowStatus({ kind: 'off' });
      flash('drawing a flow sends the diff to the claude CLI: restart with --explain (or PRVIEW_EXPLAIN=1)');
      return;
    }
    flowAbortRef.current?.abort();
    const abort = new AbortController();
    flowAbortRef.current = abort;
    const current = filesRef.current;
    setFlowStatus({
      kind: 'loading',
      startedAt: Date.now(),
      model: explain.flowModel ?? DEFAULT_FLOW_MODEL,
      files: current.filter((f) => !skipReason(f)).length,
    });
    generateFlow(current, explain, abort.signal)
      .then(({ mermaid, model }) => {
        if (abort.signal.aborted) return;
        setStoredFlow({
          hash: flowSignature(current),
          mermaid,
          model,
          createdAt: new Date().toISOString(),
        });
        setFlowStatus({ kind: 'ready' });
      })
      .catch((err: unknown) => {
        if (err instanceof ExplainAborted || abort.signal.aborted) return;
        setFlowStatus({ kind: 'error', message: (err as Error).message });
      });
  }, [explain, flash]);

  useEffect(() => () => flowAbortRef.current?.abort(), []);

  const openFlow = useCallback(() => {
    setTab('flow');
    if (!storedFlow && flowStatus.kind !== 'loading' && flowStatus.kind !== 'error') requestFlow();
  }, [storedFlow, flowStatus.kind, requestFlow]);

  const explainTriedRef = useRef(new Set<string>());
  const explainOffRef = useRef(false);

  // One request for the whole review rather than one per file: a single round
  // trip instead of N, and nothing has to choose which files a cap is spent on.
  // Results are applied per chunk, so a branch too big for one request fills in
  // progressively instead of arriving all at the end.
  //
  // Keyed on `explainGen`, not `files`: with --watch the files change every
  // time you save, and each save would otherwise be another API call — and,
  // through the cleanup, abort the batch already in flight. Summaries for
  // files edited since go stale (their hash moves on) until you press `r`.
  useEffect(() => {
    const files = filesRef.current;
    if (!explain || !files.length || explainOffRef.current) return;
    // Apply the same skip rule the runner will: counting a lockfile here makes
    // the indicator promise work that is never going to happen, and re-arms
    // this effect for a file that can never be satisfied.
    // Asked-about files are remembered per version, so the effect cannot
    // re-arm as `pending` shrinks. Keying off the pending set instead made the
    // cap per-pass rather than per session: with a cap of 3 it sent 3, saw 30
    // still missing, and went round again.
    const tried = explainTriedRef.current;
    const candidates = files.filter(
      (f) =>
        summariesRef.current[f.path]?.hash !== f.hash &&
        !skipReason(f) &&
        !tried.has(`${f.path}@${f.hash}`),
    );
    if (!candidates.length) return;

    // The runner owns the cap. Slicing here too left it computing the
    // shortfall against an already-truncated list, so it always came out as
    // zero and the truncation went unreported — which is the silence that made
    // a capped batch look like a broken tool.
    for (const f of candidates) tried.add(`${f.path}@${f.hash}`);

    const abort = new AbortController();
    explainAbortRef.current = abort;
    setExplainProgress({
      done: 0,
      total: Math.min(candidates.length, explain.maxFiles),
      startedAt: Date.now(),
    });
    void explainAll(candidates, explain, abort.signal, (chunk, done, total) => {
      setExplainProgress((prev) => ({ done, total, startedAt: prev?.startedAt ?? Date.now() }));
      setSummaries((prev) => {
        const next = { ...prev };
        for (const [path, body] of chunk) {
          const file = files.find((f) => f.path === path);
          if (file) {
            next[path] = { hash: file.hash, body, model: explain.model, createdAt: new Date().toISOString() };
          }
        }
        return next;
      });
    })
      .then((result) => {
        setExplainProgress(null);
        // Silence here is what made a truncated batch look like a broken tool.
        if (result && result.overCap > 0) {
          raise(
            `explained ${result.sent}; ${result.overCap} file${result.overCap === 1 ? '' : 's'} ` +
              `over --explain-max (${explain.maxFiles})`,
          );
        }
      })
      .catch((err: unknown) => {
        setExplainProgress(null);
        if (err instanceof ExplainAborted || abort.signal.aborted) return;
        raise(`explain: ${(err as Error).message}${explain.logPath ? '  (detail in .git/prview/explain.log)' : ''}`);
        if (err instanceof ExplainUnavailable) explainOffRef.current = true;
      });

    return () => {
      abort.abort();
    };
  }, [explain, explainGen, flash, raise]);

  // Syntax highlighting for the visible file only, both sides, lazily.
  useEffect(() => {
    if (!file) return;
    const key = `${file.path}@${file.hash}`;
    if (tokenCache[key]) return;
    let cancelled = false;
    const lang = langFor(file.path);
    if (!lang || file.binary) {
      setTokenCache((prev) => ({ ...prev, [key]: { old: null, new: null } }));
      return;
    }
    void (async () => {
      const oldPath = file.oldPath;
      const newPath = file.newPath;
      const [oldSrc, newSrc] = await Promise.all([
        oldPath && file.status !== 'added'
          ? readSide(repo, { kind: 'rev', rev: range.oldRev ?? 'HEAD' }, oldPath)
          : Promise.resolve(null),
        newPath && file.status !== 'deleted' ? readSide(repo, range.newSide, newPath) : Promise.resolve(null),
      ]);
      const [oldToks, newToks] = await Promise.all([
        oldSrc && oldSrc.length < HIGHLIGHT_LIMIT ? highlighter.tokenize(oldSrc, lang) : Promise.resolve(null),
        newSrc && newSrc.length < HIGHLIGHT_LIMIT ? highlighter.tokenize(newSrc, lang) : Promise.resolve(null),
      ]);
      if (!cancelled) setTokenCache((prev) => ({ ...prev, [key]: { old: oldToks, new: newToks } }));
    })();
    return () => {
      cancelled = true;
    };
  }, [file, repo, range, highlighter, tokenCache]);

  const tokens: TokenMaps = (file && tokenCache[`${file.path}@${file.hash}`]) || { old: null, new: null };

  const posRef = useRef(pos);
  posRef.current = pos;

  // Follow the change sideways: landing on a row whose emphasis is beyond the
  // visible columns would otherwise show two lines marked changed with no
  // visible difference — a long image tag or import path does exactly that.
  useEffect(() => {
    if (!file) return;
    const here = posRef.current;
    if (here.manualH) return;
    const target = autoScrollTarget(
      firstEmphasisStart(viewRows[cursor]),
      here.hscroll,
      codeWidthFor(file, diffWidth, effectiveLayout),
    );
    if (target == null) return;
    setPos(file.path, (p) => ({ ...p, hscroll: target }));
  }, [file, cursor, viewRows, diffWidth, effectiveLayout, setPos]);

  const flowLoading = flowStatus.kind === 'loading';
  useEffect(() => {
    if (!explainProgress && !flowLoading) return;
    const timer = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(timer);
  }, [explainProgress, flowLoading]);

  const moveCursor = useCallback(
    (delta: number) => {
      if (!file) return;
      setPos(file.path, (prev) => {
        const total = viewRows.length;
        const next = clamp(prev.cursor + delta, 0, Math.max(0, total - 1));
        const h = bodyHeightRef.current;
        let scroll = prev.scroll;
        if (next < scroll) scroll = next;
        if (next > scroll + h - 1) scroll = next - h + 1;
        return { ...prev, cursor: next, scroll: clamp(scroll, 0, Math.max(0, total - h)) };
      });
    },
    [file, setPos, viewRows.length],
  );

  const jumpHunk = useCallback(
    (dir: 1 | -1) => {
      if (!file) return;
      setPos(file.path, (prev) => {
        // Stay put when there is no further hunk, rather than flinging the
        // cursor to the end of the file.
        for (let i = prev.cursor + dir; i >= 0 && i < viewRows.length; i += dir) {
          if (viewRows[i]?.t !== 'hunk') continue;
          const h = bodyHeightRef.current;
          return { ...prev, cursor: i, scroll: clamp(i, 0, Math.max(0, viewRows.length - h)) };
        }
        return prev;
      });
    },
    [file, setPos, viewRows],
  );

  const moveFile = useCallback(
    (delta: number) => {
      if (!files.length) return;
      // Leaving a peek returns to the file list where it was, not one past it.
      if (peek) return setPeek(null);
      setFileIndex((prev) => clamp(prev + delta, 0, files.length - 1));
    },
    [files.length, peek],
  );

  const nextUnviewed = useCallback(
    (dir: 1 | -1) => {
      if (!files.length) return;
      setFileIndex((prev) => {
        for (let step = 1; step <= files.length; step++) {
          const i = (prev + dir * step + files.length * step) % files.length;
          const f = files[i];
          if (f && !viewed.has(f.path)) return i;
        }
        flash('every file is marked viewed');
        return prev;
      });
    },
    [files, viewed, flash],
  );

  const toggleViewed = useCallback(() => {
    if (!file) return;
    setViewedMap((prev) => {
      const copy = { ...prev };
      if (copy[file.path] === file.hash) delete copy[file.path];
      else copy[file.path] = file.hash;
      return copy;
    });
  }, [file]);

  const currentAnchor = anchorNear(viewRows, cursor);

  const addNote = useCallback(
    (body: string) => {
      if (!file || !currentAnchor || !body.trim()) return;
      const { side, line } = currentAnchor;
      setNotes((prev) => [...prev, newNote(file.path, side, line, body.trim(), snapshotOf(file, side, line))]);
      flash('note saved');
    },
    [file, currentAnchor, flash],
  );

  const deleteNote = useCallback(() => {
    if (!file) return;
    const row = viewRows[cursor];
    if (row?.t === 'note') {
      const id = row.note.id;
      setNotes((prev) => prev.filter((n) => n.id !== id));
      flash('note deleted');
      return;
    }
    if (!currentAnchor) return;
    const target = notes.find(
      (n) => n.path === file.path && n.side === currentAnchor.side && n.line === currentAnchor.line,
    );
    if (!target) {
      flash('no note on this line');
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== target.id));
    flash('note deleted');
  }, [file, viewRows, cursor, currentAnchor, notes, flash]);

  /**
   * Swap in a freshly read diff, staying on the file you were looking at
   * rather than on its old index — a file added or dropped above it would
   * otherwise move you to a different file mid-read.
   */
  const applyFresh = useCallback((fresh: FileDiff[]) => {
    const here = filesRef.current[fileIndexRef.current]?.path;
    const at = here ? fresh.findIndex((f) => f.path === here) : -1;
    setFiles(fresh);
    setFileIndex((prev) => (at >= 0 ? at : clamp(prev, 0, Math.max(0, fresh.length - 1))));
    setNotes((prev) => reanchorNotes(prev, fresh));
  }, []);

  const reloadingRef = useRef(false);
  const doReload = useCallback(() => {
    void (async () => {
      reloadingRef.current = true;
      try {
        const fresh = await reload();
        applyFresh(fresh);
        setTokenCache({});
        setExplainGen((g) => g + 1);
        flash(`reloaded — ${fresh.length} file${fresh.length === 1 ? '' : 's'}`);
      } catch (err) {
        flash(`reload failed: ${(err as Error).message}`);
      } finally {
        reloadingRef.current = false;
      }
    })();
  }, [reload, applyFresh, flash]);

  // The background half of `r`, for watching a change while it is being made.
  // Only acts when some patch actually changed, so an idle review does not
  // flash or re-highlight every few seconds; and only in browse mode, so the
  // line a note is being typed against cannot move under it. A chained
  // timeout rather than an interval: a slow `git diff` delays the next read
  // instead of piling up behind it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (watchMs <= 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const signature = (fs: FileDiff[]) => fs.map((f) => `${f.path}@${f.hash}`).join('\n');
    const poll = async () => {
      if (modeRef.current === 'browse' && !reloadingRef.current) {
        try {
          const fresh = await reload();
          if (!stopped && signature(fresh) !== signature(filesRef.current)) {
            applyFresh(fresh);
            // Highlighting is cached per path@hash, so unchanged files keep
            // theirs; only drop what no longer exists.
            const live = new Set(fresh.map((f) => `${f.path}@${f.hash}`));
            setTokenCache((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => live.has(k))));
            flash(`diff changed — ${fresh.length} file${fresh.length === 1 ? '' : 's'}`);
          }
        } catch {
          // Mid-rebase or mid-checkout git can fail for a moment; the next
          // tick will try again, and `r` still reports errors loudly.
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), watchMs);
    };
    timer = setTimeout(() => void poll(), watchMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [watchMs, reload, applyFresh, flash]);

  const writeNotes = useCallback(() => {
    void (async () => {
      const md = notesToMarkdown(notes, range.label, summaries, storedFlow);
      if (!md) {
        flash('no notes to write');
        return;
      }
      const out = join(repo.root, 'prview-notes.md');
      try {
        await writeFile(out, md, 'utf8');
        flash(`wrote ${out}`);
      } catch (err) {
        flash(`write failed: ${(err as Error).message}`);
      }
    })();
  }, [notes, summaries, storedFlow, range.label, repo.root, flash]);

  // Keep the cursor on the same source line when the layout changes.
  //
  // The render in which the layout flips has already rebuilt `viewRows` for
  // the new layout while the cursor still holds an index into the old one, so
  // the anchor read there points at an unrelated line. Only record the anchor
  // while rows and layout agree; the effect below then consumes the last one
  // taken before the flip.
  const layoutRef = useRef(effectiveLayout);
  const anchorRef = useRef(currentAnchor);
  if (layoutRef.current === effectiveLayout) anchorRef.current = currentAnchor;
  useEffect(() => {
    if (layoutRef.current === effectiveLayout) return;
    layoutRef.current = effectiveLayout;
    if (!file) return;
    const target = anchorRef.current;
    setPos(file.path, (prev) => {
      const next = remapCursor(viewRows, target, prev.cursor);
      const h = bodyHeightRef.current;
      return { ...prev, cursor: next, scroll: clamp(next - Math.floor(h / 2), 0, Math.max(0, viewRows.length - h)) };
    });
  }, [effectiveLayout, file, setPos, viewRows]);

  // Where Enter on a flow step should land. Applied in an effect because the
  // rows of the file being opened do not exist until the next render.
  const pendingJumpRef = useRef<{ path: string; line: number } | null>(null);
  useEffect(() => {
    const jump = pendingJumpRef.current;
    if (!jump || !file || file.path !== jump.path) return;
    pendingJumpRef.current = null;
    const at = remapCursor(viewRows, { side: 'new', line: jump.line }, firstCode);
    const h = bodyHeightRef.current;
    setPos(file.path, (prev) => ({
      ...prev,
      cursor: at,
      scroll: clamp(at - Math.floor(h / 3), 0, Math.max(0, viewRows.length - h)),
    }));
  }, [file, viewRows, firstCode, setPos]);

  /** Open a flow step's file: from the diff if it is there, else read it whole. */
  const openStep = useCallback(
    (path: string, label: string) => {
      const i = files.findIndex((f) => f.path === path);
      if (i >= 0) {
        const target = files[i]!;
        const line = stepLine(target, label);
        if (line != null) pendingJumpRef.current = { path, line };
        setPeek(null);
        setFileIndex(i);
        setTab('diff');
        return;
      }
      void (async () => {
        const text = await readSide(repo, range.newSide, path);
        if (text == null) return flash(`${path} does not exist on the ${range.newLabel} side`);
        // In the old side too means it is simply unchanged; otherwise it is
        // new, and only missing from the diff because git does not track it.
        const before = await readSide(repo, { kind: 'rev', rev: range.oldRev ?? 'HEAD' }, path);
        const shown = wholeFile(path, text, before == null ? 'added' : 'context');
        if (!shown) return flash(`${path} is empty`);
        const line = stepLine(shown, label);
        if (line != null) pendingJumpRef.current = { path, line };
        setPeek(shown);
        setTab('diff');
      })();
    },
    [files, repo, range, flash],
  );

  const handleFlowKey = useCallback(
    (input: string, key: KeyPress) => {
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (input === '?') return setMode('help');
      if (input === 'f' || key.escape) return setTab('diff');
      if (input === 'R') return requestFlow();
      if (input === 't') return setFlowTips((on) => !on);
      if (input === 'r') return doReload();
      if (!flowGraph) return;
      const { flow, layout } = flowGraph;
      const { w, h } = flowViewRef.current;

      const select = (next: number) => {
        setFlowSel(next);
        const box = layout.boxes.find((b) => b.node === next);
        if (box) setFlowPan((pan) => fitPan(box, pan, w, h));
      };
      const count = layout.order.length;
      const at = Math.max(0, layout.order.indexOf(flowSel));
      if (input === 'j' || key.downArrow || key.tab) return select(layout.order[(at + 1) % count] ?? flowSel);
      if (input === 'k' || key.upArrow) return select(layout.order[(at - 1 + count) % count] ?? flowSel);
      // Next step this change actually touched, skipping the context around it.
      if (input === 'n' || input === 'p') {
        const dir = input === 'n' ? 1 : -1;
        for (let step = 1; step <= count; step++) {
          const i = layout.order[(((at + dir * step) % count) + count) % count];
          if (i !== undefined && flow.nodes[i]?.kind !== 'context') return select(i);
        }
        return;
      }
      const maxX = Math.max(0, layout.width - w);
      const maxY = Math.max(0, layout.height - h);
      if (input === 'h' || key.leftArrow) return setFlowPan((p) => ({ ...p, x: clamp(p.x - 8, 0, maxX) }));
      if (input === 'l' || key.rightArrow) return setFlowPan((p) => ({ ...p, x: clamp(p.x + 8, 0, maxX) }));
      if (key.ctrl && input === 'd') return setFlowPan((p) => ({ ...p, y: clamp(p.y + Math.floor(h / 2), 0, maxY) }));
      if (key.ctrl && input === 'u') return setFlowPan((p) => ({ ...p, y: clamp(p.y - Math.floor(h / 2), 0, maxY) }));
      if (key.return) {
        const step = flow.nodes[flowSel];
        const path = step?.file ?? step?.missing;
        if (!step || !path) return flash('this step is not linked to a file');
        openStep(path, step.label);
      }
    },
    [exit, requestFlow, doReload, flowGraph, flowSel, flash, openStep],
  );

  const handleKey = useCallback(
    (input: string, key: KeyPress) => {
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (input === '?') return setMode('help');
      if (input === 'f') return openFlow();
      if (peek && key.escape) {
        setPeek(null);
        return setTab('flow');
      }
      if (peek && (input === ' ' || input === 'a' || input === 'A' || input === 'c' || input === 'd')) {
        return flash('read-only: this file is not part of the diff');
      }
      if (peek && (input === 's')) return flash('a file outside the diff has one side; it stays unified');

      if (input === 'j' || key.downArrow) return moveCursor(1);
      if (input === 'k' || key.upArrow) return moveCursor(-1);
      if (key.ctrl && input === 'd') return moveCursor(Math.floor(bodyHeightRef.current / 2));
      if (key.ctrl && input === 'u') return moveCursor(-Math.floor(bodyHeightRef.current / 2));
      if (key.pageDown) return moveCursor(bodyHeightRef.current);
      if (key.pageUp) return moveCursor(-bodyHeightRef.current);
      if (input === 'g') return moveCursor(-viewRows.length);
      if (input === 'G') return moveCursor(viewRows.length);
      if (input === '}' || input === ']') return jumpHunk(1);
      if (input === '{' || input === '[') return jumpHunk(-1);

      if (!file) return;

      if (input === 'h' || key.leftArrow)
        return setPos(file.path, (p) => ({ ...p, hscroll: Math.max(0, p.hscroll - 8), manualH: true }));
      if (input === 'l' || key.rightArrow)
        return setPos(file.path, (p) => ({ ...p, hscroll: p.hscroll + 8, manualH: true }));
      // Resets the column and hands the view back to auto-follow, which takes
      // effect on the next cursor move rather than yanking the view now.
      if (input === '0') return setPos(file.path, (p) => ({ ...p, hscroll: 0, manualH: false }));

      if (input === 'n' || input === 'J') return moveFile(1);
      if (input === 'p' || input === 'K') return moveFile(-1);
      if (key.tab) {
        setPeek(null);
        return nextUnviewed(key.shift ? -1 : 1);
      }

      if (input === ' ') return toggleViewed();
      // Both discard which files you had actually read, so both are deliberate.
      if (input === 'a' || input === 'A') {
        setPending(input === 'a' ? MARK_ALL : CLEAR_ALL);
        return setMode('confirm');
      }

      if (input === 'c') {
        if (!currentAnchor) return flash('no code line to attach a note to');
        setBuffer('');
        return setMode('note');
      }
      if (input === 'd') return deleteNote();
      if (input === 's') return setLayout((l) => (l === 'split' ? 'unified' : 'split'));
      if (input === 'r') return doReload();
      if (input === 'w') return writeNotes();
      if (input === 'o') {
        onOpenRequest({ path: file.path, line: currentAnchor?.line ?? 1 });
        return exit();
      }
    },
    [
      exit, moveCursor, jumpHunk, viewRows.length, file, setPos, moveFile, nextUnviewed,
      toggleViewed, flash, currentAnchor, deleteNote, doReload, writeNotes, onOpenRequest, openFlow, peek,
    ],
  );

  useInput((input, key) => {
    if (message?.sticky) setMessage(null);

    // Locked while a batch is in flight: most files have no summary yet, so
    // browsing would mean reading a review that is quietly incomplete.
    if (explainProgress) {
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (key.escape) {
        explainAbortRef.current?.abort();
        setExplainProgress(null);
        flash('explain cancelled');
      }
      return;
    }

    if (mode === 'note') {
      if (key.escape) {
        setMode('browse');
        setBuffer('');
        return;
      }
      if (key.return) {
        addNote(buffer);
        setMode('browse');
        setBuffer('');
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      // A multi-character chunk here is a paste, which is exactly what we want.
      if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
      return;
    }

    if (mode === 'help') {
      if (input === '?' || key.escape || input === 'q') setMode('browse');
      return;
    }

    if (mode === 'confirm') {
      if (pending && (input === 'y' || input === 'Y')) {
        setViewedMap(pending.apply(files));
        flash(pending.done);
      }
      setPending(null);
      setMode('browse');
      return;
    }

    // Terminals coalesce fast keystrokes — and key repeat — into a single data
    // event, so a chunk of plain characters is several presses, not one.
    const handler = tab === 'flow' ? handleFlowKey : handleKey;
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape) {
      for (const ch of input) handler(ch, key);
      return;
    }
    handler(input, key);
  });


  if (explainProgress) {
    return (
      <Working
        theme={theme}
        width={columns}
        height={termRows}
        tick={tick}
        done={explainProgress.done}
        total={explainProgress.total}
        model={explain?.model ?? '?'}
        elapsedSeconds={Math.max(0, Math.round((Date.now() - explainProgress.startedAt) / 1000))}
      />
    );
  }

  if (mode === 'help') {
    return <Help theme={theme} width={columns} height={termRows} />;
  }

  if (!files.length) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.plain}>No changes in {range.label}.</Text>
        <Text color={theme.dim}>Try `prview main` for a branch review, or `prview --staged`.</Text>
      </Box>
    );
  }

  const totals = files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );

  const statusBar = (
    <StatusBar
      theme={theme}
      width={columns}
      label={range.label}
      branch={branch}
      files={files.length}
      additions={totals.additions}
      deletions={totals.deletions}
      layout={effectiveLayout}
      message={message?.text ?? null}
      hint={tab === 'flow' ? 'j/k step  n/p changed step  enter open file  t tips  h/l pan  R redraw  f back  q quit' : undefined}
    />
  );

  if (tab === 'flow') {
    // A stored diagram that no longer parses is an error to show, not an
    // empty tab that looks like nothing was ever drawn.
    const status: FlowStatus =
      storedFlow && !flowGraph && flowStatus.kind === 'ready'
        ? { kind: 'error', message: 'the stored diagram could not be read' }
        : flowStatus;
    // The diagram's own note on the step first. Failing that, the summary of
    // its file — only while it still describes the file's current patch, and
    // flagged as being about the file, since it was not written for the step.
    const focused = flowGraph?.flow.nodes[flowSel];
    const focusedFile = focused?.file ? files.find((f) => f.path === focused.file) : undefined;
    const fileSummary = focusedFile && summaries[focusedFile.path];
    const tip = !flowTips
      ? null
      : focused?.note
      ? { text: focused.note, source: 'note' as const }
      : fileSummary && focusedFile && fileSummary.hash === focusedFile.hash
        ? { text: fileSummary.body, source: 'summary' as const }
        : null;
    return (
      <Box flexDirection="column" width={columns} height={termRows}>
        <FlowPane
          theme={theme}
          width={columns}
          height={contentHeight}
          flow={flowGraph?.flow ?? null}
          layout={flowGraph?.layout ?? null}
          status={status}
          stale={flowStale}
          author={storedFlow?.model ?? null}
          selected={flowSel}
          panX={flowPan.x}
          panY={flowPan.y}
          tick={tick}
          tip={tip}
        />
        {statusBar}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={termRows}>
      <Box height={contentHeight}>
        <FileList
          files={files}
          cursor={fileIndex}
          viewed={viewed}
          noteCounts={noteCounts}
          theme={theme}
          width={listWidth}
          height={contentHeight}
        />
        <Box height={contentHeight} width={1} flexDirection="column">
          {Array.from({ length: contentHeight }, (_, i) => (
            <Text key={i} color={theme.border}>
              {DIVIDER}
            </Text>
          ))}
        </Box>
        {file ? (
          <DiffPane
            file={file}
            oldLabel={range.oldLabel}
            newLabel={range.newLabel}
            rows={viewRows}
            tokens={tokens}
            theme={theme}
            width={diffWidth}
            height={contentHeight}
            cursor={cursor}
            scroll={top}
            hscroll={pos.hscroll}
            viewed={viewed.has(file.path)}
            noteCount={peek ? 0 : (noteCounts.get(file.path) ?? 0)}
            banner={
              peek
                ? peek.status === 'added'
                  ? 'new, untracked — not in this diff (git add -N to include it) · esc back to flow'
                  : 'unchanged — shown for context, not part of this diff · esc back to flow'
                : undefined
            }
          />
        ) : null}
      </Box>
      {mode === 'note' ? <NoteInput theme={theme} width={columns} prompt="note ▸" value={buffer} /> : null}
      {mode === 'confirm' && pending ? (
        <NoteInput theme={theme} width={columns} prompt={`${pending.prompt} y / n`} value="" />
      ) : null}
      {statusBar}
    </Box>
  );
}
