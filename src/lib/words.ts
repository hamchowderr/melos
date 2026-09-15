/** A stored code as words: `sounds_like` → `Sounds like`. Display only. */
export const words = (code: string) =>
  code.charAt(0).toUpperCase() + code.slice(1).replaceAll('_', ' ');
