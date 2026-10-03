import { render } from 'ink';
import React from 'react';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { App, type OpenRequest } from './ui/App';
import {
  git,
  openRepo,
  rawDiff,
  resolveRange,
  currentBranch,
  reviewsCurrentBranch,
  GitError,
  NoBaseError,
  UnknownRefError,
  type Range,
  type Repo,
} from './git';
import { parseDiff, type FileDiff } from './parse';
import { Highlighter } from './highlight';
import {
  describeRangeKey,
  RESET_SCOPES,
  resetState,
  Store,
  notesToMarkdown,
  type ResetScope,
} from './state';
import { dark, light } from './theme';
import { DEFAULT_EXPLAIN_MODEL, DEFAULT_MAX_FILES } from './explain';
import { mergeAnnotations, parsePayload, PayloadError } from './annotate';
import { reanchorNotes } from './anchor';
import type { Layout } from './view';

type SkillTarget = 'global' | 'local';

interface Options {
  spec?: string;
  staged: boolean;
  auto: boolean;
  paths: string[];
  context: number;
  tabWidth: number;
  layout: Layout;
  light: boolean;
  explain: boolean | null;
  annotate: boolean;
  reset: ResetScope | null;
  prune: boolean;
  explainModel: string;
  explainMaxFiles: number;
  notesOnly: boolean;
  installSkill: SkillTarget | null;
  help: boolean;
}

