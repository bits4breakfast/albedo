/**
 * Fuzzy matching for the quick-open palette. Pure; no DOM, no React.
 *
 * The model is fzf's: the query must appear in the candidate as a
 * case-insensitive subsequence, and among the ways it can, the best-scoring
 * alignment wins. Scoring rewards what a person means when they type a few
 * letters of a name -- the start of a word, a CamelCase hump, a run of letters
 * that sit together -- and charges for the gaps between them. That is what lets
 * `mprt` find `McpParameterRestrictionTest` ahead of a file that merely
 * contains an m, a p, an r and a t somewhere.
 *
 * ## Why a DP and not a greedy scan
 *
 * Greedy (take each query letter at its first occurrence) picks the wrong `p`
 * in `McpParameter`: the one inside `Mcp`, not the hump. The alignment that
 * scores best is usually not the leftmost one, and finding it needs the whole
 * table. The table is only built for candidates that already passed a cheap
 * subsequence check, which at realistic queries rejects the vast majority, so
 * ~50k candidates per keystroke stays in single-digit milliseconds.
 *
 * ## Paths
 *
 * `matchPath` tries the basename first and only falls back to the whole path
 * when the basename cannot match. A basename hit always outranks a path-only
 * hit: typing `terminal` wants `Terminal.tsx`, not every file under a
 * `terminal/` directory. A query containing `/` is a path query by
 * construction and goes straight to the whole path.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate of each matched character, ascending. */
  indices: number[];
}

// fzf's constants, near enough. Only the ratios matter.
const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
/**
 * The most a single gap can cost. fzf charges without limit, which makes
 * `mprt` highlight `ResT` in `McpParameterRestrictionTest` -- two letters on is
 * cheaper than the hump eight letters on. In identifiers the hump is what was
 * meant, so past a short distance every gap costs the same and the bonus
 * decides.
 */
const GAP_MAX = GAP_START + 3 * GAP_EXTENSION;
/** Start of the string, or after `/`. */
const BONUS_START = 10;
/** After `_ - . space` and other punctuation. */
const BONUS_BOUNDARY = 8;
/** A CamelCase hump, or a letter-to-digit step. */
const BONUS_CAMEL = 7;
/** Floor for a character that continues a run. Equals the cost of a gap. */
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION);
/**
 * Per character, when EVERY query character landed on a word start or hump.
 *
 * The DP alone scores `mprt` against `MockProductAnalyticsTracker` (M, P, the
 * `r` right after it, T) above `McpParameterRestrictionTest` (M, P, R, T),
 * because a consecutive mid-word letter is nearly as good as a hump and costs
 * no gap. But a query that is an exact acronym of a name is the strongest
 * signal there is of which name was meant -- it is how PhpStorm users type --
 * so it gets a bonus the near-miss cannot.
 */
const BONUS_ACRONYM = 4;
/** The first query character carries extra weight: where you start matters most. */
const FIRST_CHAR_MULTIPLIER = 2;

/** Every basename hit beats every path-only hit, whatever their raw scores. */
export const BASENAME_TIER = 100_000;

/** Queries past this are truncated: nobody types 64 letters into a palette. */
const MAX_QUERY = 64;
/** Candidates past this are not worth a table; they do not occur in practice. */
const MAX_CANDIDATE = 1024;

const NEG = -1_000_000_000;

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}
function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isAlnum(ch: string): boolean {
  return isUpper(ch) || isLower(ch) || isDigit(ch) || ch > '\x7f';
}

/** The bonus for matching at `j`, read from the ORIGINAL-case candidate. */
function bonusAt(text: string, j: number, from: number): number {
  if (j === from) return BONUS_START;
  const prev = text[j - 1]!;
  const cur = text[j]!;
  if (prev === '/') return BONUS_START;
  if (!isAlnum(prev)) return isAlnum(cur) ? BONUS_BOUNDARY : 0;
  if (isLower(prev) && isUpper(cur)) return BONUS_CAMEL;
  if (!isDigit(prev) && isDigit(cur)) return BONUS_CAMEL;
  // The last capital of an acronym that starts a word: the `S` in `HTTPServer`.
  if (isUpper(prev) && isUpper(cur) && j + 1 < text.length && isLower(text[j + 1]!)) return BONUS_CAMEL;
  return 0;
}

/** Lowercase that never changes the length: a character that would grow stays as is. */
export function lowerSameLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** Normalise what the user typed: lowercase, no whitespace. */
export function normaliseQuery(query: string): string {
  return query.replace(/\s+/g, '').toLowerCase().slice(0, MAX_QUERY);
}

// Scratch tables, grown on demand and reused across calls. One palette runs at
// a time, so sharing them is safe and saves ~50k allocations per keystroke.
let scoreBuf = new Int32Array(0);
let fromBuf = new Int32Array(0);
let chunkBuf = new Int32Array(0);
let bonusBuf = new Int32Array(0);

function ensure(size: number, width: number): void {
  if (scoreBuf.length < size) {
    scoreBuf = new Int32Array(size * 2);
    fromBuf = new Int32Array(size * 2);
    chunkBuf = new Int32Array(size * 2);
  }
  if (bonusBuf.length < width) bonusBuf = new Int32Array(width * 2);
}

/** Is `q` a subsequence of `lower[from..]`? The cheap reject that runs first. */
function isSubsequence(q: string, lower: string, from: number): boolean {
  let j = from;
  for (let i = 0; i < q.length; i++) {
    j = lower.indexOf(q[i]!, j);
    if (j === -1) return false;
    j++;
  }
  return true;
}

/**
 * Match a normalised query against `text[from..]`.
 *
 * `lower` must be `text.toLowerCase()` -- callers pre-compute it once per
 * candidate, because lowercasing 50k strings per keystroke is most of the cost
 * a naive implementation pays. Returned indices are into `text`, not relative
 * to `from`.
 */
