/**
 * Only caller-supplied summaries and explicitly selected metadata leave here.
 * Do not copy arbitrary item fields: they may contain full bodies or history.
 *
 * The item's id stays behind. Nothing reads it — no predicate, and not the
 * question the policy asks, which names kind and summary — and one call judges
 * one item, so it has no addressing role either. An id is often a file path,
 * and the routing state next door sends a count of relevant files rather than
 * their names for that reason. A later policy wanting the path as evidence
 * should say so with a field and a predicate that read it.
 */
export function buildFilterState({ task, item }) {
  const state = { task, item: {} };
  for (const key of ['kind', 'summary']) {
    if (typeof item[key] === 'string') state.item[key] = item[key];
  }
  return state;
}
