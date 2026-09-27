import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isBaseShaped, isPlausibleBase, rankCandidates, type Candidate, type RankedBase } from './base';

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {}

export function git(args: string[], cwd = process.cwd()): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '--no-optional-locks', ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) return rej(new GitError((stderr || err.message).trim()));
        res(stdout);
      },
    );
  });
}

/** `git diff` exits 1 when there are differences with --exit-code; plain diff never does, but be safe. */
async function gitTolerant(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch (err) {
    if (err instanceof GitError && /^\s*$/.test(err.message)) return '';
    throw err;
  }
}

export interface Repo {
  root: string;
  gitDir: string;
}

export async function openRepo(cwd = process.cwd()): Promise<Repo> {
  const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  const gitDir = resolve(root, (await git(['rev-parse', '--git-dir'], root)).trim());
  return { root, gitDir };
}

export type NewSide = { kind: 'rev'; rev: string } | { kind: 'worktree' } | { kind: 'index' };

export interface Range {
  /** Arguments handed to `git diff`. */
  diffArgs: string[];
  /** Human label for the status bar. */
  label: string;
  /** Stable key for persisting review state. */
  key: string;
  oldRev: string | null;
  newSide: NewSide;
  /** What each column of the split view is showing. */
  oldLabel: string;
  newLabel: string;
}

export interface RangeRequest {
  spec?: string;
  staged: boolean;
  /** Work the base branch out instead of being told it. */
  auto: boolean;
  paths: string[];
  context: number;
}

export class NoBaseError extends Error {}
export class UnknownRefError extends Error {}

/** A branch under review: the commit to read, and what to call it. */
export interface HeadRef {
  rev: string;
  name: string;
}

/**
 * Remote namespaces to search under `refs/remotes/`. Taken from the refs that
 * actually exist as well as the configured remotes: a clone can carry
 * remote-tracking refs for a remote that was renamed or removed, and those
 * still hold the branch someone asked about.
 */
async function remoteNamespaces(repo: Repo): Promise<string[]> {
  const configured = (await git(['remote'], repo.root).catch(() => '')).split('\n').filter(Boolean);
  const fromRefs = (
    await git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/remotes'], repo.root).catch(() => '')
  )
    .split('\n')
    .filter(Boolean)
    .map((name) => name.split('/')[0] ?? '')
    .filter(Boolean);
  const all = [...new Set([...configured, ...fromRefs])];
  // `origin` first, so `feature/x` prefers origin's copy over another remote's.
  return all.sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
}

async function refExists(repo: Repo, ref: string): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', ref], repo.root)).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Find the branch someone named, without making them spell out the remote.
 * `feature/theirs` should find `origin/feature/theirs` after a fetch, because
 * that is the form a reviewer is handed — and reading it needs no checkout.
 */
export async function resolveHeadRef(repo: Repo, name: string): Promise<HeadRef> {
  const remotes = await remoteNamespaces(repo);
  const attempts: Array<{ ref: string; label: string }> = [
    { ref: `refs/heads/${name}`, label: name },
    { ref: `refs/remotes/${name}`, label: name },
    ...remotes.map((remote) => ({ ref: `refs/remotes/${remote}/${name}`, label: `${remote}/${name}` })),
  ];

  for (const attempt of attempts) {
    if (await refExists(repo, attempt.ref)) return { rev: attempt.ref, name: attempt.label };
  }

  // Anything else git understands: a tag, a sha, HEAD~3.
  if (await refExists(repo, `${name}^{commit}`)) return { rev: name, name };

  const hint = ` — fetch it first: \`git fetch ${remotes[0] ?? 'origin'} ${name}\``;
  throw new UnknownRefError(`cannot find branch "${name}"${hint}`);
}

/** Every local and remote branch, most recently committed to first. */
async function listRefs(repo: Repo): Promise<Array<{ name: string; isRemote: boolean }>> {
  const out = await git(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes'],
    repo.root,
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', full = ''] = line.split('\t');
      return { name, isRemote: full.startsWith('refs/remotes/') };
    })
    .filter((ref) => ref.name.length);
}

