← [README](../README.md)

# How `--explain` works

`--explain` puts a one-line "what does this change do" above each file. It
does not call an API itself: it shells out to the **Claude Code CLI**
(`claude`), so it uses whatever account and login that CLI already has.

```sh
<diffs> | claude -p "<instructions>" --model opus --allowed-tools ""
```

- **Off by default.** Your code goes to Anthropic only when you pass
  `--explain`, or set `PRVIEW_EXPLAIN=1`; `--no-explain` overrides both. If
  `claude` is not on `PATH`, it says so once and the review carries on.
- **Batched, not per file.** All the diffs go up together, marked
  `=== FILE: <path>`, and come back as one `path<TAB>summary` line each. A
  large branch is split into requests of at most 60k characters, which fill
  in one after another; a single file's patch is cut at 24k.
- **No tools.** `--allowed-tools ""` means the model only reads the diff text
  it was given; it cannot open files or run commands.
- **Generated files are skipped:** lockfiles, `dist/`, `build/`, `vendor/`,
  `*.min.js`, source maps, snapshots, and binary or mode-only changes.
- **Cached per file version.** A summary is stored against the file's patch
  hash in `.git/prview/reviews.json`. Reopening a review sends nothing; after
  a rebase only the files that changed are asked about again.
- **Opus by default**: a summary is the first thing you read about a file,
  so accuracy beats speed, and caching means each file version is paid for
  once. `--explain-model <id>` picks another model (`haiku` is the fast,
  cheap one). Summaries already cached stay as they are when the model
  changes; `--reset summaries` regenerates them (and drops the stored flow).
  `--explain-max <n>` (default 200 files) is a guard against runaway
  branches.

While it runs, the screen shows an "analysing N diffs" panel; `esc` cancels
and `q` quits (which also kills the request). Failures stay on screen until
you press a key, and the full error goes to `.git/prview/explain.log`.

## The diff flow (`f`)

The same opt-in covers one more request: pressing `f` opens a tab with a
diagram of the flow the change touches. The model is asked for a Mermaid
`flowchart` in a strict subset — `id["label"]` nodes, `a --> b` /
`a -->|label| b` edges, `class … changed|added|removed`, and
`%% file: <id> <path>` lines linking a step to a file in the diff, and
`%% note: <id> <sentence>` lines saying what each step does, shown as a tip
beside the focused step (`t` hides tips; a step without a note falls back
to its file's summary, labelled as such) — which
prview lays out as box-drawing art itself. Anything outside the subset
(subgraphs, styling) is ignored rather than half-drawn. An arrow label is
drawn only beside a stretch of line its arrow does not share, since arrows
into the same step meet on one arrowhead; a label with no such place is
shown on the detail line when either of its steps is focused.

- **On demand.** Nothing is sent until you first open the tab; `R` redraws.
- **Opus by default**, set apart from the summaries' model: following calls
  across files and telling a new function from an edited one is where
  smaller models fell short, so it stays on Opus even if summaries are moved
  to `haiku`. `--flow-model <id>` picks another (`sonnet` is faster); the
  header names the model that drew it.
- **Kinds are checked against git.** A step marked added whose name is
  already defined in the old version of its file is shown as changed; a step
  marked changed that this diff defines (an added line, absent before), or
  that lives in a new file, as added. The detail line says when a mark was
  corrected, and why.
- **One request**, up to 80k characters of diff with the same skip rules;
  files past that are listed by name only.
- **Cached per diff.** The Mermaid source is stored against a hash of every
  file's patch, so editing the code marks the drawing stale (`⚠ diff
  changed since`) rather than silently out of date. `--reset summaries`
  clears it with the summaries.
- **No `--explain`?** The tab still shows a flow that an agent wrote with
  `prview --annotate` (`{"flow": "<mermaid>"}`), which costs no request.

`w` and `--notes` include the flow as a fenced `mermaid` block, which GitHub
renders as a diagram when pasted into a PR.

Summaries are shown dimmed with a `⌁` prefix and are attributed to the model
in the Markdown export, so they are never mistaken for your own notes.
`prview <range> --reset summaries` throws them away to regenerate.
