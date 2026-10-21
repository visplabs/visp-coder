const REVIEWED_KEY = "visp-ui-reviewed";

/**
 * Reviewed ticks on the Map tab, for this browser only. Each tick keeps the digest of the code it
 * was given for, so a later change shows as changed rather than as still reviewed. VISP never
 * reads them.
 */
export function readReviewed(): Record<string, Record<string, string>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Record<string, string>>)
      : {};
  } catch {
    return {};
  }
}

export function writeReviewed(reviewed: Record<string, Record<string, string>>): void {
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewed));
  } catch {
    // Without storage the ticks last until the page is closed.
  }
}
