/**
 * Date Repair & Normalization Utility
 * Strictly preserves the original year without any modification when day and month are exchanged.
 */

export function fixSwappedDateOrFormat(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  if (!str) return '';

  const pad2 = (n: number) => String(n).padStart(2, '0');

  // Split by common date separators (-, /, .)
  const parts = str.split(/[-/.]/).map(p => p.trim());

  if (parts.length === 3) {
    const n0 = parseInt(parts[0], 10);
    const n1 = parseInt(parts[1], 10);
    const n2 = parseInt(parts[2], 10);

    // Case 1: First part is a 4-digit Year (e.g., 2026-28-04, 2025/18/03, 2023-31-10)
    if (n0 >= 1000 && n0 <= 9999) {
      const year = n0; // Strictly preserve original year without defect!
      const p1 = n1;
      const p2 = n2;

      // If middle part is > 12 and third part is <= 31: day and month were exchanged!
      // Example: 2026-28-04 -> month is 04, day is 28
      if (p1 > 12 && p2 >= 1 && p2 <= 12) {
        return `${year}-${pad2(p2)}-${pad2(p1)}`;
      }

      // If middle part is <= 12 and third part is <= 31 (standard YYYY-MM-DD)
      if (p1 >= 1 && p1 <= 12 && p2 >= 1 && p2 <= 31) {
        return `${year}-${pad2(p1)}-${pad2(p2)}`;
      }

      // If both <= 12 or edge cases, clamp month to 1-12 and day to 1-31 but keep exact year
      const safeMonth = Math.min(12, Math.max(1, isNaN(p1) ? 1 : p1));
      const safeDay = Math.min(28, Math.max(1, isNaN(p2) ? 1 : p2));
      return `${year}-${pad2(safeMonth)}-${pad2(safeDay)}`;
    }

    // Case 2: Third part is a 4-digit Year (e.g., 28-04-2026, 04/28/2026, 31/12/2023)
    if (n2 >= 1000 && n2 <= 9999) {
      const year = n2; // Strictly preserve original year without defect!
      const p0 = n0;
      const p1 = n1;

      // If first part is > 12 and second is <= 12: DD-MM-YYYY (day and month)
      if (p0 > 12 && p1 >= 1 && p1 <= 12) {
        return `${year}-${pad2(p1)}-${pad2(p0)}`;
      }

      // If first part is <= 12 and second is > 12: MM-DD-YYYY
      if (p0 >= 1 && p0 <= 12 && p1 > 12) {
        return `${year}-${pad2(p0)}-${pad2(p1)}`;
      }

      // If both <= 12 (e.g. 05-04-2026)
      if (p0 >= 1 && p0 <= 12 && p1 >= 1 && p1 <= 31) {
        return `${year}-${pad2(p0)}-${pad2(p1)}`;
      }

      const safeMonth = Math.min(12, Math.max(1, isNaN(p0) ? 1 : p0));
      const safeDay = Math.min(28, Math.max(1, isNaN(p1) ? 1 : p1));
      return `${year}-${pad2(safeMonth)}-${pad2(safeDay)}`;
    }

    // Case 3: 2-digit year at end (e.g., 28-04-26 or 04/28/26)
    if (parts[2].length === 2 && n2 >= 0 && n2 < 100) {
      const year = 2000 + n2; // 26 -> 2026, preserves exact year from 2-digit shorthand
      if (n0 > 12 && n1 <= 12) {
        return `${year}-${pad2(n1)}-${pad2(n0)}`;
      }
      return `${year}-${pad2(n0)}-${pad2(n1)}`;
    }
  }

  // Fallback: check if a 4-digit year is present anywhere in the string
  const yearMatch = str.match(/\b(19\d\d|20\d\d)\b/);
  const parsed = Date.parse(str.replace(/\//g, '-'));
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    // If original string had a 4-digit year, never let Date timezone skew it
    const yr = yearMatch ? parseInt(yearMatch[0], 10) : d.getUTCFullYear();
    const mo = pad2(d.getUTCMonth() + 1);
    const da = pad2(d.getUTCDate());
    return `${yr}-${mo}-${da}`;
  }

  if (yearMatch) {
    return `${yearMatch[0]}-01-01`;
  }

  return str;
}
