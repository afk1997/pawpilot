/**
 * Indian city aliases — map colloquial / pre-rename names to the canonical
 * spelling used in the directory.
 *
 * Real pilot: a reporter asked for Bangalore; the directory has Bengaluru;
 * Levenshtein distance is 3, above the typo-fuzzy threshold of 2, so the
 * lookup returned no match. Renames are not typos — they need explicit aliasing.
 *
 * Direction: colloquial → canonical. Apply on both query and row sides so the
 * match is symmetric (legacy rows saved with old names also resolve).
 *
 * Maintained by hand. Extend as the pilot reveals more.
 */

const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru",
  bombay: "mumbai",
  madras: "chennai",
  calcutta: "kolkata",
  mysore: "mysuru",
  mangalore: "mangaluru",
  gurgaon: "gurugram",
  baroda: "vadodara",
  cochin: "kochi",
  trivandrum: "thiruvananthapuram",
  pondicherry: "puducherry",
  poona: "pune",
  vizag: "visakhapatnam",
  belgaum: "belagavi",
  hubli: "hubballi",
  allahabad: "prayagraj",
  benares: "varanasi",
  banaras: "varanasi",
};

/**
 * Replace any aliased city name in `s` (already lowercased + space-normalized)
 * with its canonical form. Per-token so compound queries like
 * "bangalore indiranagar" resolve to "bengaluru indiranagar".
 */
export function applyCityAliases(s: string): string {
  return s
    .split(" ")
    .map((token) => CITY_ALIASES[token] ?? token)
    .join(" ");
}
