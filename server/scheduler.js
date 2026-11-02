import crypto from 'node:crypto';
import { HttpError, sleep } from './net.js';
import { normalizeStation, publicStation } from './stations.js';
import { logger } from './log.js';

const log = logger('scheduler');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Alarms ("wake up to radio") and sleep timers. Both run on the hub, so they
 * work even when every phone is switched off.
 */
export class Scheduler {
  constructor(hub, store) {
    this.hub = hub;
    this.store = store;
    this.timer = null;
    this.running = new Set();
    this.fading = new Map();
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 10000);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const now = new Date();
    this.checkSleepTimers(now).catch((err) => log.error('sleep timers', err.message));
    this.checkAlarms(now).catch((err) => log.error('alarms', err.message));
  }

  // ---------------------------------------------------------------- sleep timers

  setSleep(speakerId, minutes, { fade = true } = {}) {
    this.hub.speaker(speakerId);
    if (minutes == null || minutes === 0) {
      this.store.update((s) => {
        delete s.sleepTimers[speakerId];
      });
      this.fading.delete(speakerId);
      this.hub.emitSpeaker(speakerId);
      return null;
    }
    const m = Number(minutes);
    if (!(m >= 1 && m <= 600)) throw new HttpError(400, 'Sleep timer must be between 1 and 600 minutes');
    const timer = { minutes: m, endsAt: Date.now() + m * 60000, fade: !!fade, setAt: Date.now() };
    this.store.update((s) => {
      s.sleepTimers[speakerId] = timer;
    });
    this.hub.emitSpeaker(speakerId);
    return timer;
  }

  async checkSleepTimers(now) {
    for (const [id, t] of Object.entries(this.store.state.sleepTimers)) {
      const sp = this.hub.speakers.get(id);
      if (!sp) continue;
      const remaining = t.endsAt - now.getTime();
      if (t.fade && remaining <= 60000 && remaining > 0 && !this.fading.has(id) && !sp.isStandby) {
        this.fadeOutAndSleep(id, t).catch((err) => log.warn(`sleep fade: ${err.message}`));
      } else if (remaining <= 0 && !this.fading.has(id)) {
        this.fading.set(id, true);
        this.finishSleep(id, null).catch((err) => log.warn(`sleep: ${err.message}`));
      }
    }
  }

  async fadeOutAndSleep(id, t) {
    const sp = this.hub.speakers.get(id);
    this.fading.set(id, true);
    const original = sp.state.volume?.level ?? null;
    const stillSet = () => this.store.state.sleepTimers[id]?.endsAt === t.endsAt;
    const fadeMs = Math.max(5000, t.endsAt - Date.now());
    await sp.fadeVolume(Math.max(0, Math.round((original ?? 10) * 0.15)), fadeMs, { shouldContinue: stillSet });
    if (!stillSet()) {
      this.fading.delete(id);
      return;
    }
    await this.finishSleep(id, original);
  }

  async finishSleep(id, restoreVolume) {
    const sp = this.hub.speakers.get(id);
    try {
      if (sp && sp.state.online && !sp.isStandby) {
        log.info(`Sleep timer: turning off ${sp.state.name}`);
        // Silence first, put the volume back for next time, then switch off.
        await sp.key('STOP').catch(() => {});
        if (restoreVolume != null) await sp.setVolume(restoreVolume).catch(() => {});
        await sleep(300);
        await this.hub.power(id, false).catch(() => {});
      }
    } finally {
      this.store.update((s) => {
        delete s.sleepTimers[id];
      });
      this.fading.delete(id);
      this.hub.emitSpeaker(id);
    }
  }

  // ---------------------------------------------------------------- alarms

  validateAlarm(input, existing = {}) {
    const a = { ...existing };
    if (input.label !== undefined) a.label = String(input.label || '').trim().slice(0, 40);
    if (input.time !== undefined) {
      if (!TIME_RE.test(String(input.time))) throw new HttpError(400, 'Time must look like 07:30');
      a.time = String(input.time);
    }
    if (input.days !== undefined) {
      if (!Array.isArray(input.days)) throw new HttpError(400, 'days must be a list');
      a.days = [...new Set(input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    }
    if (input.speakerId !== undefined) {
      this.hub.speaker(input.speakerId);
      a.speakerId = input.speakerId;
    }
    if (input.target !== undefined) {
      const t = input.target || {};
      if (t.kind === 'station') a.target = { kind: 'station', station: publicStation(normalizeStation(t.station)) };
      else if (t.kind === 'preset') {
        const slot = Number(t.slot);
        if (!(slot >= 1 && slot <= 6)) throw new HttpError(400, 'Preset must be 1 to 6');
        a.target = { kind: 'preset', slot };
      } else if (t.kind === 'resume') a.target = { kind: 'resume' };
      else throw new HttpError(400, 'Choose what the alarm should play');
    }
    if (input.volume !== undefined) {
      const v = Number(input.volume);
      if (!(v >= 0 && v <= 100)) throw new HttpError(400, 'Volume must be 0 to 100');
      a.volume = Math.round(v);
    }
    if (input.fadeIn !== undefined) a.fadeIn = !!input.fadeIn;
    if (input.enabled !== undefined) a.enabled = !!input.enabled;
    if (input.autoOffMinutes !== undefined) {
      const m = input.autoOffMinutes == null || input.autoOffMinutes === '' ? null : Number(input.autoOffMinutes);
      if (m != null && !(m >= 1 && m <= 600)) throw new HttpError(400, 'Auto-off must be 1 to 600 minutes');
      a.autoOffMinutes = m;
    }
    if (!a.time || !a.speakerId || !a.target) throw new HttpError(400, 'An alarm needs a time, a speaker and something to play');
    if (!Array.isArray(a.days)) a.days = [];
    if (a.volume == null) a.volume = 25;
    if (a.fadeIn == null) a.fadeIn = true;
    if (a.enabled == null) a.enabled = true;
    return a;
  }

  createAlarm(input) {
    const alarm = { id: crypto.randomUUID(), createdAt: Date.now(), ...this.validateAlarm(input) };
    this.store.update((s) => {
      s.alarms.push(alarm);
    });
    this.hub.emit('library');
    return alarm;
  }

  updateAlarm(id, input) {
    const existing = this.store.state.alarms.find((a) => a.id === id);
    if (!existing) throw new HttpError(404, 'Alarm not found');
    const next = this.validateAlarm(input, existing);
    // Re-arm a one-off alarm when it is edited or switched back on.
    if (input.time !== undefined || input.enabled === true) delete next.lastFired;
    this.store.update((s) => {
      s.alarms = s.alarms.map((a) => (a.id === id ? next : a));
    });
    this.hub.emit('library');
    return next;
  }

  deleteAlarm(id) {
    this.store.update((s) => {
      s.alarms = s.alarms.filter((a) => a.id !== id);
    });
    this.hub.emit('library');
  }

  /** Next time (ms) an alarm will go off, or null. Exposed for the app. */
  static nextFire(alarm, from = new Date()) {
    if (!alarm.enabled) return null;
    const [h, m] = alarm.time.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(h, m, 0, 0);
      if (d <= from) continue;
      if (!alarm.days.length || alarm.days.includes(d.getDay())) return d.getTime();
    }
    return null;
  }

  async checkAlarms(now) {
    const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const hhmm = stamp.slice(-5);
    for (const alarm of this.store.state.alarms) {
      if (!alarm.enabled || alarm.time !== hhmm) continue;
      if (alarm.days.length && !alarm.days.includes(now.getDay())) continue;
      if (alarm.lastFired === stamp || this.running.has(alarm.id)) continue;
      this.store.update(() => {
        alarm.lastFired = stamp;
        if (!alarm.days.length) alarm.enabled = false; // one-off alarm
      });
      this.fire(alarm).catch((err) => log.error(`Alarm "${alarm.label || alarm.time}" failed: ${err.message}`));
    }
  }

  async fire(alarm) {
    this.running.add(alarm.id);
    try {
      log.info(`Alarm ${alarm.label || alarm.time} firing on ${alarm.speakerId}`);
      const sp = this.hub.speakers.get(alarm.speakerId);
      if (!sp) throw new Error('speaker no longer exists');
      if (!sp.state.online) {
        await sp.refreshAll().catch(() => {});
        if (!sp.state.online) throw new Error('speaker is offline');
      }
      const startVolume = alarm.fadeIn ? Math.min(alarm.volume, 6) : alarm.volume;
      if (alarm.target.kind === 'station') await this.hub.play(sp.id, alarm.target.station, { volume: startVolume });
      else if (alarm.target.kind === 'preset') {
        await sp.setVolume(startVolume).catch(() => {});
        await this.hub.playPreset(sp.id, alarm.target.slot);
      } else {
        await sp.setVolume(startVolume).catch(() => {});
        await this.hub.resume(sp.id);
      }
      if (alarm.fadeIn && alarm.volume > startVolume) {
        await sleep(4000);
        await sp.fadeVolume(alarm.volume, 60000);
      }
      if (alarm.autoOffMinutes) this.setSleep(sp.id, alarm.autoOffMinutes);
      this.store.update(() => {
        alarm.lastResult = { ok: true, at: Date.now() };
      });
    } catch (err) {
      this.store.update(() => {
        alarm.lastResult = { ok: false, at: Date.now(), error: err.message };
      });
      throw err;
    } finally {
      this.running.delete(alarm.id);
      this.hub.emit('library');
    }
  }
}
