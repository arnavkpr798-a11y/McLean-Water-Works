import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeRadio } from '../dev/fake-radio.js';
import { startFakeSpeaker } from '../dev/fake-speaker.js';

export const PORTS = { http: 18090, ws: 18080, upnp: 18091, console: 17017 };
export const HUB_PORT = 18095;

/**
 * Boots fake TuneIn/radio + two fake speakers + the real hub. Environment
 * must be configured before the hub's config module is first imported.
 */
export async function bootWorld() {
  const radio = await startFakeRadio({ host: '127.0.0.1' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airwave-test-'));
  Object.assign(process.env, {
    PORT: String(HUB_PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    DISCOVERY: 'off',
    TUNEIN_BASE: radio.base,
    SPEAKER_HTTP_PORT: String(PORTS.http),
    SPEAKER_WS_PORT: String(PORTS.ws),
    SPEAKER_UPNP_PORT: String(PORTS.upnp),
    SPEAKER_CONSOLE_PORT: String(PORTS.console),
    CONSOLE_DELAY_MS: '120',
    LOG_LEVEL: process.env.LOG_LEVEL || 'error',
  });
  const living = await startFakeSpeaker({ host: '127.0.0.2', id: 'A0F6FD000001', name: 'Living Room', ports: PORTS });
  const kitchen = await startFakeSpeaker({ host: '127.0.0.3', id: 'A0F6FD000002', name: 'Kitchen', type: 'SoundTouch 10', ports: PORTS });
  const { createServer } = await import('../server/index.js');
  const app = await createServer();
  await app.start();
  const base = `http://127.0.0.1:${HUB_PORT}`;
  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return {
    radio,
    living,
    kitchen,
    app,
    api,
    base,
    async stop() {
      await app.stop();
      await living.stop();
      await kitchen.stop();
      await radio.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(fn, { timeout = 6000, interval = 50, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
