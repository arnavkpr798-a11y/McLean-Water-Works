import { html, useEffect, useRef, useState } from '../lib.js';
import { Icon } from '../icons.js';
import { get } from '../api.js';
import { activeSpeaker, openSheet, useStore } from '../store.js';
import { describeNowPlaying } from '../actions.js';
import { Artwork, Empty, Spinner, StationRow } from '../ui.js';

const enc = encodeURIComponent;
const pageCache = new Map();

const CATEGORY_STYLE = {
  local: ['pin', '#ff7043', '#d84315'],
  music: ['music', '#7c4dff', '#4527a0'],
  news: ['news', '#29b6f6', '#01579b'],
  talk: ['mic', '#26a69a', '#00695c'],
  sports: ['ball', '#66bb6a', '#2e7d32'],
  location: ['globe', '#ffa726', '#e65100'],
  language: ['language', '#ec407a', '#880e4f'],
  podcast: ['podcast', '#8d6e63', '#4e342e'],
};

function styleFor(item, i) {
  const key = (item.key || item.title || '').toLowerCase();
  const found = Object.entries(CATEGORY_STYLE).find(([k]) => key.includes(k));
  const fallback = Object.values(CATEGORY_STYLE)[i % 8];
  return found ? found[1] : fallback;
}

function readRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem('airwave.searches') || '[]');
  } catch {
    return [];
  }
}

