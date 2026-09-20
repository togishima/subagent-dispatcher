#!/usr/bin/env node
/**
 * Seed the telemetry database with synthetic delegations.
 *
 * This exists so the dashboard can be looked at, and its queries exercised,
 * without spending money on real workers. It writes through the same store API
 * the dispatcher uses, so anything it produces is shaped like real data.
 *
 * Usage: node --experimental-sqlite scripts/seed-demo.mjs [count]
 */
import { loadConfig, orderedTiers } from '../src/config/load.mjs';
import { TelemetryStore } from '../src/telemetry/store.mjs';
import { loadPolicy, semanticNodes } from '../src/policy/graph.mjs';
import { traverse } from '../src/policy/traverse.mjs';
import { resolveDispatch } from '../src/router/tier-policy.mjs';
import { newId } from '../src/util/ids.mjs';

const count = Number(process.argv[2]) || 60;
const baseConfig = loadConfig();
const store = new TelemetryStore(baseConfig);
const tiers = orderedTiers(baseConfig);
const topTier = tiers.at(-1);

// Deterministic pseudo-randomness, so a seeded database is reproducible.
let seed = 20260920;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const TASKS = [
  ['rename the helper getUser to fetchUser across the auth module', 'refactor'],
  ['add a unit test for the retry backoff in src/net/retry.ts', 'test'],
  ['sort imports in the components directory', 'refactor'],
  ['the session refresh returns 401 intermittently under load; find out why', 'investigate'],
  ['implement pagination on the projects list endpoint', 'implement'],
  ['fix the off-by-one in the pagination offset calculation', 'implement'],
  ['document the new webhook payload fields in docs/webhooks.md', 'docs'],
  ['migrate the users table to add a nullable deleted_at column', 'implement'],
  ['the worker pool deadlocks when the queue drains during a resize', 'investigate'],
  ['bump the version and update the changelog for 2.4.0', 'docs'],
  ['add rate limiting to the public search API', 'implement'],
  ['extract the duplicated date parsing into a shared utility', 'refactor'],
];

const ARMS = [
  { mode: 'fixed', fixedTier: topTier, router: 'fixed', share: 0.25 },
  { mode: 'jev-direct', router: 'jev-direct', share: 0.3 },
  { mode: 'policy-graph', router: 'policy-graph', share: 0.45 },
];

function armFor(value) {
  let acc = 0;
  for (const arm of ARMS) {
    acc += arm.share;
    if (value <= acc) return arm;
  }
  return ARMS.at(-1);
}

/**
 * Synthetic Jev answers: confident most of the time, deliberately shaky
 * sometimes. `yesBias` lets a predicate correlate with the state it is asked
 * about — a supplied plan really is more often an executable one — so the
 * dashboard has a legible shape to show. It is a simulation of a plausible
 * world, not evidence about the real one.
 */
function semanticAnswer(yesBias = 0.45) {
  const confidence = random() < 0.18 ? 0.5 + random() * 0.12 : 0.66 + random() * 0.33;
  const yes = random() < yesBias;
  const probability = yes ? confidence : 1 - confidence;
  return {
    result: yes ? 'yes' : 'no',
    probability,
    confidence,
    probabilities: { yes: probability, no: 1 - probability },
  };
}

const COST_BY_TIER = { low: 0.012, medium: 0.05, high: 0.21 };
const SUCCESS_BY_TIER = { low: 0.72, medium: 0.88, high: 0.94 };

