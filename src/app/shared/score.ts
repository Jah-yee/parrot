/** The colour band of a score: 90+ good, 70+ warn, below that bad. */
export function band(score: number | null | undefined): 'good' | 'warn' | 'bad' | '' {
  if (score == null) return '';
  return score >= 90 ? 'good' : score >= 70 ? 'warn' : 'bad';
}