export function fuzzyMatch(q: string, text: string, lower: string, from = 0): FuzzyMatch | null {
  // A few characters lowercase to two (`İ`), which would misalign every index
  // after them. Rare enough to rebuild rather than slow the common path.
  if (lower.length !== text.length) lower = lowerSameLength(text);
  const n = q.length;
  if (n === 0) return { score: 0, indices: [] };
  const m = text.length - from;
  if (m < n || m > MAX_CANDIDATE) return null;
  if (!isSubsequence(q, lower, from)) return null;

  ensure(n * m, m);
  for (let j = 0; j < m; j++) bonusBuf[j] = bonusAt(text, j + from, from);

  for (let i = 0; i < n; i++) {
    const qc = q[i]!;
    const row = i * m;
    const prev = row - m;
    // Best M[i-1][k] for k <= j-2, charged for the j-1-k characters skipped:
    // `decay` grows its charge per step, `capped` is everything charged GAP_MAX.
    let decay = NEG;
    let decayFrom = -1;
    let capped = NEG;
    let cappedFrom = -1;
    let gapBest = NEG;
    let gapFrom = -1;
    for (let j = 0; j < m; j++) {
      if (i > 0 && j >= 2) {
        const k = j - 2;
        const s = scoreBuf[prev + k]!;
        decay = decay > NEG ? decay + GAP_EXTENSION : NEG;
        if (s > NEG) {
          if (s + GAP_START > decay) {
            decay = s + GAP_START;
            decayFrom = k;
          }
          if (s + GAP_MAX > capped) {
            capped = s + GAP_MAX;
            cappedFrom = k;
          }
        }
        if (decay >= capped) {
          gapBest = decay;
          gapFrom = decayFrom;
        } else {
          gapBest = capped;
          gapFrom = cappedFrom;
        }
      }
      if (j < i || lower.charCodeAt(j + from) !== qc.charCodeAt(0)) {
        scoreBuf[row + j] = NEG;
        continue;
      }
      const b = bonusBuf[j]!;
      if (i === 0) {
        scoreBuf[row + j] = SCORE_MATCH + b * FIRST_CHAR_MULTIPLIER;
        fromBuf[row + j] = -1;
        chunkBuf[row + j] = b;
        continue;
      }
      let best = NEG;
      let bestFrom = -1;
      let bestChunk = b;
      const consec = j > 0 ? scoreBuf[prev + j - 1]! : NEG;
      if (consec > NEG) {
        // A run keeps the bonus of the character that started it, so the whole
        // of `Param` scores like its hump, not like five mid-word letters.
        const cb = Math.max(chunkBuf[prev + j - 1]!, b, BONUS_CONSECUTIVE);
        best = consec + SCORE_MATCH + cb;
        bestFrom = j - 1;
        bestChunk = cb;
      }
      if (gapBest > NEG) {
        const s = gapBest + SCORE_MATCH + b;
        if (s > best) {
          best = s;
          bestFrom = gapFrom;
          bestChunk = b;
        }
      }
      scoreBuf[row + j] = best;
      fromBuf[row + j] = bestFrom;
      chunkBuf[row + j] = bestChunk;
    }
  }

  const last = (n - 1) * m;
  let bestJ = -1;
  let bestScore = NEG;
  for (let j = n - 1; j < m; j++) {
    const s = scoreBuf[last + j]!;
    if (s > bestScore) {
      bestScore = s;
      bestJ = j;
    }
  }
  if (bestJ < 0 || bestScore <= NEG) return null;

  const indices = new Array<number>(n);
  let j = bestJ;
  let acronym = n > 1;
  for (let i = n - 1; i >= 0; i--) {
    indices[i] = j + from;
    if (bonusBuf[j]! < BONUS_CAMEL) acronym = false;
    j = fromBuf[i * m + j]!;
  }
  return { score: acronym ? bestScore + BONUS_ACRONYM * n : bestScore, indices };
}

/**
 * Match against a path, preferring the basename. See the module comment.
 *
 * `lower` is `path.toLowerCase()`; `base` is the index where the basename
 * starts (one past the last `/`, or 0).
 */
export function matchPath(q: string, path: string, lower: string, base: number): FuzzyMatch | null {
  if (q.length === 0) return { score: 0, indices: [] };
  if (!q.includes('/') && base < path.length) {
    const hit = fuzzyMatch(q, path, lower, base);
    if (hit) return { score: hit.score + BASENAME_TIER, indices: hit.indices };
  }
  return fuzzyMatch(q, path, lower, 0);
}

/** Index where the basename of `path` starts. */
export function basenameStart(path: string): number {
  return path.lastIndexOf('/') + 1;
}

/**
 * Keeps the best `limit` items seen, ordered best-first.
 *
 * A full sort of every match is wasted work when a one-letter query matches
 * 40k symbols and only 100 are rendered. Insertion into a short sorted array
 * rejects most candidates with one comparison against the current worst.
 */
export class TopK<T> {
  readonly items: T[] = [];
  constructor(
    private readonly limit: number,
    /** Negative when `a` ranks ahead of `b`. */
    private readonly compare: (a: T, b: T) => number,
  ) {}

  /** Total offered, kept or not -- for a "showing 100 of N" note. */
  seen = 0;

  push(item: T): void {
    this.seen++;
    const items = this.items;
    if (items.length >= this.limit && this.compare(item, items[items.length - 1]!) >= 0) return;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(item, items[mid]!) < 0) hi = mid;
      else lo = mid + 1;
    }
    items.splice(lo, 0, item);
    if (items.length > this.limit) items.pop();
  }
}
