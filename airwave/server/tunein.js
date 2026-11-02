import { config, USER_AGENT } from './config.js';
import { HttpError } from './net.js';
import { isValidTuneInId } from './stations.js';

/**
 * Client for TuneIn's OPML directory API (opml.radiotime.com), the same
 * catalogue that powered TuneIn inside the Bose SoundTouch app. We ask for
 * JSON and normalise the "outline" tree into sections, links and stations.
 */

const FORMATS = 'mp3,aac,ogg';
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE = 300;

function base() {
  return new URL(config.tuneinBase);
}

function withDefaults(url) {
  url.searchParams.set('render', 'json');
  if (!url.searchParams.has('formats')) url.searchParams.set('formats', FORMATS);
  if (config.tuneinPartnerId && !url.searchParams.has('partnerId')) url.searchParams.set('partnerId', config.tuneinPartnerId);
  return url;
}

async function getJson(url, { cacheable = true } = {}) {
  const key = url.href;
  const hit = cache.get(key);
  if (cacheable && hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.8' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new HttpError(502, `TuneIn is not reachable from the hub (${err.cause?.code || err.name || err.message})`, 'tunein_unreachable');
  }
  const textBody = await res.text();
  let data;
  try {
    data = JSON.parse(textBody);
  } catch {
    throw new HttpError(502, `TuneIn returned an unexpected response (HTTP ${res.status})`, 'tunein_bad_response');
  }
  const status = String(data?.head?.status ?? res.status);
  if (status !== '200') {
    throw new HttpError(status === '404' ? 404 : 502, data?.head?.fault || `TuneIn error ${status}`, 'tunein_error');
  }
  if (cacheable) {
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), data });
  }
  return data;
}

function idFromUrl(u) {
  try {
    return new URL(u).searchParams.get('id') || '';
  } catch {
    return '';
  }
}

/** Opaque, URL-safe reference to a TuneIn browse URL (only TuneIn's host is allowed). */
export function encodeRef(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return Buffer.from(`${u.pathname}${u.search}`, 'utf8').toString('base64url');
  } catch {
    return '';
  }
}

export function decodeRef(ref) {
  let pathAndQuery;
  try {
    pathAndQuery = Buffer.from(String(ref), 'base64url').toString('utf8');
  } catch {
    throw new HttpError(400, 'Invalid browse reference');
  }
  if (!/^\/[A-Za-z]+\.ashx(\?.*)?$/.test(pathAndQuery)) throw new HttpError(400, 'Invalid browse reference');
  return new URL(pathAndQuery, base());
}

export function normalizeOutline(o) {
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o.children)) {
    const items = o.children.map(normalizeOutline).filter(Boolean);
    if (!items.length) return null;
    return { kind: 'section', title: o.text || '', key: o.key || '', items };
  }
  const type = o.type;
  if (type === 'audio') {
    const id = o.guide_id || o.preset_id || idFromUrl(o.URL);
    if (!isValidTuneInId(id)) return null;
    return {
      kind: 'station',
      station: {
        type: 'tunein',
        id,
        key: `tunein:${id}`,
        name: o.text || id,
        image: o.image || '',
        subtitle: o.subtext || o.playing || '',
        bitrate: Number.parseInt(o.bitrate, 10) || null,
        formats: o.formats || '',
        genre: o.genre_id || '',
        item: o.item || '',
        reliability: Number.parseInt(o.reliability, 10) || null,
        playing: o.playing || '',
      },
    };
  }
  if (type === 'link') {
    if (!o.URL) return null;
    return {
      kind: 'link',
      title: o.text || 'More',
      subtitle: o.subtext || '',
      image: o.image || '',
      key: o.key || '',
      ref: encodeRef(o.URL),
      guideId: o.guide_id || '',
    };
  }
  if (type === 'text' && o.text) return { kind: 'text', title: o.text };
  return null;
}

function normalizeBody(data) {
  const items = (Array.isArray(data?.body) ? data.body : []).map(normalizeOutline).filter(Boolean);
  return { title: data?.head?.title || '', items };
}

export async function browse(ref) {
  const url = ref ? decodeRef(ref) : new URL('/Browse.ashx', base());
  const data = await getJson(withDefaults(url));
  const out = normalizeBody(data);
  if (!ref && !out.title) out.title = 'Browse';
  return out;
}

export async function search(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return { title: 'Search', items: [] };
  const url = withDefaults(new URL('/Search.ashx', base()));
  url.searchParams.set('query', q);
  const data = await getJson(url);
  const out = normalizeBody(data);
  out.title = `Results for “${q}”`;
  return out;
}

export async function describe(id) {
  if (!isValidTuneInId(id)) throw new HttpError(400, 'Invalid station id');
  const url = withDefaults(new URL('/Describe.ashx', base()));
  url.searchParams.set('id', id);
  const data = await getJson(url);
  const s = (data.body || []).find((x) => x.element === 'station' || x.element === 'show' || x.element === 'topic') || data.body?.[0];
  if (!s) throw new HttpError(404, 'Station not found');
  return {
    id,
    name: s.name || s.title || id,
    image: s.logo || s.image || '',
    slogan: s.slogan || s.subtext || '',
    description: s.description || '',
    genre: s.genre_name || '',
    location: s.location || '',
    language: s.language || '',
    website: s.url || '',
    frequency: s.frequency ? `${s.frequency} ${s.band || ''}`.trim() : '',
    playing: s.current_song ? `${s.current_artist ? `${s.current_artist} – ` : ''}${s.current_song}` : '',
  };
}

const FORMAT_RANK = { mp3: 0, aac: 1, aacp: 1, ogg: 2 };

/**
 * Stream candidates for a TuneIn id, best first. Each has { url, mediaType,
 * bitrate, isDirect }. HLS-only entries are dropped (the speaker can't play them).
 */
export async function tune(id) {
  if (!isValidTuneInId(id)) throw new HttpError(400, 'Invalid station id');
  const url = withDefaults(new URL('/Tune.ashx', base()));
  url.searchParams.set('id', id);
  const data = await getJson(url, { cacheable: false });
  const list = (Array.isArray(data.body) ? data.body : [])
    .filter((x) => x && x.url && (x.element === 'audio' || !x.element))
    .map((x, index) => ({
      url: String(x.url),
      mediaType: String(x.media_type || '').toLowerCase(),
      bitrate: Number.parseInt(x.bitrate, 10) || 0,
      isDirect: x.is_direct === true || x.is_direct === 'true',
      isHls: x.is_hls_advanced === 'true' || /hls|m3u8/i.test(String(x.media_type || '')) || /\.m3u8(\?|$)/i.test(String(x.url)),
      reliability: Number.parseInt(x.reliability, 10) || 0,
      index,
    }))
    .filter((x) => !x.isHls);
  list.sort((a, b) => {
    const fa = FORMAT_RANK[a.mediaType] ?? 3;
    const fb = FORMAT_RANK[b.mediaType] ?? 3;
    if (fa !== fb) return fa - fb;
    return a.index - b.index;
  });
  if (!list.length) throw new HttpError(404, 'TuneIn has no stream for this station that the speaker can play', 'no_stream');
  return list;
}

export function clearCache() {
  cache.clear();
}
