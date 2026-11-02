import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { IcyDemuxer, openStream, parseIcyMetadata, parsePlaylist, readBody } from '../server/stream.js';
import { decodeStationData, normalizeStation, stationFromContentItem, stationLocation, contentItemXml } from '../server/stations.js';
import { parseSystemConfiguration, isSafeConsoleUrl } from '../server/soundtouch/console.js';
import { normalizeNowPlaying, normalizePresets, normalizeInfo, normalizeZone } from '../server/soundtouch/models.js';
import { parseXml } from '../server/soundtouch/xml.js';
import { normalizeOutline, encodeRef } from '../server/tunein.js';

describe('playlists', () => {
  it('parses PLS', () => {
    const r = parsePlaylist('[playlist]\nNumberOfEntries=2\nFile1=http://a.example/s\nFile2=http://b.example/s\n', 'http://x/');
    assert.deepEqual(r.urls, ['http://a.example/s', 'http://b.example/s']);
  });
  it('parses M3U with comments and relative entries', () => {
    const r = parsePlaylist('#EXTM3U\n#EXTINF:-1,Radio\nhttp://a.example/live\nlive2.mp3\n', 'http://host.example/dir/list.m3u');
    assert.deepEqual(r.urls, ['http://a.example/live', 'http://host.example/dir/live2.mp3']);
  });
  it('detects HLS', () => {
    assert.equal(parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8', 'http://x/').hls, true);
  });
  it('parses ASX', () => {
    const r = parsePlaylist('<asx version="3.0"><entry><ref href="http://a.example/s"/></entry></asx>', 'http://x/');
    assert.deepEqual(r.urls, ['http://a.example/s']);
  });
});

describe('ICY metadata', () => {
  it('parses StreamTitle including apostrophes', () => {
    assert.equal(parseIcyMetadata(Buffer.from("StreamTitle='Guns N' Roses - Don't Cry';StreamUrl='';\0\0")).title, "Guns N' Roses - Don't Cry");
  });
  it('strips metadata blocks from audio across chunk boundaries', async () => {
    const metaInt = 10;
    const audio = Buffer.from('ABCDEFGHIJabcdefghij0123456789');
    const meta = Buffer.alloc(33);
    meta[0] = 2;
    meta.write("StreamTitle='Hello';", 1);
    const zero = Buffer.from([0]);
    const stream = Buffer.concat([audio.subarray(0, 10), meta, audio.subarray(10, 20), zero, audio.subarray(20, 30), zero]);
    const demux = new IcyDemuxer(metaInt);
    const titles = [];
    const out = [];
    demux.on('metadata', (m) => titles.push(m.title));
    demux.on('data', (d) => out.push(d));
    for (let i = 0; i < stream.length; i += 3) demux.write(stream.subarray(i, i + 3));
    demux.end();
    await new Promise((r) => demux.on('end', r));
    assert.equal(Buffer.concat(out).toString(), audio.toString());
    assert.deepEqual(titles, ['Hello']);
  });
});

describe('raw stream client', () => {
  it('de-chunks HTTP/1.1 chunked bodies and follows redirects', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/r') {
        res.writeHead(301, { Location: '/body' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write('hello ');
      setTimeout(() => res.end('world'), 20);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const conn = await openStream(`http://127.0.0.1:${srv.address().port}/r`);
    assert.match(conn.url, /\/body$/);
    assert.equal(await readBody(conn.body), 'hello world');
    conn.close();
    srv.close();
  });
});

describe('stations', () => {
  it('round-trips through a preset location', () => {
    const st = normalizeStation({ type: 'tunein', id: 's24939', name: 'BBC Radio 1', image: 'https://cdn.example/s.png' });
    const loc = stationLocation(st);
    assert.match(loc, /^\/station\?data=[A-Za-z0-9_-]+$/);
    const back = decodeStationData(loc.split('data=')[1]);
    assert.equal(back.key, st.key);
    assert.equal(back.name, 'BBC Radio 1');
    assert.equal(stationFromContentItem({ source: 'LOCAL_INTERNET_RADIO', location: loc }).id, 's24939');
  });
  it('reads Bose Orion and legacy TuneIn locations', () => {
    const data = Buffer.from(JSON.stringify({ streamUrl: 'http://s.example/live', name: 'Custom', imageUrl: '' })).toString('base64');
    const st = stationFromContentItem({ source: 'LOCAL_INTERNET_RADIO', location: `http://content.api.bose.io/core02/svc-bmx-adapter-orion/prod/orion/station?data=${data}` });
    assert.equal(st.url, 'http://s.example/live');
    const t = stationFromContentItem({ source: 'TUNEIN', location: '/v1/playback/station/s12345', name: 'Old preset' });
    assert.equal(t.id, 's12345');
  });
  it('escapes XML in content items', () => {
    const xml = contentItemXml(normalizeStation({ type: 'url', url: 'http://a.example/?a=1&b=2', name: 'Rock & <Roll>' }));
    assert.match(xml, /Rock &amp; &lt;Roll&gt;/);
    assert.doesNotMatch(xml, /&b=/);
  });
  it('rejects bad input', () => {
    assert.throws(() => normalizeStation({ type: 'url', url: 'javascript:alert(1)' }));
    assert.throws(() => normalizeStation({ type: 'tunein', id: '../etc' }));
    assert.throws(() => normalizeStation({ type: 'url', url: 'http://user:pw@a.example/' }));
  });
});

describe('speaker console', () => {
  it('parses protobuf, flat and XML getpdo output', () => {
    const proto = 'bmxRegistryUrl {\r\n  text: "https://content.api.bose.io/bmx/registry/v1/services"\r\n}\r\n->OK';
    assert.equal(parseSystemConfiguration(proto).bmxRegistryUrl, 'https://content.api.bose.io/bmx/registry/v1/services');
    assert.equal(parseSystemConfiguration('margeServerUrl=https://streaming.bose.com\n').margeServerUrl, 'https://streaming.bose.com');
    assert.equal(parseSystemConfiguration('<bmxRegistryUrl>http://h:1/x</bmxRegistryUrl>').bmxRegistryUrl, 'http://h:1/x');
  });
  it('only writes clean URLs', () => {
    assert.equal(isSafeConsoleUrl('http://192.168.1.5:8095/bmx/registry/v1/services'), true);
    assert.equal(isSafeConsoleUrl('http://x/;reboot'), false);
    assert.equal(isSafeConsoleUrl('http://x/ a'), false);
    assert.equal(isSafeConsoleUrl(';busybox httpd'), false);
  });
});

describe('speaker XML models', () => {
  it('normalises now playing for standby and radio', () => {
    assert.equal(normalizeNowPlaying(parseXml('<nowPlaying deviceID="X" source="STANDBY"><ContentItem source="STANDBY" isPresetable="false" /></nowPlaying>')).status, 'standby');
    const np = normalizeNowPlaying(
      parseXml(
        '<nowPlaying deviceID="X" source="TUNEIN"><ContentItem source="TUNEIN" location="/v1/playback/station/s1" isPresetable="true"><itemName>Jazz &amp; Blues</itemName></ContentItem><track>T</track><art artImageStatus="IMAGE_PRESENT">http://a/x.png</art><playStatus>PLAY_STATE</playStatus><skipEnabled /></nowPlaying>',
      ),
    );
    assert.equal(np.status, 'playing');
    assert.equal(np.item.name, 'Jazz & Blues');
    assert.equal(np.art, 'http://a/x.png');
    assert.equal(np.skipEnabled, true);
  });
  it('normalises presets, info and zones', () => {
    const presets = normalizePresets(parseXml('<presets><preset id="1" createdOn="1" updatedOn="2"><ContentItem source="TUNEIN" location="/v1/playback/station/s1" isPresetable="true"><itemName>A</itemName></ContentItem></preset></presets>'));
    assert.equal(presets.length, 1);
    assert.equal(presets[0].item.name, 'A');
    const info = normalizeInfo(parseXml('<info deviceID="AB12"><name>Den</name><type>SoundTouch 30</type><components><component><componentCategory>SCM</componentCategory><softwareVersion>27.0.6.1 build</softwareVersion></component></components><networkInfo type="SCM"><macAddress>AB12</macAddress><ipAddress>1.2.3.4</ipAddress></networkInfo></info>'));
    assert.equal(info.firmware, '27.0.6.1');
    assert.equal(info.ip, '1.2.3.4');
    assert.equal(normalizeZone(parseXml('<zone />')), null);
    const z = normalizeZone(parseXml('<zone master="M"><member ipaddress="1.1.1.1">M</member><member ipaddress="1.1.1.2">S</member></zone>'));
    assert.equal(z.members.length, 2);
  });
});

describe('TuneIn outlines', () => {
  it('normalises stations, links and sections', () => {
    const st = normalizeOutline({ element: 'outline', type: 'audio', text: 'X', URL: 'http://opml.radiotime.com/Tune.ashx?id=s1', guide_id: 's1', image: 'i' });
    assert.equal(st.station.id, 's1');
    const link = normalizeOutline({ element: 'outline', type: 'link', text: 'Music', URL: 'http://opml.radiotime.com/Browse.ashx?c=music' });
    assert.equal(link.ref, encodeRef('http://opml.radiotime.com/Browse.ashx?c=music'));
    const sec = normalizeOutline({ element: 'outline', text: 'S', children: [st && { element: 'outline', type: 'audio', text: 'Y', guide_id: 's2' }] });
    assert.equal(sec.kind, 'section');
    assert.equal(normalizeOutline({ type: 'audio', text: 'no id' }), null);
  });
});
