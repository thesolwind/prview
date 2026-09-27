/**
 * Approximations of GitHub's diff surfaces, flattened for opaque terminals.
 *
 * Surface colours are only ever applied to changed lines and the hunk/status
 * furniture; context lines and the page keep the terminal's own background,
 * which is what makes these feel native rather than like an app that has
 * seized the screen.
 */
export interface Theme {
  /** shiki theme id, so code is highlighted with GitHub's own token colours. */
  shikiTheme: string;

  addBg: string;
  delBg: string;
  addEmph: string;
  delEmph: string;

  gutter: string;
  gutterActive: string;
  hunkBg: string;
  hunkFg: string;

  plain: string;
  dim: string;
  border: string;
  accent: string;

  cursorBg: string;

  noteBg: string;
  noteFg: string;

  addSign: string;
  delSign: string;
}

export const dark: Theme = {
  shikiTheme: 'github-dark',
  addBg: '#12261a',
  delBg: '#26171c',
  addEmph: '#1c4428',
  delEmph: '#5c2126',
  gutter: '#6e7681',
  gutterActive: '#c9d1d9',
  hunkBg: '#161b22',
  hunkFg: '#8b949e',
  plain: '#c9d1d9',
  dim: '#6e7681',
  border: '#30363d',
  accent: '#58a6ff',
  cursorBg: '#1f2733',
  noteBg: '#1c2333',
  noteFg: '#d2a8ff',
  addSign: '#3fb950',
  delSign: '#f85149',
};

export const light: Theme = {
  shikiTheme: 'github-light',
  addBg: '#e6ffec',
  delBg: '#ffebe9',
  addEmph: '#abf2bc',
  delEmph: '#ffc1c0',
  gutter: '#8c959f',
  gutterActive: '#24292f',
  hunkBg: '#f6f8fa',
  hunkFg: '#57606a',
  plain: '#24292f',
  dim: '#8c959f',
  border: '#d0d7de',
  accent: '#0969da',
  cursorBg: '#eaeef2',
  noteBg: '#f3effc',
  noteFg: '#8250df',
  addSign: '#1a7f37',
  delSign: '#cf222e',
};
