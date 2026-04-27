/**
 * Fuzzy matching of repository paths.
 *
 * Each scanned repository is identified by the absolute path
 * to its working tree. The "leaf" of that path is the bare
 * repository name (e.g. `pie` for `/home/u/src/pie`); the
 * full path is the rest. The matcher prioritises matches on
 * the leaf so users can type `pie` and not have to qualify it.
 *
 * Adapted from the devtree extension; kept self-contained so
 * pure-function unit tests can pin the ordering rules without
 * spinning up the full extension.
 */

function subsequenceMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function subsequenceScore(query: string, text: string): number {
  // Lower = better. Counts gaps between matched characters.
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchPos = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (lastMatchPos >= 0) score += ti - lastMatchPos - 1;
      lastMatchPos = ti;
      qi++;
    }
  }
  if (qi < q.length) return Infinity;
  return score;
}

/**
 * Identify the repository "leaf" from a full path: the last
 * non-empty path segment. Centralized so the matcher and any
 * UI display use the same definition.
 */
export function repoLeaf(repoPath: string): string {
  const parts = repoPath.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "";
}

/**
 * Return the candidates ordered best-first for `query`.
 *
 * Ordering:
 *   1. Exact match on the full path.
 *   2. Leaf prefix match (typing `pie` matches `…/pie`).
 *   3. Leaf subsequence match.
 *   4. Full-path subsequence match.
 *
 * Within a match kind, lower subsequence score wins, then
 * shorter leaf, then alphabetical order.
 */
export function fuzzyMatchRepos(query: string, repos: string[]): string[] {
  if (!query) return [...repos];
  const q = query.toLowerCase();

  type Scored = {
    repo: string;
    matchKind: number;
    leafScore: number;
    fullScore: number;
    leafLen: number;
  };

  const results: Scored[] = [];
  for (const repo of repos) {
    const leaf = repoLeaf(repo);
    const leafLower = leaf.toLowerCase();
    const repoLower = repo.toLowerCase();

    if (repoLower === q || leafLower === q) {
      results.push({
        repo,
        matchKind: 0,
        leafScore: 0,
        fullScore: 0,
        leafLen: leaf.length,
      });
      continue;
    }

    const leafIsPrefix = leafLower.startsWith(q);
    const leafMatches = leafIsPrefix || subsequenceMatch(q, leafLower);
    const fullMatches = !leafMatches && subsequenceMatch(q, repoLower);
    if (!leafMatches && !fullMatches) continue;

    const leafScore = leafMatches ? subsequenceScore(q, leafLower) : Infinity;
    const fullScore = fullMatches ? subsequenceScore(q, repoLower) : Infinity;
    const matchKind = leafIsPrefix ? 1 : leafMatches ? 2 : 3;

    results.push({
      repo,
      matchKind,
      leafScore,
      fullScore,
      leafLen: leaf.length,
    });
  }

  results.sort((a, b) => {
    if (a.matchKind !== b.matchKind) return a.matchKind - b.matchKind;
    if (a.leafScore !== b.leafScore) return a.leafScore - b.leafScore;
    if (a.leafLen !== b.leafLen) return a.leafLen - b.leafLen;
    if (a.fullScore !== b.fullScore) return a.fullScore - b.fullScore;
    return a.repo.localeCompare(b.repo);
  });

  return results.map((r) => r.repo);
}