let created = 0;
for (let i = 0; i < count; i += 1) {
  const arm = armFor(random());
  const config = {
    ...baseConfig,
    routing: { ...baseConfig.routing, mode: arm.mode, fixedTier: arm.fixedTier ?? baseConfig.routing.fixedTier },
  };
  store.config = config;

  const [task, taskType] = pick(TASKS);
  const taskId = newId();
  const sessionId = 'seed-session';

  // Callers vary in how much of the thinking they hand over, which is the point
  // of the specification view: complete briefs should route cheaper.
  const hasPlan = random() < 0.5;
  const specification = {
    hasPlan,
    planChars: hasPlan ? 300 + Math.round(random() * 1800) : 0,
    planDocumentCount: hasPlan && random() < 0.6 ? 1 : 0,
    hasAcceptanceCriteria: random() < (hasPlan ? 0.8 : 0.25),
    hasEditSites: random() < (hasPlan ? 0.85 : 0.4),
    hasConstraints: random() < 0.35,
    hasExpectedOutput: random() < 0.7,
  };
  const verificationAvailable = random() < 0.7;
  store.openDelegation({ taskId, sessionId, task, taskType, specification, verificationAvailable });

  const policy = arm.mode === 'policy-graph' ? loadPolicy(baseConfig) : null;
  const semantic = policy ? semanticNodes(policy) : [];

  let escalatedTo = null;
  let escalated = false;
  let attempt = 0;
  let outcome = null;
  let lastTier = null;
  let lastWorker = null;
  let frontierUsed = false;
  let unverified = false;

  while (attempt < baseConfig.escalation.maxAttemptsPerTask) {
    attempt += 1;
    let decision;

    if (arm.mode === 'policy-graph') {
      const answers = {};
      for (const node of semantic) {
        // A caller who wrote a plan usually wrote a followable one.
        const bias = node.id === 'plan_is_executable' ? (specification.hasPlan ? 0.78 : 0.2) : 0.45;
        answers[node.id] = semanticAnswer(bias);
      }
      const walk = traverse(
        policy,
        { task, verificationAvailable, attempt, specification },
        answers,
        baseConfig.routing.policyGraph,
      );
      const confidences = walk.trail
        .filter((step) => step.type === 'semantic' && typeof step.confidence === 'number')
        .map((step) => step.confidence);
      decision = {
        router: 'policy-graph',
        policyVersion: policy.version,
        requiredTier: walk.tier,
        confidence: confidences.length ? Math.min(...confidences) : null,
        probabilities: null,
        trail: walk.trail,
        semanticEvaluations: semantic.map((node) => {
          const step = walk.trail.find((entry) => entry.nodeId === node.id);
          return {
            nodeId: node.id,
            type: 'semantic',
            result: answers[node.id].result,
            confidence: answers[node.id].confidence,
            probabilities: answers[node.id].probabilities,
            used: Boolean(step),
            branchTaken: step?.branch ?? null,
            uncertain: step?.uncertain ?? null,
          };
        }),
        routingLatencyMs: 90 + Math.round(random() * 260),
        jevLatencyMs: 70 + Math.round(random() * 230),
        jevUsage: { input_tokens: 240 + Math.round(random() * 300), output_tokens: 0 },
        reason: walk.reason,
        degraded: false,
        error: null,
      };
    } else if (arm.mode === 'jev-direct') {
      const tier = pick(tiers);
      const maxProbability = 0.5 + random() * 0.49;
      decision = {
        router: 'jev-direct',
        policyVersion: null,
        requiredTier: tier,
        confidence: maxProbability,
        probabilities: Object.fromEntries(tiers.map((name) => [name, name === tier ? maxProbability : (1 - maxProbability) / (tiers.length - 1)])),
        trail: [],
        semanticEvaluations: [],
        routingLatencyMs: 80 + Math.round(random() * 200),
        jevLatencyMs: 70 + Math.round(random() * 180),
        jevUsage: { input_tokens: 190 + Math.round(random() * 200), output_tokens: 0 },
        reason: 'jev-direct',
        degraded: false,
        error: null,
      };
    } else {
      decision = {
        router: 'fixed',
        policyVersion: null,
        requiredTier: arm.fixedTier,
        confidence: null,
        probabilities: null,
        trail: [],
        semanticEvaluations: [],
        routingLatencyMs: 0,
        jevLatencyMs: null,
        jevUsage: null,
        reason: `fixed-${arm.fixedTier}`,
        degraded: false,
        error: null,
      };
    }

    const resolved = resolveDispatch(config, decision, { escalatedTo });
    const dispatchId = store.recordDispatch({
      taskId, attempt, sessionId, decision, resolved, previousTier: lastTier,
    });

    const tier = resolved.selectedTier;
    lastTier = tier;
    lastWorker = resolved.worker.name;
    if (resolved.worker.frontier) frontierUsed = true;

    const fullySpecified =
      specification.hasPlan && specification.hasEditSites &&
      (specification.hasAcceptanceCriteria || specification.hasExpectedOutput);
    const specBonus = fullySpecified ? 0.16 : specification.hasPlan ? 0.07 : 0;
    const succeeded = random() < Math.min(0.98, SUCCESS_BY_TIER[tier] + specBonus);
    const verdict = !verificationAvailable ? 'UNCERTAIN' : succeeded ? 'PASS' : 'FAIL';
    if (verdict === 'UNCERTAIN') unverified = true;

    const failureReason = succeeded || verdict === 'UNCERTAIN'
      ? null
      : random() < 0.82 ? 'CAPABILITY_FAILURE' : pick(['ENVIRONMENT_FAILURE', 'SPEC_FAILURE']);
    const success = verdict === 'PASS' || verdict === 'UNCERTAIN';

    const baseCost = COST_BY_TIER[tier];
    const usage = {
      costUsd: baseCost * (0.6 + random() * 0.9),
      inputTokens: 40 + Math.round(random() * 200),
      outputTokens: 400 + Math.round(random() * 2600),
      cacheReadTokens: 40_000 + Math.round(random() * 120_000),
      cacheCreationTokens: 14_000 + Math.round(random() * 12_000),
      numTurns: 3 + Math.round(random() * 12),
      models: [],
    };

    store.recordExecution({
      taskId, attempt, dispatchId, tier,
      execution: {
        worker: resolved.worker.name,
        workerKind: resolved.worker.kind,
        workerModel: resolved.worker.model,
        workerSessionId: newId(),
        startedAt: Date.now() - Math.round(random() * 72 * 3_600_000),
        durationMs: 6000 + Math.round(random() * 60_000),
        exitCode: 0,
        timedOut: false,
        output: {
          status: success ? 'completed' : 'failed',
          summary: '', evidence: [], commandsRun: [], blockers: [],
          changedFiles: Array.from({ length: Math.round(random() * 4) }, (_, n) => `src/file${n}.ts`),
          schemaHonoured: true,
        },
        usage,
      },
      verification: { verdict, reason: verdict === 'PASS' ? 'checks passed' : verdict === 'FAIL' ? 'check failed' : 'no check applies', checks: [] },
      outcome: { success, failureReason, detail: null, unverified: verdict === 'UNCERTAIN' },
    });

    outcome = { success, failureReason };
    if (success) break;

    const canEscalate = failureReason === 'CAPABILITY_FAILURE' && attempt < baseConfig.escalation.maxAttemptsPerTask;
    if (!canEscalate) break;
    const nextIndex = tiers.indexOf(tier) + 1;
    if (nextIndex >= tiers.length) break;
    escalatedTo = tiers[nextIndex];
    escalated = true;
    store.recordEscalation({
      taskId, fromTier: tier, toTier: escalatedTo, reason: failureReason, attempt,
      policyVersion: decision.policyVersion,
    });
  }

  store.closeDelegation({
    taskId,
    summary: {
      status: outcome.success ? 'completed' : outcome.failureReason === 'SPEC_FAILURE' ? 'needs_clarification' : 'failed',
      success: outcome.success,
      finalTier: lastTier,
      finalWorker: lastWorker,
      firstRouteSuccess: outcome.success && attempt === 1,
      unverified,
      escalated,
      frontierUsed,
      failureReason: outcome.success ? null : outcome.failureReason,
    },
  });
  created += 1;
}

