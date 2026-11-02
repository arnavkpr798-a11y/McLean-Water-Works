import { EventEmitter } from 'node:events';
import { config, VERSION } from './config.js';
import { Speaker } from './speaker.js';
import { Discovery } from './discovery.js';
import { StreamResolver } from './resolver.js';
import { readStreamTitle } from './stream.js';
import { SoundTouchClient } from './soundtouch/client.js';
import {
  contentItemXml,
  normalizeStation,
  publicStation,
  rawContentItemXml,
  stationFromContentItem,
} from './stations.js';
import { HttpError, isIPv4, localAddressTowards, sleep } from './net.js';
import { logger } from './log.js';

const log = logger('hub');

/** Sources that mean "something other than our UPnP stream is playing". */
const NON_UPNP_SOURCES = new Set([
  'STANDBY',
  'BLUETOOTH',
  'AUX',
  'AIRPLAY',
  'SPOTIFY',
  'LOCAL_INTERNET_RADIO',
  'TUNEIN',
  'PRODUCT',
  'NOTIFICATION',
  'PANDORA',
  'DEEZER',
  'IHEART',
  'AMAZON',
  'SIRIUSXM',
  'INVALID_SOURCE',
]);

const MAX_RECENTS = 40;
const NATIVE_FETCH_TIMEOUT = 7000;

