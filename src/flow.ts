/**
 * Diff flow: a diagram of the code path a change sits on, so a reviewer sees
 * *where* in the program the edits land before reading them line by line.
 *
 * A diff knows which lines moved but nothing about who calls whom, so the
 * graph is drawn by the model (one `claude` call for the whole review, behind
 * the same opt-in as `--explain`) or handed in by an agent through
 * `--annotate`. Either way it arrives as Mermaid, which is the format both a
 * model and a human already know, survives a copy into a GitHub comment, and
 * is what gets stored — the terminal drawing is derived from it every time.
 *
 * Only a strict subset is understood (see `FLOW_PROMPT`). Mermaid in full is a
 * layout language with dozens of shapes and styling directives; a terminal
 * gets boxes and arrows, so everything past nodes, edges and a change class
 * is ignored rather than half-rendered.
 */
import { createHash } from 'node:crypto';

import type { FileDiff } from './parse';
import { buildPatch, runClaude, skipReason, type Explainer } from './explain';

export type FlowKind = 'changed' | 'added' | 'removed' | 'context';

export interface FlowNode {
  id: string;
  label: string;
  kind: FlowKind;
  /** Diff path this step lives in, when it lives in one; Enter jumps there. */
  file?: string;
  /**
   * A path the diagram named that this diff does not contain — most often a
   * new file that is still untracked, which `git diff` leaves out. Kept, not
   * dropped, so Enter can say why it cannot open it.
   */
  missing?: string;
  /** What the step does (and what the diff changes about it); the focus tip. */
  note?: string;
  /** The kind the diagram claimed when git said otherwise, and why (see `checkKinds`). */
  claimed?: { kind: FlowKind; why: string };
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** What is persisted: the source, never the drawing, so layout can improve. */
export interface StoredFlow {
  /** `flowSignature` of the files it was drawn for; a different diff makes it stale. */
  hash: string;
  mermaid: string;
  model: string;
  createdAt: string;
}

/** Characters of diff in the one flow request; files past it are listed by name only. */
const MAX_FLOW_CHARS = 80_000;
/** A diagram past this is a wall, not a picture; extra nodes are dropped. */
const MAX_NODES = 60;
const MAX_LABEL = 60;
/** A tip is a sentence or two; past this it is a paragraph nobody reads in a box. */
const MAX_NOTE = 240;

export const FLOW_PROMPT = [
  'You are helping someone review a code change.',
  'On stdin are unified diffs, each introduced by a line "=== FILE: <path>".',
  'Draw the program flow this change touches as a Mermaid flowchart: the entry',
  'point(s), the functions, components or steps the change sits on, and what',
  'they call or hand data to. Include unchanged steps only where they connect',
  'changed ones. Prefer 6 to 20 nodes. Labels are short (under 40 characters) and',
  'name the code: a function, method or component name as it is spelled in the',
  'source, optionally with a few words; not a sentence about the user.',
  'Output ONLY Mermaid, using exactly this subset, one statement per line:',
  '"flowchart TD" first;',
  'nodes as  id["Label"]  where id is letters, digits and underscores;',
  'edges as  a --> b  or  a -->|short label| b, where the label says when the step happens',
  '("on save", "if cached") or what is passed ("mermaid text"), never a bare key name;',
  '"class id1,id2 changed" for steps that existed before and this diff modifies',
  '(a function with some lines added is changed, not added),',
  '"class id3 added" only for steps that did not exist before this diff,',
  '"class id4 removed" for steps it deletes (unmarked nodes are unchanged context);',
  'and for every node that lives in one of the given files, a line',
  '"%% file: <id> <path exactly as given>";',
  'and for EVERY node a line "%% note: <id> <one sentence under 140 characters>"',
  'saying what that step does, and for a changed, added or removed step what this',
  'diff changes about it — shown to the reader as a tip when the step is focused.',
  'No subgraphs, no styling, no code fences, no prose before or after.',
].join(' ');

/**
 * Identifies one version of the review's content. Keyed on what was sent
 * rather than on the range, so a flow drawn before an edit reads as stale
 * after it instead of quietly describing code that has moved on.
 */
export function flowSignature(files: FileDiff[]): string {
  const lines = files
    .filter((f) => !skipReason(f))
    .map((f) => `${f.path}@${f.hash}`)
    .sort();
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** The single request: every patch that fits, then the rest by name. */
export function buildFlowRequest(files: FileDiff[]): string {
  const parts: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  for (const file of files.filter((f) => !skipReason(f))) {
    const patch = buildPatch(file);
    if (size + patch.length > MAX_FLOW_CHARS && parts.length) {
      omitted.push(`=== FILE: ${file.path} (diff omitted for length, +${file.additions} −${file.deletions})`);
      continue;
    }
    parts.push(`=== FILE: ${file.path}\n${patch}`);
    size += patch.length;
  }
  return [...parts, ...omitted].join('\n\n');
}

export class FlowParseError extends Error {}

const KIND_ALIASES: Record<string, FlowKind> = {
  changed: 'changed',
  modified: 'changed',
  touched: 'changed',
  added: 'added',
  new: 'added',
  removed: 'removed',
  deleted: 'removed',
};

const OPENERS = ['((', '([', '[[', '[(', '[/', '[\\', '{{', '[', '(', '{', '>'];

function cleanLabel(raw: string): string {
  const text = raw
    .trim()
    .replace(/^"([\s\S]*)"$/, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/#quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

interface NodeRef {
  id: string;
  label?: string;
  cls?: string;
}

/**
 * A tiny scanner over one statement. Regexes alone fall over on labels that
 * contain brackets or arrows (`a["x --> y"]`), which a model will happily
 * write; walking the string lets a quoted label swallow anything.
 */
class Scanner {
  pos = 0;
  constructor(private s: string) {}

  ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos]!)) this.pos++;
  }

