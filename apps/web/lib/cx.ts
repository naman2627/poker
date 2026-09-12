/** Joins class names, dropping anything falsy. Small on purpose. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
