#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT, VERSION } from './config.js';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { Router } from './router.js';
import { registerBmxRoutes } from './bmx.js';
import { registerApiRoutes } from './api.js';
import { EventHub } from './events.js';
import { Scheduler } from './scheduler.js';
import { RadioSetup } from './radiosetup.js';
import { firstLanAddress, sendJson } from './net.js';
import { logger } from './log.js';

const log = logger('airwave');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(file);
    const noCache = ext === '.html' || file.endsWith('sw.js') || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

export async function createServer({ store: givenStore } = {}) {
  const store = givenStore || new Store(config.dataDir).load();
  const hub = new Hub(store);
  const scheduler = new Scheduler(hub, store);
  const radioSetup = new RadioSetup(hub);
  const events = new EventHub(() => withAlarmTimes(hub.publicState()));

  function withAlarmTimes(state) {
    return { ...state, alarms: state.alarms.map((a) => ({ ...a, nextFire: Scheduler.nextFire(a) })) };
  }

  hub.on('speaker', (s) => events.broadcast('speaker', s));
  for (const evt of ['speakers', 'library', 'settings']) hub.on(evt, () => events.broadcast('state', withAlarmTimes(hub.publicState())));
  hub.on('radio-address-changed', (id) => {
    // The hub moved to a new IP: quietly re-point the speaker so preset buttons keep working.
    radioSetup.enable(id).catch((err) => log.warn(`Automatic radio repair failed: ${err.message}`));
  });

  const router = new Router();
  registerBmxRoutes(router, hub);
  registerApiRoutes(router, { hub, scheduler, radioSetup, events });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      if (url.pathname.startsWith('/relay/')) {
        const [, , sig, file] = url.pathname.split('/');
        const upstream = hub.resolver.decodeRelay(sig, file);
        if (!upstream) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Invalid relay link');
          return;
        }
        await hub.resolver.handleRelay(req, res, upstream);
        return;
      }
      if (await router.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/bmx/')) {
        sendJson(res, 404, { error: { message: 'Not found', code: 'not_found' } });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      log.error(err.stack || err.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'Internal error' } });
      else res.end();
    }
  });
  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0; // relayed streams are long-lived

  return {
    server,
    hub,
    store,
    scheduler,
    radioSetup,
    events,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      await hub.start();
      scheduler.start();
    },
    async stop() {
      scheduler.stop();
      hub.stop();
      events.close();
      store.flush();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createServer();
  try {
    await app.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') log.error(`Port ${config.port} is already in use. Set PORT=<another port> and try again.`);
    else log.error(err.message);
    process.exit(1);
  }
  const addr = config.publicAddress || firstLanAddress();
  log.info(`Airwave ${VERSION} is running.`);
  log.info(`Open on your phone (same Wi-Fi):  http://${addr}:${config.port}`);
  log.info(`Data folder: ${config.dataDir}`);
  const shutdown = async () => {
    log.info('Shutting down…');
    await app.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