/** Measure a batch of refs against HEAD, a few processes at a time. */
async function measure(
  repo: Repo,
  refs: Array<{ name: string; isRemote: boolean }>,
  head: HeadRef,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, refs.length) }, async () => {
      while (cursor < refs.length) {
        const ref = refs[cursor++]!;
        const counts = await divergence(repo, head.rev, ref.name);
        if (counts) candidates.push({ name: ref.name, isRemote: ref.isRemote, ...counts });
      }
    }),
  );
  return candidates;
}

/** `A` commits in head but not in ref, `B` the other way — one git call. */
async function divergence(
  repo: Repo,
  head: string,
  ref: string,
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const out = await git(['rev-list', '--left-right', '--count', `${head}...${ref}`], repo.root);
    const [ahead, behind] = out.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ahead: ahead!, behind: behind! };
  } catch {
    return null;
  }
}

async function remoteDefaultBranch(repo: Repo): Promise<string | null> {
  const remotes = (await git(['remote'], repo.root).catch(() => '')).split('\n').filter(Boolean);
  for (const remote of ['origin', ...remotes]) {
    try {
      return (await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], repo.root)).trim();
    } catch {
      // This remote has no recorded default; try the next one.
    }
  }
  return null;
}

/**
 * Measuring a candidate costs one git process, so a repo with hundreds of
 * branches must not measure them all. A base-shaped ref always outranks an
 * ordinary one, so measure those first and only fall back to the rest — capped
 * by recency — when none of them yielded a usable base.
 */
const MAX_FALLBACK_CANDIDATES = 60;
const CONCURRENCY = 16;

/**
 * Infer the branch the current one was cut from. Measures divergence against
 * every plausible ref, then ranks — see `rankCandidates` for the ordering.
 */
export async function detectBase(repo: Repo, head: HeadRef): Promise<RankedBase> {
  const branch = head.name;
  const refs = (await listRefs(repo)).filter((r) => isPlausibleBase(r.name, branch));

  if (!refs.length) {
    throw new NoBaseError(
      branch === 'HEAD'
        ? 'HEAD is detached and there is no other branch to compare against'
        : `no other branch to compare ${branch} against`,
    );
  }

  const defaultBranch = await remoteDefaultBranch(repo);
  const shaped = refs.filter((r) => isBaseShaped(r.name, defaultBranch));
  const rest = refs.filter((r) => !isBaseShaped(r.name, defaultBranch)).slice(0, MAX_FALLBACK_CANDIDATES);

  const best =
    rankCandidates(await measure(repo, shaped, head), defaultBranch) ??
    rankCandidates(await measure(repo, rest, head), defaultBranch);

  if (!best) {
    throw new NoBaseError(
      `every branch already contains ${branch}, so there is nothing to review — ` +
        'you may be sitting on the base branch itself',
    );
  }
  return best;
}

/**
 * Resolve a user-facing spec into a `git diff` invocation.
 *
 *   (nothing)      working tree vs HEAD        — what am I about to commit
 *   --staged       index vs HEAD
 *   main           merge-base(main, HEAD)..HEAD — the GitHub PR view (three-dot)
 *   a..b / a...b   passed through
 *   <commit>^!     passed through (single commit)
 */