  done(): boolean {
    this.ws();
    return this.pos >= this.s.length;
  }

  node(): NodeRef | null {
    this.ws();
    const m = /^[A-Za-z_][\w]*/.exec(this.s.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    const ref: NodeRef = { id: m[0] };
    const opener = OPENERS.find((o) => this.s.startsWith(o, this.pos));
    if (opener) {
      this.pos += opener.length;
      this.ws();
      let label = '';
      if (this.s[this.pos] === '"') {
        const close = this.s.indexOf('"', this.pos + 1);
        const end = close < 0 ? this.s.length : close;
        label = this.s.slice(this.pos + 1, end);
        this.pos = Math.min(this.s.length, end + 1);
      } else {
        const rest = this.s.slice(this.pos);
        const end = rest.search(/[\])}]/);
        label = end < 0 ? rest : rest.slice(0, end);
        this.pos += label.length;
      }
      // Closers vary by shape (`]`, `)]`, `}}`, `/]` …); eat whatever is there.
      while (this.pos < this.s.length && /[\])}/\\ ]/.test(this.s[this.pos]!)) this.pos++;
      ref.label = cleanLabel(label);
    }
    const cls = /^:::([\w-]+)/.exec(this.s.slice(this.pos));
    if (cls) {
      ref.cls = cls[1];
      this.pos += cls[0].length;
    }
    return ref;
  }

  /** `a & b`, which Mermaid allows on either end of an edge. */
  group(): NodeRef[] {
    const out: NodeRef[] = [];
    for (;;) {
      const ref = this.node();
      if (!ref) break;
      out.push(ref);
      this.ws();
      if (this.s[this.pos] !== '&') break;
      this.pos++;
    }
    return out;
  }

  /** An edge operator, returning its label (or '' for none), or null if there isn't one. */
  edge(): string | null {
    this.ws();
    const rest = this.s.slice(this.pos);
    const text = /^(?:--|==|-\.)\s+([^|]+?)\s+(?:-->|==>|\.->|---|-\.->)/.exec(rest);
    if (text) {
      this.pos += text[0].length;
      return cleanLabel(text[1] ?? '');
    }
    const plain = /^<?(?:-{2,}>|={2,}>|-\.+->|-{3,}|={3,}|--[ox]|-\.+-)/.exec(rest);
    if (!plain) return null;
    this.pos += plain[0].length;
    this.ws();
    if (this.s[this.pos] === '|') {
      const close = this.s.indexOf('|', this.pos + 1);
      if (close > 0) {
        const label = this.s.slice(this.pos + 1, close);
        this.pos = close + 1;
        return cleanLabel(label);
      }
    }
    return '';
  }
}

/**
 * Read the supported subset of Mermaid. Lenient about everything it does not
 * understand — a model's stray `style` line or `subgraph` costs nothing — and
 * strict only about there being a graph at all.
 */
