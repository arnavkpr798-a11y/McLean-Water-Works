import { html, useEffect, useRef, useState } from './lib.js';
import { Icon } from './icons.js';
import { closeSheet, isFavorite, openSheet, useStore } from './store.js';
import { playStation, toggleFavorite } from './actions.js';

const PALETTE = [
  ['#ff7043', '#c2185b'],
  ['#26a69a', '#1e3a8a'],
  ['#7c4dff', '#311b92'],
  ['#ffb300', '#e65100'],
  ['#29b6f6', '#1a237e'],
  ['#66bb6a', '#1b5e20'],
  ['#ec407a', '#4a148c'],
  ['#8d6e63', '#3e2723'],
];

function hash(s) {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function initials(name) {
  const words = String(name || '?')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '♪';
  if (/^\d/.test(words[0]) && words[1]) return (words[0] + words[1][0]).slice(0, 4).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Station/album art with a colourful initials fallback. */
export function Artwork({ src, name, size = 'md', icon }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    return html`<img class="art-img" src=${src} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`;
  }
  const [a, b] = PALETTE[hash(name) % PALETTE.length];
  const fontSize = { sm: '15px', md: '18px', lg: '56px', xl: '72px' }[size] || '18px';
  return html`<div class="art-fallback" style=${`background:linear-gradient(135deg,${a},${b});font-size:${fontSize}`}>
    ${icon ? html`<${Icon} name=${icon} size="lg" />` : initials(name)}
  </div>`;
}

export function Spinner({ light, lg }) {
  return html`<span class=${`spinner ${light ? 'light' : ''} ${lg ? 'lg' : ''}`} role="progressbar" aria-label="Loading"></span>`;
}

export function Switch({ checked, onChange, label, disabled }) {
  return html`<label class="switch">
    <input type="checkbox" role="switch" checked=${!!checked} disabled=${disabled} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="track"></span>
  </label>`;
}

/**
 * Slider that stays smooth while dragging: it ignores incoming updates
 * during the drag (and briefly after), and throttles outgoing changes.
 */
export function LiveSlider({ value, min = 0, max = 100, step = 1, onInput, onCommit, label, muted, throttle = 140 }) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const holdUntil = useRef(0);
  const lastSent = useRef(0);
  const timer = useRef(null);

  useEffect(() => {
    if (!dragging.current && Date.now() > holdUntil.current) setLocal(value);
  }, [value]);

  const send = (v, final) => {
    clearTimeout(timer.current);
    const now = Date.now();
    if (final) {
      onCommit?.(v);
      return;
    }
    if (now - lastSent.current >= throttle) {
      lastSent.current = now;
      onInput?.(v);
    } else {
      timer.current = setTimeout(() => {
        lastSent.current = Date.now();
        onInput?.(v);
      }, throttle);
    }
  };

  const pct = ((local - min) / (max - min || 1)) * 100;
  return html`<input
    type="range"
    class=${`slider ${muted ? 'muted' : ''}`}
    min=${min}
    max=${max}
    step=${step}
    value=${local}
    aria-label=${label}
    style=${`--pct:${pct}%`}
    onPointerDown=${() => {
      dragging.current = true;
    }}
    onInput=${(e) => {
      const v = Number(e.currentTarget.value);
      setLocal(v);
      holdUntil.current = Date.now() + 1200;
      send(v, false);
    }}
    onChange=${(e) => {
      dragging.current = false;
      holdUntil.current = Date.now() + 1200;
      send(Number(e.currentTarget.value), true);
    }}
    onPointerUp=${() => {
      dragging.current = false;
    }}
  />`;
}

export function Empty({ icon, title, children, action }) {
  return html`<div class="empty">
    ${icon && html`<${Icon} name=${icon} />`}
    <h3>${title}</h3>
    ${children && html`<p>${children}</p>`}
    ${action}
  </div>`;
}

/** A station list row: tap plays, heart toggles favorite, ⋯ opens actions. */
export function StationRow({ station, subtitle, trailing, onPlay, playing }) {
  const s = useStore();
  const fav = isFavorite(station.key);
  const busy = s.pending.play === station.key;
  return html`<div class=${`row with-art tappable ${playing ? 'playing' : ''}`}>
    <button class="thumb" aria-label=${`Play ${station.name}`} onClick=${() => (onPlay ? onPlay(station) : playStation(station))}>
      <${Artwork} src=${station.image} name=${station.name} size="sm" />
    </button>
    <button class="body" style="text-align:left" onClick=${() => (onPlay ? onPlay(station) : playStation(station))}>
      <div class="title">${playing && html`<span class="eq"><i></i><i></i><i></i></span>`}${station.name}</div>
      ${(subtitle ?? station.subtitle) && html`<div class="sub">${subtitle ?? station.subtitle}</div>`}
    </button>
    <div class="trail">
      ${busy && html`<${Spinner} />`}
      ${trailing}
      <button class=${`icon-btn ${fav ? 'active' : ''}`} aria-label=${fav ? 'Remove from favorites' : 'Add to favorites'} onClick=${() => toggleFavorite(station)}>
        <${Icon} name=${fav ? 'heartFill' : 'heart'} size="sm" />
      </button>
      <button class="icon-btn" aria-label="More actions" onClick=${() => openStationSheet(station)}>
        <${Icon} name="more" size="sm" />
      </button>
    </div>
  </div>`;
}

export function openStationSheet(station) {
  openSheet({ type: 'station', station });
}

export function Sheet({ title, subtitle, onClose = closeSheet, children, head }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);
  return html`<div>
    <div class="scrim" onClick=${onClose}></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="grab"></div>
      <div class="sheet-head">
        ${head}
        <div style="flex:1;min-width:0">
          <h3>${title}</h3>
          ${subtitle && html`<div class="sub">${subtitle}</div>`}
        </div>
        <button class="icon-btn filled" aria-label="Close" onClick=${onClose}><${Icon} name="close" size="sm" /></button>
      </div>
      <div class="sheet-body">${children}</div>
    </div>
  </div>`;
}

export function Toasts() {
  const s = useStore();
  return html`<div class="toasts" aria-live="polite">
    ${s.toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.error ? 'error' : ''}`} role=${t.error ? 'alert' : 'status'}>${t.message}</div>`)}
  </div>`;
}

export function Row({ icon, title, sub, onClick, trail, chevron = true, danger, children, href }) {
  const content = html`
    ${icon && html`<span class="lead-icon" style=${danger ? 'color:var(--danger)' : ''}><${Icon} name=${icon} size="sm" /></span>`}
    <div class="body">
      <div class="title" style=${danger ? 'color:var(--danger)' : ''}>${title}</div>
      ${sub && html`<div class="sub">${sub}</div>`}
      ${children}
    </div>
    <div class="trail">${trail}${chevron && (onClick || href) ? html`<${Icon} name="chevronRight" size="sm" />` : null}</div>
  `;
  if (href) return html`<a class="row tappable" href=${href} style="text-decoration:none">${content}</a>`;
  if (onClick) return html`<button class="row" onClick=${onClick}>${content}</button>`;
  return html`<div class="row">${content}</div>`;
}
