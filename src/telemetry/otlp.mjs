/**
 * OTLP/JSON receiver for Claude Code's own telemetry.
 *
 * Claude Code exports `claude_code.token.usage` and `claude_code.cost.usage` with
 * a `query_source` attribute of main, subagent or auxiliary — which is the only
 * way to separate the main session's token and cache behaviour from its workers'.
 * That separation is the cache-locality hypothesis, so it is worth receiving.
 *
 * Only OTLP over http/json is accepted, deliberately: parsing protobuf would mean
 * a dependency, and the JSON protocol is a supported exporter setting
 * (OTEL_EXPORTER_OTLP_PROTOCOL=http/json).
 */

const METRIC_NAMES = {
  'claude_code.token.usage': 'token',
  'claude_code.cost.usage': 'cost',
};

/** OTLP encodes attribute values as a tagged union. */
function attributeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('boolValue' in value) return value.boolValue;
  return null;
}

function attributes(list) {
  const out = {};
  for (const entry of list ?? []) {
    if (typeof entry?.key === 'string') out[entry.key] = attributeValue(entry.value);
  }
  return out;
}

function pointValue(point) {
  if (point.asDouble !== undefined) return Number(point.asDouble);
  if (point.asInt !== undefined) return Number(point.asInt);
  return null;
}

/**
 * Turn an OTLP ExportMetricsServiceRequest into counter observations.
 * Returns the rows to upsert; cumulative semantics are handled by the store.
 */
export function parseMetrics(payload) {
  const rows = [];
  for (const resource of payload?.resourceMetrics ?? []) {
    const resourceAttributes = attributes(resource.resource?.attributes);
    for (const scope of resource.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        const kind = METRIC_NAMES[metric.name];
        if (!kind) continue;
        const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        for (const point of points) {
          const value = pointValue(point);
          if (value === null) continue;
          const attrs = { ...resourceAttributes, ...attributes(point.attributes) };
          rows.push({
            metric: kind,
            sessionId: attrs['session.id'] ?? null,
            model: attrs.model ?? null,
            querySource: attrs.query_source ?? 'main',
            tokenType: kind === 'token' ? attrs.type ?? null : null,
            agentName: attrs['agent.name'] ?? null,
            value,
          });
        }
      }
    }
  }
  return rows;
}

/**
 * Logs are accepted and acknowledged but not stored. Claude Code's event payloads
 * can carry prompt and tool content, and this database is not a place for either.
 */
export function parseLogs() {
  return [];
}

export function ingestMetrics(store, payload) {
  const rows = parseMetrics(payload);
  for (const row of rows) store.recordOtelCounter(row);
  return rows.length;
}
