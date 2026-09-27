/**
 * Short, generated explanations of what a diff does, produced by shelling out
 * to the Claude Code CLI in print mode:
 *
 *   git diff … | claude -p "<instructions>" --model … --allowed-tools ""
 *
 * This exists for reviewing *other people's* branches, where the question is
 * "what am I even looking at" before the question "is it right". It never runs
 * on your own branch: you already know what you wrote.
 *
 * Sending code to an API costs time and tokens, so the work is bounded before
 * it starts — generated files are skipped, big diffs are truncated, the file
 * count is capped, and every result is cached against the patch hash so a file
 * is only ever explained once per version of itself.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FileDiff } from './parse';

export const DEFAULT_EXPLAIN_MODEL = 'claude-haiku-4-5-20251001';

/** Per-file diff text handed to the model; longer patches are truncated. */
const MAX_PATCH_CHARS = 24_000;
/**
 * A runaway guard, not a budget to ration.
 *
 * It was 25 when each file cost its own request. Batching made the cost
 * per chunk instead, so a low cap buys nothing and silently drops the tail:
 * a 58-file branch under a cap of 40 left 18 files with no summary, no
 * message, and nothing in the log — indistinguishable from the tool simply
 * not working.
 */
export const DEFAULT_MAX_FILES = 200;
/**
 * A batch is legitimately slower than a single file — it has to read every
 * diff and write a line per file — so this is generous. Quitting kills the
 * request anyway, so a long ceiling costs nothing in responsiveness.
 */
const TIMEOUT_MS = 120_000;

/**
 * One request covers many files, so the reply has to be parseable per file.
 * Tab-separated is deliberate: a path cannot contain a tab, so splitting on
 * the first one is unambiguous even when the summary contains punctuation the
 * model chose freely.
 */
const PROMPT = [
  'You are helping someone review a pull request they did not write.',
  'On stdin are unified diffs for several files, each introduced by a line',
  '"=== FILE: <path>".',
  'For EVERY file, output one line: the path, a TAB character, then ONE sentence',
  'of at most 200 characters saying what that change does and why it matters to a',
  'reviewer — the intent, not a restatement of the lines.',
  'Output nothing else: no preamble, no markdown, no bullet points, no blank',
  'lines, no code fences. One line per file, paths exactly as given.',
].join(' ');

/**
 * Characters of diff per request. Haiku has a 200k-token window; this keeps a
 * request an order of magnitude inside it while still covering most branches
 * in one go.
 */
const MAX_REQUEST_CHARS = 60_000;

/** Paths whose diffs are not worth spending a request on. */
const GENERATED = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /(^|\/)(dist|build|vendor|node_modules|__snapshots__)\//,
  /\.(min\.js|min\.css|map|snap|pb\.go|generated\.ts)$/,
  /(^|\/)[^/]*\.lock$/,
];

export type SkipReason = 'binary' | 'generated' | 'no-change' | null;

/** Why this file will not be explained, or null if it will be. */
export function skipReason(file: FileDiff): SkipReason {
  if (file.binary) return 'binary';
  if (!file.hunks.length) return 'no-change';
  if (GENERATED.some((re) => re.test(file.path))) return 'generated';
  return null;
}

/**
 * Split files into requests that each stay within the size budget. A single
 * file bigger than the budget still gets its own request, where `buildPatch`
 * truncation applies.
 */
