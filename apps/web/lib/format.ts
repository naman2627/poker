/**
 * Chip counts are money-shaped but never money: play chips, always whole units.
 * See CLAUDE.md §5.
 */
export function chips(amount: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(amount);
}

/** Whole seconds, rounded up, so "1s" is shown right up to zero. */
export function secondsLeft(deadlineTs: number, now: number): number {
  return Math.max(0, Math.ceil((deadlineTs - now) / 1000));
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || '?';
}
