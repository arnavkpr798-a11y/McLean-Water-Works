import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { SoundTouchClient } from './soundtouch/client.js';
import { UpnpTransport } from './soundtouch/upnp.js';
import { normalizeNowPlaying, normalizeVolume } from './soundtouch/models.js';
import { parseXml, rootName } from './soundtouch/xml.js';
import { config } from './config.js';
import { logger } from './log.js';
import { sleep } from './net.js';

const log = logger('speaker');

/**
 * One SoundTouch speaker: keeps a live mirror of its state using the
 * speaker's WebSocket notifications (port 8080, "gabbo" protocol), with
 * polling as a fallback, and exposes control actions.
 */
export class Speaker extends EventEmitter {
  constructor(ip, { id = '', name = '' } = {}) {
    super();
    this.ip = ip;
    this.id = id;
    this.client = new SoundTouchClient(ip, { port: config.speakerPorts.http });
    this.upnp = new UpnpTransport(ip, { port: config.speakerPorts.upnp });
    this.state = {
      id,
      ip,
      name,
      online: false,
      info: null,
      nowPlaying: null,
      volume: null,
      presets: [],
      sources: [],
      bass: null,
      bassCaps: null,
      zone: null,
      powerSaving: null,
      lastSeen: null,
    };
    this.ws = null;
    this.wsBackoff = 1000;
    this.pollTimer = null;
    this.stopped = false;
    this.failures = 0;
    this.refreshing = new Map();
  }

