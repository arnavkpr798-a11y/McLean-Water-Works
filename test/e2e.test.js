import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootWorld, waitFor } from './helpers.js';

let w;
const LIVING = 'A0F6FD000001';
const KITCHEN = 'A0F6FD000002';
const station = (id, name) => ({ type: 'tunein', id, name });

async function speaker(id = LIVING) {
  return (await w.api('GET', `/api/speakers/${id}`)).data;
}

before(async () => {
  w = await bootWorld();
});

after(async () => {
  await w?.stop();
});

describe('speakers', () => {
  it('adds speakers by IP and mirrors their state', async () => {
    const r = await w.api('POST', '/api/speakers', { ip: '127.0.0.2' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.id, LIVING);
    assert.equal(r.data.name, 'Living Room');
    assert.equal(r.data.model, 'SoundTouch 30');
    assert.equal(r.data.firmware, '27.0.6.46330.5043500');
    const k = await w.api('POST', '/api/speakers', { ip: '127.0.0.3' });
    assert.equal(k.data.id, KITCHEN);
    const state = (await w.api('GET', '/api/state')).data;
    assert.equal(state.speakers.length, 2);
    assert.equal(state.settings.activeSpeakerId, LIVING);
    const sp = await speaker();
    assert.equal(sp.online, true);
    assert.equal(sp.volume.level, 22);
    assert.equal(sp.presets.length, 6);
    assert.equal(sp.bass.available, true);
    assert.equal(sp.radio.status, 'not-configured');
  });

  it('rejects addresses without a speaker', async () => {
    const r = await w.api('POST', '/api/speakers', { ip: '127.0.0.9' });
    assert.equal(r.status, 404);
    const bad = await w.api('POST', '/api/speakers', { ip: 'not-an-ip' });
    assert.equal(bad.status, 400);
  });
});

describe('TuneIn catalogue', () => {
  it('browses the root and drills into categories', async () => {
    const root = (await w.api('GET', '/api/tunein/browse')).data;
    assert.ok(root.items.length >= 6);
    const music = root.items.find((i) => i.title === 'Music');
    assert.equal(music.kind, 'link');
    const page = (await w.api('GET', `/api/tunein/browse?ref=${encodeURIComponent(music.ref)}`)).data;
    assert.equal(page.title, 'Music');
    const stations = page.items.find((i) => i.kind === 'section' && i.key === 'stations');
    assert.ok(stations.items.every((i) => i.kind === 'station'));
    assert.equal(stations.items[0].station.type, 'tunein');
  });

  it('searches', async () => {
    const r = (await w.api('GET', '/api/tunein/search?q=jazz')).data;
    const st = r.items.flatMap((i) => i.items || [i]).find((i) => i.kind === 'station');
    assert.equal(st.station.name, 'Jazz24');
  });

  it('refuses browse refs pointing elsewhere', async () => {
    const r = await w.api('GET', `/api/tunein/browse?ref=${Buffer.from('//evil.example/x').toString('base64url')}`);
    assert.equal(r.status, 400);
  });
});

describe('playback without speaker setup (UPnP)', () => {
  it('plays a TuneIn station via UPnP and shows it as now playing', async () => {
    const r = await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10001', 'Jazz24') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.engine, 'upnp');
    await waitFor(() => w.living.state.source === 'UPNP' && w.living.state.playStatus === 'PLAY_STATE', { message: 'UPnP playback' });
    assert.match(w.living.state.upnpUri, /^http:\/\/127\.0\.0\.1:\d+\/streams\/s10001$/);
    const sp = await waitFor(async () => {
      const s = await speaker();
      return s.nowPlaying?.status === 'playing' && s;
    });
    assert.equal(sp.nowPlaying.station.name, 'Jazz24');
    assert.equal(sp.nowPlaying.engine, 'upnp');
  });

  it('reads the song title from ICY metadata', async () => {
    await w.app.hub.pollMetadataFor(LIVING);
    const sp = await waitFor(async () => {
      const s = await speaker();
      return s.nowPlaying.streamTitle && s;
    });
    assert.match(sp.nowPlaying.streamTitle, /Miles Davis/);
  });

  it('relays streams through the hub when relay mode is on, stripping ICY metadata', async () => {
    await w.api('PUT', '/api/settings', { streamMode: 'relay' });
    const r = await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10004', 'NPR News Now') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => w.living.state.upnpUri.includes('/relay/') && w.living.state.playStatus === 'PLAY_STATE', { message: 'relay playback' });
    // Fetch the relay ourselves: audio must not contain metadata blocks.
    const res = await fetch(w.living.state.upnpUri);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    const reader = res.body.getReader();
    let total = Buffer.alloc(0);
    while (total.length < 6000) {
      const { value } = await reader.read();
      total = Buffer.concat([total, Buffer.from(value)]);
    }
    await reader.cancel();
    assert.equal(total.includes(Buffer.from('StreamTitle')), false);
    await w.api('PUT', '/api/settings', { streamMode: 'auto' });
  });

  it('rejects tampered relay links', async () => {
    const res = await fetch(`${w.base}/relay/AAAAAAAAAAAAAAAAAAAAAA/${Buffer.from('http://example.com').toString('base64url')}.mp3`);
    assert.equal(res.status, 403);
  });

  it('explains when a station only has HLS streams', async () => {
    const r = await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10009', 'Smooth Chill') });
    assert.equal(r.status, 404);
    assert.match(r.data.error.message, /can play/);
  });

  it('plays custom stream URLs, including playlists and redirects', async () => {
    const r = await w.api('POST', `/api/speakers/${LIVING}/play`, {
      station: { type: 'url', url: `${w.radio.base}/pls/s10002.pls`, name: 'My PLS' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => w.living.state.upnpUri.endsWith('/streams/s10002'), { message: 'pls resolved' });
    const r2 = await w.api('POST', `/api/speakers/${LIVING}/play`, {
      station: { type: 'url', url: `${w.radio.base}/redirect/s10003`, name: 'Redirect' },
    });
    assert.equal(r2.status, 200);
    await waitFor(() => w.living.state.upnpUri.endsWith('/streams/s10003'), { message: 'redirect resolved' });
  });

  it('records recents (newest first, no duplicates)', async () => {
    const recents = (await w.api('GET', '/api/recents')).data;
    assert.equal(recents[0].station.name, 'Redirect');
    assert.equal(new Set(recents.map((r) => r.station.key)).size, recents.length);
  });
});

describe('preset buttons & radio setup', () => {
  it('reports setup status through the console', async () => {
    const s = (await w.api('GET', `/api/speakers/${LIVING}/radio-setup`)).data;
    assert.equal(s.consoleReachable, true);
    assert.equal(s.currentRegistryUrl, 'https://content.api.bose.io/bmx/registry/v1/services');
    assert.equal(s.pointsToHub, false);
    assert.equal(s.firmwareOk, true);
  });

  it('points the speaker registry at the hub and backs up the original', async () => {
    const r = await w.api('POST', `/api/speakers/${LIVING}/radio-setup`, { action: 'enable' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.verified, true);
    assert.equal(r.data.persisted, true);
    assert.equal(w.living.state.config.bmxRegistryUrl, 'http://127.0.0.1:18095/bmx/registry/v1/services');
    assert.equal(w.living.state.persisted.bmxRegistryUrl, 'http://127.0.0.1:18095/bmx/registry/v1/services');
    assert.equal(w.living.state.config.margeServerUrl, 'https://streaming.bose.com', 'other URLs untouched');
    const stored = w.app.store.state.speakers[LIVING].radio;
    assert.equal(stored.original.bmxRegistryUrl, 'https://content.api.bose.io/bmx/registry/v1/services');
    const sp = await speaker();
    assert.equal(sp.radio.status, 'enabled');
    assert.equal(sp.engine, 'native');
  });

  it('plays natively: the speaker fetches the station from the hub', async () => {
    const r = await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10002', 'KEXP 90.3 FM') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.engine, 'native');
    await waitFor(() => w.living.state.source === 'LOCAL_INTERNET_RADIO' && w.living.state.playStatus === 'PLAY_STATE', { message: 'native playback' });
    const sp = await waitFor(async () => {
      const s = await speaker();
      return s.nowPlaying.source === 'LOCAL_INTERNET_RADIO' && s;
    });
    assert.equal(sp.nowPlaying.station.name, 'KEXP 90.3 FM');
    assert.ok(sp.radio.lastStationFetchAt);
    assert.equal(sp.radio.nativeOk, true);
  });

  it('stores a station on a preset and the hardware button plays it', async () => {
    const r = await w.api('PUT', `/api/speakers/${LIVING}/presets/1`, { station: station('s10003', 'Classic FM') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const sp = await speaker();
    assert.equal(sp.presets[0].name, 'Classic FM');
    assert.equal(sp.presets[0].station.id, 's10003');
    // Simulate pressing button 1 on the speaker itself.
    await fetch('http://127.0.0.2:18090/key', { method: 'POST', body: '<key state="press" sender="Gabbo">PRESET_1</key>' });
    await fetch('http://127.0.0.2:18090/key', { method: 'POST', body: '<key state="release" sender="Gabbo">PRESET_1</key>' });
    await waitFor(() => w.living.state.stationName === 'Classic FM' && w.living.state.playStatus === 'PLAY_STATE', { message: 'preset 1 playback' });
  });

  it('revives TuneIn presets saved by the old Bose app', async () => {
    w.living.setPreset(2, { source: 'TUNEIN', type: 'stationurl', location: '/v1/playback/station/s10005', name: 'Lofi Beats Radio' });
    await w.app.hub.speakers.get(LIVING).refresh('presets');
    const sp = await speaker();
    assert.equal(sp.presets[1].legacyTuneIn, true);
    const r = await w.api('POST', `/api/speakers/${LIVING}/presets/2/play`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => w.living.state.stationName === 'Lofi Beats Radio' && w.living.state.playStatus === 'PLAY_STATE', { message: 'legacy preset' });
    assert.equal(w.living.state.source, 'LOCAL_INTERNET_RADIO');
    // And the physical button path through the TUNEIN service:
    await fetch('http://127.0.0.2:18090/key', { method: 'POST', body: '<key state="release" sender="Gabbo">PRESET_2</key>' });
    await waitFor(() => w.living.state.source === 'TUNEIN' && w.living.state.playStatus === 'PLAY_STATE', { message: 'legacy hardware button' });
  });

  it('saves what is playing to a preset', async () => {
    await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10010', 'Radio Paradise') });
    await waitFor(() => w.living.state.stationName === 'Radio Paradise');
    const r = await w.api('PUT', `/api/speakers/${LIVING}/presets/6`, { current: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await speaker()).presets[5].station.name, 'Radio Paradise');
    const del = await w.api('DELETE', `/api/speakers/${LIVING}/presets/6`);
    assert.equal(del.status, 200);
    assert.equal((await speaker()).presets[5].empty, true);
  });

  it('falls back to UPnP automatically if the speaker never calls the hub', async () => {
    const realUrl = w.living.state.config.bmxRegistryUrl;
    w.living.state.config.bmxRegistryUrl = 'http://127.0.0.1:1/dead'; // simulate speaker not reaching hub
    const r = await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10006', 'WNYC 93.9 FM') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.engine, 'upnp');
    const sp = await speaker();
    assert.equal(sp.radio.nativeOk, false);
    assert.equal(sp.engine, 'upnp');
    w.living.state.config.bmxRegistryUrl = realUrl;
    // Re-running setup ("Repair") re-enables the native path.
    await w.api('POST', `/api/speakers/${LIVING}/radio-setup`, { action: 'enable' });
    assert.equal((await speaker()).engine, 'native');
  });
});

describe('controls', () => {
  it('changes volume, mutes and unmutes', async () => {
    let r = await w.api('POST', `/api/speakers/${LIVING}/volume`, { level: 35 });
    assert.equal(r.status, 200);
    assert.equal(w.living.state.volume, 35);
    r = await w.api('POST', `/api/speakers/${LIVING}/volume`, { delta: -5 });
    assert.equal(w.living.state.volume, 30);
    await w.api('POST', `/api/speakers/${LIVING}/volume`, { muted: true });
    assert.equal(w.living.state.muted, true);
    await w.api('POST', `/api/speakers/${LIVING}/volume`, { muted: true });
    assert.equal(w.living.state.muted, true, 'mute is idempotent');
    await w.api('POST', `/api/speakers/${LIVING}/volume`, { muted: false });
    assert.equal(w.living.state.muted, false);
  });

  it('switches to Bluetooth, AUX and pairing mode', async () => {
    await w.api('POST', `/api/speakers/${LIVING}/source`, { source: 'BLUETOOTH' });
    await waitFor(() => w.living.state.source === 'BLUETOOTH');
    const sp = await waitFor(async () => {
      const s = await speaker();
      return s.nowPlaying.source === 'BLUETOOTH' && s;
    });
    assert.equal(sp.nowPlaying.station, null, 'no radio station shown for Bluetooth');
    assert.equal(sp.nowPlaying.track, 'Blinding Lights');
    await w.api('POST', `/api/speakers/${LIVING}/bluetooth`, { action: 'pair' });
    assert.ok(w.living.state.calls.some((c) => c.path === '/enterBluetoothPairing'));
    await w.api('POST', `/api/speakers/${LIVING}/source`, { source: 'AUX' });
    await waitFor(() => w.living.state.source === 'AUX');
  });

  it('powers off and resumes the last station', async () => {
    await w.api('POST', `/api/speakers/${LIVING}/power`, { on: false });
    await waitFor(() => w.living.state.source === 'STANDBY');
    const r = await w.api('POST', `/api/speakers/${LIVING}/source`, { source: 'RADIO' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => w.living.state.source === 'LOCAL_INTERNET_RADIO' && w.living.state.playStatus === 'PLAY_STATE', { message: 'resume' });
  });

  it('pauses and plays', async () => {
    await w.api('POST', `/api/speakers/${LIVING}/transport`, { action: 'pause' });
    await waitFor(() => w.living.state.playStatus === 'PAUSE_STATE');
    await w.api('POST', `/api/speakers/${LIVING}/transport`, { action: 'play' });
    await waitFor(() => w.living.state.playStatus === 'PLAY_STATE');
  });

  it('renames, adjusts bass and auto-off', async () => {
    await w.api('POST', `/api/speakers/${LIVING}/name`, { name: 'Den' });
    assert.equal(w.living.state.name, 'Den');
    await waitFor(async () => (await speaker()).name === 'Den');
    await w.api('POST', `/api/speakers/${LIVING}/bass`, { level: -4 });
    assert.equal(w.living.state.bass, -4);
    const clamp = await w.api('POST', `/api/speakers/${LIVING}/bass`, { level: 5 });
    assert.equal(clamp.status, 200);
    assert.equal(w.living.state.bass, 0, 'bass is clamped to the speaker range');
    await w.api('POST', `/api/speakers/${LIVING}/power-saving`, { enabled: false });
    assert.equal(w.living.state.powerSaving, false);
    await w.api('POST', `/api/speakers/${LIVING}/name`, { name: 'Living Room' });
  });

  it('groups and ungroups speakers', async () => {
    let r = await w.api('POST', '/api/zones', { masterId: LIVING, memberIds: [KITCHEN] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let sp = await waitFor(async () => {
      const s = await speaker();
      return s.zone && s;
    });
    assert.equal(sp.zone.master, LIVING);
    assert.ok(sp.zone.members.some((m) => m.id === KITCHEN));
    r = await w.api('DELETE', `/api/zones/${LIVING}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    sp = await waitFor(async () => {
      const s = await speaker();
      return !s.zone && s;
    });
    assert.equal(sp.zone, null);
  });
});

describe('library', () => {
  it('manages favorites', async () => {
    await w.api('POST', '/api/favorites', { station: station('s10001', 'Jazz24') });
    await w.api('POST', '/api/favorites', { station: station('s10008', 'Hot 97') });
    await w.api('POST', '/api/favorites', { station: { type: 'url', url: `${w.radio.base}/streams/s10012`, name: 'My Country' } });
    await w.api('POST', '/api/favorites', { station: station('s10001', 'Jazz24') });
    let favs = (await w.api('GET', '/api/favorites')).data;
    assert.equal(favs.length, 3, 'duplicates are merged');
    await w.api('POST', '/api/favorites/reorder', { keys: [favs[2].station.key, favs[0].station.key] });
    favs = (await w.api('GET', '/api/favorites')).data;
    assert.deepEqual(
      favs.map((f) => f.station.name),
      ['My Country', 'Jazz24', 'Hot 97'],
    );
    await w.api('PUT', `/api/favorites/${encodeURIComponent(favs[0].station.key)}`, { name: 'Country Hits' });
    favs = (await w.api('GET', '/api/favorites')).data;
    assert.equal(favs[0].station.name, 'Country Hits');
    await w.api('DELETE', `/api/favorites/${encodeURIComponent(favs[2].station.key)}`);
    assert.equal((await w.api('GET', '/api/favorites')).data.length, 2);
  });

  it('validates station input', async () => {
    const r = await w.api('POST', '/api/favorites', { station: { type: 'url', url: 'ftp://nope' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /http/);
  });

  it('tests a custom stream URL', async () => {
    const ok = (await w.api('POST', '/api/stations/test', { url: `${w.radio.base}/pls/s10002.pls` })).data;
    assert.equal(ok.ok, true);
    assert.equal(ok.contentType, 'audio/mpeg');
    const bad = (await w.api('POST', '/api/stations/test', { url: `${w.radio.base}/hls/x.m3u8` })).data;
    assert.equal(bad.ok, false);
    assert.match(bad.error, /HLS/);
  });
});

describe('timers and alarms', () => {
  it('sets and cancels a sleep timer', async () => {
    let r = await w.api('POST', `/api/speakers/${LIVING}/sleep`, { minutes: 30 });
    assert.equal(r.status, 200);
    let sp = await speaker();
    assert.ok(sp.sleepTimer.endsAt > Date.now() + 29 * 60000);
    r = await w.api('POST', `/api/speakers/${LIVING}/sleep`, { minutes: null });
    sp = await speaker();
    assert.equal(sp.sleepTimer, null);
  });

  it('turns the speaker off when the sleep timer ends and restores volume', async () => {
    await w.api('POST', `/api/speakers/${LIVING}/play`, { station: station('s10001', 'Jazz24') });
    await waitFor(() => w.living.state.playStatus === 'PLAY_STATE');
    await w.api('POST', `/api/speakers/${LIVING}/volume`, { level: 40 });
    w.app.store.update((s) => {
      s.sleepTimers[LIVING] = { minutes: 1, endsAt: Date.now() + 4000, fade: true };
    });
    w.app.scheduler.tick();
    await waitFor(() => w.living.state.source === 'STANDBY', { timeout: 15000, message: 'sleep power off' });
    await waitFor(async () => (await speaker()).sleepTimer === null, { message: 'timer cleared' });
    assert.equal(w.living.state.volume, 40, 'volume restored for next time');
  });

  it('creates, validates, edits and test-fires an alarm', async () => {
    const bad = await w.api('POST', '/api/alarms', { time: '25:00', speakerId: LIVING, target: { kind: 'resume' } });
    assert.equal(bad.status, 400);
    const r = await w.api('POST', '/api/alarms', {
      label: 'Wake up',
      time: '07:00',
      days: [1, 2, 3, 4, 5],
      speakerId: LIVING,
      target: { kind: 'station', station: station('s10002', 'KEXP 90.3 FM') },
      volume: 20,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const alarms = (await w.api('GET', '/api/alarms')).data;
    assert.equal(alarms.length, 1);
    assert.ok(alarms[0].nextFire > Date.now());
    const e = await w.api('PUT', `/api/alarms/${r.data.id}`, { volume: 18, enabled: false });
    assert.equal(e.data.volume, 18);
    const t = await w.api('POST', `/api/alarms/${r.data.id}/test`);
    assert.equal(t.status, 200, JSON.stringify(t.data));
    await waitFor(() => w.living.state.stationName === 'KEXP 90.3 FM' && w.living.state.playStatus === 'PLAY_STATE');
    assert.equal(w.living.state.volume, 18);
  });

  it('fires alarms at the scheduled minute (once)', async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    await w.api('POST', `/api/speakers/${KITCHEN}/power`, { on: false });
    const r = await w.api('POST', '/api/alarms', {
      time: hhmm,
      days: [],
      speakerId: KITCHEN,
      target: { kind: 'station', station: station('s10010', 'Radio Paradise') },
      volume: 12,
      fadeIn: false,
    });
    assert.equal(r.status, 200);
    await w.app.scheduler.checkAlarms(now);
    await waitFor(() => w.kitchen.state.stationName === 'Radio Paradise' && w.kitchen.state.playStatus === 'PLAY_STATE', { message: 'alarm fired' });
    const alarm = w.app.store.state.alarms.find((a) => a.id === r.data.id);
    assert.equal(alarm.enabled, false, 'one-off alarms switch themselves off');
    assert.equal(w.kitchen.state.volume, 12);
  });
});

describe('quick actions for Siri Shortcuts', () => {
  it('plays a favorite by name and reports status', async () => {
    const r = await w.api('GET', '/api/quick/play?favorite=jazz');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => w.living.state.stationName === 'Jazz24' && w.living.state.playStatus === 'PLAY_STATE');
    const s = await waitFor(async () => {
      const x = (await w.api('GET', '/api/quick/status')).data;
      return x.playing === 'Jazz24' && x;
    });
    assert.equal(s.power, 'on');
    await w.api('GET', '/api/quick/volume?level=up');
    assert.equal(w.living.state.volume, s.volume + 5);
    const k = await w.api('GET', '/api/quick/play?speaker=kitchen&search=paradise');
    assert.equal(k.status, 200, JSON.stringify(k.data));
    await w.api('GET', '/api/quick/power?state=off&speaker=Kitchen');
    await waitFor(() => w.kitchen.state.source === 'STANDBY');
  });
});

describe('restore', () => {
  it('puts the original Bose setting back', async () => {
    const r = await w.api('POST', `/api/speakers/${LIVING}/radio-setup`, { action: 'disable' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(w.living.state.config.bmxRegistryUrl, 'https://content.api.bose.io/bmx/registry/v1/services');
    assert.equal(w.living.state.persisted.bmxRegistryUrl, 'https://content.api.bose.io/bmx/registry/v1/services');
    const sp = await speaker();
    assert.equal(sp.radio.status, 'disabled');
    assert.equal(sp.engine, 'upnp');
  });
});
