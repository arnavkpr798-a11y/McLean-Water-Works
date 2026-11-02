import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

/**
 * Plain HTTP request helper for talking to devices on the LAN. Uses the
 * lenient parser because embedded web servers are not always strictly
 * standards compliant.
 */
export function httpRequest({ host, port, method = 'GET', path = '/', headers = {}, body, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(String(body), 'utf8');
    const req = http.request(
      {
        host,
        port,
        method,
        path,
        insecureHTTPParser: true,
        agent: false,
        headers: {
          Connection: 'close',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`Timed out after ${timeout} ms`), { code: 'ETIMEDOUT' })), timeout);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Resolve true if a TCP port accepts connections within `timeout` ms. */
export function tcpProbe(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The local IPv4 address this machine uses to reach `targetIp`. This is the
 * address a speaker must use to call back into the hub.
 */
export function localAddressTowards(targetIp) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const finish = (addr) => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(addr);
    };
    sock.once('error', () => finish(firstLanAddress()));
    try {
      sock.connect(9, targetIp, () => {
        try {
          finish(sock.address().address);
        } catch {
          finish(firstLanAddress());
        }
      });
    } catch {
      finish(firstLanAddress());
    }
  });
}

export function lanInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask, cidr: a.cidr });
    }
  }
  return out;
}

export function firstLanAddress() {
  const preferred = lanInterfaces().find((i) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address));
  return (preferred || lanInterfaces()[0])?.address || '127.0.0.1';
}

export function isIPv4(value) {
  return net.isIPv4(String(value || '').trim());
}

/** Read a JSON request body with a size limit. */
export function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
