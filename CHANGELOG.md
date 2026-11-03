# Changelog

What changed in each version of `@thesolwind/prview`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — while prview is in beta (0.x),
a minor version may change behaviour.

**On npm** marks the versions that were published to the registry. A
version without it was tagged in git only, and its changes first reached
npm in the next published version.

## [Unreleased]

## [0.3.0] — 2026-11-03 · beta · on npm

Published under the `beta` dist-tag: `npm install -g @thesolwind/prview@beta`.
A plain install still gets 0.1.2 (`latest`).

### Added

- **Diff flow tab (`f`).** A diagram of the code path the change touches —
  entry points, the functions it changes, what they call — drawn as boxes
  and arrows in the terminal. Changed steps are tagged `[~]`, new ones
  `[+]`, removed ones `[−]`, and the legend explains arrows and their
  labels.
  - Drawn by the `claude` CLI under the same opt-in as `--explain`, on
    demand: the first time the tab is opened, or on `R`. One request, cached
    against every file's patch, so later edits mark it stale.
  - An agent can supply the diagram instead with `--annotate`
    (`{"flow": "<mermaid>"}`); the annotate-for-review skill now asks for one.
  - `j`/`k` move between steps, `n`/`p` jump between changed steps, `h`/`l`
    and `ctrl-d`/`ctrl-u` pan.
  - A tip beside the focused step says what it does, from the diagram's own
    `%% note:` lines or, failing that, the file's summary. `t` hides tips.
    Tips move aside rather than cover another step.
  - `enter` opens the step's file at its definition. A file outside the
    diff — unchanged, or new and still untracked — opens whole and
    read-only; `esc` goes back to the flow.
  - Added/changed marks are checked against git: a step the model called
    new that the old version already defines is shown as changed, and the
    reverse. The detail line says when a mark was corrected, and why.
  - Arrow labels are drawn only beside a line their arrow does not share, so
    each reads as belonging to one arrow; a label with no such place is
    shown on the detail line instead.
  - `w` and `--notes` export the flow as a fenced `mermaid` block, which
    GitHub renders as a diagram.
- `--flow-model <id>` picks the model for the diff flow (default `opus`).
- While a flow is being drawn the pane shows the same working panel as an
  `--explain` batch; `f` or `esc` goes back to the diff while it runs.

### Changed

- **`--explain` uses Opus by default** (was Haiku 4.5). Summaries already
  cached are kept; `--reset summaries` regenerates them.
  `--explain-model haiku` restores the faster, cheaper model.
- The `claude` CLI request timeout is 5 minutes (was 2), for the larger
  model on a full batch.
- `--reset summaries` (and `all`) also clears the stored flow.
- `R` without `--explain` says why it cannot redraw, instead of doing
  nothing.

## [0.2.0] — 2026-10-23

Tagged in git only; first published to npm in 0.3.0.

### Added

- `--watch [seconds]` re-reads the diff on a timer (every 2s by default) and
  swaps it in only when a patch changed. Off by default; `--no-watch`
  overrides it in an alias. A refresh keeps you on the file you were reading
  and pauses while a note is being typed.

### Changed

- `r` keeps you on the same file by path rather than by index.

### Fixed

- The `--explain` help text described the old per-file behaviour; it now
  says every file is batched at startup.

## [0.1.2] — 2026-10-03 · on npm

### Fixed

- Notes stay on their line when later edits shift the line numbers. Notes
  now record the text of their line and its neighbours and are moved back
  onto it on launch, reload, `--notes`, and before `--annotate` merges.

## [0.1.1] — 2026-10-03 · on npm

### Changed

- The README and package description lead with the AI integration.

## [0.1.0] — 2026-10-03 · on npm

First release on npm, as `@thesolwind/prview`.

- Split and unified diffs with GitHub-accurate syntax highlighting.
- Viewed marks, line notes and Markdown export, persisted per range in
  `.git/prview/reviews.json`.
- `--pr` with base-branch auto-detection.
- `--explain` one-line summaries through the `claude` CLI (opt-in).
- The annotate-for-review Claude Code skill and `--annotate`.

[Unreleased]: https://github.com/thesolwind/prview/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/thesolwind/prview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/thesolwind/prview/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/thesolwind/prview/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/thesolwind/prview/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/thesolwind/prview/releases/tag/v0.1.0
