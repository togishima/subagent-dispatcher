/**
 * Adapt legacy config arguments while callers migrate to explicit policy options.
 * These defaults belong to the legacy config, not the generic policy API.
 * Remove this adapter once all callers pass explicit policy options.
 */
export function policyOptions(options) {
  if (!options?.tiers || options.values !== undefined) return options;
  const values = Object.entries(options.tiers)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([name]) => name);
  return {
    values,
    fallback: values[Math.min(1, values.length - 1)],
    graph: options.routing?.policyGraph?.graph,
    path: options.routing?.policyGraph?.path,
    configDir: options.$configDir,
  };
}
