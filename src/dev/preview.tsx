/**
 * Headless renderer for the TUI: boots the real App against a real repo,
 * feeds it a scripted sequence of keys, and prints the final frame. Used to
 * eyeball layout and to check key handling without a terminal.
 *
 *   node dist/preview.js <repo> [spec] --cols 140 --rows 34 --keys "j,j,space,s"
 */
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';

import { App } from '../ui/App';
import { openRepo, rawDiff, resolveRange, currentBranch, reviewsCurrentBranch } from '../git';
import { parseDiff } from '../parse';
import { Highlighter } from '../highlight';
import { Store } from '../state';
import { DEFAULT_EXPLAIN_MODEL, DEFAULT_MAX_FILES } from '../explain';
import { dark, light } from '../theme';
import type { Layout } from '../view';

const ESC = '\u001B';

const SPECIAL: Record<string, string> = {
  space: ' ',
  tab: '\t',
  enter: '\r',
  esc: ESC,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  'ctrl-d': '\u0004',
  'ctrl-u': '\u0015',
  backspace: '\u007F',
};

function fakeStdout(columns: number, rows: number) {
  const stream = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  const frames: string[] = [];
  stream.on('data', (chunk: Buffer) => frames.push(chunk.toString('utf8')));
  return { stream, frames };
}

function fakeStdin() {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let columns = 140;
  let rows = 34;
  let keys = '';
  let layout: Layout = 'split';
  let auto = false;
  let useLight = false;
  let explain = false;
  let dumpFrames = false;
  let explainMax = DEFAULT_MAX_FILES;
  let settle = 300;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--cols') columns = Number(argv[++i]);
    else if (arg === '--rows') rows = Number(argv[++i]);
    else if (arg === '--keys') keys = argv[++i] ?? '';
    else if (arg === '--unified') layout = 'unified';
    else if (arg === '--light') useLight = true;
    else if (arg === '--dump-frames') dumpFrames = true;
    else if (arg === '--explain-max') explainMax = Number(argv[++i]);
    else if (arg === '--explain') {
      explain = true;
      // A round trip to the model takes seconds; without waiting, the frame is
      // captured before any summary can land.
      settle = 20000;
    }
    else if (arg === '--pr') auto = true;
    else positional.push(arg);
  }

  const cwd = positional[0] ?? process.cwd();
  const spec = positional[1];

  const repo = await openRepo(cwd);
  const range = await resolveRange({ spec, staged: false, auto, paths: [], context: 3 }, repo);
  const files = parseDiff(await rawDiff(range, repo), 4);
  const store = new Store(repo.gitDir, range.key);
  const state = await store.load();
  const branch = reviewsCurrentBranch(range) ? await currentBranch(repo) : '';

  const theme = useLight ? light : dark;
  const { stream: stdout, frames } = fakeStdout(columns, rows);
  const stdin = fakeStdin();

  const app = render(
    <App
      repo={repo}
      range={range}
      branch={branch}
      files={files}
      initial={state}
      store={store}
      theme={theme}
      highlighter={new Highlighter(theme.shikiTheme, 4)}
      reload={async () => parseDiff(await rawDiff(range, repo), 4)}
      onOpenRequest={() => {}}
      preferredLayout={layout}
      initialMessage={null}
      explain={
        explain
          ? {
              model: DEFAULT_EXPLAIN_MODEL,
              cwd: repo.root,
              maxFiles: explainMax,
              logPath: join(repo.gitDir, 'prview', 'explain.log'),
            }
          : null
      }
    />,
    { stdout: stdout as never, stdin: stdin as never, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  await sleep(700); // let shiki load its grammar

  for (const raw of keys.split(',').map((k) => k.trim()).filter(Boolean)) {
    stdin.write(SPECIAL[raw] ?? raw);
    await sleep(90);
  }
  await sleep(settle);

  const finalFrame = [...frames].reverse().find((f) => f.includes('viewed')) ?? frames[frames.length - 1];
  app.unmount();
  // Every frame, for checking transient states that the last frame cannot show.
  if (dumpFrames) {
    // A text marker, not a NUL: grep treats a file with NULs as binary and
    // silently declines to search it.
    process.stdout.write(frames.join('\n----- FRAME -----\n'));
    process.exit(0);
  }
  process.stdout.write(finalFrame ?? '(no frames rendered)');
  process.stdout.write('\n');
  process.exit(0);
}

void main();