// A plausible main session: mostly cache reads, which is the point of the design.
store.recordSessionStart({ sessionId: 'seed-session', model: 'claude-opus-5', cwd: process.cwd() });
for (const [source, values] of Object.entries({
  main: { input: 38_400, output: 96_200, cacheRead: 4_812_000, cacheCreation: 212_400, cost: 14.82 },
  subagent: { input: 2_100, output: 18_400, cacheRead: 96_000, cacheCreation: 41_200, cost: 0.94 },
  auxiliary: { input: 9_800, output: 3_200, cacheRead: 12_400, cacheCreation: 8_100, cost: 0.11 },
})) {
  for (const type of ['input', 'output', 'cacheRead', 'cacheCreation']) {
    store.recordOtelCounter({
      metric: 'token', sessionId: 'seed-session',
      model: source === 'main' ? 'claude-opus-5' : 'claude-haiku-4-5',
      querySource: source, tokenType: type, value: values[type],
    });
  }
  store.recordOtelCounter({
    metric: 'cost', sessionId: 'seed-session',
    model: source === 'main' ? 'claude-opus-5' : 'claude-haiku-4-5',
    querySource: source, tokenType: null, value: values.cost,
  });
}
store.recordSubagentEvent({ sessionId: 'seed-session', agentId: 'a1', agentType: 'Explore', event: 'SubagentStart' });
store.recordSubagentEvent({ sessionId: 'seed-session', agentId: 'a1', agentType: 'Explore', event: 'SubagentStop' });

console.log(`seeded ${created} delegations into ${store.file}`);
store.close();
