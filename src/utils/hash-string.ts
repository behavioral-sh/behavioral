/**
 * Canonical masked djb2 over a raw string — the provenance source hash.
 *
 * The accumulator is masked to 32 bits (`>>> 0`) on every step, so the
 * result matches textbook djb2 implementations in every language (the
 * unmasked f64 accumulator silently drops low bits past ~50 chars and
 * diverges from every canonical implementation). Deterministic and
 * trivially reimplementable (e.g. the Blackwell-side Python tooling that
 * recomputes source hashes to join eval rows on provenance).
 *
 * MINIMAL: 32-bit djb2, not sha256 — provenance is identity/association,
 * not a security boundary (admission rides the registry's content hash +
 * ThreadSchema); the birthday bound is irrelevant at dozens-of-plugins
 * scale. Upgrade path: swap in sha256 if provenance ever becomes a trust
 * boundary.
 *
 * The caller owns the canonical input form: this util takes raw strings —
 * path normalization (trailing slashes, case, symlinks) lives with the
 * caller, which pins the canonical source string before hashing.
 *
 * @returns the 32-bit hash — always a number. Non-empty validation of the
 * source string belongs to the caller (the plugin collision pass enforces
 * it); an empty string hashes to the seed (5381).
 */
export const hashString = (str: string): number => {
  const hash = [...str].reduce<number>((acc, cur) => ((acc << 5) + acc + cur.charCodeAt(0)) >>> 0, 5381)
  return hash
}
