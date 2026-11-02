import { HttpError } from './net.js';
import * as tunein from './tunein.js';
import { normalizeStation, publicStation } from './stations.js';
import { resolveStream } from './stream.js';
import { Scheduler } from './scheduler.js';

const TRANSPORT = new Set(['play', 'pause', 'toggle', 'stop', 'next', 'prev', 'thumbsUp', 'thumbsDown']);

/** REST API used by the phone app (and handy for Siri Shortcuts / Home Assistant). */
export function registerApiRoutes(router, { hub, scheduler, radioSetup, events }) {
  const id = (params) => params.id;

  router.get('/api/health', () => ({ ok: true }));
  router.get('/api/state', () => withAlarmTimes(hub.publicState()));
  router.get('/api/events', ({ req, res }) => events.attach(req, res));

  // ------------------------------------------------------------ speakers
  router.post('/api/speakers/scan', async () => {
    hub.discovery.searchOnce();
    const found = await hub.discovery.scanSubnets();
    await Promise.allSettled(found.map((ip) => hub.addByIp(ip)));
    return { found: found.length, speakers: hub.publicState().speakers };
  });
  router.post('/api/speakers', async ({ body }) => {
    const sp = await hub.addByIp(body.ip);
    return hub.publicSpeaker(sp);
  });
  router.delete('/api/speakers/:id', ({ params }) => hub.forget(id(params)));
  router.get('/api/speakers/:id', ({ params }) => hub.publicSpeaker(hub.speaker(id(params))));
  router.post('/api/speakers/:id/refresh', async ({ params }) => {
    const sp = hub.speaker(id(params));
    await sp.refreshAll();
    return hub.publicSpeaker(sp);
  });

  router.post('/api/speakers/:id/play', ({ params, body }) => hub.play(id(params), body.station, { volume: body.volume }));
  router.post('/api/speakers/:id/power', ({ params, body }) => hub.power(id(params), body.on));
  router.post('/api/speakers/:id/transport', ({ params, body }) => {
    if (!TRANSPORT.has(body.action)) throw new HttpError(400, 'Unknown action');
    return hub.transport(id(params), body.action);
  });
  router.post('/api/speakers/:id/volume', ({ params, body }) => hub.volume(id(params), body));
  router.post('/api/speakers/:id/source', ({ params, body }) => hub.source(id(params), body.source));
  router.post('/api/speakers/:id/bluetooth', ({ params, body }) => hub.bluetooth(id(params), body.action));
  router.post('/api/speakers/:id/name', ({ params, body }) => hub.rename(id(params), body.name));
  router.post('/api/speakers/:id/bass', ({ params, body }) => hub.setBass(id(params), body.level));
  router.post('/api/speakers/:id/power-saving', ({ params, body }) => hub.setPowerSaving(id(params), body.enabled));
  router.post('/api/speakers/:id/sleep', ({ params, body }) => scheduler.setSleep(id(params), body.minutes, { fade: body.fade !== false }));

  router.post('/api/speakers/:id/presets/:slot/play', ({ params }) => hub.playPreset(id(params), params.slot));
  router.put('/api/speakers/:id/presets/:slot', ({ params, body }) => hub.storePreset(id(params), params.slot, body));
  router.delete('/api/speakers/:id/presets/:slot', ({ params }) => hub.removePreset(id(params), params.slot));

  router.get('/api/speakers/:id/radio-setup', ({ params }) => radioSetup.status(id(params)));
  router.post('/api/speakers/:id/radio-setup', ({ params, body }) => {
    if (body.action === 'enable') return radioSetup.enable(id(params), { reboot: !!body.reboot });
    if (body.action === 'disable') return radioSetup.disable(id(params), { reboot: !!body.reboot });
    if (body.action === 'reboot') return radioSetup.reboot(id(params));
    throw new HttpError(400, 'Unknown action');
  });

  // ------------------------------------------------------------ multi-room
  router.post('/api/zones', ({ body }) => hub.createZone(body.masterId, body.memberIds || []));
  router.post('/api/zones/:id/members', ({ params, body }) => hub.addToZone(id(params), body.memberId));
  router.delete('/api/zones/:id/members/:member', ({ params }) => hub.removeFromZone(id(params), params.member));
  router.delete('/api/zones/:id', ({ params }) => hub.dissolveZone(id(params)));

  // ------------------------------------------------------------ TuneIn
  router.get('/api/tunein/browse', ({ query }) => tunein.browse(query.ref || ''));
  router.get('/api/tunein/search', ({ query }) => tunein.search(query.q || ''));
  router.get('/api/tunein/describe', ({ query }) => tunein.describe(query.id));

  // ------------------------------------------------------------ library
  router.get('/api/favorites', () => hub.store.state.favorites);
  router.post('/api/favorites', ({ body }) => hub.addFavorite(body.station));
  router.put('/api/favorites/:key', ({ params, body }) => hub.updateFavorite(params.key, body));
  router.delete('/api/favorites/:key', ({ params }) => hub.removeFavorite(params.key));
  router.post('/api/favorites/reorder', ({ body }) => hub.reorderFavorites(body.keys));
  router.get('/api/recents', () => hub.store.state.recents);
  router.delete('/api/recents', () => hub.clearRecents());

  router.post('/api/stations/test', async ({ body }) => {
    const st = normalizeStation({ type: 'url', url: body.url, name: body.name || 'Test' });
    try {
      const r = await resolveStream(st.url);
      return { ok: true, url: r.url, contentType: r.contentType, bitrate: r.bitrate, name: r.name, https: r.url.startsWith('https:') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ------------------------------------------------------------ alarms & settings
  router.get('/api/alarms', () => withAlarmTimes({ alarms: hub.store.state.alarms }).alarms);
  router.post('/api/alarms', ({ body }) => scheduler.createAlarm(body));
  router.put('/api/alarms/:id', ({ params, body }) => scheduler.updateAlarm(params.id, body));
  router.delete('/api/alarms/:id', ({ params }) => scheduler.deleteAlarm(params.id));
  router.post('/api/alarms/:id/test', async ({ params }) => {
    const alarm = hub.store.state.alarms.find((a) => a.id === params.id);
    if (!alarm) throw new HttpError(404, 'Alarm not found');
    await scheduler.fire({ ...alarm, fadeIn: false, autoOffMinutes: null });
  });
  router.put('/api/settings', ({ body }) => hub.updateSettings(body));

  // ------------------------------------------------------------ quick actions (Siri Shortcuts etc.)
  // Simple GET/POST endpoints that act on the active (or ?speaker=name) speaker.
  const pick = (query) => {
    const all = [...hub.speakers.values()].filter((s) => s.id);
    if (query.speaker) {
      const q = String(query.speaker).toLowerCase();
      const sp = all.find((s) => s.id === query.speaker || (s.state.name || '').toLowerCase() === q) || all.find((s) => (s.state.name || '').toLowerCase().includes(q));
      if (!sp) throw new HttpError(404, `No speaker called "${query.speaker}"`);
      return sp.id;
    }
    const active = hub.store.state.settings.activeSpeakerId;
    if (active && hub.speakers.has(active)) return active;
    if (all[0]) return all[0].id;
    throw new HttpError(404, 'No speakers found yet');
  };
  const quick = (path, fn) => {
    router.get(`/api/quick/${path}`, (ctx) => fn({ ...ctx, sid: pick(ctx.query) }));
    router.post(`/api/quick/${path}`, (ctx) => fn({ ...ctx, query: { ...ctx.query, ...ctx.body }, sid: pick({ ...ctx.query, ...ctx.body }) }));
  };
  quick('play', async ({ sid, query }) => {
    if (query.preset) return hub.playPreset(sid, query.preset);
    if (query.favorite) {
      const st = hub.findFavorite(query.favorite);
      if (!st) throw new HttpError(404, `No favorite matching "${query.favorite}"`);
      return hub.play(sid, st);
    }
    if (query.url) return hub.play(sid, { type: 'url', url: query.url, name: query.name });
    if (query.search) {
      const res = await tunein.search(query.search);
      const first = res.items.flatMap((i) => (i.kind === 'section' ? i.items : [i])).find((i) => i.kind === 'station');
      if (!first) throw new HttpError(404, `Nothing found for "${query.search}"`);
      return hub.play(sid, first.station);
    }
    return hub.resume(sid);
  });
  quick('pause', ({ sid }) => hub.transport(sid, 'pause'));
  quick('toggle', ({ sid }) => hub.transport(sid, 'toggle'));
  quick('power', ({ sid, query }) => hub.power(sid, !['off', 'false', '0'].includes(String(query.state ?? 'on').toLowerCase())));
  quick('volume', ({ sid, query }) => {
    const v = String(query.level ?? '');
    if (v === 'up') return hub.volume(sid, { delta: 5 });
    if (v === 'down') return hub.volume(sid, { delta: -5 });
    if (v === 'mute') return hub.volume(sid, { muted: true });
    if (v === 'unmute') return hub.volume(sid, { muted: false });
    return hub.volume(sid, { level: Number(v) });
  });
  quick('bluetooth', ({ sid, query }) => (query.pair ? hub.bluetooth(sid, 'pair') : hub.source(sid, 'BLUETOOTH')));
  quick('aux', ({ sid }) => hub.source(sid, 'AUX'));
  quick('sleep', ({ sid, query }) => scheduler.setSleep(sid, Number(query.minutes ?? 30)));
  quick('status', ({ sid }) => {
    const s = hub.publicSpeaker(hub.speaker(sid));
    const np = s.nowPlaying;
    return {
      speaker: s.name,
      power: np && np.source !== 'STANDBY' ? 'on' : 'off',
      playing: np?.station?.name || np?.stationName || np?.track || np?.sourceLabel || '',
      song: np?.streamTitle || [np?.artist, np?.track].filter(Boolean).join(' – '),
      volume: s.volume?.level ?? null,
    };
  });

  function withAlarmTimes(state) {
    return { ...state, alarms: state.alarms.map((a) => ({ ...a, nextFire: Scheduler.nextFire(a) })) };
  }

  return { publicStation };
}