/**
 * Walk up from `cli.ts`'s own location to find the package root (the nearest
 * ancestor with a `package.json`) — this repo when running from source, or
 * `<prefix>/lib/node_modules/@thesolwind/prview` once installed. Deliberately not a fixed
 * `dirname(dirname(...))` count off `dist/cli.js`: that would silently break
 * `--install-skill` if the build's output ever nested a level deeper, with
 * nothing to catch it since this is the only thing that reads it.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find this package's root above ${startDir}`);
    dir = parent;
  }
}

const USAGE = `prview — review a diff in your terminal, GitHub-style

Usage
  prview                     working tree vs HEAD
  prview --pr                review your branch against an auto-detected base
  prview --pr feat/theirs    review somebody else's branch the same way
  prview --staged            index vs HEAD
  prview main                merge-base(main, HEAD)..HEAD — an explicit base
  prview v1.2..v1.3          any revision range
  prview <commit>^!          a single commit
  prview main -- src/ lib/   limit to paths

Options
  --pr [branch]           work out which branch this one was cut from and
                          review against it; the base and why it was chosen
                          are shown in the status bar. Give it a branch name
                          to review someone else's work — no checkout needed,
                          and a bare name finds the remote copy
  --staged, --cached      diff the index instead of the work tree
  -u, --unified           start in unified layout
  --split                 start in split layout (the default; use it to
                          override a -u in an alias or wrapper)
  -U, --context <n>       lines of context (default 3); -U0 also works
  --tab-width <n>         columns per tab (default 4)
  --light                 light theme (default is dark)
  --explain               as you open each file, summarise it by piping its
                          diff to the \`claude\` CLI. OFF by default: it sends
                          your code to an API, which is not something to do
                          without being asked. Set PRVIEW_EXPLAIN=1 to have it
                          on by default. Cached per file version, and only
                          files you actually open are ever sent.
  --no-explain            turn it off, overriding PRVIEW_EXPLAIN
  --explain-model <id>    model for the summaries (default ${DEFAULT_EXPLAIN_MODEL})
  --explain-max <n>       most files one session will explain; a runaway
                          guard, not a budget (default ${DEFAULT_MAX_FILES})
  --notes                 print saved notes for this range and exit
  --reset <what>          clear part of this range's review state and exit:
                          summaries (re-runs --explain from scratch), viewed,
                          notes, or all. Notes are your own writing and are
                          not recoverable, so the word is required
  --prune                 drop review state for ranges whose commit no longer
                          exists — the leftovers of amends and rebases
  --annotate              read {summaries, notes} as JSON on stdin, write it
                          into this range's review state, and exit. Lets a
                          tool leave review material where the reader will
                          find it; see \`--notes\` to read it back
  --install-skill [where] copy the annotate-for-review Claude Code skill,
                          then exit. \`global\` (default) installs to
                          ~/.claude/skills, for every project; \`local\`
                          installs to this repo's .claude/skills, to
                          commit and share with a team. Safe to re-run to
                          pick up an update
  -h, --help              this text

Keys are listed with ? inside the tool. Review state lives in
.git/prview/reviews.json and is keyed by the range you are reviewing.`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    staged: false,
    auto: false,
    paths: [],
    context: 3,
    tabWidth: 4,
    layout: 'split',
    light: false,
    explain: null,
    annotate: false,
    reset: null,
    prune: false,
    explainModel: DEFAULT_EXPLAIN_MODEL,
    explainMaxFiles: DEFAULT_MAX_FILES,
    notesOnly: false,
    installSkill: null,
    help: false,
  };
  const rest: string[] = [];
  let afterDashDash = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (afterDashDash) {
      opts.paths.push(arg);
      continue;
    }
    switch (arg) {
      case '--':
        afterDashDash = true;
        break;
      case '--staged':
      case '--cached':
        opts.staged = true;
        break;
      case '--pr':
        opts.auto = true;
        break;
      case '-u':
      case '--unified':
        opts.layout = 'unified';
        break;
      case '--split':
        opts.layout = 'split';
        break;
      case '--light':
        opts.light = true;
        break;
      case '--annotate':
        opts.annotate = true;
        break;
      case '--install-skill': {
        const next = argv[i + 1];
        if (next === 'global' || next === 'local') {
          opts.installSkill = next;
          i++;
        } else if (next === undefined || next.startsWith('-')) {
          opts.installSkill = 'global';
        } else {
          throw new Error(`--install-skill takes "global" or "local" (or nothing, for global), got: ${next}`);
        }
        break;
      }
      case '--reset': {
        const scope = argv[++i] ?? '';
        if (!RESET_SCOPES.includes(scope as ResetScope)) {
          throw new Error(`--reset needs one of: ${RESET_SCOPES.join(', ')}`);
        }
        opts.reset = scope as ResetScope;
        break;
      }
      case '--prune':
        opts.prune = true;
        break;
      case '--explain':
        opts.explain = true;
        break;
      case '--no-explain':
        opts.explain = false;
        break;
      case '--explain-model':
        opts.explainModel = argv[++i] ?? DEFAULT_EXPLAIN_MODEL;
        break;
      case '--explain-max':
        opts.explainMaxFiles = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--notes':
        opts.notesOnly = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-U':
      case '--context':
        opts.context = Number.parseInt(argv[++i] ?? '3', 10);
        break;
      case '--tab-width':
        opts.tabWidth = Number.parseInt(argv[++i] ?? '4', 10);
        break;
      default:
        if (arg.startsWith('-U')) opts.context = Number.parseInt(arg.slice(2), 10);
        else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        else rest.push(arg);
    }
  }

  if (rest.length > 1) throw new Error(`expected at most one revision spec, got: ${rest.join(' ')}`);
  if (opts.staged && rest.length) throw new Error('--staged diffs the index, so it cannot be combined with a revision');
  if (opts.auto && opts.staged) throw new Error('--pr and --staged review different things; pick one');
  opts.spec = rest[0];
  if (opts.auto && opts.spec?.includes('..'))
    throw new Error(`--pr takes a single branch, not a range; use \`prview ${opts.spec}\` instead`);
  if (!Number.isFinite(opts.explainMaxFiles) || opts.explainMaxFiles < 1) opts.explainMaxFiles = DEFAULT_MAX_FILES;
  if (!Number.isFinite(opts.context) || opts.context < 0) opts.context = 3;
  if (!Number.isFinite(opts.tabWidth) || opts.tabWidth < 1) opts.tabWidth = 4;
  return opts;
}

/** Build the editor invocation for the handful of editors that take a line. */
function editorCommand(path: string, line: number): [string, string[]] {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const [bin, ...preset] = editor.split(/\s+/);
  const name = (bin ?? 'vi').split('/').pop() ?? 'vi';
  if (/^(vi|vim|nvim|view|nano|emacs|emacsclient|kak|hx|helix)$/.test(name)) {
    return [bin!, [...preset, `+${line}`, path]];
  }
  if (/^(code|code-insiders|cursor|windsurf)$/.test(name)) {
    return [bin!, [...preset, '-g', `${path}:${line}`]];
  }
  if (/^(subl|smerge)$/.test(name)) return [bin!, [...preset, `${path}:${line}`]];
  if (name === 'idea' || name === 'webstorm') return [bin!, [...preset, '--line', String(line), path]];
  return [bin!, [...preset, path]];
}