function rememberSearch(q) {
  try {
    const list = [q, ...readRecentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    localStorage.setItem('airwave.searches', JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function BrowseView({ route }) {
  const ref = route.params.ref || '';
  const initialQ = route.query.q || '';
  const [q, setQ] = useState(initialQ);
  const [focused, setFocused] = useState(false);

  useEffect(() => setQ(initialQ), [initialQ]);

  const searching = q.trim().length > 0;
  return html`<div>
    ${!ref &&
    html`<div class="topbar"><h1>Browse</h1>
      <button class="icon-btn filled" aria-label="Add a station by URL" onClick=${() => openSheet({ type: 'custom' })}><${Icon} name="plus" /></button>
    </div>`}
    <div class="search">
      <form
        class="search-box"
        role="search"
        onSubmit=${(e) => {
          e.preventDefault();
          if (q.trim()) {
            rememberSearch(q.trim());
            history.replaceState(null, '', `#/browse?q=${enc(q.trim())}`);
          }
          e.currentTarget.querySelector('input').blur();
        }}
      >
        <${Icon} name="search" size="sm" />
        <input
          type="search"
          placeholder="Stations, genres, cities…"
          aria-label="Search TuneIn"
          value=${q}
          enterkeyhint="search"
          autocomplete="off"
          onFocus=${() => setFocused(true)}
          onBlur=${() => setTimeout(() => setFocused(false), 150)}
          onInput=${(e) => setQ(e.currentTarget.value)}
        />
        ${q &&
        html`<button
          type="button"
          class="icon-btn"
          style="width:32px;height:32px"
          aria-label="Clear search"
          onClick=${() => {
            setQ('');
            if (initialQ) history.replaceState(null, '', '#/browse');
          }}
        >
          <${Icon} name="close" size="sm" />
        </button>`}
      </form>
    </div>
    ${searching
      ? html`<${SearchResults} q=${q.trim()} />`
      : focused && !ref
        ? html`<${RecentSearches} onPick=${(x) => setQ(x)} />`
        : html`<${BrowsePage} ref_=${ref} title=${route.query.t} />`}
  </div>`;
}

function RecentSearches({ onPick }) {
  const list = readRecentSearches();
  if (!list.length) return null;
  return html`<div>
    <div class="list-label">Recent searches</div>
    <div class="list">
      ${list.map((x) => html`<button class="row" key=${x} onMouseDown=${(e) => e.preventDefault()} onClick=${() => onPick(x)}><span class="lead-icon"><${Icon} name="search" size="sm" /></span><div class="body"><div class="title">${x}</div></div></button>`)}
    </div>
  </div>`;
}

function useTuneIn(path) {
  const [data, setData] = useState(pageCache.get(path) || null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!pageCache.has(path)) setData(null);
    get(path)
      .then((d) => {
        if (cancelled) return;
        pageCache.set(path, d);
        if (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value);
        setData(d);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [path, reload]);
  return { data, error, retry: () => setReload((n) => n + 1) };
}

function SearchResults({ q }) {
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (debounced.length > 2) rememberSearch(debounced);
  }, [debounced]);
  const { data, error, retry } = useTuneIn(`/api/tunein/search?q=${enc(debounced)}`);
  if (error) return html`<${LoadError} error=${error} retry=${retry} />`;
  if (!data || debounced !== q) return html`<${Skeleton} />`;
  if (!data.items.length) return html`<${Empty} icon="search" title="No results">Try a station name, a call sign like “WNYC”, a city, or a genre.<//>`;
  return html`<${Items} items=${data.items} />`;
}

function BrowsePage({ ref_, title }) {
  const { data, error, retry } = useTuneIn(`/api/tunein/browse${ref_ ? `?ref=${enc(ref_)}` : ''}`);
  const back = html`<div class="page-title">
    <button class="icon-btn" aria-label="Back" onClick=${() => history.back()}><${Icon} name="chevronLeft" /></button>
    <h2>${data?.title || title || ''}</h2>
  </div>`;
  if (error) return html`${ref_ && back}<${LoadError} error=${error} retry=${retry} />`;
  if (!data) return html`${ref_ && back}<${Skeleton} />`;
  if (!ref_) {
    const links = data.items.filter((i) => i.kind === 'link');
    return html`<div>
      <div class="category-grid">
        ${links.map((l, i) => {
          const [icon, a, b] = styleFor(l, i);
          return html`<a class="category" key=${l.ref} href=${`#/browse/${enc(l.ref)}?t=${enc(l.title)}`} style=${`background:linear-gradient(135deg,${a},${b});text-decoration:none`}>
            <${Icon} name=${icon} />
            <span>${l.title}</span>
          </a>`;
        })}
      </div>
      <${Items} items=${data.items.filter((i) => i.kind !== 'link')} />
      <${LibraryShortcuts} />
      <p class="list-foot center" style="margin-top:22px">Radio directory by TuneIn</p>
    </div>`;
  }
  return html`<div>${back}<${Items} items=${data.items} /></div>`;
}

function LibraryShortcuts() {
  const s = useStore();
  if (!s.recents.length) return null;
  return html`<div>
    <div class="list-label">Recently played</div>
    <div class="list">${s.recents.slice(0, 5).map((r) => html`<${StationRowLive} key=${r.station.key} station=${r.station} />`)}</div>
  </div>`;
}

function StationRowLive({ station, subtitle }) {
  useStore();
  const sp = activeSpeaker();
  const d = describeNowPlaying(sp);
  const playing = !d.standby && d.station?.key === station.key;
  return html`<${StationRow} station=${station} subtitle=${subtitle} playing=${playing} />`;
}

function Items({ items }) {
  const sections = [];
  let loose = [];
  for (const it of items) {
    if (it.kind === 'section') {
      if (loose.length) sections.push({ title: '', items: loose });
      loose = [];
      sections.push({ title: it.title, items: it.items });
    } else loose.push(it);
  }
  if (loose.length) sections.push({ title: '', items: loose });
  return sections.map(
    (sec, i) => html`<div key=${i}>
      ${sec.title && html`<div class="list-label">${sec.title}</div>`}
      <div class="list" style=${!sec.title && i === 0 ? '' : ''}>
        ${sec.items.map((it, j) => {
          if (it.kind === 'station') return html`<${StationRowLive} key=${it.station.key} station=${it.station} subtitle=${it.station.playing || it.station.subtitle} />`;
          if (it.kind === 'link')
            return html`<a class=${`row tappable ${it.image ? 'with-art' : ''}`} key=${it.ref || j} href=${`#/browse/${enc(it.ref)}?t=${enc(it.title)}`} style="text-decoration:none">
              ${it.image ? html`<span class="thumb"><${Artwork} src=${it.image} name=${it.title} size="sm" /></span>` : html`<span class="lead-icon"><${Icon} name="radio" size="sm" /></span>`}
              <div class="body"><div class="title">${it.title}</div>${it.subtitle && html`<div class="sub">${it.subtitle}</div>`}</div>
              <div class="trail"><${Icon} name="chevronRight" size="sm" /></div>
            </a>`;
          if (it.kind === 'text') return html`<div class="text-row" key=${j}>${it.title}</div>`;
          return null;
        })}
      </div>
    </div>`,
  );
}

function Skeleton() {
  return html`<div class="list" style="padding:8px 12px" aria-busy="true">
    ${[0, 1, 2, 3, 4, 5].map((i) => html`<div key=${i} class="row-gap" style="padding:8px 0"><div class="skeleton" style="width:50px;height:50px"></div><div style="flex:1"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:12px;width:40%;margin-top:8px"></div></div></div>`)}
  </div>`;
}

function LoadError({ error, retry }) {
  return html`<${Empty} icon="wifi" title="Couldn't load stations" action=${html`<button class="btn" onClick=${retry}><${Icon} name="refresh" size="sm" />Try again</button>`}>
    ${error.message}
  <//>`;
}

export { Items, StationRowLive };
