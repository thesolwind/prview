/** Half-open character range within a line. */
export interface Span {
  start: number;
  end: number;
}

const TOKEN = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;
const MAX_TOKENS = 400;

interface Token {
  text: string;
  start: number;
}

function tokenize(line: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(line)) !== null) {
    out.push({ text: m[0], start: m.index });
    if (out.length > MAX_TOKENS) return out;
  }
  return out;
}

function merge(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  const out: Span[] = [spans[0]!];
  for (const s of spans.slice(1)) {
    const last = out[out.length - 1]!;
    if (s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Word-level diff of a deleted/added line pair, so the eye lands on the part
 * that actually changed rather than re-reading the whole line. Returns the
 * spans to emphasise on each side, or null when the lines are too dissimilar
 * for the emphasis to help (then the whole line reads as changed, like GitHub).
 */
export function intralineSpans(
  oldLine: string,
  newLine: string,
): { old: Span[]; new: Span[] } | null {
  if (oldLine === newLine) return { old: [], new: [] };
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  // Longest common subsequence over tokens.
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i]!.text === b[j]!.text
          ? dp[at(i + 1, j + 1)]! + 1
          : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
    }
  }

  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  let common = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ta = a[i]!;
    const tb = b[j]!;
    if (ta.text === tb.text) {
      common += ta.text.trim().length ? ta.text.length : 0;
      i++;
      j++;
    } else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) {
      oldSpans.push({ start: ta.start, end: ta.start + ta.text.length });
      i++;
    } else {
      newSpans.push({ start: tb.start, end: tb.start + tb.text.length });
      j++;
    }
  }
  for (; i < n; i++) oldSpans.push({ start: a[i]!.start, end: a[i]!.start + a[i]!.text.length });
  for (; j < m; j++) newSpans.push({ start: b[j]!.start, end: b[j]!.start + b[j]!.text.length });

  // If almost nothing survived, the "pairing" was a coincidence.
  const scale = Math.max(oldLine.trim().length, newLine.trim().length, 1);
  if (common / scale < 0.25) return null;

  return { old: merge(oldSpans), new: merge(newSpans) };
}

/** Rough similarity used to decide whether two lines are the same line edited. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const at = a.trim();
  const bt = b.trim();
  if (!at.length || !bt.length) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) ?? 0) + 1);
    }
    return set;
  };
  const ga = bigrams(at);
  const gb = bigrams(bt);
  let shared = 0;
  for (const [g, count] of ga) shared += Math.min(count, gb.get(g) ?? 0);
  return (2 * shared) / (at.length - 1 + bt.length - 1 || 1);
}