export function parseMermaid(raw: string): Flow {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const seenEdges = new Set<string>();

  const touch = (ref: NodeRef): FlowNode | null => {
    let node = nodes.get(ref.id);
    if (!node) {
      if (nodes.size >= MAX_NODES) return null;
      node = { id: ref.id, label: ref.id, kind: 'context' };
      nodes.set(ref.id, node);
    }
    if (ref.label) node.label = ref.label;
    const kind = ref.cls ? KIND_ALIASES[ref.cls.toLowerCase()] : undefined;
    if (kind) node.kind = kind;
    return node;
  };

  // Nothing counts until the header: almost any English sentence starts with
  // a word that would otherwise read as a node id, so a reply of prose — an
  // apology, a preamble — would draw as a graph of its own words.
  let started = false;
  const text = raw.replace(/```(?:mermaid)?/g, '\n');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/;+$/, '');
    if (!line) continue;
    if (!started) {
      started = /^(flowchart|graph)\b/i.test(line);
      continue;
    }

    const file = /^%%\s*file:\s*([A-Za-z_]\w*)\s+(.+?)\s*$/i.exec(line);
    if (file) {
      const node = nodes.get(file[1]!) ?? touch({ id: file[1]! });
      if (node) node.file = file[2]!.replace(/^["'`]|["'`]$/g, '');
      continue;
    }
    const note = /^%%\s*(?:note|desc|tip):\s*([A-Za-z_]\w*)\s+(.+?)\s*$/i.exec(line);
    if (note) {
      const node = nodes.get(note[1]!) ?? touch({ id: note[1]! });
      const text = note[2]!.replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim();
      if (node && text) node.note = text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text;
      continue;
    }
    if (line.startsWith('%%')) continue;
    if (/^(flowchart|graph)\b/i.test(line)) continue;
    if (/^(subgraph|end|direction|style|classDef|linkStyle|click)\b/i.test(line)) continue;

    const cls = /^class\s+([\w,\s]+?)\s+([\w-]+)$/i.exec(line);
    if (cls) {
      const kind = KIND_ALIASES[cls[2]!.toLowerCase()];
      if (!kind) continue;
      for (const id of cls[1]!.split(',').map((s) => s.trim()).filter(Boolean)) {
        const node = nodes.get(id) ?? touch({ id });
        if (node) node.kind = kind;
      }
      continue;
    }

    // Statements: a node, or a chain `a --> b -->|x| c`.
    const scan = new Scanner(line);
    let left = scan.group();
    if (!left.length) continue;
    let leftNodes = left.map(touch).filter((n): n is FlowNode => !!n);
    for (;;) {
      const label = scan.edge();
      if (label === null) break;
      const right = scan.group();
      if (!right.length) break;
      const rightNodes = right.map(touch).filter((n): n is FlowNode => !!n);
      for (const a of leftNodes) {
        for (const b of rightNodes) {
          const key = `${a.id}\u0000${b.id}`;
          if (a.id === b.id || seenEdges.has(key)) continue;
          seenEdges.add(key);
          edges.push({ from: a.id, to: b.id, ...(label ? { label } : {}) });
        }
      }
      left = right;
      leftNodes = rightNodes;
    }
  }

  if (!started) throw new FlowParseError('no "flowchart TD" header');
  if (!nodes.size) throw new FlowParseError('no flowchart nodes found');
  return { nodes: [...nodes.values()], edges };
}

/**
 * Split file links into ones Enter can follow and ones it cannot. A path not
 * in this diff moves to `missing`: jumping to it would do nothing, and saying
 * only "not in a changed file" about a file that plainly changed is wrong.
 */
export function linkFiles(flow: Flow, files: FileDiff[]): { flow: Flow; unknown: string[] } {
  const paths = new Set(files.map((f) => f.path));
  const unknown: string[] = [];
  const nodes = flow.nodes.map((node) => {
    if (!node.file || paths.has(node.file)) return node;
    unknown.push(node.file);
    const { file, ...rest } = node;
    return { ...rest, missing: file };
  });
  return { flow: { ...flow, nodes }, unknown };
}

/**
 * The flow has its own model setting, separate from the summaries', because
 * it is the harder job: a summary is one sentence about one patch, while a
 * flow has to follow calls across every file, tell a new function from an
 * edited one, and keep labels to what the prompt allows. So someone who puts
 * summaries on a small, cheap model still gets a large one here by default.
 * Drawn over this repo's own change, Haiku
 * did none of the three, Sonnet still marked new functions as changed, and
 * Opus got every kind right with the clearest labels. It is one request per
 * drawing, made only on demand, so the largest model costs little. The alias,
 * not a dated id, so it follows whatever the claude CLI currently calls Opus.
 */
export const DEFAULT_FLOW_MODEL = 'opus';

