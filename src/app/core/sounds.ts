/** A word's letters grouped into the units that spell one sound, each with how surely it was heard. */
export interface SoundUnit {
  text: string;
  /** 0-1, the best of its letters (the aligner credits a sound to one of the letters that spell it) */
  score: number | null;
  level: 'good' | 'warn' | 'bad' | 'none';
}

/** consonant pairs spoken as one sound, or with one letter silent */
const PAIRS = new Set(['th', 'sh', 'ch', 'ph', 'wh', 'gh', 'ck', 'ng', 'qu', 'kn', 'wr', 'gn', 'mb', 'dg']);
const VOWEL = /[aeiou]/;

/** Below these a unit sounds off (amber) or wrong (red); set from real takes, where a clearly said sound scores
 * 0.9 or more and a sound said as another one under 0.1. */
export const WARN_BELOW = 0.5;
export const BAD_BELOW = 0.2;

export function level(score: number | null): SoundUnit['level'] {
  if (score == null) return 'none';
  return score < BAD_BELOW ? 'bad' : score < WARN_BELOW ? 'warn' : 'good';
}

/**
 * Group a word ("night") and its per-character scores into sound units ("n", "igh", "t"): vowel teams (with a y, w
 * or gh after them), consonant pairs like th and ng, double letters, and a silent final e with the letter before it.
 * Characters that are not letters are left out.
 */
export function soundUnits(word: string, letters: (number | null)[]): SoundUnit[] {
  const chars = [...word].map((c, i) => ({ c, s: letters[i] ?? null })).filter((x) => /\p{L}|'/u.test(x.c) && x.c !== "'");
  const units: { text: string; scores: (number | null)[] }[] = [];
  const low = (k: number) => chars[k]?.c.toLowerCase() ?? '';
  for (let k = 0; k < chars.length; ) {
    let n = 1;
    if (VOWEL.test(low(k))) {
      while (VOWEL.test(low(k + n))) n++;
      if (low(k + n) === 'g' && low(k + n + 1) === 'h') n += 2;
      else if (/[yw]/.test(low(k + n)) && !VOWEL.test(low(k + n + 1))) n++;
    } else if (PAIRS.has(low(k) + low(k + 1)) || (low(k) === low(k + 1) && low(k) !== '')) {
      n = 2;
    }
    // a final e after a consonant is silent: it goes with the sound before it ("paste": p, a, s, te)
    if (k + n === chars.length - 1 && low(k + n) === 'e' && !VOWEL.test(low(k + n - 1)) && chars.length > 2 && units.length > 0) n++;
    const part = chars.slice(k, k + n);
    units.push({ text: part.map((x) => x.c).join(''), scores: part.map((x) => x.s) });
    k += n;
  }
  return units.map((u) => {
    const known = u.scores.filter((s): s is number => s != null);
    const score = known.length ? Math.max(...known) : null;
    return { text: u.text, score, level: level(score) };
  });
}
