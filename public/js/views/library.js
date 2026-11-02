import { html, useState } from '../lib.js';
import { Icon } from '../icons.js';
import { del, post } from '../api.js';
import { attempt, openSheet, useStore } from '../store.js';
import { timeAgo } from '../actions.js';
import { Artwork, Empty } from '../ui.js';
import { StationRowLive } from './browse.js';

const enc = encodeURIComponent;

export function LibraryView({ route }) {
  const s = useStore();
  const tab = route.query.tab === 'recents' ? 'recents' : 'favorites';
  const [editing, setEditing] = useState(false);
  const setTab = (t) => {
    setEditing(false);
    history.replaceState(null, '', t === 'recents' ? '#/library?tab=recents' : '#/library');
    dispatchEvent(new HashChangeEvent('hashchange'));
  };
  return html`<div>
    <div class="topbar">
      <h1>Library</h1>
      ${tab === 'favorites' &&
      s.favorites.length > 0 &&
      html`<button class="link-btn" onClick=${() => setEditing(!editing)}>${editing ? 'Done' : 'Edit'}</button>`}
      ${tab === 'recents' &&
      s.recents.length > 0 &&
      html`<button class="link-btn" onClick=${() => openSheet({ type: 'confirm', title: 'Clear recently played?', confirmLabel: 'Clear', danger: true, onConfirm: () => attempt(() => del('/api/recents')) })}>Clear</button>`}
    </div>
    <div class="segmented" role="tablist">
      <button role="tab" aria-selected=${tab === 'favorites'} class=${tab === 'favorites' ? 'on' : ''} onClick=${() => setTab('favorites')}>Favorites${s.favorites.length ? ` (${s.favorites.length})` : ''}</button>
      <button role="tab" aria-selected=${tab === 'recents'} class=${tab === 'recents' ? 'on' : ''} onClick=${() => setTab('recents')}>Recently played</button>
    </div>
    <div class="mt">${tab === 'favorites' ? html`<${Favorites} editing=${editing} />` : html`<${Recents} />`}</div>
  </div>`;
}

function Favorites({ editing }) {
  const s = useStore();
  const favs = s.favorites;
  if (!favs.length) {
    return html`<${Empty}
      icon="heart"
      title="No favorites yet"
      action=${html`<div class="btn-row" style="max-width:360px;margin:0 auto"><a class="btn primary" href="#/browse">Browse radio</a><button class="btn" onClick=${() => openSheet({ type: 'custom' })}>Add by URL</button></div>`}
    >
      Tap the heart on any station to keep it here. Favorites are shared by every phone that uses this hub.
    <//>`;
  }
  const move = (i, dir) => {
    const keys = favs.map((f) => f.station.key);
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    attempt(() => post('/api/favorites/reorder', { keys }));
  };
  if (editing) {
    return html`<div class="list">
      ${favs.map(
        (f, i) => html`<div class="row with-art" key=${f.station.key}>
          <span class="thumb"><${Artwork} src=${f.station.image} name=${f.station.name} size="sm" /></span>
          <button class="body" style="text-align:left" onClick=${() => openSheet({ type: 'custom', initial: f.station })}>
            <div class="title">${f.station.name}</div>
            <div class="sub">Tap to rename</div>
          </button>
          <div class="trail">
            <button class="icon-btn" aria-label="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}><${Icon} name="up" size="sm" /></button>
            <button class="icon-btn" aria-label="Move down" disabled=${i === favs.length - 1} onClick=${() => move(i, 1)}><${Icon} name="down" size="sm" /></button>
            <button class="icon-btn" style="color:var(--danger)" aria-label=${`Remove ${f.station.name}`} onClick=${() => attempt(() => del(`/api/favorites/${enc(f.station.key)}`))}><${Icon} name="trash" size="sm" /></button>
          </div>
        </div>`,
      )}
    </div>`;
  }
  return html`<div>
    <div class="list">${favs.map((f) => html`<${StationRowLive} key=${f.station.key} station=${f.station} subtitle=${f.station.type === 'url' ? 'Custom stream' : f.station.subtitle} />`)}</div>
    <button class="btn block mt" onClick=${() => openSheet({ type: 'custom' })}><${Icon} name="link" size="sm" />Add a station by URL</button>
  </div>`;
}

function Recents() {
  const s = useStore();
  if (!s.recents.length) return html`<${Empty} icon="radio" title="Nothing played yet">Stations you play from the app or the speaker's buttons will show up here.<//>`;
  return html`<div class="list">${s.recents.map((r) => html`<${StationRowLive} key=${r.station.key} station=${r.station} subtitle=${timeAgo(r.at)} />`)}</div>`;
}
