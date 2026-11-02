import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('store');

const DEFAULT_STATE = () => ({
  version: 1,
  secret: crypto.randomBytes(24).toString('hex'),
  favorites: [],
  recents: [],
  alarms: [],
  sleepTimers: {},
  speakers: {},
  settings: {
    /** auto | direct | relay: how stream URLs are handed to the speaker. */
    streamMode: 'auto',
    /** auto | native | upnp: how the hub starts radio on a speaker. */
    playbackEngine: 'auto',
    activeSpeakerId: null,
  },
});

/**
 * Small JSON document store with atomic, debounced writes. Everything the hub
 * remembers (favorites, alarms, speaker setup backups) lives in one file so it
 * is easy to back up.
 */
export class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'airwave.json');
    this.state = DEFAULT_STATE();
    this.timer = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const base = DEFAULT_STATE();
      this.state = {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
      };
      for (const key of ['favorites', 'recents', 'alarms']) {
        if (!Array.isArray(this.state[key])) this.state[key] = [];
      }
      for (const key of ['speakers', 'sleepTimers']) {
        if (!this.state[key] || typeof this.state[key] !== 'object') this.state[key] = {};
      }
      if (!this.state.secret) this.state.secret = base.secret;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        log.error(`Could not read ${this.file} (${err.message}); keeping a copy at ${backup}`);
        try {
          fs.copyFileSync(this.file, backup);
        } catch {
          /* ignore */
        }
      }
      this.state = DEFAULT_STATE();
      this.flush();
    }
    return this;
  }

  get(key) {
    return this.state[key];
  }

  /** Mutate state through a callback, then persist. */
  update(fn) {
    const result = fn(this.state);
    this.save();
    this.emit('change');
    return result;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('Failed to save state:', err.message);
    }
  }
}
