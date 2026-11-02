import { sendJson } from './net.js';
import { decodeStationData, normalizeStation } from './stations.js';
import { logger } from './log.js';

const log = logger('bmx');

/**
 * Endpoints the *speaker* calls once its BMX registry points at this hub.
 * They replace Bose's retired cloud services for radio:
 *   GET /bmx/registry/v1/services                 service registry
 *   GET /bmx/orion/station?data=…                 our stations + custom streams
 *   GET /bmx/tunein/v1/playback/station/:id       presets saved by the old Bose app
 * Responses must be plain HTTP 200 JSON (the speaker does not follow redirects).
 */
export function registerBmxRoutes(router, hub) {
  async function hubBaseForRequest(req) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const sp = hub.speakerByIp(ip);
    if (sp) return hub.hubBaseFor(sp);
    const host = req.headers.host || '';
    return `http://${host}`;
  }

  router.get('/bmx/registry/v1/services', async ({ req, res }) => {
    const base = await hubBaseForRequest(req);
    hub.noteRegistryFetch(req.socket.remoteAddress);
    log.info(`Registry requested by ${req.socket.remoteAddress}`);
    const service = (name, value, baseUrl, label) => ({
      _links: { bmx_token: { href: '/token' }, self: { href: '/' } },
      askAdapter: false,
      assets: { color: '#000000', name: label, description: `${label} via Airwave` },
      authenticationModel: { anonymousAccount: { autoCreate: true, enabled: true } },
      baseUrl,
      id: { name, value },
      streamTypes: ['liveRadio'],
    });
    sendJson(res, 200, {
      _links: { bmx_services_availability: { href: '../servicesAvailability' } },
      askAgainAfter: 60000,
      bmx_services: [
        service('LOCAL_INTERNET_RADIO', 11, `${base}/bmx/orion`, 'Airwave Radio'),
        service('TUNEIN', 25, `${base}/bmx/tunein`, 'TuneIn'),
      ],
    });
  });

  async function respondStation(req, res, station) {
    const ip = req.socket.remoteAddress;
    if (!station) {
      sendJson(res, 404, { error: 'Unknown station' });
      return;
    }
    try {
      const sp = hub.speakerByIp(ip);
      const base = sp ? await hub.hubBaseFor(sp) : `http://${req.headers.host}`;
      const resolved = await hub.resolver.resolve(station, { hubBase: base });
      log.info(`Speaker ${ip} -> ${station.name}: ${resolved.relayed ? 'relayed' : 'direct'} ${resolved.sourceUrl}`);
      hub.noteStationFetch(ip, station, resolved, null);
      if (sp) hub.addRecent(station);
      sendJson(res, 200, {
        audio: { isRealtime: true, hasPlaylist: false, streamUrl: resolved.streamUrl },
        imageUrl: station.image || '',
        name: station.name,
        streamType: 'liveRadio',
      });
    } catch (err) {
      log.warn(`Speaker ${ip} -> ${station.name}: ${err.message}`);
      hub.noteStationFetch(ip, station, null, err);
      sendJson(res, 502, { error: err.message });
    }
  }

  router.get('/bmx/orion/station', async ({ req, res, query }) => {
    await respondStation(req, res, decodeStationData(query.data || ''));
  });

  // Also accept Bose's original Orion adapter path (absolute locations in old presets).
  router.get('/core02/svc-bmx-adapter-orion/prod/orion/station', async ({ req, res, query }) => {
    await respondStation(req, res, decodeStationData(query.data || ''));
  });

  router.get('/bmx/tunein/v1/playback/station/:id', async ({ req, res, params }) => {
    let station = null;
    try {
      station = normalizeStation({ type: 'tunein', id: params.id, name: params.id });
      const known =
        hub.store.state.favorites.find((f) => f.station.key === station.key)?.station ||
        hub.store.state.recents.find((r) => r.station?.key === station.key)?.station;
      if (known) station = normalizeStation(known);
      else {
        const { describe } = await import('./tunein.js');
        const d = await describe(params.id).catch(() => null);
        if (d) station = normalizeStation({ type: 'tunein', id: params.id, name: d.name, image: d.image });
      }
    } catch {
      station = null;
    }
    await respondStation(req, res, station);
  });

  // Telemetry endpoints older firmware may call; accept and ignore.
  router.post('/bmx/tunein/v1/reporting/station/:id', () => ({ ok: true }));
  router.post('/bmx/orion/reporting', () => ({ ok: true }));
}
