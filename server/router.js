import { HttpError, readJson, sendJson } from './net.js';
import { logger } from './log.js';

const log = logger('http');

/** Minimal router: method + path pattern with :params. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/\/:([A-Za-z]+)/g, (_, k) => {
        keys.push(k);
        return '/([^/]+)';
      })}/?$`,
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  /** Returns true if a route handled the request. */
  async handle(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      try {
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
        const result = await r.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body, url });
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result === undefined ? { ok: true } : result);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : err.status && err.status >= 400 && err.status < 600 ? err.status : err.code === 'UNREACHABLE' ? 503 : 500;
        if (status >= 500) log.warn(`${req.method} ${url.pathname}: ${err.message}`);
        if (!res.headersSent) {
          sendJson(res, status, { error: { message: err.message || 'Something went wrong', code: err.code || 'error' } });
        } else res.end();
      }
      return true;
    }
    return false;
  }
}
