import { httpRequest } from '../net.js';
import { attr, escapeXml, parseXml, rootName, text } from './xml.js';
import {
  normalizeBass,
  normalizeBassCaps,
  normalizeCapabilities,
  normalizeInfo,
  normalizeNowPlaying,
  normalizePresets,
  normalizeSources,
  normalizeVolume,
  normalizeZone,
} from './models.js';

export const KEYS = new Set([
  'PLAY',
  'PAUSE',
  'STOP',
  'PREV_TRACK',
  'NEXT_TRACK',
  'THUMBS_UP',
  'THUMBS_DOWN',
  'BOOKMARK',
  'POWER',
  'MUTE',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'PRESET_1',
  'PRESET_2',
  'PRESET_3',
  'PRESET_4',
  'PRESET_5',
  'PRESET_6',
  'AUX_INPUT',
  'SHUFFLE_OFF',
  'SHUFFLE_ON',
  'REPEAT_OFF',
  'REPEAT_ONE',
  'REPEAT_ALL',
  'PLAY_PAUSE',
  'ADD_FAVORITE',
  'REMOVE_FAVORITE',
]);

/** Friendly messages for the speaker's numeric error codes. */
const ERROR_HINTS = {
  1005: 'The speaker rejected this source. If it was factory-reset it may need to be set up in the Bose app first.',
  1019: 'The speaker could not understand the request.',
  1023: 'This source is not available on the speaker right now.',
  1026: 'The speaker is busy, try again in a moment.',
  1027: 'The speaker is busy, try again in a moment.',
  1043: 'This content is not available.',
};

export class SpeakerError extends Error {
  constructor(message, { code, name, status } = {}) {
    super(message);
    this.code = code;
    this.errorName = name;
    this.status = status;
  }
}

/** Client for the SoundTouch Web API (HTTP, port 8090). */
export class SoundTouchClient {
  constructor(host, { port = 8090, timeout = 6000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
  }

  async request(method, path, body, { timeout } = {}) {
    let res;
    try {
      res = await httpRequest({
        host: this.host,
        port: this.port,
        method,
        path,
        body,
        timeout: timeout ?? this.timeout,
        headers: body != null ? { 'Content-Type': 'application/xml; charset=utf-8' } : {},
      });
    } catch (err) {
      throw new SpeakerError(`Speaker at ${this.host} is not responding (${err.code || err.message})`, {
        code: 'UNREACHABLE',
      });
    }
    const doc = parseXml(res.body);
    const root = rootName(doc);
    if (root === 'errors' || root === 'error' || res.status >= 400) {
      const errs = doc.errors?.error || [];
      const first = errs[0];
      const code = Number.parseInt(attr(first, 'value'), 10) || res.status;
      const name = attr(first, 'name') || '';
      const detail = text(first) || text(doc.error) || `HTTP ${res.status}`;
      const hint = ERROR_HINTS[code];
      throw new SpeakerError(hint || `Speaker error ${code}${name ? ` (${name})` : ''}: ${detail}`, {
        code,
        name,
        status: res.status,
      });
    }
    return doc;
  }

  get(path, opts) {
    return this.request('GET', path, null, opts);
  }

  post(path, xml, opts) {
    return this.request('POST', path, xml, opts);
  }

  async info(opts) {
    return normalizeInfo(await this.get('/info', opts));
  }

  async nowPlaying() {
    return normalizeNowPlaying(await this.get('/now_playing'));
  }

  async volume() {
    return normalizeVolume(await this.get('/volume'));
  }

  async setVolume(level) {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    await this.post('/volume', `<volume>${v}</volume>`);
  }

  async presets() {
    return normalizePresets(await this.get('/presets'));
  }

  async storePreset(slot, contentItemXml) {
    const now = Math.floor(Date.now() / 1000);
    await this.post('/storePreset', `<preset id="${slot}" createdOn="${now}" updatedOn="${now}">${contentItemXml}</preset>`);
  }

  async removePreset(slot) {
    await this.post('/removePreset', `<preset id="${slot}"></preset>`);
  }

  async key(name, { release = true } = {}) {
    if (!KEYS.has(name)) throw new SpeakerError(`Unknown key ${name}`);
    await this.post('/key', `<key state="press" sender="Gabbo">${name}</key>`);
    if (release) await this.post('/key', `<key state="release" sender="Gabbo">${name}</key>`);
  }

  async select(contentItemXml) {
    await this.post('/select', contentItemXml, { timeout: 15000 });
  }

  async selectBluetooth() {
    await this.select('<ContentItem source="BLUETOOTH"></ContentItem>');
  }

  async selectAux(account = 'AUX') {
    await this.select(`<ContentItem source="AUX" sourceAccount="${escapeXml(account)}"></ContentItem>`);
  }

  async sources() {
    return normalizeSources(await this.get('/sources'));
  }

  async bass() {
    return normalizeBass(await this.get('/bass'));
  }

  async bassCapabilities() {
    return normalizeBassCaps(await this.get('/bassCapabilities'));
  }

  async setBass(level) {
    await this.post('/bass', `<bass>${Math.round(level)}</bass>`);
  }

  async zone() {
    return normalizeZone(await this.get('/getZone'));
  }

  static zoneXml(masterId, members, senderIp) {
    const sender = senderIp ? ` senderIPAddress="${escapeXml(senderIp)}"` : '';
    const body = members.map((m) => `<member ipaddress="${escapeXml(m.ip)}">${escapeXml(m.id)}</member>`).join('');
    return `<zone master="${escapeXml(masterId)}"${sender}>${body}</zone>`;
  }

  async setZone(masterId, masterIp, members) {
    await this.post('/setZone', SoundTouchClient.zoneXml(masterId, members, masterIp));
  }

  async addZoneSlave(masterId, members) {
    await this.post('/addZoneSlave', SoundTouchClient.zoneXml(masterId, members));
  }

  async removeZoneSlave(masterId, members) {
    await this.post('/removeZoneSlave', SoundTouchClient.zoneXml(masterId, members));
  }

  async setName(name) {
    await this.post('/name', `<name>${escapeXml(name)}</name>`);
  }

  async capabilities() {
    return normalizeCapabilities(await this.get('/capabilities'));
  }

  async enterBluetoothPairing() {
    await this.get('/enterBluetoothPairing');
  }

  async clearBluetoothPaired() {
    await this.get('/clearBluetoothPaired');
  }

  async powerSaving() {
    const doc = await this.get('/systemtimeout');
    const node = doc.systemtimeout;
    if (!node) return null;
    return text(node.powersaving_enabled) === 'true';
  }

  async setPowerSaving(enabled) {
    await this.post('/systemtimeout', `<systemtimeout><powersaving_enabled>${enabled ? 'true' : 'false'}</powersaving_enabled></systemtimeout>`);
  }
}
