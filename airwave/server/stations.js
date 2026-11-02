import crypto from 'node:crypto';
import { escapeXml } from './soundtouch/xml.js';

/**
 * A station is the app-wide unit of "something you can play":
 *   { type: 'tunein', id: 's24939', name, image, subtitle? }
 *   { type: 'url', url: 'http://…', name, image? }
 * `key` uniquely identifies it (used for favorites/recents de-duplication).
 */

const TUNEIN_ID = /^[a-zA-Z]\d+$/;

export function isValidTuneInId(id) {
  return TUNEIN_ID.test(String(id || ''));
}

export function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanImage(value) {
  return isHttpUrl(value) && String(value).length <= 600 ? String(value) : '';
}

export function stationKey(st) {
  if (st.type === 'tunein') return `tunein:${st.id}`;
  return `url:${crypto.createHash('sha1').update(st.url).digest('hex').slice(0, 16)}`;
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_station' });
}

/** Validate and normalise untrusted station input. Throws (HTTP 400) on invalid data. */
export function normalizeStation(input) {
  if (!input || typeof input !== 'object') throw invalid('Station is missing');
  const type = input.type === 'url' ? 'url' : input.type === 'tunein' ? 'tunein' : null;
  if (!type) throw invalid('Station type must be "tunein" or "url"');
  const st = { type };
  if (type === 'tunein') {
    if (!isValidTuneInId(input.id)) throw invalid('Invalid TuneIn station id');
    st.id = String(input.id);
  } else {
    const url = String(input.url || '').trim();
    if (!isHttpUrl(url) || url.length > 2048) throw invalid('Stream URL must be a valid http:// or https:// address');
    st.url = url;
  }
  st.name = cleanText(input.name) || (type === 'tunein' ? st.id : new URL(st.url).hostname);
  const image = cleanImage(input.image);
  if (image) st.image = image;
  const subtitle = cleanText(input.subtitle, 160);
  if (subtitle) st.subtitle = subtitle;
  st.key = stationKey(st);
  return st;
}

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64Decode(str) {
  const normal = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normal, 'base64').toString('utf8');
}

/**
 * Location stored in a speaker ContentItem / preset. Relative to the
 * LOCAL_INTERNET_RADIO baseUrl the hub advertises in its BMX registry, so the
 * speaker requests `<hub>/bmx/orion/station?data=…`. Keeping it relative means
 * presets keep working if the hub moves to a new address.
 */
export function stationLocation(st) {
  const data = st.type === 'tunein' ? { t: st.id } : { u: st.url };
  if (st.name) data.n = st.name;
  if (st.image) data.i = st.image;
  return `/station?data=${b64urlEncode(JSON.stringify(data))}`;
}

/** Decode the `data` parameter of a station location (ours, or Bose's original Orion format). */
export function decodeStationData(data) {
  let obj;
  try {
    obj = JSON.parse(b64Decode(data));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const tuneinId = obj.t || obj.tuneinId || obj.tuneInId;
  const url = obj.u || obj.streamUrl || obj.audio?.streamUrl;
  const raw = {
    type: tuneinId && !url ? 'tunein' : 'url',
    id: tuneinId,
    url,
    name: obj.n || obj.name,
    image: obj.i || obj.imageUrl,
  };
  try {
    return normalizeStation(raw);
  } catch {
    return null;
  }
}

/**
 * Recognise what station (if any) a speaker ContentItem refers to:
 * - our LOCAL_INTERNET_RADIO locations (relative or absolute)
 * - legacy TuneIn presets saved by the Bose app ("/v1/playback/station/s123")
 */
export function stationFromContentItem(item) {
  if (!item) return null;
  const location = String(item.location || '');
  if (item.source === 'LOCAL_INTERNET_RADIO' || /\/station\?data=/.test(location)) {
    const m = location.match(/\/station\?data=([A-Za-z0-9_\-+/=%]+)/);
    if (m) {
      const st = decodeStationData(decodeURIComponent(m[1]));
      if (st) return { ...st, image: st.image || item.art || undefined };
    }
  }
  if (item.source === 'TUNEIN') {
    const m = location.match(/station\/([a-zA-Z]\d+)/);
    if (m) {
      try {
        return normalizeStation({ type: 'tunein', id: m[1], name: item.name, image: item.art });
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function contentItemXml(st) {
  const loc = stationLocation(st);
  const art = st.image ? `<containerArt>${escapeXml(st.image)}</containerArt>` : '';
  return (
    `<ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" location="${escapeXml(loc)}" ` +
    `sourceAccount="" isPresetable="true"><itemName>${escapeXml(st.name)}</itemName>${art}</ContentItem>`
  );
}

/** Pass-through XML for a ContentItem read back from the speaker (e.g. to store as preset). */
export function rawContentItemXml(item) {
  const attrs = [
    ['source', item.source],
    ['type', item.type],
    ['location', item.location],
    ['sourceAccount', item.sourceAccount ?? ''],
    ['isPresetable', 'true'],
  ]
    .filter(([, v]) => v != null && v !== undefined)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(' ');
  const art = item.art ? `<containerArt>${escapeXml(item.art)}</containerArt>` : '';
  return `<ContentItem ${attrs}><itemName>${escapeXml(item.name || '')}</itemName>${art}</ContentItem>`;
}

/** Public, display-safe copy of a station (strips nothing sensitive, just a stable shape). */
export function publicStation(st) {
  if (!st) return null;
  const out = { key: st.key || stationKey(st), type: st.type, name: st.name };
  if (st.type === 'tunein') out.id = st.id;
  else out.url = st.url;
  if (st.image) out.image = st.image;
  if (st.subtitle) out.subtitle = st.subtitle;
  return out;
}
