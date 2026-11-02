import { html, render, useEffect, useState } from './lib.js';
import { Icon } from './icons.js';
import { activeSpeaker, start, useStore } from './store.js';
import { describeNowPlaying, speakerCall } from './actions.js';
import { Artwork, Spinner, Toasts } from './ui.js';
import { SheetHost, registerSheet } from './sheets.js';
import { ListenView, SavePresetCurrentSheet } from './views/listen.js';
import { BrowseView } from './views/browse.js';
import { LibraryView } from './views/library.js';
import { SettingsView } from './views/settings.js';

registerSheet('savePresetCurrent', SavePresetCurrentSheet);

/** Hash router: #/listen, #/browse/<ref>?q=, #/library?tab=, #/settings/<sub>/<id> */
function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  const tab = ['browse', 'library', 'settings'].includes(parts[0]) ? parts[0] : 'listen';
  const params = {};
  if (tab === 'browse' && parts[1]) params.ref = decodeURIComponent(parts[1]);
  if (tab === 'settings') {
    params.sub = parts[1];
    if (parts[2]) params.id = decodeURIComponent(parts[2]);
  }
  return { tab, params, query, key: raw };
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute());
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

const TABS = [
  ['listen', '#/', 'home', 'Listen'],
  ['browse', '#/browse', 'search', 'Browse'],
  ['library', '#/library', 'library', 'Library'],
  ['settings', '#/settings', 'settings', 'Settings'],
];

function TabBar({ tab }) {
  return html`<nav class="tabbar" aria-label="Main">
    ${TABS.map(([id, href, icon, label]) => html`<a key=${id} href=${href} class=${tab === id ? 'on' : ''} aria-current=${tab === id ? 'page' : undefined}><${Icon} name=${icon} />${label}</a>`)}
  </nav>`;
}

function MiniPlayer() {
  useStore();
  const sp = activeSpeaker();
  const d = describeNowPlaying(sp);
  if (!sp || !sp.online || d.standby) return null;
  return html`<div class="mini" role="region" aria-label="Now playing">
    <a href="#/" class="thumb" aria-label="Open now playing"><${Artwork} src=${d.art} name=${d.title} size="sm" icon=${d.isRadio || d.art ? null : d.icon} /></a>
    <a href="#/" class="body" style="text-decoration:none;color:inherit">
      <div class="title">${d.title}</div>
      <div class="sub">${d.buffering ? 'Connecting…' : d.subtitle || `${d.label} · ${sp.name}`}</div>
    </a>
    <button class="icon-btn" aria-label=${d.playing || d.buffering ? 'Pause' : 'Play'} onClick=${() => speakerCall('transport', { action: 'toggle' })}>
      ${d.buffering ? html`<${Spinner} />` : html`<${Icon} name=${d.playing ? 'pause' : 'play'} />`}
    </button>
  </div>`;
}

function OfflineBar() {
  const s = useStore();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (s.connected) {
      setShow(false);
      return undefined;
    }
    const t = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(t);
  }, [s.connected]);
  if (!show) return null;
  return html`<div class="offline-bar" role="alert">Can't reach the Airwave hub — retrying… (is the hub on and are you on home Wi-Fi?)</div>`;
}

function App() {
  const route = useRoute();
  useStore();
  const sp = activeSpeaker();
  const d = describeNowPlaying(sp);
  const showMini = route.tab !== 'listen' && sp && sp.online && !d.standby;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.tab, route.params.ref, route.params.sub, route.params.id]);

  useEffect(() => {
    document.title = sp && !d.standby ? `${d.title} · Airwave` : 'Airwave';
  }, [d.title, d.standby]);

  let view;
  if (route.tab === 'browse') view = html`<${BrowseView} route=${route} />`;
  else if (route.tab === 'library') view = html`<${LibraryView} route=${route} />`;
  else if (route.tab === 'settings') view = html`<${SettingsView} route=${route} />`;
  else view = html`<${ListenView} route=${route} />`;

  return html`<div class="app">
    <${OfflineBar} />
    <main class=${`view ${showMini ? 'has-mini' : ''}`} key=${route.tab}>${view}</main>
    ${showMini && html`<${MiniPlayer} />`}
    <${TabBar} tab=${route.tab} />
    <${Toasts} />
    <${SheetHost} />
  </div>`;
}

// Theme preference (system / dark / light)
try {
  const t = localStorage.getItem('airwave.theme');
  if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t);
} catch {
  /* ignore */
}

start();
render(html`<${App} />`, document.getElementById('app'));

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
