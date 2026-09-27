/**
 * Working out which branch you branched off.
 *
 * There is no git command for this — a branch does not record its parent — so
 * it has to be inferred. The signal that works is: among every other branch,
 * the base is the one you have diverged from *least*. Branch `feature/x` off
 * `develop` off `main`, and you are 1 commit from `develop` but 2 from `main`,
 * so `develop` wins. See `rankCandidates` for the full ordering.
 */

/** Conventional trunk names, used only to break ties. */
const CONVENTIONAL = ['main', 'master', 'develop', 'dev', 'trunk', 'default'];

export interface Candidate {
  /** Short ref name, e.g. `develop` or `origin/develop`. */
  name: string;
  isRemote: boolean;
  /** Commits in HEAD but not in this ref — how far I have diverged. */
  ahead: number;
  /** Commits in this ref but not in HEAD — how far it has moved on. */
  behind: number;
}

export interface RankedBase extends Candidate {
  /** Why this one won, for showing the user. */
  reason: string;
}

/**
 * Is this ref shaped like a base branch at all? The remote's default branch
 * and the conventional trunk names are; a feature branch is not.
 *
 * This matters because "nearest fork" alone finds *children* when you are
 * sitting on a trunk: on `develop`, the branch you diverged from least is
 * whichever feature branch was cut most recently, which is the opposite of a
 * base. Preferring base-shaped refs outright fixes that, and costs nothing in
 * the normal case because `main` and `develop` are both base-shaped, so
 * distance still decides between them.
 */
export function isBaseShaped(name: string, defaultBranch: string | null): boolean {
  if (defaultBranch && (name === defaultBranch || name === stripRemote(defaultBranch))) return true;
  return CONVENTIONAL.includes(stripRemote(name));
}

function stripRemote(name: string): string {
  const slash = name.indexOf('/');
  return slash < 0 ? name : name.slice(slash + 1);
}

/**
 * A branch and its remote-tracking copy are one logical branch, and either can
 * be the closer fork point — a stale local `develop` against a current
 * `origin/develop`, or the reverse. Keep whichever forked nearer to HEAD, and
 * on a tie prefer the local name, because `develop` reads better than
 * `origin/develop` for an identical diff.
 */
function collapseRemoteCopies(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = stripRemote(candidate.name);
    const held = best.get(key);
    if (!held || candidate.ahead < held.ahead || (candidate.ahead === held.ahead && !candidate.isRemote)) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
}

/**
 * Pick the most plausible base from candidates already measured against HEAD.
 *
 * Ordering, in priority order:
 *  1. Base-shaped refs first — see `isBaseShaped`. Only if there are none does
 *     an ordinary branch get considered, which keeps teams whose base is
 *     `release/x` or `integration` working.
 *  2. Fewest commits of mine since the fork. The branch I left most recently
 *     is the branch I branched off, which is why `develop` beats `main` when
 *     I forked from `develop`.
 *  3. Prefer a ref that is still an ancestor of HEAD. This separates a base
 *     from a sibling branch that forked at the same commit — the base's tip is
 *     behind me, the sibling's is not. It ranks *below* distance, because a
 *     base that has moved on since I forked stops being an ancestor and is
 *     still the base.
 *  4. The remote's default branch, then local before remote, then the shorter
 *     name: cosmetic, but deterministic.
 */
export function rankCandidates(candidates: Candidate[], defaultBranch: string | null): RankedBase | null {
  // `ahead === 0` means HEAD is fully contained in the candidate, so it is a
  // child branch or the same commit — never something to diff against.
  const usable = collapseRemoteCopies(candidates.filter((c) => c.ahead > 0));
  if (!usable.length) return null;

  const rank = (c: Candidate) => ({
    tier: isBaseShaped(c.name, defaultBranch) ? 0 : 1,
    ahead: c.ahead,
    ancestor: c.behind === 0 ? 0 : 1,
    isDefault: defaultBranch && stripRemote(c.name) === stripRemote(defaultBranch) ? 0 : 1,
    remote: c.isRemote ? 1 : 0,
    length: c.name.length,
  });

  const sorted = [...usable].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return (
      ra.tier - rb.tier ||
      ra.ahead - rb.ahead ||
      ra.ancestor - rb.ancestor ||
      ra.isDefault - rb.isDefault ||
      ra.remote - rb.remote ||
      ra.length - rb.length ||
      a.name.localeCompare(b.name)
    );
  });

  const winner = sorted[0]!;
  const commits = `${winner.ahead} commit${winner.ahead === 1 ? '' : 's'} ahead`;
  const moved = winner.behind === 0 ? '' : `, ${winner.behind} behind`;
  return { ...winner, reason: `${commits}${moved}` };
}

/** Refs that can never be the base of the branch you are on. */
export function isPlausibleBase(name: string, currentBranch: string): boolean {
  if (name === currentBranch) return false;
  // A remote-tracking copy of the branch I am on: diffing against it shows
  // unpushed commits, which is a different question entirely.
  if (name.endsWith(`/${currentBranch}`)) return false;
  return !name.endsWith('/HEAD');
}
