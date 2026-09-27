← [README](../README.md)

# Every flag

**Choosing what to review**

| | |
|---|---|
| `<rev>` | a bare ref is a **base branch** — three-dot, your commits only |
| `<a>..<b>` / `<a>...<b>` / `<rev>^!` | any range git understands, passed through |
| `--pr [branch]` | detect the base; with a branch, review *that* branch instead of yours |
| `--staged`, `--cached` | the index against `HEAD` rather than the work tree |
| `-- <path>…` | limit to paths; everything after `--` is a pathspec |

**Rendering**

| | |
|---|---|
| `-u`, `--unified` | start unified instead of split |
| `--split` | start split (the default; overrides a `-u` in an alias) |
| `-U <n>`, `-U<n>`, `--context <n>` | lines of context, default 3 |
| `--tab-width <n>` | columns per tab, default 4 |
| `--light` | GitHub's light palette instead of dark |

**Generated explanations** — see [how `--explain` works](explain.md)

| | |
|---|---|
| `--explain` | summarise every file in one batch (off by default — it sends code to an API) |
| `--no-explain` | keep it off, overriding `PRVIEW_EXPLAIN=1` |
| `--explain-model <id>` | model for the summaries, default `claude-haiku-4-5-20251001` |
| `--explain-max <n>` | most files one session will explain, default 200 |

**Reading and writing review state without the TUI**

| | |
|---|---|
| `--notes` | print this range's notes and summaries as Markdown, then exit |
| `--annotate` | read `{summaries, notes}` as JSON on stdin, store it, then exit |
| `--reset <what>` | clear `summaries`, `viewed`, `notes` or `all` for this range |
| `--prune` | drop ranges whose commit no longer exists |
| `--install-skill [where]` | install the [annotate-for-review](annotate-for-review.md) skill; `global` (default) or `local` |
| `-h`, `--help` | usage |

Range flags combine with everything: `prview develop --staged` is rejected as
contradictory, but `prview develop --notes`, `prview --pr theirs --no-explain`
and `prview main -u -U0 -- src/` all do what they look like.
