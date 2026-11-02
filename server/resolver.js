import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IcyDemuxer, StreamError, extensionFor, openStream, resolveStream } from './stream.js';
import * as tunein from './tunein.js';
import { HttpError } from './net.js';
import { logger } from './log.js';

const log = logger('stream');
const CACHE_TTL = 60 * 1000;

/**
 * Turns a station into something a speaker can play and, when needed, relays
 * the audio through the hub (for https-only streams, the UPnP path, or when
 * relay mode is forced). Also tracks "now playing" song titles from ICY
 * metadata.
 */
export class StreamResolver extends EventEmitter {
  constructor({ secret, settings }) {
    super();
    this.secret = secret;
    this.settings = settings; // () => settings object
    this.cache = new Map();
    this.titles = new Map(); // metaKey -> { title, at }
    this.activeRelays = new Map(); // id -> { url, since }
    this.relaySeq = 0;
  }

  sign(data) {
    return crypto.createHmac('sha256', this.secret).update(data).digest('base64url').slice(0, 22);
  }

  metaKeyFor(url) {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  }

  relayUrl(hubBase, sourceUrl, contentType) {
    const data = Buffer.from(sourceUrl, 'utf8').toString('base64url');
    return `${hubBase}/relay/${this.sign(data)}/${data}.${extensionFor(contentType)}`;
  }

  /** Verify and decode a relay path. Returns the upstream URL or null. */
  decodeRelay(sig, file) {
    const data = String(file || '').replace(/\.[a-z0-9]{2,4}$/i, '');
    if (!data || this.sign(data) !== sig) return null;
    try {
      return Buffer.from(data, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  async candidates(station) {
    if (station.type === 'tunein') {
      const list = await tunein.tune(station.id);
      return list.map((c) => c.url);
    }
    return [station.url];
  }

  /** Find a working stream URL for the station (cached briefly). */
  async probe(station) {
    const hit = this.cache.get(station.key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    const urls = await this.candidates(station);
    let lastErr;
    for (const url of urls.slice(0, 5)) {
      try {
        const value = await resolveStream(url);
        this.cache.set(station.key, { at: Date.now(), value });
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
        return value;
      } catch (err) {
        lastErr = err;
        log.debug(`Candidate failed for ${station.name}: ${url} (${err.message})`);
      }
    }
    if (lastErr instanceof StreamError) {
      throw new HttpError(502, `${station.name} isn't available right now: ${lastErr.message}`, 'stream_unavailable');
    }
    throw lastErr || new HttpError(502, `${station.name} isn't available right now`, 'stream_unavailable');
  }

  /**
   * @param station normalised station
   * @param opts.hubBase http://<hub address as seen by the speaker>:<port>
   * @param opts.requireHttp true when the consumer can't do https (UPnP)
   * @returns { streamUrl, sourceUrl, contentType, relayed, metaKey, bitrate, icy }
   */
  async resolve(station, { hubBase, requireHttp = false } = {}) {
    const probed = await this.probe(station);
    const mode = this.settings().streamMode || 'auto';
    const isHttps = /^https:/i.test(probed.url);
    const relay = mode === 'relay' || (isHttps && (mode === 'auto' || requireHttp));
    const streamUrl = relay ? this.relayUrl(hubBase, probed.url, probed.contentType) : probed.url;
    return {
      streamUrl,
      sourceUrl: probed.url,
      contentType: probed.contentType,
      relayed: relay,
      metaKey: this.metaKeyFor(probed.url),
      bitrate: probed.bitrate,
      icy: probed.icyMetaInt > 0,
    };
  }

  setTitle(metaKey, title) {
    const prev = this.titles.get(metaKey);
    if (prev && prev.title === title) {
      prev.at = Date.now();
      return;
    }
    this.titles.set(metaKey, { title, at: Date.now() });
    if (this.titles.size > 100) this.titles.delete(this.titles.keys().next().value);
    this.emit('title', metaKey, title);
  }

  getTitle(metaKey) {
    return this.titles.get(metaKey)?.title || '';
  }

  /**
   * Serve a relayed stream to the speaker. Reconnects to the upstream server
   * transparently if it drops, so a flaky station doesn't stop the music.
   */
  async handleRelay(req, res, upstreamUrl) {
    const id = ++this.relaySeq;
    const metaKey = this.metaKeyFor(upstreamUrl);
    let closed = false;
    let current = null;
    let headersSent = false;
    let retries = 0;
    let lastStart = 0;

    const cleanup = () => {
      closed = true;
      this.activeRelays.delete(id);
      if (current) current.close();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    if (req.method === 'HEAD') {
      const ext = (req.url.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1] || 'mp3';
      const type = { mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' }[ext] || 'audio/mpeg';
      res.writeHead(200, relayHeaders(type));
      res.end();
      cleanup();
      return;
    }

    this.activeRelays.set(id, { url: upstreamUrl, since: Date.now() });
    log.info(`Relay #${id} started for ${req.socket.remoteAddress}: ${upstreamUrl}`);

    while (!closed) {
      lastStart = Date.now();
      try {
        current = await openStream(upstreamUrl, { timeout: 10000 });
      } catch (err) {
        if (!headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Stream unavailable: ${err.message}`);
          cleanup();
          return;
        }
        if (++retries > 6) break;
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** retries)));
        continue;
      }
      if (closed) break;
      if (!headersSent) {
        res.writeHead(200, relayHeaders(current.headers['content-type'] || 'audio/mpeg', current.headers));
        headersSent = true;
      }
      const metaInt = Number.parseInt(current.headers['icy-metaint'] || '', 10);
      let body = current.body;
      if (metaInt > 0) {
        const demux = new IcyDemuxer(metaInt);
        demux.on('metadata', (m) => {
          if (m.title) this.setTitle(metaKey, m.title);
        });
        current.body.on('error', (err) => demux.destroy(err));
        body = current.body.pipe(demux);
      }
      await new Promise((resolve) => {
        const onData = (chunk) => {
          if (closed) return;
          if (!res.write(chunk)) {
            body.pause();
            res.once('drain', () => body.resume());
          }
        };
        body.on('data', onData);
        body.once('end', resolve);
        body.once('error', resolve);
        body.once('close', resolve);
        req.once('close', resolve);
      });
      if (current) current.close();
      if (closed) break;
      // Upstream dropped while the speaker is still listening: reconnect.
      if (Date.now() - lastStart > 60000) retries = 0;
      if (++retries > 6) break;
      log.warn(`Relay #${id} upstream ended, reconnecting (attempt ${retries})`);
      await new Promise((r) => setTimeout(r, Math.min(8000, 300 * 2 ** retries)));
    }
    if (!res.writableEnded) res.end();
    cleanup();
    log.info(`Relay #${id} finished`);
  }
}

function relayHeaders(contentType, upstream = {}) {
  const h = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
    'Accept-Ranges': 'none',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  };
  if (upstream['icy-br']) h['icy-br'] = upstream['icy-br'];
  if (upstream['icy-name']) h['icy-name'] = upstream['icy-name'].replace(/[^\x20-\x7e]/g, '');
  return h;
}
