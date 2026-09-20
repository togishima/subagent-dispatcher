import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { uiDir } from '../util/paths.mjs';
import { isLoopback } from '../config/load.mjs';
import { log } from '../util/log.mjs';
import { ingestMetrics } from './otlp.mjs';
import {
  overview, timeline, taskDetail, confidenceView, workerView,
  policyView, policyComparison, cacheCostView, policyVersionsSeen, specificationView,
  evaluatorView, predicateAgreement, evaluatorsSeen,
} from './queries.mjs';

/**
 * Local dashboard and OTLP receiver.
 *
 * Loopback only, and not as a default that a config file can change: a
 * non-loopback bind address is refused outright. Nothing is sent anywhere — this
 * server only receives, and the only writer is Claude Code on this machine.
 */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // The dashboard is local and self-contained; nothing may embed or frame it.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  response.end(text);
}

function serveStatic(response, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(uiDir, relative);
  // Refuse anything that escapes the ui directory, even though URL parsing has
  // already normalised `..` away.
  if (!file.startsWith(path.resolve(uiDir) + path.sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  });
}

function parseWindow(url) {
  const since = url.searchParams.get('since');
  if (!since) return null;
  const hours = Number(since);
  if (Number.isFinite(hours) && hours > 0) return Date.now() - hours * 3_600_000;
  return null;
}

export function createTelemetryServer(config, store) {
  if (!isLoopback(config.ui.host)) {
    throw new Error(`refusing to bind ${config.ui.host}: the dashboard is loopback-only`);
  }

  const routes = {
    '/api/overview': (url) => overview(store, {
      since: parseWindow(url),
      policyVersion: url.searchParams.get('policyVersion') || null,
      mode: url.searchParams.get('mode') || null,
    }),
    '/api/timeline': (url) => timeline(store, {
      since: parseWindow(url),
      limit: Math.min(500, Number(url.searchParams.get('limit')) || 50),
    }),
    '/api/confidence': (url) => confidenceView(store, { since: parseWindow(url) }),
    '/api/specification': (url) => specificationView(store, { since: parseWindow(url) }),
    '/api/evaluators': (url) => ({
      evaluators: evaluatorView(store, {
        since: parseWindow(url),
        policyVersion: url.searchParams.get('policyVersion') || null,
      }),
      agreement: predicateAgreement(store, { policyVersion: url.searchParams.get('policyVersion') || null }),
      configured: config.routing.semanticEvaluator?.provider ?? 'jev',
    }),
    '/api/workers': (url) => workerView(store, { since: parseWindow(url) }),
    '/api/policy': (url) => policyView(store, { policyVersion: url.searchParams.get('policyVersion') || null }),
    '/api/comparison': () => policyComparison(store),
    '/api/cache-cost': () => cacheCostView(store),
    '/api/meta': () => ({
      routingMode: config.routing.mode,
      tiers: Object.entries(config.tiers)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([name, tier]) => ({ name, worker: tier.worker, frontier: Boolean(config.workers[tier.worker]?.frontier) })),
      policyVersions: policyVersionsSeen(store),
      semanticEvaluator: config.routing.semanticEvaluator?.provider ?? 'jev',
      evaluatorsSeen: evaluatorsSeen(store),
      otelEndpoint: config.otel.receiverEnabled ? `http://${config.ui.host}:${config.ui.port}` : null,
      dbPath: store.file,
      debugStoreRawInput: config.telemetry.debugStoreRawInput,
      retentionDays: config.telemetry.retentionDays,
    }),
  };

  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${config.ui.host}:${config.ui.port}`);
    } catch {
      response.writeHead(400).end('bad request');
      return;
    }

    // OTLP ingest. Claude Code posts here when CLAUDE_CODE_ENABLE_TELEMETRY=1 and
    // OTEL_EXPORTER_OTLP_ENDPOINT points at this server.
    if (request.method === 'POST' && (url.pathname === '/v1/metrics' || url.pathname === '/v1/logs')) {
      if (!config.otel.receiverEnabled) return sendJson(response, 404, { error: 'otel receiver disabled' });
      try {
        const body = await readBody(request);
        const type = request.headers['content-type'] ?? '';
        if (!type.includes('json')) {
          // Protobuf would need a dependency; say so rather than silently dropping.
          return sendJson(response, 415, {
            error: 'only OTLP/JSON is accepted; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
          });
        }
        if (url.pathname === '/v1/logs') return sendJson(response, 200, { partialSuccess: {} });
        const count = ingestMetrics(store, JSON.parse(body.toString('utf8')));
        log.debug('otel metrics ingested', { count });
        return sendJson(response, 200, { partialSuccess: {} });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD, POST' }).end('method not allowed');
      return;
    }

    const taskMatch = /^\/api\/task\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
    if (taskMatch) {
      const detail = taskDetail(store, taskMatch[1]);
      return sendJson(response, detail ? 200 : 404, detail ?? { error: 'unknown task' });
    }

    const handler = routes[url.pathname];
    if (handler) {
      try {
        return sendJson(response, 200, handler(url));
      } catch (error) {
        log.error('api error', { path: url.pathname, error: error.message });
        return sendJson(response, 500, { error: error.message });
      }
    }

    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'unknown endpoint' });
    return serveStatic(response, url.pathname);
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.ui.port, config.ui.host, () => {
          log.info('dashboard listening', { url: `http://${config.ui.host}:${config.ui.port}/` });
          resolve(`http://${config.ui.host}:${config.ui.port}/`);
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
