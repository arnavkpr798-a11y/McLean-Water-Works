import net from 'node:net';
import tls from 'node:tls';
import { PassThrough, Transform } from 'node:stream';
import { USER_AGENT } from './config.js';

/**
 * A deliberately small HTTP/1.1 client for radio streams. Node's built-in
 * client rejects SHOUTcast v1 servers ("ICY 200 OK"), which are still common,
 * so we speak the protocol ourselves: follow redirects, de-chunk, expose
 * headers and the body as a stream.
 */

export class StreamError extends Error {
  constructor(message, code = 'STREAM_ERROR') {
    super(message);
    this.code = code;
  }
}

class Dechunker extends Transform {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.remaining = -1; // -1: expecting a size line
    this.finished = false;
  }

  _transform(chunk, _enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.buf.length && !this.finished) {
        if (this.remaining === -1) {
          const idx = this.buf.indexOf('\r\n');
          if (idx === -1) {
            if (this.buf.length > 1024) throw new StreamError('Invalid chunked encoding');
            break;
          }
          const size = Number.parseInt(this.buf.subarray(0, idx).toString('latin1').split(';')[0].trim(), 16);
          if (!Number.isFinite(size)) throw new StreamError('Invalid chunk size');
          this.buf = this.buf.subarray(idx + 2);
          if (size === 0) {
            this.finished = true;
            this.push(null);
            break;
          }
          this.remaining = size;
        } else if (this.remaining > 0) {
          const take = Math.min(this.remaining, this.buf.length);
          this.push(this.buf.subarray(0, take));
          this.buf = this.buf.subarray(take);
          this.remaining -= take;
        } else {
          // remaining === 0: expect CRLF after chunk data
          if (this.buf.length < 2) break;
          this.buf = this.buf.subarray(2);
          this.remaining = -1;
        }
      }
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

function connect(url, timeout) {
  return new Promise((resolve, reject) => {
    const isTls = url.protocol === 'https:';
    const port = Number(url.port) || (isTls ? 443 : 80);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const socket = isTls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new StreamError(`Connection to ${url.host} timed out`, 'TIMEOUT'));
    }, timeout);
    socket.once(isTls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new StreamError(`Could not connect to ${url.host}: ${err.code || err.message}`, 'CONNECT'));
    });
  });
}

function readHead(socket, timeout) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new StreamError('Stream server did not answer', 'TIMEOUT')), timeout);
    function finish(err, value) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      if (err) reject(err);
      else resolve(value);
    }
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      let idx = buf.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (idx === -1) {
        idx = buf.indexOf('\n\n');
        sepLen = 2;
      }
      if (idx !== -1) {
        socket.pause();
        finish(null, { head: buf.subarray(0, idx).toString('latin1'), rest: buf.subarray(idx + sepLen) });
      } else if (buf.length > 32 * 1024) {
        finish(new StreamError('Response headers too large'));
      }
    }
    function onError(err) {
      finish(new StreamError(`Stream connection failed: ${err.code || err.message}`, 'CONNECT'));
    }
    function onEnd() {
      finish(new StreamError('Stream server closed the connection', 'CLOSED'));
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

function parseHead(head) {
  const lines = head.split(/\r?\n/);
  const statusLine = lines.shift() || '';
  const m = statusLine.match(/^(?:HTTP\/\d(?:\.\d)?|ICY)\s+(\d{3})/i);
  if (!m) throw new StreamError('Not an HTTP/ICY stream response');
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return { status: Number(m[1]), headers };
}

/**
 * Open an HTTP(S)/ICY stream, following redirects.
 * Resolves to { url, status, headers, body: Readable, close() }.
 */
export async function openStream(rawUrl, { headers = {}, timeout = 8000, maxRedirects = 6, icy = true, method = 'GET' } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url;
    try {
      url = new URL(current);
    } catch {
      throw new StreamError('Invalid stream URL', 'BAD_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new StreamError(`Unsupported protocol ${url.protocol}`, 'BAD_URL');
    const socket = await connect(url, timeout);
    socket.setNoDelay(true);
    const reqHeaders = {
      Host: url.host,
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Connection: 'close',
      ...(icy ? { 'Icy-MetaData': '1' } : {}),
      ...headers,
    };
    const path = `${url.pathname || '/'}${url.search || ''}`;
    socket.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(reqHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    let parsed;
    let rest;
    try {
      const head = await readHead(socket, timeout);
      rest = head.rest;
      parsed = parseHead(head.head);
    } catch (err) {
      socket.destroy();
      throw err;
    }
    if (parsed.status >= 300 && parsed.status < 400 && parsed.headers.location) {
      socket.destroy();
      current = new URL(parsed.headers.location, url).href;
      continue;
    }
    if (parsed.status >= 400) {
      socket.destroy();
      throw new StreamError(`Stream server answered HTTP ${parsed.status}`, parsed.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
    }
    const raw = new PassThrough();
    if (rest.length) raw.write(rest);
    socket.on('error', (err) => raw.destroy(err));
    socket.pipe(raw);
    socket.resume();
    let body = raw;
    if (/chunked/i.test(parsed.headers['transfer-encoding'] || '')) {
      const d = new Dechunker();
      raw.on('error', (err) => d.destroy(err));
      body = raw.pipe(d);
    }
    return {
      url: url.href,
      status: parsed.status,
      headers: parsed.headers,
      body,
      close() {
        socket.destroy();
        raw.destroy();
        if (body !== raw) body.destroy();
      },
    };
  }
  throw new StreamError('Too many redirects', 'REDIRECTS');
}

/** Read up to `limit` bytes of a body (for playlists). */
export function readBody(body, limit = 128 * 1024, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => done(), timeout);
    function done(err) {
      clearTimeout(timer);
      body.removeAllListeners('data');
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    }
    body.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size >= limit) done();
    });
    body.once('end', () => done());
    body.once('error', (err) => done(err));
  });
}

