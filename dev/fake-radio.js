#!/usr/bin/env node
/**
 * Fake TuneIn OPML API + fake radio streams, for tests and the offline demo.
 * The JSON mirrors opml.radiotime.com's render=json format.
 */
import http from 'node:http';
import net from 'node:net';

const COLORS = ['#ff6b35', '#2ec4b6', '#e71d36', '#7b2cbf', '#3a86ff', '#ffbe0b', '#06d6a0', '#ef476f', '#118ab2', '#8338ec'];

export const STATIONS = [
  { id: 's10001', name: 'Jazz24', sub: 'Jazz from Seattle', genre: 'Jazz', kind: 'direct', song: 'Miles Davis - So What' },
  { id: 's10002', name: 'KEXP 90.3 FM', sub: 'Where the music matters', genre: 'Indie', kind: 'pls', song: 'Fleet Foxes - Mykonos' },
  { id: 's10003', name: 'Classic FM', sub: 'The world’s greatest music', genre: 'Classical', kind: 'redirect', song: 'Debussy - Clair de Lune' },
  { id: 's10004', name: 'NPR News Now', sub: 'Hourly national news', genre: 'News', kind: 'icy', song: 'NPR News' },
  { id: 's10005', name: 'Lofi Beats Radio', sub: 'Beats to relax and study to', genre: 'Chill', kind: 'direct', song: 'Chillhop - Late Night' },
  { id: 's10006', name: 'WNYC 93.9 FM', sub: 'New York Public Radio', genre: 'Talk', kind: 'direct', song: 'All Things Considered' },
  { id: 's10007', name: 'ESPN Radio', sub: 'Live sports talk', genre: 'Sports', kind: 'direct', song: 'SportsCenter AllNight' },
  { id: 's10008', name: 'Hot 97', sub: 'Hip hop & R&B', genre: 'Hip Hop', kind: 'direct', song: 'Kendrick Lamar - Luther' },
  { id: 's10009', name: 'Smooth Chill (HLS only)', sub: 'Unplayable on SoundTouch', genre: 'Chill', kind: 'hls', song: '' },
  { id: 's10010', name: 'Radio Paradise', sub: 'Eclectic, commercial-free', genre: 'Eclectic', kind: 'direct', song: 'Radiohead - Reckoner' },
  { id: 's10011', name: 'BBC World Service', sub: 'International news', genre: 'News', kind: 'pls', song: 'Newshour' },
  { id: 's10012', name: '1.FM Country', sub: 'Today’s country hits', genre: 'Country', kind: 'direct', song: 'Zach Bryan - Something in the Orange' },
];

function silentMp3Frame() {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  return frame;
}
const FRAME = silentMp3Frame();

