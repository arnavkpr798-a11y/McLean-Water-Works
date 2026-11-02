import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return (value || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * All runtime configuration comes from environment variables so the hub can run
 * unchanged under Node, systemd, launchd or Docker.
 */
export const config = {
  /** Port the hub listens on (phone app + speaker callbacks). */
  port: int(process.env.PORT, 8095),
  host: process.env.HOST || '0.0.0.0',
  /** Where favorites, alarms and settings are stored. */
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  /**
   * Address the *speaker* uses to reach this hub. Leave empty to detect it
   * automatically (the hub's LAN IP on the route towards each speaker).
   */
  publicAddress: process.env.PUBLIC_ADDRESS || '',
  /** Speakers to always connect to, e.g. "192.168.1.40,192.168.1.41". */
  staticSpeakers: list(process.env.SPEAKERS),
  /** Set DISCOVERY=off to disable automatic network discovery. */
  discovery: (process.env.DISCOVERY || 'on').toLowerCase() !== 'off',
  /** TuneIn's public OPML API (the catalogue the Bose app used). */
  tuneinBase: process.env.TUNEIN_BASE || 'https://opml.radiotime.com',
  /** Optional TuneIn partner id, if you have one. */
  tuneinPartnerId: process.env.TUNEIN_PARTNER_ID || '',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  /** Speaker ports. Only change these for testing against a simulator. */
  speakerPorts: {
    http: int(process.env.SPEAKER_HTTP_PORT, 8090),
    ws: int(process.env.SPEAKER_WS_PORT, 8080),
    upnp: int(process.env.SPEAKER_UPNP_PORT, 8091),
    console: int(process.env.SPEAKER_CONSOLE_PORT, 17000),
  },
  /** Delay between telnet console commands; the speaker needs ~2 s. */
  consoleDelayMs: int(process.env.CONSOLE_DELAY_MS, 2000),
};

export const VERSION = '1.0.0';
export const USER_AGENT = `Airwave/${VERSION} (SoundTouch hub)`;
