#!/usr/bin/env node
/**
 * A SoundTouch speaker simulator for tests and demos. Implements the parts of
 * the real device that Airwave uses:
 *  - Web API on :8090 (info, now_playing, volume, presets, select, key, …)
 *  - WebSocket notifications on :8080 ("gabbo")
 *  - UPnP AVTransport on :8091
 *  - Maintenance console on :17000 (getpdo / sys configuration / envswitch)
 *  - Native radio: LOCAL_INTERNET_RADIO / TUNEIN items are resolved through the
 *    configured BMX registry exactly like firmware 27 does, then the stream is
 *    opened to verify it plays.
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attr(xml, tag, name) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}

function inner(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : '';
}

function fetchFrom(localAddress, url, { maxBytes = 2048, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:') return reject(new Error(`unsupported scheme ${u.protocol}`));
    const req = http.get(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, localAddress, agent: false, insecureHTTPParser: true },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          if (size >= maxBytes) {
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export async function startFakeSpeaker({
  host = '127.0.0.2',
  id = 'A0F6FD000001',
  name = 'Living Room',
  type = 'SoundTouch 30',
  firmware = '27.0.6.46330.5043500 epdbuild.trunk.hepdswbld04.2022-08-04T11:20:29',
  ports = { http: 8090, ws: 8080, upnp: 8091, console: 17000 },
  bmxRegistryUrl = 'https://content.api.bose.io/bmx/registry/v1/services',
  log = () => {},
} = {}) {
  const state = {
    name,
    power: false,
    source: 'STANDBY',
    item: null,
    playStatus: 'STOP_STATE',
    track: '',
    artist: '',
    stationName: '',
    art: '',
    volume: 22,
    muted: false,
    bass: 0,
    presets: {},
    zone: null,
    powerSaving: true,
    lastSource: { source: 'BLUETOOTH', item: { source: 'BLUETOOTH' } },
    config: {
      margeServerUrl: 'https://streaming.bose.com',
      statsServerUrl: 'https://events.api.bosecm.com',
      swUpdateUrl: 'https://worldwide.bose.com/updates/soundtouch',
      bmxRegistryUrl,
    },
    pendingConfig: null,
    upnpUri: '',
    calls: [],
    errors: [],
  };

  const sockets = new Set();
  function notify(xml) {
    for (const ws of sockets) if (ws.readyState === 1) ws.send(`<updates deviceID="${id}">${xml}</updates>`);
  }

  function nowPlayingXml() {
    if (state.source === 'STANDBY') {
      return `<nowPlaying deviceID="${id}" source="STANDBY"><ContentItem source="STANDBY" isPresetable="false" /></nowPlaying>`;
    }
    const it = state.item || {};
    const ci = `<ContentItem source="${esc(it.source || state.source)}"${it.type ? ` type="${esc(it.type)}"` : ''}${it.location ? ` location="${esc(it.location)}"` : ''} sourceAccount="${esc(it.sourceAccount || '')}" isPresetable="${it.isPresetable ? 'true' : 'false'}">${it.name ? `<itemName>${esc(it.name)}</itemName>` : ''}${it.art ? `<containerArt>${esc(it.art)}</containerArt>` : ''}</ContentItem>`;
    const conn = state.source === 'BLUETOOTH' ? '<connectionStatusInfo status="CONNECTED" deviceName="Arnav’s iPhone" />' : '';
    return (
      `<nowPlaying deviceID="${id}" source="${esc(state.source)}" sourceAccount="">${ci}` +
      `<track>${esc(state.track)}</track><artist>${esc(state.artist)}</artist><album></album>` +
      `<stationName>${esc(state.stationName)}</stationName>` +
      `<art artImageStatus="${state.art ? 'IMAGE_PRESENT' : 'SHOW_DEFAULT_IMAGE'}">${esc(state.art)}</art>` +
      `<playStatus>${state.playStatus}</playStatus>${conn}<streamType>RADIO_STREAMING</streamType></nowPlaying>`
    );
  }

  function volumeXml() {
    return `<volume deviceID="${id}"><targetvolume>${state.volume}</targetvolume><actualvolume>${state.volume}</actualvolume><muteenabled>${state.muted}</muteenabled></volume>`;
  }

  function presetsXml() {
    const items = Object.entries(state.presets)
      .map(
        ([slot, p]) =>
          `<preset id="${slot}" createdOn="${p.createdOn}" updatedOn="${p.updatedOn}"><ContentItem source="${esc(p.source)}" type="${esc(p.type || '')}" location="${esc(p.location || '')}" sourceAccount="${esc(p.sourceAccount || '')}" isPresetable="true"><itemName>${esc(p.name)}</itemName>${p.art ? `<containerArt>${esc(p.art)}</containerArt>` : ''}</ContentItem></preset>`,
      )
      .join('');
    return `<presets>${items}</presets>`;
  }

  function zoneXml() {
    if (!state.zone) return '<zone />';
    return `<zone master="${state.zone.master}">${state.zone.members.map((m) => `<member ipaddress="${m.ip}">${m.id}</member>`).join('')}</zone>`;
  }

  function changed(what) {
    if (what === 'nowPlaying') notify(`<nowPlayingUpdated>${nowPlayingXml()}</nowPlayingUpdated>`);
    if (what === 'volume') notify(`<volumeUpdated>${volumeXml()}</volumeUpdated>`);
    if (what === 'presets') notify('<presetsUpdated/>');
    if (what === 'zone') notify('<zoneUpdated/>');
    if (what === 'bass') notify('<bassUpdated/>');
    if (what === 'info') notify('<infoUpdated/>');
  }

  async function resolveViaRegistry(serviceName, location) {
    const reg = await fetchFrom(host, state.config.bmxRegistryUrl, { maxBytes: 1e6 });
    if (reg.status !== 200) throw new Error(`registry HTTP ${reg.status}`);
    const services = JSON.parse(reg.body.toString()).bmx_services || [];
    const svc = services.find((s) => s.id?.name === serviceName);
    if (!svc) throw new Error(`service ${serviceName} not in registry`);
    const url = /^https?:/.test(location) ? location : svc.baseUrl + location;
    const st = await fetchFrom(host, url, { maxBytes: 1e6 });
    if (st.status !== 200) throw new Error(`station HTTP ${st.status}`);
    const json = JSON.parse(st.body.toString());
    const streamUrl = json.audio?.streamUrl;
    if (!streamUrl) throw new Error('no streamUrl');
    const audio = await fetchFrom(host, streamUrl.replace(/^https:/, 'http:'), { maxBytes: 4096 });
    if (audio.status !== 200 || audio.body.length === 0) throw new Error(`stream HTTP ${audio.status}`);
    return { name: json.name, image: json.imageUrl, streamUrl };
  }

  async function selectItem(item) {
    state.power = true;
    if (item.source === 'BLUETOOTH' || item.source === 'AUX') {
      state.source = item.source;
      state.item = { source: item.source, sourceAccount: item.sourceAccount, isPresetable: false, name: item.source === 'AUX' ? 'AUX IN' : '' };
      state.playStatus = item.source === 'AUX' ? 'PLAY_STATE' : 'PLAY_STATE';
      state.stationName = item.source === 'BLUETOOTH' ? 'Arnav’s iPhone' : '';
      state.track = item.source === 'BLUETOOTH' ? 'Blinding Lights' : '';
      state.artist = item.source === 'BLUETOOTH' ? 'The Weeknd' : '';
      state.art = '';
      state.lastSource = { source: item.source, item };
      changed('nowPlaying');
      return;
    }
    if (item.source === 'LOCAL_INTERNET_RADIO' || item.source === 'TUNEIN') {
      state.source = item.source;
      state.item = { ...item, isPresetable: true };
      state.playStatus = 'BUFFERING_STATE';
      state.stationName = item.name;
      state.track = '';
      state.artist = '';
      state.art = item.art || '';
      changed('nowPlaying');
      try {
        const r = await resolveViaRegistry(item.source, item.location);
        state.playStatus = 'PLAY_STATE';
        state.art = r.image || state.art;
        state.lastSource = { source: item.source, item };
        log(`${name}: playing ${r.name} from ${r.streamUrl}`);
      } catch (err) {
        state.errors.push(err.message);
        state.playStatus = 'STOP_STATE';
        state.source = 'INVALID_SOURCE';
        log(`${name}: radio failed: ${err.message}`);
      }
      changed('nowPlaying');
      return;
    }
    throw Object.assign(new Error('unsupported'), { code: 1005 });
  }

  function errorXml(code, nameStr = 'UNKNOWN') {
    return `<errors deviceID="${id}"><error value="${code}" name="${nameStr}" severity="Unknown">${code}</error></errors>`;
  }

  const api = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const path = req.url.split('?')[0];
    state.calls.push({ method: req.method, path, body });
    const ok = (xml) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8" ?>${xml}`);
    };
    try {
      switch (`${req.method} ${path}`) {
        case 'GET /info':
          return ok(
            `<info deviceID="${id}"><name>${esc(state.name)}</name><type>${esc(type)}</type><margeAccountUUID>1234567</margeAccountUUID>` +
              `<components><component><componentCategory>SCM</componentCategory><softwareVersion>${firmware}</softwareVersion><serialNumber>F1234567890123456</serialNumber></component></components>` +
              `<margeURL>https://streaming.bose.com</margeURL><networkInfo type="SCM"><macAddress>${id}</macAddress><ipAddress>${host}</ipAddress></networkInfo></info>`,
          );
        case 'GET /now_playing':
          return ok(nowPlayingXml());
        case 'GET /volume':
          return ok(volumeXml());
        case 'POST /volume': {
          const v = Number.parseInt(body.replace(/<[^>]+>/g, ''), 10);
          if (Number.isFinite(v)) {
            if (v > state.volume) state.muted = false;
            state.volume = Math.max(0, Math.min(100, v));
          }
          changed('volume');
          return ok('<status>/volume</status>');
        }
        case 'GET /presets':
          return ok(presetsXml());
        case 'POST /storePreset': {
          const slot = attr(body, 'preset', 'id');
          const now = Math.floor(Date.now() / 1000);
          state.presets[slot] = {
            source: attr(body, 'ContentItem', 'source'),
            type: attr(body, 'ContentItem', 'type'),
            location: attr(body, 'ContentItem', 'location'),
            sourceAccount: attr(body, 'ContentItem', 'sourceAccount'),
            name: inner(body, 'itemName'),
            art: inner(body, 'containerArt'),
            createdOn: now,
            updatedOn: now,
          };
          changed('presets');
          return ok(presetsXml());
        }
        case 'POST /removePreset': {
          delete state.presets[attr(body, 'preset', 'id')];
          changed('presets');
          return ok(presetsXml());
        }
        case 'POST /select': {
          const item = {
            source: attr(body, 'ContentItem', 'source'),
            type: attr(body, 'ContentItem', 'type'),
            location: attr(body, 'ContentItem', 'location'),
            sourceAccount: attr(body, 'ContentItem', 'sourceAccount'),
            name: inner(body, 'itemName'),
            art: inner(body, 'containerArt'),
          };
          selectItem(item).catch(() => {});
          return ok('<status>/select</status>');
        }
        case 'POST /key': {
          const key = inner(body, 'key');
          const st = attr(body, 'key', 'state');
          if (st !== 'release') return ok('<status>/key</status>');
          if (key === 'POWER') {
            if (state.source === 'STANDBY') {
              selectItem(state.lastSource.item).catch(() => {});
            } else {
              state.source = 'STANDBY';
              state.power = false;
              state.playStatus = 'STOP_STATE';
              changed('nowPlaying');
            }
          } else if (key === 'MUTE') {
            state.muted = !state.muted;
            changed('volume');
          } else if (/^PRESET_\d$/.test(key)) {
            const p = state.presets[key.slice(-1)];
            if (p) selectItem({ ...p }).catch(() => {});
          } else if (key === 'PAUSE' || key === 'STOP') {
            if (state.source !== 'STANDBY') state.playStatus = key === 'PAUSE' ? 'PAUSE_STATE' : 'STOP_STATE';
            changed('nowPlaying');
          } else if (key === 'PLAY') {
            if (state.source !== 'STANDBY') state.playStatus = 'PLAY_STATE';
            changed('nowPlaying');
          }
          return ok('<status>/key</status>');
        }
        case 'GET /sources':
          return ok(
            `<sources deviceID="${id}"><sourceItem source="AUX" sourceAccount="AUX" status="READY" isLocal="true" multiroomallowed="true">AUX IN</sourceItem>` +
              '<sourceItem source="BLUETOOTH" status="READY" isLocal="true" multiroomallowed="true" />' +
              '<sourceItem source="LOCAL_INTERNET_RADIO" status="READY" isLocal="false" multiroomallowed="true" />' +
              '<sourceItem source="TUNEIN" status="READY" isLocal="false" multiroomallowed="true" /></sources>',
          );
        case 'GET /bassCapabilities':
          return ok(`<bassCapabilities deviceID="${id}"><bassAvailable>true</bassAvailable><bassMin>-9</bassMin><bassMax>0</bassMax><bassDefault>0</bassDefault></bassCapabilities>`);
        case 'GET /bass':
          return ok(`<bass deviceID="${id}"><targetbass>${state.bass}</targetbass><actualbass>${state.bass}</actualbass></bass>`);
        case 'POST /bass':
          state.bass = Number.parseInt(body.replace(/<[^>]+>/g, ''), 10) || 0;
          changed('bass');
          return ok('<status>/bass</status>');
        case 'GET /getZone':
          return ok(zoneXml());
        case 'POST /setZone': {
          const master = attr(body, 'zone', 'master');
          const members = [...body.matchAll(/<member ipaddress="([^"]*)">([^<]*)<\/member>/g)].map((m) => ({ ip: m[1], id: m[2] }));
          state.zone = members.length ? { master, members: [{ ip: host, id: master }, ...members] } : null;
          changed('zone');
          return ok('<status>/setZone</status>');
        }
        case 'POST /addZoneSlave': {
          const members = [...body.matchAll(/<member ipaddress="([^"]*)">([^<]*)<\/member>/g)].map((m) => ({ ip: m[1], id: m[2] }));
          if (state.zone) state.zone.members.push(...members);
          changed('zone');
          return ok('<status>/addZoneSlave</status>');
        }
        case 'POST /removeZoneSlave': {
          const ids = [...body.matchAll(/<member[^>]*>([^<]*)<\/member>/g)].map((m) => m[1]);
          if (state.zone) {
            state.zone.members = state.zone.members.filter((m) => !ids.includes(m.id));
            if (state.zone.members.length <= 1) state.zone = null;
          }
          changed('zone');
          return ok('<status>/removeZoneSlave</status>');
        }
        case 'POST /name':
          state.name = inner(body, 'name');
          changed('info');
          return ok('<status>/name</status>');
        case 'GET /enterBluetoothPairing':
          return ok('<status>/enterBluetoothPairing</status>');
        case 'GET /clearBluetoothPaired':
          return ok('<status>/clearBluetoothPaired</status>');
        case 'GET /systemtimeout':
          return ok(`<systemtimeout><powersaving_enabled>${state.powerSaving}</powersaving_enabled></systemtimeout>`);
        case 'POST /systemtimeout':
          state.powerSaving = /true/.test(body);
          return ok('<status>/systemtimeout</status>');
        case 'GET /capabilities':
          return ok(`<capabilities deviceID="${id}"><networkConfig><dualMode>true</dualMode></networkConfig></capabilities>`);
        default:
          res.writeHead(404, { 'Content-Type': 'text/xml' });
          return res.end(errorXml(404, 'HTTP_STATUS_NOT_FOUND'));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(errorXml(err.code || 500, 'ERROR'));
    }
  });

  const wsHttp = http.createServer((req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    server: wsHttp,
    handleProtocols: (protocols) => (protocols.has('gabbo') ? 'gabbo' : false),
  });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.send(`<SoundTouchSdkInfo serverVersion="4" serverBuild="trunk" />`);
    ws.on('close', () => sockets.delete(ws));
  });

  const upnp = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
    state.calls.push({ method: 'UPNP', path: action, body });
    const fault = (desc) => {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>402</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    };
    if (action === 'SetAVTransportURI') {
      const uri = inner(body, 'CurrentURI');
      if (!/^http:\/\//.test(uri)) return fault('URI must start with http://');
      state.upnpUri = uri;
      const meta = inner(body, 'CurrentURIMetaData');
      const title = (meta.match(/<dc:title>([^<]*)<\/dc:title>/) || [])[1] || '';
      state.power = true;
      state.source = 'UPNP';
      state.item = { source: 'UPNP', location: uri, name: title, isPresetable: false };
      state.stationName = title;
      state.playStatus = 'BUFFERING_STATE';
      changed('nowPlaying');
      fetchFrom(host, uri, { maxBytes: 4096 })
        .then((r) => {
          state.playStatus = r.status === 200 && r.body.length ? 'PLAY_STATE' : 'STOP_STATE';
          changed('nowPlaying');
        })
        .catch((err) => {
          state.errors.push(err.message);
          state.playStatus = 'STOP_STATE';
          changed('nowPlaying');
        });
    } else if (action === 'Play') {
      if (state.source === 'UPNP') state.playStatus = 'PLAY_STATE';
      changed('nowPlaying');
    } else if (action === 'Pause' || action === 'Stop') {
      if (state.source === 'UPNP') state.playStatus = action === 'Pause' ? 'PAUSE_STATE' : 'STOP_STATE';
      changed('nowPlaying');
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<s:Envelope><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`);
  });

  const consoleServer = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        state.calls.push({ method: 'CONSOLE', path: line });
        if (line === 'getpdo CurrentSystemConfiguration') {
          const c = state.config;
          sock.write(Object.entries(c).map(([k, v]) => `${k} {\r\n  text: "${v}"\r\n}\r\n`).join('') + '->OK\r\n');
        } else if (line.startsWith('sys configuration ')) {
          const [, , key, value] = line.split(/\s+/);
          state.config[key] = value;
          sock.write('->OK\r\n');
        } else if (line.startsWith('envswitch boseurls set ')) {
          const [marge, sw] = line.slice('envswitch boseurls set '.length).split(/\s+/);
          state.config.margeServerUrl = marge;
          state.config.swUpdateUrl = sw;
          state.persisted = { ...state.config };
          sock.write('Setting Bose Server URLs\r\n->OK\r\n');
        } else if (line === 'sys reboot') {
          state.rebooted = (state.rebooted || 0) + 1;
          sock.end();
        } else if (line) {
          sock.write('Command not found\r\n');
        }
      }
    });
    sock.on('error', () => {});
  });

  const listen = (srv, port) =>
    new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, resolve);
    });
  await listen(api, ports.http);
  await listen(wsHttp, ports.ws);
  await listen(upnp, ports.upnp);
  await listen(consoleServer, ports.console);

  return {
    id,
    host,
    state,
    setPreset(slot, p) {
      const now = Math.floor(Date.now() / 1000);
      state.presets[slot] = { createdOn: now, updatedOn: now, ...p };
    },
    async stop() {
      for (const ws of sockets) ws.terminate();
      await Promise.all([api, wsHttp, upnp, consoleServer].map((s) => new Promise((r) => s.close(() => r()))));
    },
  };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const host = process.argv[2] || '127.0.0.2';
  await startFakeSpeaker({ host, log: console.log });
  console.log(`Fake SoundTouch running at ${host}`);
}
