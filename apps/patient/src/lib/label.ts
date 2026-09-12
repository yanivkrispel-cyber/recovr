/** English subtitle to render under a Hebrew label. Returns null when it would
 *  just repeat the primary — the exercise library has no Hebrew names yet, so
 *  ingested rows carry name === name_en. */
export function secondaryLabel(primary: string, secondary?: string | null): string | null {
  const s = secondary?.trim();
  return s && s !== primary.trim() ? s : null;
}