/** The sha a range key was taken against, if it carries one. */
function headShortOf(range: Range): string | null {
  return /(?:\.\.\.|:)([0-9a-f]{7,40})$/.exec(range.key)?.[1] ?? null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

async function loadFiles(range: Range, repo: Repo, tabWidth: number): Promise<FileDiff[]> {
  return parseDiff(await rawDiff(range, repo), tabWidth);
}

/** `openRepo`, reported and exited on the same terms everywhere it's needed. */
async function openRepoOrExit(reason: string): Promise<Repo> {
  try {
    return await openRepo();
  } catch (err) {
    const detail = err instanceof GitError ? err.message : (err as Error).message;
    process.stderr.write(`prview: ${reason} (${detail})\n`);
    process.exit(1);
  }
}

/**
 * `local` needs a repo to root the copy in; `global` deliberately does not —
 * this is often the first thing run right after `npm install -g`, before
 * `cd`-ing into any project.
 */
async function runInstallSkill(target: SkillTarget): Promise<void> {
  const dest =
    target === 'local'
      ? join((await openRepoOrExit('--install-skill local needs a git repository')).root, '.claude', 'skills', 'annotate-for-review')
      : join(homedir(), '.claude', 'skills', 'annotate-for-review');

  const skillSource = join(findPackageRoot(dirname(fileURLToPath(import.meta.url))), '.claude', 'skills', 'annotate-for-review');

  // Running `--install-skill local` from inside prview's own checkout makes
  // source and destination the same directory (this repo *is* the skill's
  // canonical copy). `rm`-then-`cp` in that case deletes the source out from
  // under itself before copying it — caught the hard way once already.
  if (resolvePath(skillSource) === resolvePath(dest)) {
    process.stdout.write(`${dest} is the skill's own source — nothing to install.\n`);
    return;
  }

  try {
    // A plain `cp` only overwrites and adds — it never removes a file the
    // source has since dropped or renamed, so re-running would not actually
    // mirror an update. Clearing the destination first makes "safe to re-run"
    // true rather than aspirational.
    await rm(dest, { recursive: true, force: true });
    await cp(skillSource, dest, { recursive: true });
  } catch (err) {
    process.stderr.write(`prview: could not install the skill — ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `installed the annotate-for-review skill to ${dest}\n` +
      'Run `/reload-skills` in an open session, or start a new one, to pick it up.\n',
  );
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`prview: ${(err as Error).message}\n\n${USAGE}\n`);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (opts.installSkill) {
    await runInstallSkill(opts.installSkill);
    return;
  }

  const repo = await openRepoOrExit('not inside a git repository');

  let range: Range;
  try {
    range = await resolveRange(
      { spec: opts.spec, staged: opts.staged, auto: opts.auto, paths: opts.paths, context: opts.context },
      repo,
    );
  } catch (err) {
    if (err instanceof UnknownRefError) {
      process.stderr.write(`prview: ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof NoBaseError) {
      process.stderr.write(
        `prview: ${err.message}.\nPass a base explicitly, e.g. \`prview main\`, or use \`prview\` for uncommitted changes.\n`,
      );
      process.exit(1);
    }
    const what = opts.auto ? 'the detected base' : `"${opts.spec}"`;
    process.stderr.write(`prview: cannot resolve ${what} — ${(err as Error).message}\n`);
    process.exit(1);
  }

  const store = new Store(repo.gitDir, range.key);
  const state = await store.load();

  if (opts.notesOnly) {
    // Best effort: the stored line numbers may predate later edits, and the
    // export is useless without the right ones — but notes still print if the
    // diff cannot be read.
    const current = await loadFiles(range, repo, opts.tabWidth).catch(() => [] as FileDiff[]);
    const md = notesToMarkdown(reanchorNotes(state.notes, current), range.label, state.summaries);
    process.stdout.write(md ? `${md}\n` : `No notes saved for ${range.label}.\n`);
    return;
  }

  if (opts.reset) {
    const { state: next, removed } = resetState(state, opts.reset);
    await store.save(next);
    try {
      await store.flush();
    } catch (err) {
      process.stderr.write(`prview: could not save — ${(err as Error).message}\n`);
      process.exit(1);
    }
    process.stdout.write(`cleared ${removed.join(', ')} from ${range.label}\n`);
    return;
  }

  if (opts.prune) {
    const entries = await store.keys();
    const stale: string[] = [];
    for (const entry of entries) {
      // Keys end in the short sha they were taken against; a key that names a
      // commit git no longer knows is a leftover from an amend or a rebase.
      const sha = /(?:\.\.\.|:)([0-9a-f]{7,40})$/.exec(entry.key)?.[1];
      if (!sha || sha === headShortOf(range)) continue;
      try {
        await git(['cat-file', '-e', `${sha}^{commit}`], repo.root);
      } catch {
        stale.push(entry.key);
      }
    }
    if (!stale.length) {
      process.stdout.write(`nothing to prune; ${entries.length} range${entries.length === 1 ? '' : 's'} all live\n`);
      return;
    }
    let dropped: number;
    try {
      dropped = await store.drop(stale);
    } catch (err) {
      process.stderr.write(`prview: could not save — ${(err as Error).message}\n`);
      process.exit(1);
    }
    process.stdout.write(`pruned ${dropped} stale range${dropped === 1 ? '' : 's'}:\n`);
    for (const key of stale) process.stdout.write(`  ${key}\n`);
    return;
  }

  let files: FileDiff[];
  try {
    files = await loadFiles(range, repo, opts.tabWidth);
  } catch (err) {
    process.stderr.write(`prview: git diff failed — ${(err as Error).message}\n`);
    process.exit(1);
  }

  if (!files.length) {
    process.stdout.write(`No changes in ${range.label}.\n`);
    return;
  }

  if (opts.annotate) {
    let payload;
    try {
      payload = parsePayload(await readStdin());
    } catch (err) {
      process.stderr.write(
        `prview: ${err instanceof PayloadError ? err.message : (err as Error).message}\n`,
      );
      process.exit(2);
    }
    // Re-anchor first: with `replace: false`, or for notes on files this
    // payload does not touch, what is already stored is written straight back.
    const anchored = { ...state, notes: reanchorNotes(state.notes, files) };
    const { state: next, report } = mergeAnnotations(anchored, payload, files);
    await store.save(next);
    try {
      await store.flush();
    } catch (err) {
      process.stderr.write(`prview: could not save — ${(err as Error).message}\n`);
      process.exit(1);
    }
    for (const warning of report.warnings) process.stderr.write(`prview: ${warning}\n`);
    process.stdout.write(
      `wrote ${report.summaries} summar${report.summaries === 1 ? 'y' : 'ies'} and ` +
        `${report.notes} note${report.notes === 1 ? '' : 's'}` +
        `${report.replaced ? ` (replaced ${report.replaced})` : ''} to ${range.label}\n`,
    );
    return;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('prview: needs an interactive terminal (stdout is not a TTY).\n');
    process.exit(1);
  }

  // A review is one slice of the repo, and nothing else says the other slices
  // exist. Someone whose work is uncommitted annotates the working tree, opens
  // --pr, and finds an empty review with no hint that their notes are one
  // command away.
  const hints: string[] = [];
  const thisIsEmpty = !state.notes.length && !Object.keys(state.summaries).length;
  if (thisIsEmpty) {
    for (const other of await store.keys()) {
      if (other.key === range.key || (!other.notes && !other.summaries)) continue;
      const where = describeRangeKey(other.key);
      if (!where) continue;
      const parts = [
        other.summaries ? `${other.summaries} summaries` : '',
        other.notes ? `${other.notes} notes` : '',
      ].filter(Boolean);
      hints.push(`${parts.join(' and ')} saved for ${where.label} — run \`${where.command}\``);
      break;
    }
  }
  if (range.newSide.kind === 'rev') {
    const dirty = (await git(['status', '--porcelain'], repo.root).catch(() => ''))
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('??')).length;
    if (dirty) {
      hints.push(`${dirty} uncommitted file${dirty === 1 ? '' : 's'} are not in this review — run \`prview\``);
    }
  }

  const theme = opts.light ? light : dark;
  const highlighter = new Highlighter(theme.shikiTheme, opts.tabWidth);
  // Only name your branch when it is the one being reviewed.
  const reviewingMine = reviewsCurrentBranch(range);
  const branch = reviewingMine ? await currentBranch(repo) : '';

  // Sending code to an API is not a default. `--explain` opts in per run, and
  // PRVIEW_EXPLAIN=1 opts in for good; `--no-explain` always wins.
  const wantExplain = opts.explain ?? ['1', 'true', 'yes'].includes((process.env.PRVIEW_EXPLAIN ?? '').toLowerCase());
  const explain = wantExplain
    ? {
        model: opts.explainModel,
        cwd: repo.root,
        maxFiles: opts.explainMaxFiles,
        logPath: join(repo.gitDir, 'prview', 'explain.log'),
      }
    : null;

  let openRequest: OpenRequest | null = null;

  const app = render(
    React.createElement(App, {
      repo,
      range,
      branch,
      files,
      initial: state,
      store,
      theme,
      highlighter,
      reload: () => loadFiles(range, repo, opts.tabWidth),
      onOpenRequest: (req: OpenRequest) => {
        openRequest = req;
      },
      preferredLayout: opts.layout,
      explain,
      initialMessage: hints.join('  ·  ') || null,
    }),
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();
  try {
    await store.flush();
  } catch (err) {
    // The TUI has already exited and handed the terminal back, so this is not
    // fatal — but the review state (viewed marks, notes, summaries) from this
    // session may not actually be on disk, and that has to be loud.
    process.stderr.write(`prview: your review state may not have saved — ${(err as Error).message}\n`);
    process.exitCode = 1;
  }

  const final = await store.load();
  const md = notesToMarkdown(final.notes, range.label, final.summaries);
  if (md) process.stdout.write(`\n${md}\n`);

  const req = openRequest as OpenRequest | null;
  if (req) {
    const [bin, args] = editorCommand(req.path, req.line);
    await new Promise<void>((resolve) => {
      const child = spawn(bin, args, { cwd: repo.root, stdio: 'inherit' });
      child.on('close', () => resolve());
      child.on('error', (err) => {
        process.stderr.write(`prview: could not launch editor — ${err.message}\n`);
        resolve();
      });
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`prview: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
