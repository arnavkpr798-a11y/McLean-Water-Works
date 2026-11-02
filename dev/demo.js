#!/usr/bin/env node
/**
 * Offline demo: runs the real hub against two simulated SoundTouch speakers
 * and a fake TuneIn directory, so the app can be tried without hardware.
 *   npm run demo   ->  open http://localhost:8095
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeRadio } from './fake-radio.js';
import { startFakeSpeaker } from './fake-speaker.js';

const ports = { http: 28090, ws: 28080, upnp: 28091, console: 27017 };
const radio = await startFakeRadio({ host: '127.0.0.1', port: 7070 });
const dataDir = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'airwave-demo-'));

Object.assign(process.env, {
  PORT: process.env.PORT || '8095',
  DATA_DIR: dataDir,
  DISCOVERY: 'off',
  TUNEIN_BASE: radio.base,
  SPEAKER_HTTP_PORT: String(ports.http),
  SPEAKER_WS_PORT: String(ports.ws),
  SPEAKER_UPNP_PORT: String(ports.upnp),
  SPEAKER_CONSOLE_PORT: String(ports.console),
  CONSOLE_DELAY_MS: '200',
  SPEAKERS: '127.0.0.2,127.0.0.3',
});

const living = await startFakeSpeaker({ host: '127.0.0.2', id: 'A0F6FD000001', name: 'Living Room', ports });
await startFakeSpeaker({ host: '127.0.0.3', id: 'A0F6FD000002', name: 'Bedroom', type: 'SoundTouch 10', ports });

// Pretend the old Bose app had saved some TuneIn presets.
living.setPreset(1, { source: 'TUNEIN', type: 'stationurl', location: '/v1/playback/station/s10001', name: 'Jazz24', art: `${radio.base}/logos/s10001.svg` });
living.setPreset(2, { source: 'TUNEIN', type: 'stationurl', location: '/v1/playback/station/s10002', name: 'KEXP 90.3 FM', art: `${radio.base}/logos/s10002.svg` });
living.setPreset(4, { source: 'TUNEIN', type: 'stationurl', location: '/v1/playback/station/s10004', name: 'NPR News Now', art: `${radio.base}/logos/s10004.svg` });

const { createServer } = await import('../server/index.js');
const app = await createServer();
await app.start();

if (process.argv.includes('--seed')) {
  const base = `http://127.0.0.1:${process.env.PORT}`;
  const call = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  await new Promise((r) => setTimeout(r, 1500));
  const st = (id, name) => ({ type: 'tunein', id, name, image: `${radio.base}/logos/${id}.svg` });
  for (const [id, name] of [
    ['s10001', 'Jazz24'],
    ['s10010', 'Radio Paradise'],
    ['s10006', 'WNYC 93.9 FM'],
    ['s10005', 'Lofi Beats Radio'],
  ])
    await call('POST', '/api/favorites', { station: st(id, name) });
  await call('PUT', '/api/speakers/A0F6FD000001/presets/3', { station: st('s10010', 'Radio Paradise') });
  await call('PUT', '/api/speakers/A0F6FD000001/presets/5', { station: st('s10005', 'Lofi Beats Radio') });
  await call('POST', '/api/speakers/A0F6FD000001/play', { station: st('s10002', 'KEXP 90.3 FM') });
  await call('POST', '/api/speakers/A0F6FD000001/play', { station: st('s10001', 'Jazz24') });
  await call('POST', '/api/alarms', { label: 'Wake up', time: '07:00', days: [1, 2, 3, 4, 5], speakerId: 'A0F6FD000002', target: { kind: 'station', station: st('s10006', 'WNYC 93.9 FM') }, volume: 20 });
  console.log('Seeded demo data');
}

console.log(`\nAirwave demo running: http://localhost:${process.env.PORT}\n(simulated speakers at 127.0.0.2 and 127.0.0.3, fake TuneIn at ${radio.base})`);
