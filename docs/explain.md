← [README](../README.md)

# How `--explain` works

`--explain` puts a one-line "what does this change do" above each file. It
does not call an API itself: it shells out to the **Claude Code CLI**
(`claude`), so it uses whatever account and login that CLI already has.

```sh
<diffs> | claude -p "<instructions>" --model claude-haiku-4-5-20251001 --allowed-tools ""
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
- **Haiku 4.5 by default**, for speed and cost. `--explain-model <id>` picks
  another model. `--explain-max <n>` (default 200 files) is a guard against
  runaway branches.

While it runs, the screen shows an "analysing N diffs" panel; `esc` cancels
and `q` quits (which also kills the request). Failures stay on screen until
you press a key, and the full error goes to `.git/prview/explain.log`.

Summaries are shown dimmed with a `⌁` prefix and are attributed to the model
in the Markdown export, so they are never mistaken for your own notes.
`prview <range> --reset summaries` throws them away to regenerate.
