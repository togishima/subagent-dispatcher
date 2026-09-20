/**
 * Diagnostics go to stderr only. An MCP server owns stdout for the protocol, so
 * anything written there would corrupt the transport.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.JEV_DISPATCH_LOG_LEVEL] ?? LEVELS.info;

/** Keys whose values must never reach a log line or the telemetry database. */
const SECRET_KEY = /(^|_)(api[-_]?key|apikey|token|secret|password|passwd|credential|authorization|auth|bearer|cookie|session[-_]?token)($|_)/i;

/** Redact secret-looking values from an object before it is logged. */
export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

function emit(level, message, detail) {
  if (LEVELS[level] > threshold) return;
  const line = { ts: new Date().toISOString(), level, message };
  if (detail !== undefined) line.detail = redact(detail);
  process.stderr.write(`[jev-dispatch] ${JSON.stringify(line)}\n`);
}

export const log = {
  error: (message, detail) => emit('error', message, detail),
  warn: (message, detail) => emit('warn', message, detail),
  info: (message, detail) => emit('info', message, detail),
  debug: (message, detail) => emit('debug', message, detail),
};