export async function resolveRange(req: RangeRequest, repo: Repo): Promise<Range> {
  const common = ['diff', '--no-color', '--no-ext-diff', '--find-renames', `-U${req.context}`];
  const paths = req.paths.length ? ['--', ...req.paths] : [];

  const finish = (
    extra: string[],
    label: string,
    key: string,
    oldRev: string | null,
    newSide: NewSide,
    sides: { oldLabel: string; newLabel: string },
  ): Range => ({
    diffArgs: [...common, ...extra, ...paths],
    label,
    key: req.paths.length ? `${key} :: ${req.paths.join(',')}` : key,
    oldRev,
    newSide,
    ...sides,
  });

  // `--pr` with no ref reviews the branch you are on; `--pr <branch>` reviews
  // somebody else's, read straight out of the object database so it needs no
  // checkout and disturbs nothing in the work tree.
  if (req.auto) {
    const head: HeadRef = req.spec
      ? await resolveHeadRef(repo, req.spec)
      : { rev: 'HEAD', name: await currentBranch(repo) };
    const base = await detectBase(repo, head);
    const mergeBase = (await git(['merge-base', base.name, head.rev], repo.root)).trim();
    const headShort = (await git(['rev-parse', '--short', head.rev], repo.root)).trim();
    return finish(
      [`${mergeBase}..${head.rev}`],
      `${base.name}...${head.name}  (auto: ${base.reason})`,
      `${base.name}...${headShort}`,
      mergeBase,
      { kind: 'rev', rev: head.rev },
      { oldLabel: base.name, newLabel: head.name },
    );
  }

  if (!req.spec) {
    const head = await headRev(repo);
    return req.staged
      ? finish(['--cached', 'HEAD'], 'staged vs HEAD', `index:${head}`, 'HEAD', { kind: 'index' }, {
          oldLabel: 'HEAD',
          newLabel: 'index',
        })
      : finish(['HEAD'], 'working tree vs HEAD', `worktree:${head}`, 'HEAD', { kind: 'worktree' }, {
          oldLabel: 'HEAD',
          newLabel: 'working tree',
        });
  }

  if (req.spec.endsWith('^!')) {
    const commit = req.spec.slice(0, -2);
    return finish([req.spec], req.spec, req.spec, `${commit}^`, { kind: 'rev', rev: commit }, {
      oldLabel: `${commit}^`,
      newLabel: commit,
    });
  }

  if (req.spec.includes('..')) {
    const threeDot = req.spec.includes('...');
    const [rawOld] = req.spec.split(/\.{2,3}/);
    const leftRev = rawOld && rawOld.length ? rawOld : 'HEAD';
    const newRev = revOf(req.spec);
    // A three-dot range diffs from the merge base, so that — not the left ref —
    // is where the old side of each file has to be read from, or the syntax
    // tokens line up against the wrong text.
    const oldRev = threeDot
      ? (await git(['merge-base', leftRev, newRev], repo.root)).trim()
      : leftRev;
    return finish([req.spec], req.spec, req.spec, oldRev, { kind: 'rev', rev: newRev }, {
      oldLabel: leftRev,
      newLabel: newRev,
    });
  }

  // Bare ref: treat as a base branch and diff against the merge base, like a PR.
  const base = (await git(['merge-base', req.spec, 'HEAD'], repo.root)).trim();
  const head = await headRev(repo);
  return finish([`${base}..HEAD`], `${req.spec}...HEAD`, `${req.spec}...${head}`, base, {
    kind: 'rev',
    rev: 'HEAD',
  }, { oldLabel: req.spec, newLabel: await currentBranch(repo) });
}

function revOf(spec: string): string {
  const parts = spec.split(/\.{2,3}/);
  const last = parts[parts.length - 1];
  return last && last.length ? last : 'HEAD';
}

async function headRev(repo: Repo): Promise<string> {
  try {
    return (await git(['rev-parse', '--short', 'HEAD'], repo.root)).trim();
  } catch {
    return 'no-head';
  }
}

/**
 * Whether the right-hand side of this review is the branch you are sitting on.
 * When it is not — someone else's branch, or a tag range — showing your own
 * branch in the status bar is worse than showing nothing: it reads as if it
 * were what you are looking at.
 */
export function reviewsCurrentBranch(range: Range): boolean {
  return range.newSide.kind !== 'rev' || range.newSide.rev === 'HEAD';
}

export function rawDiff(range: Range, repo: Repo): Promise<string> {
  return gitTolerant(range.diffArgs, repo.root);
}

/** Full contents of one side of a file, used to syntax-highlight with real context. */
export async function readSide(
  repo: Repo,
  side: NewSide | { kind: 'rev'; rev: string },
  path: string,
): Promise<string | null> {
  try {
    if (side.kind === 'worktree') return await readFile(resolve(repo.root, path), 'utf8');
    if (side.kind === 'index') return await git(['show', `:${path}`], repo.root);
    return await git(['show', `${side.rev}:${path}`], repo.root);
  } catch {
    return null;
  }
}

export async function currentBranch(repo: Repo): Promise<string> {
  try {
    return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo.root)).trim();
  } catch {
    return 'HEAD';
  }
}