export function chunkFiles(files: FileDiff[], patchOf: (f: FileDiff) => string): FileDiff[][] {
  const chunks: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let size = 0;
  for (const file of files) {
    const cost = patchOf(file).length;
    if (current.length && size + cost > MAX_REQUEST_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** One request's payload: every file's patch, each under a path marker. */
export function buildRequest(files: FileDiff[]): string {
  return files.map((file) => `=== FILE: ${file.path}\n${buildPatch(file)}`).join('\n\n');
}

/**
 * Read `path<TAB>summary` lines back, keeping only paths we asked about.
 *
 * Anything else the model emits — a stray preamble, a blank line, a bullet, a
 * path we never sent — is dropped rather than trusted, because a mislabelled
 * summary attached to the wrong file is worse than a missing one.
 */
export function parseBatch(raw: string, expected: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const path = line.slice(0, tab).trim().replace(/^["'`]|["'`]$/g, '');
    if (!expected.has(path) || out.has(path)) continue;
    const body = tidy(line.slice(tab + 1));
    if (body) out.set(path, body);
  }
  return out;
}

export function buildPatch(file: FileDiff): string {
  const header = `--- a/${file.oldPath ?? file.path}\n+++ b/${file.newPath ?? file.path}\n`;
  const body = file.hunks
    .map((hunk) => {
      const head = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${
        hunk.section ? ' ' + hunk.section : ''
      }\n`;
      const lines = hunk.lines
        .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
        .join('\n');
      return head + lines;
    })
    .join('\n');
  const patch = header + body;
  return patch.length > MAX_PATCH_CHARS
    ? `${patch.slice(0, MAX_PATCH_CHARS)}\n… (diff truncated for length)`
    : patch;
}

/** Collapse whatever came back into the single line the UI has room for. */
export function tidy(raw: string): string {
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .trim();
  if (!text) return '';
  return text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text;
}

export class ExplainUnavailable extends Error {}

/** Thrown when the caller went away; never worth reporting to anyone. */
export class ExplainAborted extends Error {}

/**
 * A short, readable reason a request failed.
 *
 * Node's own message for a failed child is `Command failed: <argv>`, and our
 * argv carries the whole prompt — so reporting `err.message` puts hundreds of
 * characters of instructions in the status bar, truncated to nonsense. Worse,
 * a timeout kill produces exactly that message with empty stderr, so the one
 * failure most likely to happen is the one least likely to be legible.
 */
/**
 * `execFile`'s error as it actually arrives. `ErrnoException` types `code` as a
 * string, but a child that exits non-zero carries the numeric exit status
 * there — so the check for it looks unreachable unless the type says otherwise.
 */
export type ChildError = Omit<NodeJS.ErrnoException, 'code'> & {
  code?: string | number;
  signal?: string | null;
  killed?: boolean;
};

export function describeFailure(err: ChildError, stderr: string): string {
  const first = stderr.trim().split('\n').find((line) => line.trim().length);
  if (err.killed || err.signal === 'SIGTERM') {
    return `no reply within ${TIMEOUT_MS / 1000}s${first ? ` — ${first}` : ''}`;
  }
  if (first) return first;
  if (typeof err.code === 'number') return `claude exited with code ${err.code}`;
  return 'claude failed with no output';
}

async function logFailure(logPath: string | undefined, detail: string): Promise<void> {
  if (!logPath) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${detail}\n`, 'utf8');
  } catch {
    // Diagnostics failing must never be the thing that breaks the review.
  }
}

function runClaude(
  patch: string,
  options: Explainer,
  signal: AbortSignal,
  what: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', PROMPT, '--model', options.model, '--allowed-tools', ''],
      { cwd: options.cwd, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', signal },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as ChildError;
          if (e.code === 'ABORT_ERR' || signal.aborted) return reject(new ExplainAborted('aborted'));
          if (e.code === 'ENOENT') {
            return reject(new ExplainUnavailable('the `claude` CLI is not on PATH'));
          }
          const reason = describeFailure(e, stderr);
          void logFailure(
            options.logPath,
            `explain failed (${what}, model ${options.model}, ${patch.length} chars): ${reason}` +
              `${e.code ? ` [code ${e.code}]` : ''}${e.signal ? ` [signal ${e.signal}]` : ''}` +
              `${stderr.trim() ? `\n  stderr: ${stderr.trim().slice(0, 2000)}` : ''}`,
          );
          return reject(new Error(reason));
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(patch);
  });
}

export interface Explainer {
  model: string;
  cwd: string;
  /** Requests this session may spend in total. */
  maxFiles: number;
  /** Where to append full failure detail, since a status bar cannot hold it. */
  logPath?: string;
}

/**
 * Explain one file, or return null if it is not worth a request.
 *
 * On demand rather than in a batch, because a batch has to choose which files
 * to spend a cap on and every ordering starves someone: largest-first never
 * reaches the small files, and a 6-line new type is exactly where a one-line
 * summary earns its keep. Asking only for the file being read means every file
 * you open has a description and the ones you never open cost nothing.
 *
 * The signal is not an optimisation. A child process keeps Node's event loop
 * alive, so without killing it on the way out, quitting unmounts the UI and
 * then sits there for however long the request had left — which reads exactly
 * like `q` being broken.
 */
/**
 * Explain everything that needs it, in as few requests as the size budget
 * allows — usually one. Each chunk's results are handed back as they land, so
 * a big branch fills in progressively rather than all at the end.
 */
export async function explainAll(
  files: FileDiff[],
  options: Explainer,
  signal: AbortSignal,
  onChunk: (summaries: Map<string, string>, done: number, total: number) => void,
): Promise<{ sent: number; overCap: number }> {
  const candidates = files.filter((file) => !skipReason(file));
  const wanted = candidates.slice(0, options.maxFiles);
  const overCap = candidates.length - wanted.length;
  if (!wanted.length) return { sent: 0, overCap };

  const chunks = chunkFiles(wanted, buildPatch);
  let done = 0;
  for (const chunk of chunks) {
    // Cancelled: report what did land rather than nothing, since earlier
    // chunks have already been applied.
    if (signal.aborted) return { sent: done, overCap };
    const expected = new Set(chunk.map((f) => f.path));
    const raw = await runClaude(
      buildRequest(chunk),
      options,
      signal,
      `${chunk.length} file${chunk.length === 1 ? '' : 's'}: ${chunk[0]?.path ?? '?'}…`,
    );
    const parsed = parseBatch(raw, expected);
    done += chunk.length;

    // A reply that matched nothing is a failure, not an empty success. Left as
    // a success it looks exactly like this: the panel appears, closes, and no
    // explanation arrives — with nothing logged and nothing said, because from
    // the code's point of view the request was fine.
    if (parsed.size === 0) {
      await logFailure(
        options.logPath,
        `explain reply matched none of ${expected.size} paths (model ${options.model}).` +
          ` First 400 chars of reply:\n  ${raw.trim().slice(0, 400).replace(/\n/g, '\n  ')}`,
      );
      throw new Error(`reply did not name any of the ${expected.size} files asked about`);
    }
    if (parsed.size < expected.size) {
      await logFailure(
        options.logPath,
        `explain reply covered ${parsed.size} of ${expected.size} paths (model ${options.model});` +
          ` missing: ${[...expected].filter((path) => !parsed.has(path)).slice(0, 12).join(', ')}`,
      );
    }
    onChunk(parsed, done, wanted.length);
  }
  return { sent: wanted.length, overCap };
}