/** Ask the model for the review's flow. Returns the Mermaid source, validated, and who drew it. */
export async function generateFlow(
  files: FileDiff[],
  options: Explainer,
  signal: AbortSignal,
): Promise<{ mermaid: string; model: string }> {
  const input = buildFlowRequest(files);
  if (!input) throw new FlowParseError('nothing to draw: every file is generated or binary');
  const model = options.flowModel ?? DEFAULT_FLOW_MODEL;
  const raw = await runClaude(FLOW_PROMPT, input, { ...options, model }, signal, `flow over ${files.length} files`);
  const start = raw.search(/^\s*(flowchart|graph)\b/im);
  const mermaid = (start >= 0 ? raw.slice(start) : raw).replace(/```\s*$/g, '').trim();
  parseMermaid(mermaid); // throws if there is nothing usable
  return { mermaid, model };
}

// ---------------------------------------------------------------------------
// Layout
//
// A layered (Sugiyama-style) layout, kept deliberately small: break cycles,
// assign layers by longest path, thread long edges through placeholder
// columns, order each layer by barycentre, then place boxes left to right
// pulled towards their neighbours. Edges route down from a box, across on a
// lane of their own, and down into the next box — so two edges never share a
// horizontal run, and a crossing shows as `┼` rather than as an ambiguity.

export type CellRole = 'border' | 'text' | 'edge' | 'arrow' | 'edgeLabel' | 'tag';

export interface FlowCell {
  ch: string;
  role: CellRole;
  /** Index into `flow.nodes` for box cells. */
  node?: number;
}

export interface FlowBox {
  node: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  /** Sparse rows: undefined is blank. */
  cells: Array<Array<FlowCell | undefined>>;
  boxes: FlowBox[];
  /** Node indices in reading order (layer by layer, left to right), for j/k. */
  order: number[];
  /**
   * Edges whose label found no place it could be read unambiguously. They
   * are listed rather than dropped, so the pane can still show them for the
   * focused step.
   */
  unlabelled: number[];
}

/** Longest edge label drawn in full; longer ones are cut with an ellipsis. */
const EDGE_LABEL = 24;

const BOX_TEXT = 24;
const H_GAP = 3;
const TAGS: Record<FlowKind, string> = { changed: '~', added: '+', removed: '−', context: '' };

function wrap(label: string, width: number, maxLines = 3): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const w = word.length > width ? `${word.slice(0, width - 1)}…` : word;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1]!;
    kept[maxLines - 1] = last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
    return kept;
  }
  return lines.length ? lines : [''];
}

const U = 1;
const D = 2;
const L = 4;
const R = 8;
const GLYPH: Record<number, string> = {
  [U]: '│', [D]: '│', [U | D]: '│',
  [L]: '─', [R]: '─', [L | R]: '─',
  [D | R]: '┌', [D | L]: '┐', [U | R]: '└', [U | L]: '┘',
  [U | D | R]: '├', [U | D | L]: '┤', [D | L | R]: '┬', [U | L | R]: '┴',
  [U | D | L | R]: '┼',
};

interface Seg {
  from: number;
  to: number;
  /** Original edge index; the label is drawn on its last segment. */
  edge: number;
  reversed: boolean;
  last: boolean;
  first: boolean;
}

export function layoutFlow(flow: Flow): FlowLayout {
  const n = flow.nodes.length;
  const index = new Map(flow.nodes.map((node, i) => [node.id, i]));
  const edges = flow.edges
    .map((e, i) => ({ u: index.get(e.from), v: index.get(e.to), i }))
    .filter((e): e is { u: number; v: number; i: number } => e.u !== undefined && e.v !== undefined && e.u !== e.v);

  // 1. Break cycles: an edge back to a node still on the DFS stack is drawn
  // reversed, with its arrow on the other end, so the picture stays layered.
  const out: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, k) => out[e.u]!.push(k));
  const state = new Array<number>(n).fill(0);
  const reversed = new Set<number>();
  const visit = (u: number) => {
    state[u] = 1;
    for (const k of out[u]!) {
      const v = edges[k]!.v;
      if (state[v] === 1) reversed.add(k);
      else if (state[v] === 0) visit(v);
    }
    state[u] = 2;
  };
  for (let u = 0; u < n; u++) if (state[u] === 0) visit(u);
  const dag = edges.map((e, k) => (reversed.has(k) ? { u: e.v, v: e.u, i: e.i, rev: true } : { ...e, rev: false }));

  // 2. Layers by longest path from the sources.
  const indeg = new Array<number>(n).fill(0);
  const succ: number[][] = Array.from({ length: n }, () => []);
  for (const e of dag) {
    indeg[e.v]!++;
    succ[e.u]!.push(e.v);
  }
  const layer = new Array<number>(n).fill(0);
  const queue = [...Array(n).keys()].filter((u) => indeg[u] === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi]!;
    for (const v of succ[u]!) {
      layer[v] = Math.max(layer[v]!, layer[u]! + 1);
      if (--indeg[v]! === 0) queue.push(v);
    }
  }

  // 3. Placeholder vertices for edges that skip layers.
  const vLayer = [...layer];
  const segs: Seg[] = [];
  for (const e of dag) {
    let prev = e.u;
    const span = layer[e.v]! - layer[e.u]!;
    for (let step = 1; step < span; step++) {
      const dummy = vLayer.length;
      vLayer.push(layer[e.u]! + step);
      segs.push({ from: prev, to: dummy, edge: e.i, reversed: e.rev, first: step === 1, last: false });
      prev = dummy;
    }
    segs.push({ from: prev, to: e.v, edge: e.i, reversed: e.rev, first: span <= 1, last: true });
  }
  const total = vLayer.length;
  const isReal = (v: number) => v < n;

  const depth = Math.max(0, ...vLayer) + 1;
  const layers: number[][] = Array.from({ length: depth }, () => []);
  for (let v = 0; v < total; v++) layers[vLayer[v]!]!.push(v);

  const preds: number[][] = Array.from({ length: total }, () => []);
  const succs: number[][] = Array.from({ length: total }, () => []);
  for (const s of segs) {
    preds[s.to]!.push(s.from);
    succs[s.from]!.push(s.to);
  }

  // 4. Order within layers by barycentre, a few sweeps each way.
  const rank = new Array<number>(total).fill(0);
  const reRank = () => layers.forEach((ls) => ls.forEach((v, i) => (rank[v] = i)));
  reRank();
  const sortBy = (ls: number[], nbrs: number[][]) => {
    const key = new Map(
      ls.map((v) => {
        const ns = nbrs[v]!;
        return [v, ns.length ? ns.reduce((a, b) => a + rank[b]!, 0) / ns.length : rank[v]!];
      }),
    );
    ls.sort((a, b) => key.get(a)! - key.get(b)!);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let li = 1; li < depth; li++) {
      sortBy(layers[li]!, preds);
      reRank();
    }
    for (let li = depth - 2; li >= 0; li--) {
      sortBy(layers[li]!, succs);
      reRank();
    }
  }

  // 5. Sizes.
  const textOf: string[][] = flow.nodes.map((node) => wrap(node.label, BOX_TEXT));
  const width = new Array<number>(total).fill(1);
  const height = new Array<number>(total).fill(0);
  for (let v = 0; v < n; v++) {
    const lines = textOf[v]!;
    // At least 9, so the centre — where edges attach — clears the `[~]` tag.
    width[v] = Math.max(9, Math.max(...lines.map((l) => l.length)) + 4);
    height[v] = lines.length + 2;
  }
  const layerH = layers.map((ls) => Math.max(3, ...ls.filter(isReal).map((v) => height[v]!)));

  // 6. Horizontal placement: pack, then pull each vertex towards the centre of
  // its neighbours without overlapping, alternating direction.
  const x = new Array<number>(total).fill(0);
  const centre = (v: number) => x[v]! + (isReal(v) ? Math.floor(width[v]! / 2) : 0);
  for (const ls of layers) {
    let at = 0;
    for (const v of ls) {
      x[v] = at;
      at += width[v]! + H_GAP;
    }
  }
  const place = (ls: number[], nbrs: number[][]) => {
    const want = ls.map((v) => {
      const ns = nbrs[v]!;
      if (!ns.length) return x[v]!;
      const c = ns.reduce((a, b) => a + centre(b), 0) / ns.length;
      return Math.round(c - (isReal(v) ? Math.floor(width[v]! / 2) : 0));
    });
    // Resolving overlaps only rightwards drifts a crowded layer off to the
    // right; only leftwards, off to the left. Each is a valid placement, and
    // so is their average (the spacing constraint is linear), which centres.
    const right: number[] = [];
    for (let i = 0; i < ls.length; i++) {
      const prev = i > 0 ? right[i - 1]! + width[ls[i - 1]!]! + H_GAP : -Infinity;
      right.push(Math.max(want[i]!, prev));
    }
    const left: number[] = new Array<number>(ls.length).fill(0);
    for (let i = ls.length - 1; i >= 0; i--) {
      const next = i < ls.length - 1 ? left[i + 1]! - width[ls[i]!]! - H_GAP : Infinity;
      left[i] = Math.min(want[i]!, next);
    }
    ls.forEach((v, i) => (x[v] = Math.round((right[i]! + left[i]!) / 2)));
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    for (let li = 1; li < depth; li++) place(layers[li]!, preds);
    for (let li = depth - 2; li >= 0; li--) place(layers[li]!, succs);
  }
  const minX = Math.min(0, ...x);
  for (let v = 0; v < total; v++) x[v]! -= minX;

  // 7. Lanes per gap, so no two edges share a horizontal run.
  const gapSegs: Seg[][] = Array.from({ length: Math.max(0, depth - 1) }, () => []);
  for (const s of segs) gapSegs[vLayer[s.from]!]!.push(s);
  const laneOf = new Map<Seg, number>();
  const lanes = gapSegs.map((list) => {
    const spans = list
      .map((s) => ({ s, a: Math.min(centre(s.from), centre(s.to)), b: Math.max(centre(s.from), centre(s.to)) }))
      .filter((sp) => sp.a !== sp.b)
      .sort((p, q) => p.a - q.a || p.b - q.b);
    const ends: number[] = [];
    for (const sp of spans) {
      let lane = ends.findIndex((end) => end < sp.a - 1);
      if (lane < 0) {
        lane = ends.length;
        ends.push(sp.b);
      } else ends[lane] = sp.b;
      laneOf.set(sp.s, lane);
    }
    return ends.length;
  });

  // 8. Vertical placement.
  const top: number[] = [];
  let y = 0;
  for (let li = 0; li < depth; li++) {
    top.push(y);
    y += layerH[li]! + (li < depth - 1 ? lanes[li]! + 2 : 0);
  }
  const heightTotal = y;
  const widthTotal = Math.max(1, ...Array.from({ length: total }, (_, v) => x[v]! + width[v]!));

  // 9. Draw: edges as a direction mask first, so joins and crossings resolve
  // to the right glyph, then boxes and arrows over the top.
  const mask: number[][] = Array.from({ length: heightTotal }, () => new Array<number>(widthTotal).fill(0));
  const vline = (cx: number, y1: number, y2: number) => {
    const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1];
    for (let yy = a; yy <= b; yy++) {
      const row = mask[yy];
      if (!row || cx < 0 || cx >= widthTotal) continue;
      if (yy > a) row[cx]! |= U;
      if (yy < b) row[cx]! |= D;
      if (a === b) row[cx]! |= U | D;
    }
  };
  const hline = (yy: number, x1: number, x2: number) => {
    const row = mask[yy];
    if (!row) return;
    const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1];
    for (let xx = a; xx <= b; xx++) {
      if (xx > a) row[xx]! |= L;
      if (xx < b) row[xx]! |= R;
    }
  };

  const cells: Array<Array<FlowCell | undefined>> = Array.from({ length: heightTotal }, () =>
    new Array<FlowCell | undefined>(widthTotal).fill(undefined),
  );
  const put = (yy: number, xx: number, cell: FlowCell) => {
    const row = cells[yy];
    if (row && xx >= 0 && xx < widthTotal) row[xx] = cell;
  };
  const overlays: Array<{ y: number; x: number; cell: FlowCell }> = [];

  // Placeholders run straight down through their layer.
  for (let v = n; v < total; v++) {
    const li = vLayer[v]!;
    vline(x[v]!, top[li]!, top[li]! + layerH[li]! - 1);
  }

  for (const s of segs) {
    const li = vLayer[s.from]!;
    const sx = centre(s.from);
    const tx = centre(s.to);
    const fromBottom = isReal(s.from) ? top[li]! + height[s.from]! - 1 : top[li]! + layerH[li]! - 1;
    const gapTop = top[li]! + layerH[li]!;
    const arrowY = top[li + 1]! - 1;
    const endY = isReal(s.to) ? arrowY : top[li + 1]!;
    const lane = laneOf.get(s);
    const turnY = lane === undefined ? endY : gapTop + 1 + lane;
    vline(sx, fromBottom, turnY);
    hline(turnY, sx, tx);
    vline(tx, turnY, endY);
    if (isReal(s.from)) {
      // Joins the box border; the box draw would otherwise cover the start.
      overlays.push({ y: fromBottom, x: sx, cell: { ch: s.reversed && s.first ? '┴' : '┬', role: 'border', node: s.from } });
      if (s.reversed && s.first) overlays.push({ y: fromBottom + 1, x: sx, cell: { ch: '▲', role: 'arrow' } });
    }
    if (isReal(s.to)) {
      if (!s.reversed) overlays.push({ y: arrowY, x: tx, cell: { ch: '▼', role: 'arrow' } });
      else overlays.push({ y: top[li + 1]!, x: tx, cell: { ch: '┴', role: 'border', node: s.to } });
    }
  }

  for (let yy = 0; yy < heightTotal; yy++) {
    for (let xx = 0; xx < widthTotal; xx++) {
      const m = mask[yy]![xx]!;
      if (m) put(yy, xx, { ch: GLYPH[m] ?? '┼', role: 'edge' });
    }
  }

  const boxes: FlowBox[] = [];
  for (let v = 0; v < n; v++) {
    const li = vLayer[v]!;
    const bx = x[v]!;
    const by = top[li]!;
    const w = width[v]!;
    const h = height[v]!;
    boxes.push({ node: v, x: bx, y: by, w, h });
    const node = flow.nodes[v]!;
    for (let xx = bx; xx < bx + w; xx++) {
      const edgeChar = xx === bx ? '┌' : xx === bx + w - 1 ? '┐' : '─';
      put(by, xx, { ch: edgeChar, role: 'border', node: v });
      put(by + h - 1, xx, { ch: xx === bx ? '└' : xx === bx + w - 1 ? '┘' : '─', role: 'border', node: v });
    }
    for (let yy = by + 1; yy < by + h - 1; yy++) {
      put(yy, bx, { ch: '│', role: 'border', node: v });
      put(yy, bx + w - 1, { ch: '│', role: 'border', node: v });
      for (let xx = bx + 1; xx < bx + w - 1; xx++) put(yy, xx, { ch: ' ', role: 'text', node: v });
    }
    textOf[v]!.forEach((line, i) => {
      const start = bx + 2 + Math.floor((w - 4 - line.length) / 2);
      for (let c = 0; c < line.length; c++) put(by + 1 + i, start + c, { ch: line[c]!, role: 'text', node: v });
    });
    // Colour alone does not survive a monochrome terminal or a colour-blind
    // reader, so the kind is spelled out in the border too.
    const tag = TAGS[node.kind];
    if (tag) {
      put(by, bx + 1, { ch: '[', role: 'border', node: v });
      put(by, bx + 2, { ch: tag, role: 'tag', node: v });
      put(by, bx + 3, { ch: ']', role: 'border', node: v });
    }
  }
  for (const o of overlays) {
    const existing = cells[o.y]?.[o.x];
    // Never cut through a kind tag or a label.
    if (existing && (existing.role === 'tag' || existing.role === 'text')) continue;
    if (existing?.role === 'border' && existing.ch === '[') continue;
    if (existing?.role === 'border' && existing.ch === ']') continue;
    put(o.y, o.x, o.cell);
  }

  // Edge labels. A label is only readable beside a stretch of line that
  // belongs to its edge alone: every edge into a step ends on the same
  // arrowhead, so two labels beside a shared arrow ("StoredFlow ▼ validated
  // flow") give no way to tell which came from where. So each label looks
  // for a vertical run its edge does not share — the arrow into a step with
  // one way in, the stub under a step with one way out, or a long edge's
  // pass-through column — and is left out, and reported, when it finds none.
  const inCount = new Array<number>(total).fill(0);
  const outCount = new Array<number>(total).fill(0);
  for (const s of segs) {
    inCount[s.to]!++;
    outCount[s.from]!++;
  }
  const isLabel = (yy: number, xx: number) => cells[yy]?.[xx]?.role === 'edgeLabel';
  const fits = (yy: number, start: number, len: number, side: 'right' | 'left') => {
    const row = cells[yy];
    // Past either edge of the boxes counts as blank: the canvas widens to fit.
    if (!row || start < 0) return false;
    // The label plus a blank cell either side, so it never touches a line,
    // and no label directly above or below, so two never read as one.
    for (let c = -1; c <= len; c++) {
      if (row[start + c]) return false;
      if (isLabel(yy - 1, start + c) || isLabel(yy + 1, start + c)) return false;
    }
    // Two more blanks on the far side: a label between two lines could
    // belong to either, so it must sit visibly nearer its own.
    return side === 'right' ? !row[start + len + 1] && !row[start + len + 2] : !row[start - 2] && !row[start - 3];
  };
  const unlabelled: number[] = [];
  const byEdge = new Map<number, Seg[]>();
  for (const s of segs) byEdge.set(s.edge, [...(byEdge.get(s.edge) ?? []), s]);
  for (const [edge, chain] of byEdge) {
    const label = flow.edges[edge]?.label;
    if (!label) continue;
    const text = label.length > EDGE_LABEL ? `${label.slice(0, EDGE_LABEL - 1)}…` : label;
    // Places nearest the arrowhead first: that is where the eye lands.
    const spots: Array<{ y: number; x: number }> = [];
    for (const s of [...chain].reverse()) {
      const li = vLayer[s.from]!;
      const lane = laneOf.get(s);
      const gapTop = top[li]! + layerH[li]!;
      const turnY = lane === undefined ? top[li + 1]! - 1 : gapTop + 1 + lane;
      if (inCount[s.to] === 1) {
        const tx = centre(s.to);
        // Beside the arrow, or along the drop from this edge's own turn.
        for (let yy = top[li + 1]! - 1; yy >= turnY; yy--) spots.push({ y: yy, x: tx });
        if (!isReal(s.to)) {
          for (let yy = top[li + 1]!; yy < top[li + 1]! + layerH[li + 1]!; yy++) spots.push({ y: yy, x: tx });
        }
      }
      if (outCount[s.from] === 1) {
        const sx = centre(s.from);
        const fromBottom = isReal(s.from) ? top[li]! + height[s.from]! - 1 : top[li]! + layerH[li]! - 1;
        for (let yy = fromBottom + 1; yy < turnY; yy++) spots.push({ y: yy, x: sx });
      }
    }
    // Right of the line reads best; left is the fallback when another edge
    // runs close by on the right, which is common beside a merge.
    const spot = spots
      .flatMap((p) => [
        { y: p.y, start: p.x + 2, side: 'right' as const },
        { y: p.y, start: p.x - 1 - text.length, side: 'left' as const },
      ])
      .find((p) => fits(p.y, p.start, text.length, p.side));
    if (!spot) {
      unlabelled.push(edge);
      continue;
    }
    const row = cells[spot.y]!;
    for (let c = 0; c < text.length; c++) row[spot.start + c] = { ch: text[c]!, role: 'edgeLabel' };
  }
  unlabelled.sort((a, b) => a - b);
  // A label past the right-most box widens the canvas; keep rows rectangular.
  const canvasWidth = Math.max(widthTotal, ...cells.map((row) => row.length));
  for (const row of cells) while (row.length < canvasWidth) row.push(undefined);

  const order = [...boxes]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((b) => b.node);
  return { width: canvasWidth, height: heightTotal, cells, boxes, order, unlabelled };
}

/**
 * The line a step most likely means, so Enter lands on it rather than at the
 * top of the file. Labels are usually a name with a few words around it
 * ("App: handleKey 'f'"), so each identifier in the label is tried in turn —
 * the most specific (longest) first — looking for a definition before any
 * mere mention. Only new-side lines count: that is the code as it now is.
 */
export function stepLine(file: FileDiff, label: string): number | null {
  const lines: Array<{ no: number; text: string }> = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) if (line.newNo != null) lines.push({ no: line.newNo, text: line.text });
  }
  for (const name of labelNames(label)) {
    const definition = definitionOf(name);
    const def = lines.find((l) => definition.test(l.text));
    if (def) return def.no;
    const esc = name.replace(/\$/g, '\\$');
    const mention = lines.find((l) => new RegExp(String.raw`\b${esc}\b`).test(l.text));
    if (mention) return mention.no;
  }
  return null;
}

/** Identifiers in a step label, most specific (longest) first. */
function labelNames(label: string): string[] {
  return [...new Set(label.match(/[A-Za-z_$][\w$]*/g) ?? [])]
    .filter((name) => name.length >= 3)
    .sort((a, b) => b.length - a.length);
}

/** A line that defines `name`: a declaration, or a method/arrow assignment. */
function definitionOf(name: string): RegExp {
  // String.raw: in a plain template literal `\s` and `\b` are not regex escapes.
  const esc = name.replace(/\$/g, '\\$');
  return new RegExp(
    String.raw`(?:function\*?|class|const|let|var|interface|type|enum|def|fn|func|struct)\s+${esc}\b` +
      String.raw`|\b${esc}\s*(?:=\s*(?:async\s*)?\(|\([^)]*\)\s*(?::[^{]*)?\{)`,
  );
}

/**
 * Hold the diagram's added/changed marks to what git says. Models — the
 * small ones especially — mark every step they mention as added, which turns
 * the legend into noise: the one thing a reviewer wants from it is which
 * steps are new. Larger models err the other way, calling a new function in
 * an edited file "changed". Three facts settle most cases without asking:
 *
 * - a step in a file the diff adds cannot have existed before: `added`;
 * - a step marked `added` whose name is already defined in the old version
 *   of its file did exist: `changed`;
 * - a step marked `changed` whose definition is an added line, and which the
 *   old version does not define, did not exist: `added`.
 *
 * Only the label's longest identifier is looked up — "openFlow() sets flow
 * tab" must not count as old because some `const flow` was. `oldText` holds
 * the old side of each modified file, keyed by diff path; a file missing from
 * it is left as the diagram said. The claimed kind is kept on the node so the
 * pane can say it was corrected rather than silently disagree with its author.
 */
export function checkKinds(flow: Flow, files: readonly FileDiff[], oldText: ReadonlyMap<string, string>): Flow {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const nodes = flow.nodes.map((node): FlowNode => {
    const file = node.file ? byPath.get(node.file) : undefined;
    if (!file) return node;
    const name = labelNames(node.label)[0];
    const old = oldText.get(file.path);
    const correct = (kind: FlowKind, why: string): FlowNode => ({ ...node, kind, claimed: { kind: node.kind, why } });
    if (file.status === 'added') {
      return node.kind === 'changed' ? correct('added', 'its file is new') : node;
    }
    if (!name || old == null || (node.kind !== 'added' && node.kind !== 'changed')) return node;
    const definition = definitionOf(name);
    const before = old.split('\n').some((line) => definition.test(line));
    if (node.kind === 'added' && before) return correct('changed', 'it exists before this change');
    if (node.kind === 'changed' && !before) {
      const introduced = file.hunks.some((h) => h.lines.some((l) => l.kind === 'add' && definition.test(l.text)));
      if (introduced) return correct('added', 'this change defines it');
    }
    return node;
  });
  return { ...flow, nodes };
}

/** Diff paths whose old side `checkKinds` needs: modified files with an added or changed step. */
export function kindCheckPaths(flow: Flow, files: readonly FileDiff[]): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = new Set<string>();
  for (const node of flow.nodes) {
    const file = node.file ? byPath.get(node.file) : undefined;
    if (file && file.status !== 'added' && (node.kind === 'added' || node.kind === 'changed')) {
      paths.add(file.path);
    }
  }
  return [...paths];
}

export interface TipBox {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
}

/** Widest a tip gets: about a sentence per line, narrow enough to sit beside a box. */
const TIP_TEXT = 40;

/**
 * Where the focused step's tip goes, in canvas coordinates. Beside the box
 * reads as belonging to it, so right first, then left; below, then above,
 * only when the view is too narrow for either — a tip that covers its own
 * step, or hangs off-screen, is worse than none. Among the places that fit,
 * the first that hides no other step wins; failing that, the one that hides
 * the least of them, since a tip over a neighbour makes that step unreadable.
 */
export function placeTip(
  box: FlowBox,
  text: string,
  view: { x: number; y: number; w: number; h: number },
  others: readonly FlowBox[] = [],
): TipBox | null {
  const width = Math.max(12, Math.min(TIP_TEXT, view.w - 6));
  const lines = wrap(text, width, 6);
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  const h = lines.length + 2;
  const clampX = (x: number): number => Math.max(view.x, Math.min(x, view.x + view.w - w));
  const clampY = (y: number): number => Math.max(view.y, Math.min(y, view.y + view.h - h));
  const fits = (x: number, y: number): boolean =>
    x >= view.x && y >= view.y && x + w <= view.x + view.w && y + h <= view.y + view.h;

  const right = box.x + box.w + 2;
  const left = box.x - 2 - w;
  // Beside the box, top-aligned first, then bottom-aligned so it can dodge
  // a neighbour by sliding up.
  const besideY = [clampY(box.y), clampY(box.y + box.h - h)];
  const candidates: Array<[number, number]> = [
    ...besideY.map((y): [number, number] => [right, y]),
    ...besideY.map((y): [number, number] => [left, y]),
    [clampX(box.x), box.y + box.h],
    [clampX(box.x), box.y - h],
  ];

  const hidden = (x: number, y: number): number => {
    let area = 0;
    for (const o of others) {
      if (o === box || o.node === box.node) continue;
      const ow = Math.min(x + w, o.x + o.w) - Math.max(x, o.x);
      const oh = Math.min(y + h, o.y + o.h) - Math.max(y, o.y);
      if (ow > 0 && oh > 0) area += ow * oh;
    }
    return area;
  };

  let best: { x: number; y: number; cost: number } | null = null;
  for (const [x, y] of candidates) {
    if (!fits(x, y)) continue;
    const cost = hidden(x, y);
    if (cost === 0) return { x, y, w, h, lines };
    if (!best || cost < best.cost) best = { x, y, cost };
  }
  return best ? { x: best.x, y: best.y, w, h, lines } : null;
}