const PLAYLIST_TYPES = [
  'audio/x-scpls',
  'audio/scpls',
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/pls+xml',
  'video/x-ms-asf',
  'video/x-ms-asx',
  'audio/x-ms-wax',
  'application/xspf+xml',
];

export function looksLikePlaylist(url, contentType = '') {
  const ct = contentType.toLowerCase();
  if (PLAYLIST_TYPES.some((t) => ct.includes(t))) return true;
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  return /\.(pls|m3u|m3u8|asx|xspf|wax)$/.test(path);
}

/** Parse PLS / M3U / ASX / XSPF playlists. Returns { urls, hls }. */
export function parsePlaylist(textBody, baseUrl) {
  const t = String(textBody || '');
  const abs = (u) => {
    try {
      return new URL(u.trim(), baseUrl).href;
    } catch {
      return null;
    }
  };
  if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|VERSION)/.test(t)) return { urls: [], hls: true };
  let urls = [];
  if (/^\s*\[playlist\]/im.test(t)) {
    urls = [...t.matchAll(/^\s*File\d+\s*=\s*(.+)$/gim)].map((m) => m[1]);
  } else if (/<asx/i.test(t)) {
    urls = [...t.matchAll(/<ref\s+href\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  } else if (/<playlist[^>]*xspf/i.test(t)) {
    urls = [...t.matchAll(/<location>([^<]+)<\/location>/gi)].map((m) => m[1]);
  } else {
    urls = t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && /^(https?:)?\/\/|^[\w./-]+$/i.test(l));
  }
  return { urls: [...new Set(urls.map(abs).filter((u) => u && /^https?:/i.test(u)))], hls: false };
}

function isAudioType(ct) {
  const c = (ct || '').toLowerCase();
  return (
    !c ||
    c.startsWith('audio/') ||
    c.includes('ogg') ||
    c.includes('octet-stream') ||
    c.includes('aacp') ||
    c.includes('mpeg')
  );
}

export function extensionFor(contentType = '') {
  const c = contentType.toLowerCase();
  if (c.includes('aac') || c.includes('mp4')) return 'aac';
  if (c.includes('ogg') || c.includes('opus')) return 'ogg';
  if (c.includes('flac')) return 'flac';
  if (c.includes('wav')) return 'wav';
  return 'mp3';
}

/**
 * Turn a station URL (which may be a playlist, redirect, or stream) into a
 * directly playable stream. Resolves to
 * { url, contentType, bitrate, name, icyMetaInt } or throws StreamError.
 */