export class Hub extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.speakers = new Map(); // id -> Speaker
    this.pendingIps = new Set();
    this.sessions = new Map(); // speakerId -> session
    this.hubAddressCache = new Map();
    this.fetchWaiters = new Map(); // speaker ip -> [resolve]
    this.discovery = new Discovery();
    this.resolver = new StreamResolver({ secret: store.state.secret, settings: () => store.state.settings });
    this.resolver.on('title', (metaKey) => {
      for (const [id, s] of this.sessions) if (s.metaKey === metaKey) this.emitSpeaker(id);
    });
    this.metaTimer = null;
    this.emitTimers = new Map();
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    const known = Object.values(this.store.state.speakers || {});
    await Promise.allSettled(known.map((s) => this.attach(s.ip, s.id, s.name)));
    for (const ip of config.staticSpeakers) this.addByIp(ip).catch((err) => log.warn(`Configured speaker ${ip}: ${err.message}`));
    this.discovery.on('candidate', (ip) => this.addByIp(ip).catch(() => {}));
    this.discovery.start();
    if (config.discovery && !known.length && !config.staticSpeakers.length) {
      // First run: also sweep the subnet in case multicast is blocked.
      setTimeout(() => this.discovery.scanSubnets().catch(() => {}), 4000);
    }
    this.metaTimer = setInterval(() => this.pollMetadata().catch(() => {}), 25000);
  }

  stop() {
    clearInterval(this.metaTimer);
    this.discovery.stop();
    for (const sp of this.speakers.values()) sp.stop();
  }

  attach(ip, id, name) {
    if (id && this.speakers.has(id)) return this.speakers.get(id);
    const sp = new Speaker(ip, { id, name });
    sp.on('change', (part) => this.onSpeakerChange(sp, part));
    if (id) this.speakers.set(id, sp);
    sp.start().then(() => {
      if (!id && sp.id) this.speakers.set(sp.id, sp);
    });
    return sp;
  }

  /** Add (or re-address) a speaker by IP after confirming it is a SoundTouch. */
  async addByIp(rawIp) {
    const ip = String(rawIp || '').trim();
    if (!isIPv4(ip)) throw new HttpError(400, 'Enter a valid IPv4 address like 192.168.1.40');
    const existing = [...this.speakers.values()].find((s) => s.ip === ip);
    if (existing?.state.online) return existing;
    if (this.pendingIps.has(ip)) return existing || null;
    this.pendingIps.add(ip);
    try {
      let info;
      try {
        info = await new SoundTouchClient(ip, { port: config.speakerPorts.http, timeout: 3500 }).info();
      } catch {
        throw new HttpError(404, `No SoundTouch speaker answered at ${ip}`, 'not_found');
      }
      if (!info.id) throw new HttpError(404, `The device at ${ip} is not a SoundTouch speaker`, 'not_found');
      let sp = this.speakers.get(info.id);
      if (sp) {
        sp.setIp(ip);
        sp.refreshAll().catch(() => {});
      } else {
        log.info(`Found ${info.name} (${info.type}) at ${ip}`);
        sp = new Speaker(ip, { id: info.id, name: info.name });
        sp.on('change', (part) => this.onSpeakerChange(sp, part));
        this.speakers.set(info.id, sp);
        await sp.start();
      }
      this.persistSpeaker(sp);
      if (!this.store.state.settings.activeSpeakerId) {
        this.store.update((s) => {
          s.settings.activeSpeakerId = info.id;
        });
      }
      this.emit('speakers');
      return sp;
    } finally {
      this.pendingIps.delete(ip);
    }
  }

  forget(id) {
    const sp = this.speaker(id);
    sp.stop();
    this.speakers.delete(id);
    this.sessions.delete(id);
    this.store.update((s) => {
      delete s.speakers[id];
      delete s.sleepTimers[id];
      if (s.settings.activeSpeakerId === id) s.settings.activeSpeakerId = [...this.speakers.keys()][0] || null;
    });
    this.emit('speakers');
  }

  persistSpeaker(sp) {
    if (!sp.id) return;
    const prev = this.store.state.speakers[sp.id] || {};
    const next = { ...prev, id: sp.id, ip: sp.ip, name: sp.state.name || prev.name || '', type: sp.state.info?.type || prev.type || '' };
    if (prev.ip === next.ip && prev.name === next.name && prev.type === next.type) return;
    this.store.update((s) => {
      s.speakers[sp.id] = next;
    });
  }

  onSpeakerChange(sp, part) {
    if (!sp.id) return;
    if (!this.speakers.has(sp.id)) this.speakers.set(sp.id, sp);
    if (part === 'info' || part === 'ip') this.persistSpeaker(sp);
    if (part === 'online' && sp.state.online) this.checkRadioAddress(sp).catch(() => {});
    this.emitSpeaker(sp.id);
  }

  /** Coalesce bursts of changes into one push to the app. */
  emitSpeaker(id) {
    if (this.emitTimers.has(id)) return;
    this.emitTimers.set(
      id,
      setTimeout(() => {
        this.emitTimers.delete(id);
        const sp = this.speakers.get(id);
        if (sp) this.emit('speaker', this.publicSpeaker(sp));
      }, 60),
    );
  }

  speaker(id) {
    const sp = this.speakers.get(id);
    if (!sp) throw new HttpError(404, 'Speaker not found', 'speaker_not_found');
    return sp;
  }

  onlineSpeaker(id) {
    const sp = this.speaker(id);
    if (!sp.state.online) throw new HttpError(503, `${sp.state.name || 'The speaker'} is offline. Check it is plugged in and on Wi-Fi.`, 'speaker_offline');
    return sp;
  }

  // ---------------------------------------------------------------- addresses

  /** http://<hub ip as seen from this speaker>:<port> */
  async hubBaseFor(sp) {
    if (config.publicAddress) {
      const addr = config.publicAddress.replace(/^https?:\/\//, '').replace(/\/$/, '');
      return addr.includes(':') ? `http://${addr}` : `http://${addr}:${config.port}`;
    }
    const cached = this.hubAddressCache.get(sp.ip);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const addr = await localAddressTowards(sp.ip);
    const value = `http://${addr}:${config.port}`;
    this.hubAddressCache.set(sp.ip, { at: Date.now(), value });
    return value;
  }

  speakerByIp(ip) {
    const clean = String(ip || '').replace(/^::ffff:/, '');
    return [...this.speakers.values()].find((s) => s.ip === clean) || null;
  }

  radioInfo(id) {
    return this.store.state.speakers[id]?.radio || null;
  }

  setRadioInfo(id, patch) {
    this.store.update((s) => {
      const entry = s.speakers[id] || (s.speakers[id] = { id });
      entry.radio = { ...(entry.radio || {}), ...patch };
    });
    this.emitSpeaker(id);
  }

  /** If the hub's address changed since radio setup, the speaker must be re-pointed. */
  async checkRadioAddress(sp) {
    const radio = this.radioInfo(sp.id);
    if (!radio || radio.status !== 'enabled' || !radio.registryUrl) return;
    const expected = `${await this.hubBaseFor(sp)}/bmx/registry/v1/services`;
    if (radio.registryUrl !== expected && !radio.addressMismatch) {
      log.warn(`${sp.state.name}: hub address changed (${radio.registryUrl} -> ${expected}); radio setup needs a repair`);
      this.setRadioInfo(sp.id, { addressMismatch: true });
      this.emit('radio-address-changed', sp.id);
    } else if (radio.registryUrl === expected && radio.addressMismatch) {
      this.setRadioInfo(sp.id, { addressMismatch: false });
    }
  }

  // ---------------------------------------------------------------- speaker callbacks (BMX)

  /** Called by the BMX routes whenever a speaker fetches the registry. */
  noteRegistryFetch(ip) {
    const sp = this.speakerByIp(ip);
    if (!sp) return;
    this.setRadioInfo(sp.id, { registrySeenAt: Date.now() });
  }

  /** Called by the BMX routes when a speaker asks how to play a station. */
  noteStationFetch(ip, station, resolved, error) {
    const sp = this.speakerByIp(ip);
    if (sp) {
      this.setRadioInfo(sp.id, { nativeOk: true, lastStationFetchAt: Date.now(), registrySeenAt: Date.now() });
      if (station && resolved) {
        this.setSession(sp.id, { station, engine: 'native', ...resolved, origin: 'speaker' });
      }
      if (station && error) {
        this.setSession(sp.id, { station, engine: 'native', error: error.message, origin: 'speaker' });
      }
    }
    const waiters = this.fetchWaiters.get(String(ip).replace(/^::ffff:/, ''));
    if (waiters) {
      this.fetchWaiters.delete(String(ip).replace(/^::ffff:/, ''));
      for (const w of waiters) w({ station, error });
    }
  }

  waitForStationFetch(ip, timeout) {
    return new Promise((resolve) => {
      const list = this.fetchWaiters.get(ip) || [];
      let done = false;
      const fn = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const arr = this.fetchWaiters.get(ip) || [];
        this.fetchWaiters.set(
          ip,
          arr.filter((x) => x !== fn),
        );
        fn(null);
      }, timeout);
      list.push(fn);
      this.fetchWaiters.set(ip, list);
    });
  }

  // ---------------------------------------------------------------- playback

  setSession(id, session) {
    this.sessions.set(id, { ...session, startedAt: Date.now() });
    this.emitSpeaker(id);
  }

  /** The hub session if it still describes what the speaker is playing. */
  currentSession(sp) {
    const s = this.sessions.get(sp.id);
    const np = sp.state.nowPlaying;
    if (!s || !np) return null;
    if (np.source === 'STANDBY') return null;
    let matches;
    if (s.engine === 'native') {
      const st = stationFromContentItem(np.item);
      matches = !!st && st.key === s.station.key;
    } else matches = !NON_UPNP_SOURCES.has(np.source);
    if (matches) return s;
    // Right after starting, the speaker may still report the previous source.
    const settled = (sp.state.nowPlayingAt || 0) > s.startedAt + 2500;
    return !settled && Date.now() - s.startedAt < 8000 ? s : null;
  }

  chooseEngine(sp) {
    const pref = this.store.state.settings.playbackEngine || 'auto';
    if (pref === 'native' || pref === 'upnp') return pref;
    const radio = this.radioInfo(sp.id);
    return radio?.status === 'enabled' && radio.nativeOk !== false && !radio.addressMismatch ? 'native' : 'upnp';
  }

  /**
   * Play a station on a speaker.
   * Native engine: tell the speaker to play a LOCAL_INTERNET_RADIO item; it
   * calls back into the hub for the stream (requires radio setup).
   * UPnP engine: hand the speaker a plain-http stream URL directly (works on
   * any speaker, no setup).
   */
  async play(id, rawStation, { volume } = {}) {
    const station = normalizeStation(rawStation);
    const sp = this.onlineSpeaker(id);
    const hubBase = await this.hubBaseFor(sp);
    let engine = this.chooseEngine(sp);

    // Resolve first so problems surface immediately with a clear message.
    const resolved = await this.resolver.resolve(station, { hubBase, requireHttp: engine === 'upnp' });

    if (volume != null) await sp.setVolume(volume).catch(() => {});

    if (engine === 'native') {
      const wait = this.waitForStationFetch(sp.ip, NATIVE_FETCH_TIMEOUT);
      await sp.select(contentItemXml(station));
      const fetched = await wait;
      if (fetched?.error) throw new HttpError(502, fetched.error.message, 'stream_unavailable');
      if (!fetched) {
        log.warn(`${sp.state.name} did not request the station from the hub; falling back to UPnP`);
        this.setRadioInfo(sp.id, { nativeOk: false, nativeFailedAt: Date.now() });
        if ((this.store.state.settings.playbackEngine || 'auto') === 'native') {
          throw new HttpError(
            502,
            'The speaker did not contact the hub. Open Settings → Preset buttons & radio and choose Repair.',
            'native_failed',
          );
        }
        engine = 'upnp';
      }
    }

    if (engine === 'upnp') {
      const upnpResolved = resolved.streamUrl.startsWith('http://')
        ? resolved
        : await this.resolver.resolve(station, { hubBase, requireHttp: true });
      if (sp.isStandby) {
        await sp.key('POWER').catch(() => {});
        await sleep(1500);
      }
      try {
        await sp.upnp.playUrl(upnpResolved.streamUrl, {
          title: station.name,
          image: station.image,
          mime: upnpResolved.contentType.split(';')[0],
        });
      } catch (err) {
        throw new HttpError(502, `The speaker refused the stream (${err.message})`, 'upnp_failed');
      }
      this.setSession(sp.id, { station, engine: 'upnp', ...upnpResolved, origin: 'app' });
    } else {
      this.setSession(sp.id, { station, engine: 'native', ...resolved, origin: 'app' });
    }

    this.addRecent(station);
    setTimeout(() => sp.refresh('nowPlaying').catch(() => {}), 1500);
    setTimeout(() => this.pollMetadataFor(sp.id).catch(() => {}), 4000);
    return { engine, station: publicStation(station) };
  }

  async transport(id, action) {
    const sp = this.onlineSpeaker(id);
    const session = this.currentSession(sp);
    const np = sp.state.nowPlaying;
    switch (action) {
      case 'play':
        if (sp.isStandby) return this.resume(id);
        if (session?.engine === 'upnp') return sp.upnp.play().catch(() => this.play(id, session.station));
        return sp.key('PLAY');
      case 'pause':
        if (session?.engine === 'upnp') return sp.upnp.pause().catch(() => sp.upnp.stop());
        return sp.key('PAUSE');
      case 'toggle':
        if (np?.status === 'playing' || np?.status === 'buffering') return this.transport(id, 'pause');
        return this.transport(id, 'play');
      case 'stop':
        if (session?.engine === 'upnp') return sp.upnp.stop();
        return sp.key('STOP');
      case 'next':
        return sp.key('NEXT_TRACK');
      case 'prev':
        return sp.key('PREV_TRACK');
      case 'thumbsUp':
        return sp.key('THUMBS_UP');
      case 'thumbsDown':
        return sp.key('THUMBS_DOWN');
      default:
        throw new HttpError(400, 'Unknown transport action');
    }
  }

  /** Power on and continue with the last thing played (falls back to the speaker's own resume). */
  async resume(id) {
    const sp = this.onlineSpeaker(id);
    const last = this.sessions.get(id)?.station || this.store.state.recents[0]?.station;
    if (sp.isStandby && !last) return sp.setPower(true);
    if (last) return this.play(id, last);
    return sp.key('PLAY');
  }

  async power(id, on) {
    const sp = this.onlineSpeaker(id);
    await sp.setPower(!!on);
    if (!on) this.sessions.delete(id);
  }

  async volume(id, { level, delta, muted }) {
    const sp = this.onlineSpeaker(id);
    if (muted !== undefined) await sp.setMuted(!!muted);
    if (level !== undefined || delta !== undefined) {
      const base = sp.state.volume?.level ?? (await sp.refresh('volume')).level;
      const target = level !== undefined ? Number(level) : base + Number(delta);
      if (!Number.isFinite(target)) throw new HttpError(400, 'Volume must be a number');
      await sp.setVolume(target);
    }
    return sp.state.volume;
  }

  async source(id, source) {
    const sp = this.onlineSpeaker(id);
    if (source === 'BLUETOOTH' || source === 'AUX') {
      this.sessions.delete(id);
      this.emitSpeaker(id);
    }
    if (source === 'BLUETOOTH') return sp.select('<ContentItem source="BLUETOOTH"></ContentItem>');
    if (source === 'AUX') {
      const aux = (sp.state.sources || []).find((s) => s.source === 'AUX');
      return sp.select(`<ContentItem source="AUX" sourceAccount="${aux?.account || 'AUX'}"></ContentItem>`);
    }
    if (source === 'RADIO') return this.resume(id);
    throw new HttpError(400, 'Unsupported source');
  }

  async bluetooth(id, action) {
    const sp = this.onlineSpeaker(id);
    if (action === 'pair') {
      this.sessions.delete(id);
      await sp.select('<ContentItem source="BLUETOOTH"></ContentItem>').catch(() => {});
      await sp.guard(() => sp.client.enterBluetoothPairing());
    } else if (action === 'clear') {
      await sp.guard(() => sp.client.clearBluetoothPaired());
    } else throw new HttpError(400, 'Unknown Bluetooth action');
  }

  // ---------------------------------------------------------------- presets

  async storePreset(id, slot, { station, current } = {}) {
    const n = Number(slot);
    if (!(n >= 1 && n <= 6)) throw new HttpError(400, 'Preset must be 1 to 6');
    const sp = this.onlineSpeaker(id);
    let xml;
    if (station) {
      xml = contentItemXml(normalizeStation(station));
    } else if (current) {
      const session = this.currentSession(sp);
      const np = await sp.refresh('nowPlaying');
      if (session) xml = contentItemXml(session.station);
      else if (np?.item && np.item.isPresetable && np.item.location) xml = rawContentItemXml({ ...np.item, art: np.item.art || np.art });
      else throw new HttpError(400, 'What is playing now cannot be saved as a preset', 'not_presetable');
    } else throw new HttpError(400, 'Nothing to store');
    await sp.guard(() => sp.client.storePreset(n, xml));
    await sp.refresh('presets');
  }

  async removePreset(id, slot) {
    const n = Number(slot);
    if (!(n >= 1 && n <= 6)) throw new HttpError(400, 'Preset must be 1 to 6');
    const sp = this.onlineSpeaker(id);
    await sp.guard(() => sp.client.removePreset(n));
    await sp.refresh('presets');
  }

  async playPreset(id, slot) {
    const n = Number(slot);
    if (!(n >= 1 && n <= 6)) throw new HttpError(400, 'Preset must be 1 to 6');
    const sp = this.onlineSpeaker(id);
    const preset = (sp.state.presets || []).find((p) => p.slot === n);
    if (!preset) throw new HttpError(404, `Preset ${n} is empty`, 'preset_empty');
    const station = stationFromContentItem(preset.item);
    if (station) return this.play(id, station);
    this.sessions.delete(id);
    await sp.key(`PRESET_${n}`);
    return { engine: 'speaker' };
  }

  // ---------------------------------------------------------------- multi-room

  async createZone(masterId, memberIds) {
    const master = this.onlineSpeaker(masterId);
    const members = [...new Set(memberIds)].filter((m) => m !== masterId).map((m) => this.onlineSpeaker(m));
    if (!members.length) throw new HttpError(400, 'Pick at least one other speaker');
    await master.guard(() =>
      master.client.setZone(
        master.id,
        master.ip,
        members.map((m) => ({ id: m.id, ip: m.ip })),
      ),
    );
    await sleep(800);
    await Promise.allSettled([master, ...members].map((s) => s.refresh('zone')));
  }

  async addToZone(masterId, memberId) {
    const master = this.onlineSpeaker(masterId);
    const member = this.onlineSpeaker(memberId);
    const zone = await master.refresh('zone');
    if (!zone || zone.master !== master.id) return this.createZone(masterId, [memberId]);
    await master.guard(() => master.client.addZoneSlave(master.id, [{ id: member.id, ip: member.ip }]));
    await sleep(800);
    await Promise.allSettled([master, member].map((s) => s.refresh('zone')));
  }

  async removeFromZone(masterId, memberId) {
    const master = this.onlineSpeaker(masterId);
    const member = this.speaker(memberId);
    await master.guard(() => master.client.removeZoneSlave(master.id, [{ id: member.id, ip: member.ip }]));
    await sleep(800);
    await Promise.allSettled([master, member].map((s) => s.refresh('zone')));
  }

  async dissolveZone(masterId) {
    const master = this.onlineSpeaker(masterId);
    const zone = await master.refresh('zone');
    if (!zone) return;
    const members = zone.members.filter((m) => m.id && m.id !== master.id);
    if (members.length) await master.guard(() => master.client.removeZoneSlave(master.id, members.map((m) => ({ id: m.id, ip: m.ip }))));
    await sleep(800);
    await Promise.allSettled([master, ...members.map((m) => this.speakers.get(m.id)).filter(Boolean)].map((s) => s.refresh('zone')));
  }

  // ---------------------------------------------------------------- settings on speaker

  async rename(id, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new HttpError(400, 'Name cannot be empty');
    const sp = this.onlineSpeaker(id);
    await sp.guard(() => sp.client.setName(clean));
    await sp.refresh('info');
  }

  async setBass(id, level) {
    const sp = this.onlineSpeaker(id);
    const caps = sp.state.bassCaps || (await sp.refresh('bassCaps'));
    if (!caps?.available) throw new HttpError(400, 'This speaker does not support bass adjustment');
    const v = Math.max(caps.min, Math.min(caps.max, Math.round(Number(level))));
    await sp.guard(() => sp.client.setBass(v));
    await sp.refresh('bass');
  }

  async setPowerSaving(id, enabled) {
    const sp = this.onlineSpeaker(id);
    await sp.guard(() => sp.client.setPowerSaving(!!enabled));
    await sp.refresh('powerSaving');
  }

  // ---------------------------------------------------------------- library

  addRecent(station) {
    this.store.update((s) => {
      s.recents = [{ station: publicStation(station), at: Date.now() }, ...s.recents.filter((r) => r.station?.key !== station.key)].slice(
        0,
        MAX_RECENTS,
      );
    });
    this.emit('library');
  }

  clearRecents() {
    this.store.update((s) => {
      s.recents = [];
    });
    this.emit('library');
  }

  addFavorite(raw) {
    const station = normalizeStation(raw);
    this.store.update((s) => {
      const existing = s.favorites.findIndex((f) => f.station.key === station.key);
      const entry = { station: publicStation(station), addedAt: Date.now() };
      if (existing >= 0) s.favorites[existing] = { ...s.favorites[existing], station: entry.station };
      else s.favorites.push(entry);
    });
    this.emit('library');
    return publicStation(station);
  }

  updateFavorite(key, patch) {
    let found = false;
    this.store.update((s) => {
      const fav = s.favorites.find((f) => f.station.key === key);
      if (!fav) return;
      found = true;
      const merged = normalizeStation({ ...fav.station, ...patch, type: fav.station.type, id: fav.station.id, url: patch.url ?? fav.station.url });
      fav.station = publicStation(merged);
    });
    if (!found) throw new HttpError(404, 'Favorite not found');
    this.emit('library');
  }

  removeFavorite(key) {
    this.store.update((s) => {
      s.favorites = s.favorites.filter((f) => f.station.key !== key);
    });
    this.emit('library');
  }

  reorderFavorites(keys) {
    if (!Array.isArray(keys)) throw new HttpError(400, 'keys must be an array');
    this.store.update((s) => {
      const byKey = new Map(s.favorites.map((f) => [f.station.key, f]));
      const ordered = keys.map((k) => byKey.get(k)).filter(Boolean);
      const rest = s.favorites.filter((f) => !keys.includes(f.station.key));
      s.favorites = [...ordered, ...rest];
    });
    this.emit('library');
  }

  findFavorite(query) {
    const favs = this.store.state.favorites;
    if (query == null || query === '') return null;
    const n = Number(query);
    if (Number.isInteger(n) && n >= 1 && n <= favs.length) return favs[n - 1].station;
    const q = String(query).toLowerCase().trim();
    return (
      favs.find((f) => f.station.name.toLowerCase() === q)?.station ||
      favs.find((f) => f.station.name.toLowerCase().includes(q))?.station ||
      null
    );
  }

  updateSettings(patch) {
    const allowed = {
      streamMode: ['auto', 'direct', 'relay'],
      playbackEngine: ['auto', 'native', 'upnp'],
    };
    this.store.update((s) => {
      for (const [k, values] of Object.entries(allowed)) {
        if (patch[k] !== undefined) {
          if (!values.includes(patch[k])) throw new HttpError(400, `Invalid value for ${k}`);
          s.settings[k] = patch[k];
        }
      }
      if (patch.activeSpeakerId !== undefined) {
        if (patch.activeSpeakerId && !this.speakers.has(patch.activeSpeakerId)) throw new HttpError(404, 'Speaker not found');
        s.settings.activeSpeakerId = patch.activeSpeakerId;
      }
    });
    this.emit('settings');
  }

  // ---------------------------------------------------------------- metadata

  async pollMetadataFor(id) {
    const sp = this.speakers.get(id);
    if (!sp) return;
    const session = this.currentSession(sp);
    if (!session || session.relayed || !session.sourceUrl || !session.icy) return;
    if (sp.state.nowPlaying?.status !== 'playing' && sp.state.nowPlaying?.status !== 'buffering') return;
    const title = await readStreamTitle(session.sourceUrl).catch(() => null);
    if (title != null) this.resolver.setTitle(session.metaKey, title);
  }

  async pollMetadata() {
    await Promise.allSettled([...this.speakers.keys()].map((id) => this.pollMetadataFor(id)));
  }

  // ---------------------------------------------------------------- views

  publicSpeaker(sp) {
    const s = sp.state;
    const session = this.currentSession(sp);
    const np = s.nowPlaying;
    const decoded = np ? stationFromContentItem(np.item) : null;
    const station = session?.station || decoded;
    const radio = this.radioInfo(sp.id) || {};
    const sleepTimer = this.store.state.sleepTimers[sp.id] || null;
    const presets = [1, 2, 3, 4, 5, 6].map((slot) => {
      const p = (s.presets || []).find((x) => x.slot === slot);
      if (!p) return { slot, empty: true };
      const st = stationFromContentItem(p.item);
      return {
        slot,
        empty: false,
        name: p.item.name || st?.name || `Preset ${slot}`,
        art: p.item.art || st?.image || '',
        source: p.item.source,
        station: st ? publicStation(st) : null,
        legacyTuneIn: p.item.source === 'TUNEIN',
      };
    });
    return {
      id: sp.id,
      ip: sp.ip,
      name: s.name || s.info?.name || sp.ip,
      online: s.online,
      lastSeen: s.lastSeen,
      model: s.info?.type || '',
      firmware: s.info?.firmware || '',
      serial: s.info?.serial || '',
      mac: s.info?.mac || sp.id,
      accountLinked: !!s.info?.accountId,
      nowPlaying: np
        ? {
            ...np,
            station: station ? publicStation(station) : null,
            streamTitle: session?.metaKey ? this.resolver.getTitle(session.metaKey) : '',
            engine: session?.engine || null,
            error: session?.error || null,
          }
        : null,
      volume: s.volume,
      bass: s.bassCaps?.available ? { ...s.bassCaps, level: s.bass?.level ?? s.bassCaps.default } : null,
      powerSaving: s.powerSaving,
      presets,
      sources: s.sources || [],
      zone: s.zone,
      sleepTimer,
      radio: {
        status: radio.status || 'not-configured',
        registryUrl: radio.registryUrl || '',
        enabledAt: radio.enabledAt || null,
        registrySeenAt: radio.registrySeenAt || null,
        lastStationFetchAt: radio.lastStationFetchAt || null,
        nativeOk: radio.nativeOk ?? null,
        addressMismatch: !!radio.addressMismatch,
        hasBackup: !!radio.original,
      },
      engine: this.chooseEngine(sp),
    };
  }

  publicState() {
    const s = this.store.state;
    return {
      hub: {
        version: VERSION,
        time: Date.now(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
        port: config.port,
        discovery: config.discovery,
        activeRelays: this.resolver.activeRelays.size,
      },
      settings: s.settings,
      speakers: [...this.speakers.values()].filter((sp) => sp.id).map((sp) => this.publicSpeaker(sp)),
      favorites: s.favorites,
      recents: s.recents,
      alarms: s.alarms,
    };
  }
}
