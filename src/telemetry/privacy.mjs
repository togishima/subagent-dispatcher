import { sha256 } from '../util/ids.mjs';

/**
 * Privacy rules for the telemetry database.
 *
 * The store holds what an experiment needs to be analysed — tiers, predicates,
 * confidences, verdicts, cost — and not the work itself. Prompts, code, diffs and
 * command output never land in a column by default.
 */

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /(?:Bearer|Authorization|token|api[_-]?key|password|secret)\s*[:=]\s*\S+/gi,
];

export function redactText(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * A short, single-line, secret-free label for a task. Enough to recognise a row
 * in the timeline; not enough to reconstruct the work.
 */
export function sanitizeTitle(task, config) {
  if (!config.telemetry.storeTitles) return null;
  const firstLine = String(task ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#')) ?? '';
  const cleaned = redactText(firstLine)
    .replace(/[`*_>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = config.telemetry.titleMaxLength ?? 80;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned || null;
}

export const taskHash = (task) => sha256(String(task ?? ''));

/** Raw task text, only when debug capture has been explicitly turned on. */
export function rawTaskIfEnabled(task, config) {
  if (!config.telemetry.debugStoreRawInput) return null;
  return redactText(task).slice(0, 20_000);
}

/**
 * Verification output is command output — it can contain source code, so only a
 * structured summary is stored, never the text itself.
 */
export function safeVerificationDetail(summary) {
  return JSON.stringify({
    verdict: summary.verdict,
    reason: redactText(summary.reason ?? '').slice(0, 300),
    checks: summary.checks ?? [],
  });
}

/** A failure detail line: truncated hard and redacted. */
export function safeFailureDetail(detail) {
  if (!detail) return null;
  return redactText(detail).replace(/\s+/g, ' ').slice(0, 500);
}