  async start() {
    this.stopped = false;
    await this.refreshAll().catch((err) => log.debug(`${this.ip}: initial refresh failed: ${err.message}`));
    this.connectWs();
    this.schedulePoll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.wsTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      this.ws.terminate();
      this.ws = null;
    }
  }

  setIp(ip) {
    if (ip === this.ip) return;
    log.info(`${this.state.name || this.id}: address changed ${this.ip} -> ${ip}`);
    this.ip = ip;
    this.state.ip = ip;
    this.client = new SoundTouchClient(ip, { port: config.speakerPorts.http });
    this.upnp = new UpnpTransport(ip, { port: config.speakerPorts.upnp });
    if (this.ws) this.ws.terminate();
    this.changed('ip');
  }

  changed(part) {
    if (part === 'nowPlaying') this.state.nowPlayingAt = Date.now();
    this.emit('change', part);
  }

  markOnline(online) {
    if (online) {
      this.failures = 0;
      this.state.lastSeen = Date.now();
    }
    if (this.state.online !== online) {
      this.state.online = online;
      log.info(`${this.state.name || this.ip} is ${online ? 'online' : 'offline'}`);
      this.changed('online');
    }
  }

  async guard(fn) {
    try {
      const value = await fn();
      this.markOnline(true);
      return value;
    } catch (err) {
      if (err.code === 'UNREACHABLE') {
        this.failures += 1;
        if (this.failures >= 2) this.markOnline(false);
      } else {
        this.markOnline(true);
      }
      throw err;
    }
  }

  /** Refresh one part of the state, coalescing concurrent requests. */
  refresh(part) {
    if (this.refreshing.has(part)) return this.refreshing.get(part);
    const p = this.guard(() => this.fetchPart(part))
      .then((value) => {
        if (value !== undefined) {
          this.state[part] = value;
          if (part === 'info') {
            this.state.name = value.name || this.state.name;
            if (value.id) {
              this.id = value.id;
              this.state.id = value.id;
            }
          }
          this.changed(part);
        }
        return value;
      })
      .finally(() => this.refreshing.delete(part));
    this.refreshing.set(part, p);
    return p;
  }

  async fetchPart(part) {
    switch (part) {
      case 'info':
        return this.client.info();
      case 'nowPlaying':
        return this.client.nowPlaying();
      case 'volume':
        return this.client.volume();
      case 'presets':
        return this.client.presets();
      case 'sources':
        return this.client.sources();
      case 'bass':
        return this.client.bass().catch(() => null);
      case 'bassCaps':
        return this.client.bassCapabilities().catch(() => ({ available: false }));
      case 'zone':
        return this.client.zone().catch(() => null);
      case 'powerSaving':
        return this.client.powerSaving().catch(() => null);
      default:
        return undefined;
    }
  }

  async refreshAll() {
    await this.refresh('info');
    await Promise.allSettled(
      ['nowPlaying', 'volume', 'presets', 'sources', 'bassCaps', 'bass', 'zone', 'powerSaving'].map((p) => this.refresh(p)),
    );
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.stopped) return;
    const wsOk = this.ws && this.ws.readyState === WebSocket.OPEN;
    const interval = !this.state.online ? 15000 : wsOk ? 30000 : 4000;
    this.pollTimer = setTimeout(async () => {
      try {
        if (!this.state.online) await this.refreshAll();
        else {
          await this.refresh('nowPlaying');
          if (!wsOk) await this.refresh('volume');
        }
      } catch {
        /* handled by guard */
      }
      this.schedulePoll();
    }, interval);
  }

  connectWs() {
    if (this.stopped) return;
    clearTimeout(this.wsTimer);
    let ws;
    try {
      ws = new WebSocket(`ws://${this.ip}:${config.speakerPorts.ws}/`, 'gabbo', { handshakeTimeout: 5000 });
    } catch (err) {
      log.debug(`${this.ip}: websocket error ${err.message}`);
      this.retryWs();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.wsBackoff = 1000;
      log.debug(`${this.ip}: live updates connected`);
      this.markOnline(true);
      this.schedulePoll();
      // Catch up on anything missed while disconnected.
      this.refreshAll().catch(() => {});
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.schedulePoll();
      this.retryWs();
    });
    ws.on('error', (err) => log.debug(`${this.ip}: websocket ${err.message}`));
  }

  retryWs() {
    if (this.stopped) return;
    clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => this.connectWs(), this.wsBackoff);
    this.wsBackoff = Math.min(this.wsBackoff * 2, 30000);
  }

  onMessage(xml) {
    let doc;
    try {
      doc = parseXml(xml);
    } catch {
      return;
    }
    if (rootName(doc) !== 'updates') return;
    this.markOnline(true);
    const u = doc.updates || {};
    for (const key of Object.keys(u)) {
      if (key === '$') continue;
      const payload = u[key];
      switch (key) {
        case 'nowPlayingUpdated':
          if (payload && typeof payload === 'object' && payload.nowPlaying) {
            this.state.nowPlaying = normalizeNowPlaying(payload.nowPlaying);
            this.changed('nowPlaying');
          } else this.refresh('nowPlaying').catch(() => {});
          break;
        case 'nowSelectionUpdated':
          this.refresh('nowPlaying').catch(() => {});
          break;
        case 'volumeUpdated':
          if (payload && typeof payload === 'object' && payload.volume) {
            this.state.volume = normalizeVolume(payload.volume);
            this.changed('volume');
          } else this.refresh('volume').catch(() => {});
          break;
        case 'presetsUpdated':
          this.refresh('presets').catch(() => {});
          break;
        case 'zoneUpdated':
          this.refresh('zone').catch(() => {});
          this.emit('zoneUpdated');
          break;
        case 'bassUpdated':
          this.refresh('bass').catch(() => {});
          break;
        case 'sourcesUpdated':
          this.refresh('sources').catch(() => {});
          break;
        case 'infoUpdated':
        case 'nameUpdated':
          this.refresh('info').catch(() => {});
          break;
        case 'connectionStateUpdated':
          this.refresh('nowPlaying').catch(() => {});
          break;
        default:
          break;
      }
    }
  }

  // ---------------------------------------------------------------- actions

  get isStandby() {
    return !this.state.nowPlaying || this.state.nowPlaying.source === 'STANDBY';
  }

  async setPower(on) {
    await this.refresh('nowPlaying').catch(() => {});
    if (on === !this.isStandby) return;
    await this.guard(() => this.client.key('POWER'));
    await sleep(700);
    await this.refresh('nowPlaying').catch(() => {});
  }

  async setVolume(level) {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    await this.guard(() => this.client.setVolume(v));
    this.state.volume = { ...(this.state.volume || {}), level: v, target: v, muted: v > (this.state.volume?.level ?? 0) ? false : this.state.volume?.muted ?? false };
    this.changed('volume');
  }

  async setMuted(muted) {
    const vol = await this.refresh('volume');
    if (!!vol?.muted === !!muted) return;
    await this.guard(() => this.client.key('MUTE'));
    await sleep(250);
    await this.refresh('volume').catch(() => {});
  }

  async key(name) {
    await this.guard(() => this.client.key(name));
  }

  async select(xml) {
    await this.guard(() => this.client.select(xml));
  }

  /** Fade volume from its current level to `target` over `ms`. Aborts if the user changes it. */
  async fadeVolume(target, ms, { shouldContinue = () => true } = {}) {
    const startVol = (await this.refresh('volume').catch(() => null))?.level ?? this.state.volume?.level ?? 0;
    const steps = Math.max(1, Math.round(ms / 1500));
    let expected = startVol;
    for (let i = 1; i <= steps; i++) {
      if (!shouldContinue()) return false;
      const current = this.state.volume?.level;
      if (current != null && Math.abs(current - expected) > 2) return false; // someone else changed it
      expected = Math.round(startVol + ((target - startVol) * i) / steps);
      await this.setVolume(expected).catch(() => {});
      if (i < steps) await sleep(ms / steps);
    }
    return true;
  }
}
