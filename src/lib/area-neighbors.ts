/**
 * Geographic-neighbor map for areas we don't directly cover.
 *
 * Real pilot: a reporter in Goregaon (Mumbai) was told "we don't run there"
 * even though Malad — literally the next suburb, ~3km — is in our directory.
 * Hardcode adjacencies for the most-trafficked clusters. When the directory
 * lookup returns 0, try the input's neighbors before falling back to
 * "out of coverage".
 *
 * Maintained by hand. ~30 entries. Keep small — neighbors are bidirectional.
 * Extend as the pilot reveals more gaps.
 */

const NEIGHBOR_MAP: Record<string, string[]> = {
  // Mumbai
  goregaon: ["malad", "andheri"],
  bandra: ["khar", "andheri"],
  khar: ["bandra", "santacruz"],
  santacruz: ["khar", "vile parle", "andheri"],
  "vile parle": ["santacruz", "andheri"],
  juhu: ["andheri", "vile parle", "santacruz"],
  jogeshwari: ["andheri", "goregaon"],
  lokhandwala: ["andheri"],
  kurla: ["ghatkopar", "chembur"],
  vikhroli: ["ghatkopar", "mulund"],
  bhandup: ["mulund", "vikhroli"],
  nahur: ["mulund", "bhandup"],
  thane: ["mulund", "dombivali"],
  kalwa: ["thane"],
  kalyan: ["dombivali"],
  matunga: ["dadar", "wadala"],
  worli: ["dadar", "tardeo"],
  "lower parel": ["tardeo", "dadar"],
  prabhadevi: ["dadar"],
  parel: ["dadar"],
  sion: ["dadar", "wadala"],
  // Pune
  kothrud: ["pcmc"],
  warje: ["pcmc"],
  shivajinagar: ["pmc", "pcmc"],
  kasba: ["pmc"],
  hadapsar: ["pmc"],
  kharadi: ["pmc"],
  viman: ["pmc"],
  // Delhi NCR
  noida: ["delhi"],
  faridabad: ["delhi"],
  ghaziabad: ["delhi"],
  // Common Mumbai suburb spellings
  bhayender: ["mira road", "bhayandar"],
  vasai: ["bhayandar"],
  virar: ["bhayandar"],
};

/**
 * Given a location query (lowercased, normalized), return ordered candidate
 * neighbors that we *might* have ambulance coverage in.
 */
export function neighborCandidates(query: string): string[] {
  const q = query.toLowerCase().trim();
  // Exact key hit
  if (NEIGHBOR_MAP[q]) return NEIGHBOR_MAP[q];
  // Token contains a known neighbor key (e.g. "goregaon east")
  for (const key of Object.keys(NEIGHBOR_MAP)) {
    if (q.includes(key)) return NEIGHBOR_MAP[key];
  }
  return [];
}
