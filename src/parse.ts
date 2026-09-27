import { createHash } from 'node:crypto';

export type LineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** `\ No newline at end of file` followed this line. */
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'mode';

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** Path to show in the UI. */
  path: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  /** Hash of this file's raw patch: invalidates "viewed" when the change itself changes. */
  hash: string;
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/;

/** Undo git's C-style quoting of unusual paths. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const body = path.slice(1, -1);
  return body.replace(/\\([\\"abfnrtv]|[0-7]{3})/g, (_, esc: string) => {
    switch (esc) {
      case '\\': return '\\';
      case '"': return '"';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      default: return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

function stripPrefix(path: string): string | null {
  const p = unquote(path);
  if (p === '/dev/null') return null;
  return p.replace(/^[abciow]\//, '');
}

export function expandTabs(text: string, tabWidth: number): string {
  if (!text.includes('\t')) return text;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') out += ' '.repeat(tabWidth - (out.length % tabWidth));
    else out += ch;
  }
  return out;
}

/**
 * Parse unified diff output from `git diff`. Deliberately tolerant: unknown
 * extended headers are skipped rather than rejected, so new git versions or
 * unusual configs degrade to "we still show the hunks".
 */
export function parseDiff(raw: string, tabWidth = 4): FileDiff[] {
  const lines = raw.split('\n');
  // The final newline of the diff leaves an empty element behind. An empty
  // line is otherwise tolerated as context — some pipelines strip the leading
  // space off blank context lines — so without this the last hunk of every
  // file gains a phantom line numbered past the end of the file.
  if (lines[lines.length - 1] === '') lines.pop();

  const files: FileDiff[] = [];

  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let rawChunk: string[] = [];
  let oldNo = 0;
  let newNo = 0;

  const seal = () => {
    if (!file) return;
    file.hash = createHash('sha1').update(rawChunk.join('\n')).digest('hex').slice(0, 16);
    if (file.hunks.length === 0 && !file.binary && file.status === 'modified') file.status = 'mode';
    files.push(file);
    file = null;
    hunk = null;
    rawChunk = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      seal();
      const paths = splitDiffGit(line.slice('diff --git '.length));
      file = {
        oldPath: paths[0],
        newPath: paths[1],
        path: paths[1] ?? paths[0] ?? '?',
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        hash: '',
      };
      rawChunk = [line];
      continue;
    }
    if (!file) continue;
    rawChunk.push(line);

    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (!m) continue;
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '',
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      const marker = line[0];
      if (marker === '+') {
        hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: expandTabs(line.slice(1), tabWidth) });
        file.additions++;
        continue;
      }
      if (marker === '-') {
        hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: expandTabs(line.slice(1), tabWidth) });
        file.deletions++;
        continue;
      }
      if (marker === ' ' || line === '') {
        hunk.lines.push({
          kind: 'context',
          oldNo: oldNo++,
          newNo: newNo++,
          text: expandTabs(line.slice(1), tabWidth),
        });
        continue;
      }
      if (line.startsWith('\\')) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewline = true;
        continue;
      }
      // Anything else ends the hunk body (next file's headers, trailing output).
      hunk = null;
    }

    if (line.startsWith('--- ')) {
      file.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      file.newPath = stripPrefix(line.slice(4));
      file.path = file.newPath ?? file.oldPath ?? file.path;
    } else if (line.startsWith('new file mode ')) {
      file.status = 'added';
      file.newMode = line.slice('new file mode '.length).trim();
    } else if (line.startsWith('deleted file mode ')) {
      file.status = 'deleted';
      file.oldMode = line.slice('deleted file mode '.length).trim();
    } else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = unquote(line.slice('rename to '.length));
      file.path = file.newPath;
    } else if (line.startsWith('copy from ')) {
      file.status = 'copied';
      file.oldPath = unquote(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) {
      file.status = 'copied';
      file.newPath = unquote(line.slice('copy to '.length));
      file.path = file.newPath;
    } else if (line.startsWith('similarity index ')) {
      file.similarity = Number.parseInt(line.slice('similarity index '.length), 10);
    } else if (line.startsWith('old mode ')) {
      file.oldMode = line.slice('old mode '.length).trim();
    } else if (line.startsWith('new mode ')) {
      file.newMode = line.slice('new mode '.length).trim();
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
    }
  }
  seal();
  return files;
}

/**
 * `diff --git a/x b/y` is ambiguous when paths contain spaces. Prefer the
 * quoted form, then the a/ b/ split, then a midpoint guess. The `---`/`+++`
 * lines correct us a moment later anyway.
 */
function splitDiffGit(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end > 0) {
      const first = rest.slice(0, end + 1);
      const second = rest.slice(end + 1).trim();
      return [stripPrefix(first), stripPrefix(second)];
    }
  }
  const bSplit = rest.indexOf(' b/');
  if (bSplit > 0) return [stripPrefix(rest.slice(0, bSplit)), stripPrefix(rest.slice(bSplit + 1))];
  const half = Math.floor(rest.length / 2);
  return [stripPrefix(rest.slice(0, half).trim()), stripPrefix(rest.slice(half).trim())];
}

function findQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

export function statusLabel(f: FileDiff): string {
  switch (f.status) {
    case 'added': return 'added';
    case 'deleted': return 'deleted';
    case 'renamed': return `renamed from ${f.oldPath ?? '?'}`;
    case 'copied': return `copied from ${f.oldPath ?? '?'}`;
    case 'mode': return 'mode changed';
    default: return 'modified';
  }
}
