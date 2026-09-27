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
import type { Theme } from '../theme';
import type { FileDiff } from '../parse';
import { Highlighter, langFor } from '../highlight';
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
  const { repo, range, branch, store, theme, highlighter, reload, onOpenRequest, preferredLayout, explain } =
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
  const [notes, setNotes] = useState<Note[]>(props.initial.notes);
  const [summaries, setSummaries] = useState<Record<string, Summary>>(props.initial.summaries);
  const [positions, setPositions] = useState<Record<string, Scroll>>({});
  const [layout, setLayout] = useState<Layout>(preferredLayout);
  const [mode, setMode] = useState<'browse' | 'note' | 'help' | 'confirm'>('browse');
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
  const explainAbortRef = useRef<AbortController | null>(null);

  const file = files[fileIndex];

  const effectiveLayout: Layout = columns < MIN_SPLIT_COLS ? 'unified' : layout;

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
      last: file ? { path: file.path } : undefined,
      updatedAt: new Date().toISOString(),
    });
  }, [store, viewedMap, notes, summaries, file]);

  const explainTriedRef = useRef(new Set<string>());
  const explainOffRef = useRef(false);

  // One request for the whole review rather than one per file: a single round
  // trip instead of N, and nothing has to choose which files a cap is spent on.
  // Results are applied per chunk, so a branch too big for one request fills in
  // progressively instead of arriving all at the end.
  useEffect(() => {
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
  }, [explain, files, flash, raise]);

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

  useEffect(() => {
    if (!explainProgress) return;
    const timer = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(timer);
  }, [explainProgress]);

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
      setFileIndex((prev) => clamp(prev + delta, 0, files.length - 1));
    },
    [files.length],
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
      setNotes((prev) => [...prev, newNote(file.path, currentAnchor.side, currentAnchor.line, body.trim())]);
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

  const doReload = useCallback(() => {
    void (async () => {
      try {
        const fresh = await reload();
        setFiles(fresh);
        setTokenCache({});
        flash(`reloaded — ${fresh.length} file${fresh.length === 1 ? '' : 's'}`);
      } catch (err) {
        flash(`reload failed: ${(err as Error).message}`);
      }
    })();
  }, [reload, flash]);

  const writeNotes = useCallback(() => {
    void (async () => {
      const md = notesToMarkdown(notes, range.label, summaries);
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
  }, [notes, summaries, range.label, repo.root, flash]);

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

  const handleKey = useCallback(
    (input: string, key: KeyPress) => {
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (input === '?') return setMode('help');

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
      if (key.tab) return nextUnviewed(key.shift ? -1 : 1);

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
      toggleViewed, flash, currentAnchor, deleteNote, doReload, writeNotes, onOpenRequest,
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
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape) {
      for (const ch of input) handleKey(ch, key);
      return;
    }
    handleKey(input, key);
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
            noteCount={noteCounts.get(file.path) ?? 0}
          />
        ) : null}
      </Box>
      {mode === 'note' ? <NoteInput theme={theme} width={columns} prompt="note ▸" value={buffer} /> : null}
      {mode === 'confirm' && pending ? (
        <NoteInput theme={theme} width={columns} prompt={`${pending.prompt} y / n`} value="" />
      ) : null}
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
      />
    </Box>
  );
}