export async function resolveStream(url, { depth = 0, timeout = 8000 } = {}) {
  if (depth > 3) throw new StreamError('Playlist nesting too deep');
  const conn = await openStream(url, { timeout });
  const ct = conn.headers['content-type'] || '';
  try {
    if (looksLikePlaylist(conn.url, ct) || /^text\/(plain|html)|xml/i.test(ct)) {
      const body = await readBody(conn.body);
      conn.close();
      const list = parsePlaylist(body, conn.url);
      if (list.hls) throw new StreamError('This station only offers an HLS stream, which SoundTouch speakers cannot play', 'HLS');
      if (!list.urls.length) {
        if (/html/i.test(ct)) throw new StreamError('That address is a web page, not an audio stream', 'NOT_AUDIO');
        throw new StreamError('Playlist contains no playable streams', 'EMPTY_PLAYLIST');
      }
      let lastErr;
      for (const entry of list.urls.slice(0, 6)) {
        try {
          return await resolveStream(entry, { depth: depth + 1, timeout });
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new StreamError('No stream in the playlist could be opened');
    }
    if (!isAudioType(ct)) throw new StreamError(`Not an audio stream (${ct})`, 'NOT_AUDIO');
    // Make sure audio actually flows (servers sometimes accept and then stall).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new StreamError('Stream did not send any audio', 'NO_DATA')), timeout);
      conn.body.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      conn.body.once('error', (err) => {
        clearTimeout(timer);
        reject(new StreamError(`Stream failed: ${err.message}`));
      });
      conn.body.once('end', () => {
        clearTimeout(timer);
        reject(new StreamError('Stream ended immediately', 'NO_DATA'));
      });
    });
    return {
      url: conn.url,
      contentType: ct || 'audio/mpeg',
      bitrate: Number.parseInt(conn.headers['icy-br'] || '', 10) || null,
      name: conn.headers['icy-name'] || '',
      icyMetaInt: Number.parseInt(conn.headers['icy-metaint'] || '', 10) || 0,
    };
  } finally {
    conn.close();
  }
}

export function parseIcyMetadata(raw) {
  let str = raw.toString('utf8');
  if (str.includes('�')) str = raw.toString('latin1');
  str = str.replace(/\0+$/, '');
  const m = str.match(/StreamTitle='((?:[^']|'(?!;))*)';?/);
  return { title: m ? m[1].trim() : '' };
}

/**
 * Removes interleaved ICY metadata blocks from a stream, emitting
 * 'metadata' events with the parsed StreamTitle.
 */
export class IcyDemuxer extends Transform {
  constructor(metaInt) {
    super();
    this.metaInt = metaInt;
    this.state = 'audio'; // audio -> len -> meta -> audio …
    this.left = metaInt; // bytes left in the current audio or metadata block
    this.metaBuf = [];
  }

  _transform(chunk, _enc, cb) {
    let i = 0;
    while (i < chunk.length) {
      if (this.state === 'audio') {
        const take = Math.min(this.left, chunk.length - i);
        this.push(chunk.subarray(i, i + take));
        i += take;
        this.left -= take;
        if (this.left === 0) this.state = 'len';
      } else if (this.state === 'len') {
        const len = chunk[i] * 16;
        i += 1;
        if (len === 0) {
          this.state = 'audio';
          this.left = this.metaInt;
        } else {
          this.state = 'meta';
          this.left = len;
        }
      } else {
        const take = Math.min(this.left, chunk.length - i);
        this.metaBuf.push(chunk.subarray(i, i + take));
        i += take;
        this.left -= take;
        if (this.left === 0) {
          const meta = parseIcyMetadata(Buffer.concat(this.metaBuf));
          this.metaBuf = [];
          this.state = 'audio';
          this.left = this.metaInt;
          this.emit('metadata', meta);
        }
      }
    }
    cb();
  }
}

/** Fetch the current StreamTitle of a stream without keeping it open. */
export async function readStreamTitle(url, { timeout = 8000 } = {}) {
  const conn = await openStream(url, { timeout });
  const metaInt = Number.parseInt(conn.headers['icy-metaint'] || '', 10);
  if (!metaInt) {
    conn.close();
    return null;
  }
  return new Promise((resolve) => {
    const demux = new IcyDemuxer(metaInt);
    const timer = setTimeout(() => finish(null), timeout);
    function finish(title) {
      clearTimeout(timer);
      conn.close();
      demux.destroy();
      resolve(title);
    }
    demux.on('metadata', (m) => finish(m.title));
    demux.on('data', () => {});
    demux.on('error', () => finish(null));
    conn.body.on('error', () => finish(null));
    conn.body.pipe(demux);
  });
}
