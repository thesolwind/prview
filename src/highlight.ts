import { expandTabs } from './parse';

export interface Tok {
  text: string;
  color?: string;
}

/** Extensions and filenames worth a grammar; anything unlisted renders plain. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', pl: 'perl', lua: 'lua', r: 'r', dart: 'dart',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml',
  clj: 'clojure', zig: 'zig', nim: 'nim', jl: 'julia',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'fish', ps1: 'powershell',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', astro: 'astro',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', jsonc: 'jsonc', json5: 'json5', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', xml: 'xml', md: 'markdown', mdx: 'mdx',
  tf: 'terraform', hcl: 'hcl', nix: 'nix', diff: 'diff', patch: 'diff',
  gradle: 'groovy', groovy: 'groovy', cmake: 'cmake', make: 'make',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  cmakelists: 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.env': 'dotenv',
};

export function langFor(path: string): string | null {
  const base = path.split('/').pop() ?? path;
  const lower = base.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower]!;
  const stem = lower.replace(/\.(in|tpl|template)$/, '');
  const ext = stem.includes('.') ? stem.slice(stem.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] ?? null;
}

type ShikiHighlighter = {
  codeToTokensBase: (
    code: string,
    options: { lang: string; theme: string },
  ) => Array<Array<{ content: string; color?: string }>>;
  loadLanguage: (lang: string) => Promise<void>;
  getLoadedLanguages: () => string[];
};

/**
 * Lazy wrapper over shiki. Grammars are pulled in per language on first use so
 * startup stays fast, and every failure path degrades to unhighlighted text
 * rather than taking the UI down.
 */
export class Highlighter {
  private shiki: ShikiHighlighter | null = null;
  private booting: Promise<void> | null = null;
  private loaded = new Set<string>();
  private bundled: Set<string> | null = null;
  private failed = false;

  constructor(
    private theme: string,
    private tabWidth: number,
  ) {}

  private async boot(): Promise<void> {
    if (this.shiki || this.failed) return;
    const theme = this.theme;
    if (!this.booting) {
      this.booting = (async () => {
        try {
          const shiki = await import('shiki');
          this.bundled = new Set(Object.keys(shiki.bundledLanguages));
          this.shiki = (await shiki.createHighlighter({
            themes: [theme],
            langs: [],
          })) as unknown as ShikiHighlighter;
        } catch {
          this.failed = true;
        }
      })();
    }
    await this.booting;
  }

  /** Token runs per line (1-indexed lookup by `lines[n - 1]`), or null if unavailable. */
  async tokenize(code: string, lang: string): Promise<Tok[][] | null> {
    await this.boot();
    const theme = this.theme;
    if (!this.shiki || this.failed || theme === null) return null;
    if (this.bundled && !this.bundled.has(lang)) return null;
    if (!this.loaded.has(lang)) {
      try {
        await this.shiki.loadLanguage(lang);
        this.loaded.add(lang);
      } catch {
        return null;
      }
    }
    const expanded = code
      .split('\n')
      .map((line) => expandTabs(line, this.tabWidth))
      .join('\n');
    try {
      return this.shiki
        .codeToTokensBase(expanded, { lang, theme })
        .map((line) => line.map((t) => ({ text: t.content, color: t.color })));
    } catch {
      return null;
    }
  }
}
