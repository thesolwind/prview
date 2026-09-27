# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`prview` — a terminal diff reviewer (Ink/React TUI). Two panes: changed files
on the left, a GitHub-style side-by-side (or unified) diff on the right, with
real syntax highlighting and persistent review state (viewed files, line
notes, generated summaries) stored per-range in `.git/prview/reviews.json`.
`README.md` is a short landing page; `docs/flags.md` is the full CLI
reference, `docs/explain.md` summarises how `--explain` calls the `claude`
CLI, and `docs/annotate-for-review.md` covers the skill. The reasoning behind
the rest (base-branch detection, review-state keying, rendering) lives in the
doc comments of the modules below.

## Commands

```sh
npm run build       # esbuild bundle -> dist/cli.js
npm run dev          # esbuild watch
npm test             # bundles test/*.test.ts -> dist/test, runs with node --test
npm run typecheck    # tsc --noEmit
npm run build -- --preview   # also builds dist/preview.js (headless UI renderer)
```

Run a single test file directly once built:

```sh
node scripts/build.mjs        # or --watch
node --test dist/test/parse.test.js
```

There is no watch-mode test runner; `npm test` always rebuilds first via
`scripts/test.mjs`, which bundles the files listed there and runs
`node --test` over the output. When adding a new test file, add it to the
`entryPoints` array in `scripts/test.mjs` (and the corresponding path in the
`node --test` args) or it silently won't run.

`node dist/preview.js <repo> [spec] --cols 150 --rows 30 --keys "n,n,j,space,c"`
boots the real Ink UI against a real repo with a fake TTY and prints the
final frame — this is how layout and key handling get checked without an
interactive terminal, and is the way to verify UI changes rather than
launching the real TUI.

## Architecture

Pipeline, roughly in data-flow order:

1. **`src/git.ts`** — all shelling out to `git`. Resolves a user's revision
   spec (`RangeRequest`) into a `Range` (the `git diff` args, a stable
   storage key, and what each side of the split view should be labeled).
   Also owns `--pr` base-branch auto-detection (delegated to `src/base.ts`
   for the ranking heuristic) and reading a file's full blob for
   highlighting context (`readSide`).
2. **`src/parse.ts`** — turns raw `git diff` text into `FileDiff[]` (files →
   hunks → `DiffLine[]`), including a hash of each file's raw patch (used to
   invalidate "viewed" marks and cache summaries).
3. **`src/pair.ts`** + **`src/intraline.ts`** — turns hunks into left/right
   `Row[]` pairs for split rendering, with word-level intraline diff spans.
4. **`src/highlight.ts`** — Shiki-based syntax highlighting of full file
   blobs (not diff fragments — hunks starting inside a block comment or
   template literal would otherwise color wrong).
5. **`src/view.ts`** — combines parsed diff + pairing + highlighting +
   viewport/scroll state into what's actually drawn, including horizontal
   auto-scroll-to-change and the split↔unified fold at 108 columns.
6. **`src/ui/*.tsx`** — the Ink components. `App.tsx` is the root: owns
   keybindings, viewed/note state mutation, and wiring `Store` + `Highlighter`
   + `Explainer` into the panes. `DiffPane.tsx` renders the diff itself;
   `FileList.tsx`, `StatusBar.tsx`, `NoteInput.tsx`, `Help.tsx`, `Working.tsx`
   are the surrounding chrome (the last is the "analysing N diffs" takeover
   screen during `--explain`).
7. **`src/state.ts`** — the `Store`: atomic read-modify-write of
   `.git/prview/reviews.json`, keyed by range. Holds `viewed` marks (keyed by
   patch hash, so edits invalidate them), `notes` (yours, anchored to
   `path:side:line`), and `summaries` (generated, separate namespace so they
   never get confused with your own notes). Also markdown export
   (`notesToMarkdown`) and the `--reset` scopes.
8. **`src/explain.ts`** — `--explain`: batches diffs (skipping generated
   files, capping size) into one shelled-out call to the `claude` CLI per
   batch, parses `path<TAB>summary` lines back out, caches per patch hash.
   Never runs unprompted — off unless `--explain` or `PRVIEW_EXPLAIN=1`.
9. **`src/annotate.ts`** — the other half of `--annotate`: validates and
   merges a `{summaries, notes}` JSON payload from stdin into a `ReviewState`,
   used by the `annotate-for-review` skill (`.claude/skills/annotate-for-review/`) so an
   agent session can leave review notes for a human without touching
   `reviews.json` directly.
10. **`src/cli.ts`** — argument parsing and top-level command dispatch
    (`--notes`, `--reset`, `--prune`, `--annotate`, or launch the Ink app).

`src/dev/preview.tsx` is the headless-render entry point used by
`npm run build -- --preview` / `dist/preview.js`, not part of the shipped CLI.

## Working in this repo

- Written for the "why", not the "what": most non-trivial modules and
  functions carry a doc comment explaining a design decision (e.g. why
  summaries are batched in one request rather than per-file, why viewed marks
  key off the patch hash, why notes render above their line rather than
  below). Read the surrounding comments before changing behavior they
  describe — they usually record a rejected alternative and why it lost.
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`) — index access on
  arrays/records returns `T | undefined` and must be handled, not asserted
  away.
- `.git/prview/` (state, `explain.log`) is intentionally outside the work
  tree so it never shows up in `git status`; don't move review state into the
  repo itself.
- The `annotate-for-review` skill (`.claude/skills/annotate-for-review/SKILL.md`) is
  committed in this repo and self-applies here: after making a change to
  prview itself, consider using it (or `prview --annotate` directly) to leave
  review notes for whoever reviews the change.
