/* jev-dispatch dashboard. No dependencies, no network beyond this origin. */

const $ = (id) => document.getElementById(id);
const tip = $('tip');

const state = { view: 'overview', since: '', policyVersion: '', meta: null, tiers: [] };

// ---------------------------------------------------------------- formatting

const pct = (value, digits = 0) =>
  value == null || Number.isNaN(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
const usd = (value) => {
  if (value == null) return '—';
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
};
const num = (value, digits = 0) =>
  value == null || Number.isNaN(value) ? '—' : Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const ms = (value) => {
  if (value == null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
};
const clock = (epoch) =>
  new Date(epoch).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (epoch) => new Date(epoch).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/**
 * The ordinal tier colour, as a class rather than an inline style: the dashboard
 * ships a strict Content-Security-Policy, so every colour is a stylesheet class and
 * every bar width is set through the CSSOM.
 */
function tierClass(tier) {
  const index = state.tiers.findIndex((entry) => entry.name === tier);
  return `t${Math.min(3, Math.max(1, index + 1))}`;
}

/** Set bar widths from data-w after the markup is in the DOM. */
function applyMarks(container) {
  for (const fill of container.querySelectorAll('.bar-fill[data-w]')) {
    fill.style.width = `${fill.dataset.w}%`;
  }
}

const VERDICTS = {
  PASS: { icon: '✓', word: 'pass', cls: 'pass' },
  FAIL: { icon: '✕', word: 'fail', cls: 'fail' },
  UNCERTAIN: { icon: '?', word: 'unverified', cls: 'uncertain' },
  SKIPPED: { icon: '–', word: 'skipped', cls: 'skipped' },
};

function verdictHtml(verdict) {
  const spec = VERDICTS[verdict] ?? VERDICTS.SKIPPED;
  return `<span class="verdict ${spec.cls}"><span class="icon" aria-hidden="true">${spec.icon}</span>${spec.word}</span>`;
}

/** Worker name, with its model only when the model adds information. */
const workerLabel = (worker, model) =>
  model && model !== worker ? `${esc(worker)} <span class="mono">${esc(model)}</span>` : esc(worker);

const tierChip = (tier) =>
  tier ? `<span class="chip tier-${esc(tier)}">${esc(tier).toUpperCase()}</span>` : '<span class="chip">—</span>';

// -------------------------------------------------------------------- tooltip

function showTip(target, title, rows) {
  const box = target.getBoundingClientRect();
  tip.innerHTML =
    `<div class="t-title">${esc(title)}</div>` +
    rows.map((row) => `<div class="t-row">${esc(row)}</div>`).join('');
  tip.style.left = `${box.left + box.width / 2}px`;
  tip.style.top = `${box.top - 8}px`;
  tip.classList.add('on');
}
const hideTip = () => tip.classList.remove('on');

/** Attach the hover layer to a mark. The whole row is the hit target, not the bar. */
function hoverable(element, title, rows) {
  element.tabIndex = 0;
  element.addEventListener('mouseenter', () => showTip(element, title, rows));
  element.addEventListener('focus', () => showTip(element, title, rows));
  element.addEventListener('mouseleave', hideTip);
  element.addEventListener('blur', hideTip);
}

// --------------------------------------------------------------------- charts

function tile(label, value, hint) {
  const unavailable = value === '—';
  return `<div class="tile"><div class="label">${esc(label)}</div>
    <div class="value${unavailable ? ' na' : ''}">${esc(value)}</div>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}

/** Single-series horizontal bars. No legend: the card title names what is plotted. */
function barChart(container, rows) {
  container.innerHTML = '';
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">No data yet.</p>';
    return;
  }
  for (const row of rows) {
    const element = document.createElement('div');
    element.className = 'bar-row';
    element.innerHTML =
      `<div class="key">${row.keyHtml ?? esc(row.key)}</div>` +
      `<div class="bar-track"><div class="bar-fill ${esc(row.colorClass)}" data-w="${((row.value / max) * 100).toFixed(2)}"></div></div>` +
      `<div class="val">${esc(row.valueLabel)}</div>`;
    hoverable(element, row.key, row.tooltip ?? []);
    container.append(element);
  }
  applyMarks(container);
}

/** Two rate series per category, stacked in a group with a 2px surface gap. */
function groupedRates(container, groups) {
  container.innerHTML = '';
  if (groups.length === 0) {
    container.innerHTML = '<p class="empty">No routed delegations with a confidence score yet.</p>';
    return;
  }
  for (const group of groups) {
    const element = document.createElement('div');
    element.className = 'group';
    const bars = group.series
      .map(
        (series) =>
          `<div class="group-bar"><div class="track"><div class="bar-fill ${esc(series.colorClass)}" data-w="${((series.value ?? 0) * 100).toFixed(2)}"></div></div>` +
          `<div class="val">${esc(series.label)}</div></div>`,
      )
      .join('');
    element.innerHTML = `<div class="key">${esc(group.key)}</div><div class="group-bars">${bars}</div>`;
    hoverable(element, group.key, group.tooltip ?? []);
    container.append(element);
  }
  applyMarks(container);
}

function table(element, columns, rows, emptyMessage = 'No data yet.') {
  if (rows.length === 0) {
    element.innerHTML = `<tbody><tr><td class="empty">${esc(emptyMessage)}</td></tr></tbody>`;
    return;
  }
  element.innerHTML =
    `<thead><tr>${columns.map((column) => `<th>${esc(column.title)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows
      .map((row) => `<tr>${columns.map((column) => `<td>${column.cell(row)}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;
}

// ----------------------------------------------------------------- data access

const query = () => {
  const params = new URLSearchParams();
  if (state.since) params.set('since', state.since);
  if (state.policyVersion) params.set('policyVersion', state.policyVersion);
  const text = params.toString();
  return text ? `?${text}` : '';
};

async function get(path, withQuery = true) {
  const response = await fetch(`/api/${path}${withQuery ? query() : ''}`);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

// ------------------------------------------------------------------- renderers

async function renderOverview() {
  const data = await get('overview');
  $('kpis').innerHTML = [
    tile('Total delegations', num(data.delegations)),
    tile('Task success', pct(data.taskSuccessRate, 1), `${num(Math.round((data.taskSuccessRate ?? 0) * data.delegations))} of ${num(data.delegations)}`),
    tile('First-route success', pct(data.firstRouteSuccessRate, 1), 'no escalation needed'),
    tile('Escalation rate', pct(data.escalationRate, 1), 'under-routed on first try'),
    tile('Frontier invocation', pct(data.frontierInvocationRate, 1), 'touched the frontier worker'),
    tile('Avg attempts / task', num(data.averageAttemptsPerTask, 2)),
    tile('Total cost', usd(data.totalCostUsd), 'delegated work only'),
    tile('Cost per success', usd(data.costPerSuccessfulDelegation)),
    tile(
      'Est. frontier avoided',
      data.estimatedFrontierAvoidedUsd == null ? '—' : usd(data.estimatedFrontierAvoidedUsd),
      data.frontierBaselineSamples > 0
        ? `vs ${usd(data.frontierBaselineCostUsd)}/task observed at top tier (n=${data.frontierBaselineSamples})`
        : 'needs top-tier runs to compare against',
    ),
    tile('Routing latency', ms(data.averageRoutingLatencyMs), `${num(data.routingInputTokens)} evaluator input tokens`),
    tile('Unverified passes', pct(data.unverifiedRate, 1), 'nothing could check the result'),
  ].join('');

  const toRows = (distribution) =>
    distribution.map((entry) => ({
      key: entry.tier,
      keyHtml: tierChip(entry.tier),
      value: entry.count,
      colorClass: tierClass(entry.tier),
      valueLabel: `${num(entry.count)} · ${pct(entry.share)}`,
      tooltip: [
        `${num(entry.count)} delegations (${pct(entry.share, 1)})`,
        `success ${pct(entry.successRate, 1)}`,
        `spend ${usd(entry.costUsd)}`,
      ],
    }));
  barChart($('tier-final'), toRows(data.tierDistribution));
  barChart($('tier-first'), toRows(data.firstRouteTierDistribution));
}

async function renderTimeline() {
  const rows = await get('timeline');
  const container = $('timeline');
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">No delegations recorded yet. Call the delegate tool from a Claude Code session.</p>';
    return;
  }
  container.innerHTML = rows
    .map((task) => {
      const attempts = task.attempts
        .map((attempt, index) => {
          const lead = index === 0 ? '' : '<span class="arrow" aria-hidden="true">↳</span> ';
          const confidence = attempt.confidence == null ? '' : ` · conf ${attempt.confidence.toFixed(2)}`;
          const required =
            attempt.required_tier && attempt.required_tier !== attempt.tier
              ? ` <span class="arrow">(asked ${esc(attempt.required_tier)})</span>`
              : '';
          return `<div class="attempt">${lead}${tierChip(attempt.tier)} <span class="arrow">→</span>
            <span>${esc(attempt.worker ?? '—')}</span>
            ${verdictHtml(attempt.verification_verdict)}
            <span>${esc(attempt.failure_reason ?? '')}</span>
            <span class="mono">${ms(attempt.duration_ms)} · ${usd(attempt.cost_usd)}${confidence}</span>${required}</div>`;
        })
        .join('');
      return `<div class="entry">
        <div class="entry-head">
          <span class="entry-time">${esc(day(task.created_at))} ${esc(clock(task.created_at))}</span>
          <span class="entry-title" title="${esc(task.title ?? task.task_id)}">${esc(task.title ?? '(no title stored)')}</span>
          <span class="chip">${esc(task.routing_mode ?? '—')}${task.policy_version ? ` ${esc(task.policy_version)}` : ''}</span>
          <span class="entry-cost">${esc(usd(task.total_cost_usd))}</span>
        </div>${attempts}</div>`;
    })
    .join('');
}

async function renderPolicy() {
  const data = await get('policy');
  $('policy-kpis').innerHTML = [
    tile(
      `First-routed to ${data.expensiveBranchTier ?? 'top tier'}`,
      pct(data.expensiveBranchShare, 1),
      'share of tasks the policy sent straight to the strongest worker',
    ),
    tile('Predicates in use', num(data.predicates.filter((entry) => entry.used > 0).length)),
  ].join('');

  const container = $('predicates');
  if (data.predicates.length === 0) {
    container.innerHTML = '<p class="empty">No predicate evaluations recorded yet.</p>';
    return;
  }
  container.innerHTML = data.predicates
    .map((entry) => {
      const branches = entry.branches.length
        ? entry.branches
            .map(
              (branch) =>
                `<tr><td>${esc(branch.branch)}</td><td>${num(branch.count)}</td>
                 <td>${pct(branch.successRate, 1)}</td><td>${pct(branch.escalationRate, 1)}</td>
                 <td>${pct(branch.frontierRate, 1)}</td><td>${usd(branch.averageCostUsd)}</td></tr>`,
            )
            .join('')
        : '<tr><td class="empty" colspan="6">No finished delegations took either branch yet.</td></tr>';
      const confidence =
        entry.type === 'semantic'
          ? `<span>avg confidence <b>${entry.avg_confidence == null ? '—' : entry.avg_confidence.toFixed(2)}</b></span>
             <span>lowest <b>${entry.min_confidence == null ? '—' : entry.min_confidence.toFixed(2)}</b></span>
             <span>over-routed on uncertainty <b>${pct(entry.uncertainRate, 1)}</b></span>`
          : '<span>decided in code, no model call</span>';
      return `<div class="predicate">
        <div class="predicate-head">
          <span class="predicate-id">${esc(entry.node_id)}</span>
          <span class="predicate-kind">${esc(entry.type)}${entry.predicate ? ` · ${esc(entry.predicate)}` : ''}</span>
          <span class="predicate-kind">${esc(entry.policy_version ?? '')}</span>
        </div>
        <div class="predicate-stats">
          <span>reached <b>${num(entry.used)}</b> of ${num(entry.evaluations)} (<b>${pct(entry.fireRate, 1)}</b>)</span>
          <span>yes <b>${num(entry.yes_used)}</b> / no <b>${num(entry.no_used)}</b></span>
          ${confidence}
        </div>
        <div class="scroll"><table><thead><tr>
          <th>Branch</th><th>Tasks</th><th>Success</th><th>Escalated</th><th>Frontier</th><th>Avg cost</th>
        </tr></thead><tbody>${branches}</tbody></table></div>
      </div>`;
    })
    .join('');
}

async function renderConfidence() {
  const buckets = await get('confidence');
  const withData = buckets.filter((bucket) => bucket.count > 0);
  groupedRates(
    $('confidence'),
    withData.map((bucket) => ({
      key: bucket.bucket,
      series: [
        { value: bucket.firstRouteSuccessRate, label: pct(bucket.firstRouteSuccessRate), colorClass: 's1' },
        { value: bucket.escalationRate, label: pct(bucket.escalationRate), colorClass: 's2' },
      ],
      tooltip: [
        `${num(bucket.count)} delegations`,
        `first-route success ${pct(bucket.firstRouteSuccessRate, 1)}`,
        `escalation ${pct(bucket.escalationRate, 1)}`,
        `task success ${pct(bucket.taskSuccessRate, 1)}`,
      ],
    })),
  );
  table(
    $('confidence-table'),
    [
      { title: 'Confidence', cell: (row) => esc(row.bucket) },
      { title: 'Delegations', cell: (row) => num(row.count) },
      { title: 'First-route success', cell: (row) => pct(row.firstRouteSuccessRate, 1) },
      { title: 'Escalation', cell: (row) => pct(row.escalationRate, 1) },
      { title: 'Task success', cell: (row) => pct(row.taskSuccessRate, 1) },
    ],
    buckets,
  );
}

async function renderWorkers() {
  const rows = await get('workers');
  table(
    $('workers'),
    [
      { title: 'Worker', cell: (row) => workerLabel(row.worker, row.worker_model) },
      { title: 'Tier', cell: (row) => tierChip(row.tier) },
      { title: 'Invocations', cell: (row) => num(row.invocations) },
      { title: 'Success', cell: (row) => pct(row.successRate, 1) },
      { title: 'First-attempt success', cell: (row) => pct(row.firstAttemptSuccessRate, 1) },
      { title: 'Avg latency', cell: (row) => ms(row.avg_duration_ms) },
      { title: 'Avg cost', cell: (row) => usd(row.avg_cost_usd) },
      { title: 'Total cost', cell: (row) => usd(row.total_cost_usd) },
      { title: 'Escalated out', cell: (row) => num(row.escalatedFrom) },
      { title: 'Escalated in', cell: (row) => num(row.escalatedTo) },
    ],
    rows,
    'No worker executions yet.',
  );
}

async function renderCost() {
  const data = await get('cache-cost');
  $('otel-banner').innerHTML = data.otelAvailable
    ? ''
    : `<div class="banner"><b>Main-session figures need Claude Code's OpenTelemetry export.</b>
        Set <code>CLAUDE_CODE_ENABLE_TELEMETRY=1</code>,
        <code>OTEL_METRICS_EXPORTER=otlp</code>,
        <code>OTEL_EXPORTER_OTLP_PROTOCOL=http/json</code> and
        <code>OTEL_EXPORTER_OTLP_ENDPOINT=${esc(state.meta?.otelEndpoint ?? 'http://127.0.0.1:4319')}</code>,
        then restart Claude Code. Worker figures below do not depend on it.</div>`;

  $('cache-kpis').innerHTML = [
    tile(
      'Main session cache read ratio',
      pct(data.main.cacheReadRatio, 1),
      'cache reads as a share of all readable input — the hypothesis',
    ),
    tile('Main session cost', usd(data.main.costUsd), data.main.models.join(', ') || 'no model recorded'),
    tile('Subagent cost (OTel)', usd(data.subagent.costUsd), 'in-session subagents'),
    tile(
      'Delegated worker cost',
      usd(data.workers.reduce((total, row) => total + row.cost_usd, 0)),
      `${num(data.workers.reduce((total, row) => total + row.invocations, 0))} worker invocations`,
    ),
  ].join('');

  const swatchFor = { main: 's1', subagent: 's2', auxiliary: 's3' };
  table(
    $('otel-table'),
    [
      {
        title: 'Source',
        cell: (row) =>
          `<span class="verdict"><i class="swatch ${swatchFor[row.source]}"></i>${esc(row.source)}</span>`,
      },
      { title: 'Input', cell: (row) => num(row.input) },
      { title: 'Output', cell: (row) => num(row.output) },
      { title: 'Cache read', cell: (row) => num(row.cacheRead) },
      { title: 'Cache creation', cell: (row) => num(row.cacheCreation) },
      { title: 'Cache read ratio', cell: (row) => pct(row.cacheReadRatio, 1) },
      { title: 'Cost', cell: (row) => usd(row.costUsd) },
    ],
    [data.main, data.subagent, data.auxiliary].filter(
      (row) => row.input || row.output || row.cacheRead || row.cacheCreation || row.costUsd,
    ),
    'No OpenTelemetry counters received yet.',
  );

  table(
    $('worker-cost'),
    [
      { title: 'Worker', cell: (row) => workerLabel(row.worker, row.worker_model) },
      { title: 'Invocations', cell: (row) => num(row.invocations) },
      { title: 'Input', cell: (row) => num(row.input_tokens) },
      { title: 'Output', cell: (row) => num(row.output_tokens) },
      { title: 'Cache read', cell: (row) => num(row.cache_read_tokens) },
      { title: 'Cache creation', cell: (row) => num(row.cache_creation_tokens) },
      { title: 'Cost', cell: (row) => usd(row.cost_usd) },
    ],
    data.workers,
    'No worker executions yet.',
  );
}

async function renderCompare() {
  const rows = await get('comparison', false);
  table(
    $('comparison'),
    [
      {
        title: 'Arm',
        cell: (row) => `${esc(row.routing_mode)} <span class="mono">${esc(row.policy_version)}</span>`,
      },
      { title: 'Delegations', cell: (row) => num(row.delegations) },
      { title: 'Task success', cell: (row) => pct(row.task_success_rate, 1) },
      { title: 'First-route success', cell: (row) => pct(row.first_route_success_rate, 1) },
      { title: 'Escalation', cell: (row) => pct(row.escalation_rate, 1) },
      { title: 'Frontier invocation', cell: (row) => pct(row.frontier_invocation_rate, 1) },
      { title: 'Unverified', cell: (row) => pct(row.unverified_rate, 1) },
      { title: 'Avg attempts', cell: (row) => num(row.avg_attempts, 2) },
      { title: 'Routing latency', cell: (row) => ms(row.avg_routing_latency_ms) },
      { title: 'Total cost', cell: (row) => usd(row.total_cost_usd) },
      { title: 'Cost per success', cell: (row) => usd(row.costPerSuccess) },
    ],
    rows,
    'No finished delegations yet.',
  );
  $('arm-help').innerHTML = [
    'A  jev-dispatch config set routing.mode fixed-high',
    'B  jev-dispatch config set routing.mode jev-direct',
    'C  jev-dispatch config set routing.mode policy-graph   (+ semanticEvaluator.provider jev)',
    'D  jev-dispatch config set routing.semanticEvaluator.provider laya',
  ]
    .map((line) => `<div>${esc(line)}</div>`)
    .join('');
}

async function renderSpecification() {
  const data = await get('specification');
  const columns = [
    { title: 'Population', cell: (row) => `${esc(row.population)}<br><span class="mono">${esc(row.note ?? '')}</span>` },
    { title: 'Tasks', cell: (row) => num(row.count) },
    { title: `Routed ${esc(data.cheapestTier)}`, cell: (row) => pct(row.cheapestRouteRate, 1) },
    { title: `Routed ${esc(data.topTier)}`, cell: (row) => pct(row.topRouteRate, 1) },
    { title: 'Task success', cell: (row) => pct(row.taskSuccessRate, 1) },
    { title: 'First-route success', cell: (row) => pct(row.firstRouteSuccessRate, 1) },
    { title: 'Escalation', cell: (row) => pct(row.escalationRate, 1) },
    { title: 'Avg attempts', cell: (row) => num(row.averageAttempts, 2) },
    { title: 'Avg cost', cell: (row) => usd(row.averageCostUsd) },
    { title: 'Cost per success', cell: (row) => usd(row.costPerSuccess) },
  ];
  table($('spec-populations'), columns, data.populations, 'No finished delegations yet.');

  barChart(
    $('spec-cheapest'),
    // One series, one colour: the tier ramp means tiers elsewhere in this
    // dashboard, and these bars are populations of tasks, not tiers.
    data.populations.map((row) => ({
      key: row.population,
      value: row.cheapestRouteRate ?? 0,
      colorClass: 's1',
      valueLabel: `${pct(row.cheapestRouteRate, 1)} of ${num(row.count)}`,
      tooltip: [
        esc(row.note ?? ''),
        `task success ${pct(row.taskSuccessRate, 1)}`,
        `escalation ${pct(row.escalationRate, 1)}`,
        `avg cost ${usd(row.averageCostUsd)}`,
      ],
    })),
  );

  table(
    $('spec-signals'),
    [
      { title: 'Signal present', cell: (row) => esc(row.signal) },
      { title: 'Tasks', cell: (row) => num(row.count) },
      { title: `Routed ${esc(data.cheapestTier)}`, cell: (row) => pct(row.cheapestRouteRate, 1) },
      { title: 'Task success', cell: (row) => pct(row.taskSuccessRate, 1) },
      { title: 'Escalation', cell: (row) => pct(row.escalationRate, 1) },
      { title: 'Avg cost', cell: (row) => usd(row.averageCostUsd) },
    ],
    data.signals,
    'No finished delegations yet.',
  );
}

/** Local engines read the state in place; remote ones are sent it. */
function privacyCell(local) {
  return local
    ? '<span class="verdict pass"><span class="icon" aria-hidden="true">\u2713</span>local · stays on this machine</span>'
    : '<span class="verdict uncertain"><span class="icon" aria-hidden="true">\u2191</span>remote · routing state sent</span>';
}

async function renderEvaluators() {
  const data = await get('evaluators');
  table(
    $('evaluators'),
    [
      {
        title: 'Evaluator',
        // Identity, model, policy and privacy in one cell: thirteen columns of
        // equal weight is a table nobody reads across.
        cell: (row) =>
          `<div><b>${esc(row.provider)}</b> <span class="mono">${esc(row.policy_version)}</span></div>` +
          `<div class="mono">${esc(row.model)}</div>` +
          `<div>${privacyCell(row.local)}</div>`,
      },
      { title: 'Delegations', cell: (row) => num(row.delegations) },
      { title: 'First-route success', cell: (row) => pct(row.first_route_success_rate, 1) },
      { title: 'Escalation', cell: (row) => pct(row.escalation_rate, 1) },
      { title: 'Frontier', cell: (row) => pct(row.frontier_invocation_rate, 1) },
      { title: 'Task success', cell: (row) => pct(row.task_success_rate, 1) },
      { title: 'Degraded', cell: (row) => pct(row.degraded_rate, 1) },
      { title: 'Avg confidence', cell: (row) => (row.avg_confidence == null ? '—' : row.avg_confidence.toFixed(2)) },
      { title: 'Latency', cell: (row) => `${ms(row.latency.median)}<br><span class="mono">p95 ${ms(row.latency.p95)}</span>` },
      { title: 'Cost per success', cell: (row) => usd(row.costPerSuccess) },
    ],
    data.evaluators,
    'No delegations routed by a semantic evaluator yet.',
  );

  barChart(
    $('evaluator-latency'),
    data.evaluators
      .filter((row) => row.latency.median != null)
      .map((row) => ({
        key: row.provider,
        value: row.latency.median,
        colorClass: row.local ? 's3' : 's1',
        valueLabel: `median ${ms(row.latency.median)} · p95 ${ms(row.latency.p95)}`,
        tooltip: [
          row.local ? 'local inference' : 'network call',
          `${num(row.latency.samples)} samples`,
          `min ${ms(row.latency.min)} · max ${ms(row.latency.max)}`,
          `first-route success ${pct(row.first_route_success_rate, 1)}`,
        ],
      })),
  );

  const container = $('agreement');
  if (data.agreement.length === 0) {
    container.innerHTML = '<p class="empty">No semantic predicate evaluations recorded yet.</p>';
    return;
  }
  container.innerHTML = data.agreement
    .map((entry) => {
      const rows = entry.providers
        .map(
          (provider) =>
            `<tr><td>${esc(provider.provider)}</td><td>${num(provider.evaluations)}</td>
             <td>${pct(provider.yesRate, 1)}</td>
             <td>${provider.averageConfidence == null ? '—' : provider.averageConfidence.toFixed(2)}</td>
             <td>${pct(provider.uncertainRate, 1)}</td></tr>`,
        )
        .join('');
      const spread = entry.yesRateSpread == null
        ? '<span class="predicate-kind">one evaluator only</span>'
        : `<span class="predicate-kind">yes-rate spread <b>${pct(entry.yesRateSpread, 1)}</b></span>`;
      return `<div class="predicate">
        <div class="predicate-head"><span class="predicate-id">${esc(entry.nodeId)}</span>${spread}</div>
        <div class="scroll"><table><thead><tr>
          <th>Evaluator</th><th>Evaluations</th><th>Answered yes</th><th>Avg confidence</th><th>Uncertain</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    })
    .join('');
}

const RENDERERS = {
  overview: renderOverview,
  evaluators: renderEvaluators,
  timeline: renderTimeline,
  specification: renderSpecification,
  policy: renderPolicy,
  confidence: renderConfidence,
  workers: renderWorkers,
  cost: renderCost,
  compare: renderCompare,
};

// ------------------------------------------------------------------- plumbing

async function render() {
  hideTip();
  try {
    await RENDERERS[state.view]();
  } catch (error) {
    const section = $(`view-${state.view}`);
    section.insertAdjacentHTML('afterbegin', `<div class="banner">Could not load this view: ${esc(error.message)}</div>`);
  }
}

function selectView(view) {
  state.view = view;
  for (const button of $('tabs').children) {
    button.setAttribute('aria-current', String(button.dataset.view === view));
  }
  for (const section of document.querySelectorAll('main > section')) {
    section.hidden = section.id !== `view-${view}`;
  }
  render();
}

$('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (button) selectView(button.dataset.view);
});
$('window').addEventListener('change', (event) => { state.since = event.target.value; render(); });
$('policy').addEventListener('change', (event) => { state.policyVersion = event.target.value; render(); });
$('refresh').addEventListener('click', render);
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('jev-dispatch-theme', dark ? 'light' : 'dark');
  } catch {
    /* private mode: the toggle still works for this page view */
  }
  render();
});

try {
  const saved = localStorage.getItem('jev-dispatch-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* nothing stored, nothing to restore */
}

const meta = await get('meta', false);
state.meta = meta;
state.tiers = meta.tiers;
$('subtitle').textContent =
  `${meta.routingMode} · evaluator ${meta.semanticEvaluator} · ` +
  `tiers ${meta.tiers.map((tier) => `${tier.name}→${tier.worker}`).join(', ')}` +
  `${meta.debugStoreRawInput ? ' · raw input capture ON' : ''}`;
for (const version of meta.policyVersions) {
  const option = document.createElement('option');
  option.value = version;
  option.textContent = version;
  $('policy').append(option);
}

await render();
setInterval(render, 5000);
