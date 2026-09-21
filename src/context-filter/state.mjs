/**
 * Only caller-supplied summaries and explicitly selected metadata leave here.
 * Do not copy arbitrary item fields: they may contain full bodies or history.
 */
export function buildFilterState({ task, item }) {
  const state = { task, item: {} };
  for (const key of ['id', 'kind', 'summary']) {
    if (typeof item[key] === 'string') state.item[key] = item[key];
  }
  return state;
}
