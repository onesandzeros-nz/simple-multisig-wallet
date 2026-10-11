/**
 * Splits the keys offered for a group wallet into the ones other members
 * shared and the ones on this phone, keeping each group's original order.
 * The Configure keys screen shows them apart — members' keys first, ours
 * below — so our own keys never get lost among everyone else's.
 */
export function splitKeyCandidates<T extends { mine: boolean }>(candidates: T[]): { remote: T[]; local: T[] } {
  return {
    remote: candidates.filter((c) => !c.mine),
    local: candidates.filter((c) => c.mine),
  };
}