function logoSvg(st, i) {
  const initials = st.name
    .replace(/[^A-Za-z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  const c = COLORS[i % COLORS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#111"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><text x="100" y="122" font-family="Helvetica,Arial,sans-serif" font-size="64" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
}

export async function startFakeRadio({ host = '127.0.0.1', port = 0, icyPort = 0 } = {}) {
  let base = '';
  let icyBase = '';
  const stats = { streams: 0, tune: 0 };

  const outline = (st) => ({
    element: 'outline',
    type: 'audio',
    text: st.name,
    URL: `${base}/Tune.ashx?id=${st.id}`,
    bitrate: '128',
    reliability: '98',
    guide_id: st.id,
    subtext: st.sub,
    genre_id: 'g1',
    formats: st.kind === 'hls' ? 'hls' : 'mp3',
    playing: st.song,
    item: 'station',
    image: `${base}/logos/${st.id}.svg`,
    now_playing_id: st.id,
    preset_id: st.id,
  });
  const link = (text, query, key) => ({ element: 'outline', type: 'link', text, URL: `${base}/Browse.ashx?${query}`, key });
  const ok = (title, body) => ({ head: { title, status: '200' }, body });

  function browse(params) {
    const c = params.get('c');
    const id = params.get('id');
    if (!c && !id) {
      return ok('Browse', [
        link('Local Radio', 'c=local', 'local'),
        link('Music', 'c=music', 'music'),
        link('News', 'c=News', 'news'),
        link('Talk', 'c=talk', 'talk'),
        link('Sports', 'c=sports', 'sports'),
        link('By Location', 'id=r0', 'location'),
        link('By Language', 'c=lang', 'language'),
        link('Podcasts', 'c=podcast', 'podcast'),
      ]);
    }
    if (c === 'local') return ok('Local Radio', [{ element: 'outline', text: 'Stations', key: 'stations', children: STATIONS.slice(0, 6).map(outline) }]);
    if (c === 'music') {
      return ok('Music', [
        { element: 'outline', text: 'Genres', key: 'genres', children: ['Jazz', 'Indie', 'Classical', 'Hip Hop', 'Country'].map((g) => link(g, `id=g_${g.replace(/\W/g, '')}`, g)) },
        { element: 'outline', text: 'Popular Stations', key: 'stations', children: STATIONS.filter((s) => !['News', 'Talk', 'Sports'].includes(s.genre)).map(outline) },
      ]);
    }
    if (id && id.startsWith('g_')) {
      const g = id.slice(2);
      const list = STATIONS.filter((s) => s.genre.replace(/\W/g, '') === g);
      return ok(g, list.length ? list.map(outline) : [{ element: 'outline', type: 'text', text: 'No stations or shows available' }]);
    }
    if (c === 'News' || c === 'talk' || c === 'sports') {
      const genre = { News: 'News', talk: 'Talk', sports: 'Sports' }[c];
      return ok(genre, STATIONS.filter((s) => s.genre === genre).map(outline));
    }
    return ok('Browse', [{ element: 'outline', type: 'text', text: 'No stations or shows available' }]);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base || 'http://x');
    const json = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/Browse.ashx') return json(browse(url.searchParams));
    if (url.pathname === '/Search.ashx') {
      const q = (url.searchParams.get('query') || '').toLowerCase();
      const list = STATIONS.filter((s) => s.name.toLowerCase().includes(q) || s.genre.toLowerCase().includes(q));
      return json(ok('Search', list.length ? [{ element: 'outline', text: 'Stations', key: 'stations', children: list.map(outline) }] : []));
    }
    if (url.pathname === '/Describe.ashx') {
      const st = STATIONS.find((s) => s.id === url.searchParams.get('id'));
      if (!st) return json({ head: { status: '400', fault: 'Invalid id' } });
      return json(ok('', [{ element: 'station', guide_id: st.id, name: st.name, logo: `${base}/logos/${st.id}.svg`, slogan: st.sub, genre_name: st.genre, location: 'Seattle, WA', url: 'https://example.org' }]));
    }
    if (url.pathname === '/Tune.ashx') {
      stats.tune++;
      const st = STATIONS.find((s) => s.id === url.searchParams.get('id'));
      if (!st) return json({ head: { status: '400', fault: 'Invalid id' } });
      const entry = (u, extra = {}) => ({ element: 'audio', url: u, reliability: 98, bitrate: 128, media_type: 'mp3', position: 0, is_direct: true, ...extra });
      const map = {
        direct: [entry(`${base}/streams/${st.id}`)],
        pls: [entry(`${base}/pls/${st.id}.pls`, { is_direct: false })],
        redirect: [entry(`${base}/redirect/${st.id}`)],
        icy: [entry(`${icyBase}/${st.id}`)],
        hls: [entry(`${base}/hls/${st.id}.m3u8`, { media_type: 'hls', is_hls_advanced: 'true' })],
      };
      return json(ok('', map[st.kind]));
    }
    let m = url.pathname.match(/^\/logos\/(s\d+)\.svg$/);
    if (m) {
      const i = STATIONS.findIndex((s) => s.id === m[1]);
      if (i < 0) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
      return res.end(logoSvg(STATIONS[i], i));
    }
    m = url.pathname.match(/^\/pls\/(s\d+)\.pls$/);
    if (m) {
      res.writeHead(200, { 'Content-Type': 'audio/x-scpls' });
      return res.end(`[playlist]\nNumberOfEntries=2\nFile1=${base}/dead/${m[1]}\nTitle1=dead\nFile2=${base}/streams/${m[1]}\nTitle2=ok\nVersion=2\n`);
    }
    m = url.pathname.match(/^\/redirect\/(s\d+)$/);
    if (m) {
      res.writeHead(302, { Location: `/streams/${m[1]}` });
      return res.end();
    }
    if (url.pathname.startsWith('/hls/')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\nseg1.ts\n');
    }
    m = url.pathname.match(/^\/streams\/(s\d+)$/);
    if (m) {
      const st = STATIONS.find((s) => s.id === m[1]);
      return streamTo(res, st, req.headers['icy-metadata'] === '1', (h) => res.writeHead(200, h));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  function streamTo(sink, st, wantMeta, writeHead) {
    stats.streams++;
    const metaInt = 2048;
    const headers = { 'Content-Type': 'audio/mpeg', 'icy-name': st?.name || 'Stream', 'icy-br': '128' };
    if (wantMeta) headers['icy-metaint'] = String(metaInt);
    writeHead(headers);
    let sinceMeta = 0;
    let n = 0;
    const songs = [st?.song || 'Unknown', `${st?.song || 'Unknown'} (Live)`];
    const timer = setInterval(() => {
      for (let k = 0; k < 4; k++) {
        let frame = FRAME;
        while (frame.length) {
          if (wantMeta && sinceMeta === metaInt) {
            const title = songs[Math.floor(n / 40) % songs.length];
            const text = Buffer.from(`StreamTitle='${title.replace(/'/g, '’')}';`);
            const blocks = Math.ceil(text.length / 16);
            const meta = Buffer.alloc(1 + blocks * 16);
            meta[0] = blocks;
            text.copy(meta, 1);
            sink.write(meta);
            sinceMeta = 0;
          }
          const take = wantMeta ? Math.min(frame.length, metaInt - sinceMeta) : frame.length;
          sink.write(frame.subarray(0, take));
          frame = frame.subarray(take);
          sinceMeta += take;
        }
        n++;
      }
    }, 100);
    const stop = () => clearInterval(timer);
    sink.on('close', stop);
    sink.on('error', stop);
  }

  // SHOUTcast v1 style server answering "ICY 200 OK".
  const icy = net.createServer((sock) => {
    let head = '';
    sock.on('data', (d) => {
      if (head.includes('\r\n\r\n')) return;
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const path = head.split(' ')[1] || '/';
      const st = STATIONS.find((s) => path.endsWith(s.id));
      const wantMeta = /icy-metadata:\s*1/i.test(head);
      streamTo(sock, st, wantMeta, (h) => {
        sock.write(`ICY 200 OK\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      });
    });
    sock.on('error', () => {});
  });

  await new Promise((r) => server.listen(port, host, r));
  await new Promise((r) => icy.listen(icyPort, host, r));
  base = `http://${host}:${server.address().port}`;
  icyBase = `http://${host}:${icy.address().port}`;
  return {
    base,
    icyBase,
    stats,
    async stop() {
      server.closeAllConnections?.();
      await Promise.all([new Promise((r) => server.close(() => r())), new Promise((r) => icy.close(() => r()))]);
    },
  };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const r = await startFakeRadio({ port: Number(process.argv[2] || 7070) });
  console.log(`Fake TuneIn at ${r.base}`);
}
