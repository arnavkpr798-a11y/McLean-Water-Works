import { html } from './lib.js';

/** Hand-drawn 24px stroke icon set. */
const P = {
  play: html`<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none" />`,
  pause: html`<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />`,
  stop: html`<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />`,
  next: html`<path d="M5 5.5v13l9-6.5z" fill="currentColor" stroke="none" /><path d="M18 5.5v13" />`,
  prev: html`<path d="M19 5.5v13l-9-6.5z" fill="currentColor" stroke="none" /><path d="M6 5.5v13" />`,
  power: html`<path d="M12 3.5v8" /><path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0" />`,
  heart: html`<path d="M12 20s-7.2-4.4-9-8.9C1.8 7.8 3.9 4.5 7.2 4.5c2 0 3.5 1.1 4.8 2.9 1.3-1.8 2.8-2.9 4.8-2.9 3.3 0 5.4 3.3 4.2 6.6C19.2 15.6 12 20 12 20z" />`,
  heartFill: html`<path d="M12 20s-7.2-4.4-9-8.9C1.8 7.8 3.9 4.5 7.2 4.5c2 0 3.5 1.1 4.8 2.9 1.3-1.8 2.8-2.9 4.8-2.9 3.3 0 5.4 3.3 4.2 6.6C19.2 15.6 12 20 12 20z" fill="currentColor" />`,
  search: html`<circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />`,
  radio: html`<rect x="3" y="8" width="18" height="12" rx="2.5" /><circle cx="15.5" cy="14" r="3" /><path d="M6.5 12.5h3M6.5 15.5h3M7 8l9-4.5" />`,
  home: html`<circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2" />`,
  library: html`<path d="M4.5 5h11M4.5 10h11M4.5 15h6" /><path d="M16.5 20s-3.3-2-4.1-4.1c-.6-1.5.4-3 1.9-3 .9 0 1.6.5 2.2 1.3.6-.8 1.3-1.3 2.2-1.3 1.5 0 2.5 1.5 1.9 3-.8 2.1-4.1 4.1-4.1 4.1z" />`,
  settings: html`<path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />`,
  bluetooth: html`<path d="m7 7.5 10 9-5 4.5V3l5 4.5-10 9" />`,
  aux: html`<path d="M9 3v4.5M15 3v4.5M7 7.5h10v3.5a5 5 0 0 1-10 0z" /><path d="M12 16v5" />`,
  speaker: html`<rect x="5" y="2.8" width="14" height="18.4" rx="3" /><circle cx="12" cy="14.5" r="3.4" /><circle cx="12" cy="7.3" r="1.2" />`,
  speakers: html`<rect x="2.5" y="5" width="9" height="14" rx="2.2" /><circle cx="7" cy="13.5" r="2.3" /><path d="M14.5 7.5h4.8a2.2 2.2 0 0 1 2.2 2.2v7.1a2.2 2.2 0 0 1-2.2 2.2h-4.8" /><circle cx="17.3" cy="14.3" r="1.6" />`,
  moon: html`<path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" />`,
  alarm: html`<circle cx="12" cy="13" r="7.5" /><path d="M12 9v4.2l2.6 1.6M4 5.5 6.6 3.4M20 5.5l-2.6-2.1" />`,
  chevronRight: html`<path d="m9.5 5.5 6.5 6.5-6.5 6.5" />`,
  chevronLeft: html`<path d="M14.5 5.5 8 12l6.5 6.5" />`,
  chevronDown: html`<path d="m6 9.5 6 6 6-6" />`,
  more: html`<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />`,
  volume: html`<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" stroke-linejoin="round" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />`,
  volumeLow: html`<path d="M5 9.5h3.2L13 5.5v13l-4.8-4H5z" fill="currentColor" stroke-linejoin="round" /><path d="M16.5 9.5a3.3 3.3 0 0 1 0 5" />`,
  mute: html`<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" stroke-linejoin="round" /><path d="m16 9.5 5 5M21 9.5l-5 5" />`,
  plus: html`<path d="M12 5v14M5 12h14" />`,
  check: html`<path d="m5 12.5 4.5 4.5L19 7.5" />`,
  close: html`<path d="M6 6l12 12M18 6 6 18" />`,
  edit: html`<path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />`,
  trash: html`<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10 10.5v6M14 10.5v6" />`,
  refresh: html`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4.2h-4.2" />`,
  wifi: html`<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.3a9.5 9.5 0 0 1 13 0M8.6 15.5a5 5 0 0 1 6.8 0" /><circle cx="12" cy="19" r="1.2" fill="currentColor" />`,
  link: html`<path d="M10 14a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7L12 6.3" /><path d="M14 10a4 4 0 0 0-5.7 0L5 13.3A4 4 0 0 0 10.7 19l1.3-1.3" />`,
  info: html`<circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.6v.2" />`,
  up: html`<path d="m6 14.5 6-6 6 6" />`,
  down: html`<path d="m6 9.5 6 6 6-6" />`,
  star: html`<path d="m12 3.8 2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.4l-5.1 2.8L8 13.6 3.8 9.7l5.7-.7z" />`,
  grid: html`<rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />`,
  music: html`<path d="M9 18.5V6l11-2v12.5" /><circle cx="6.5" cy="18.5" r="2.5" /><circle cx="17.5" cy="16.5" r="2.5" />`,
  mic: html`<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />`,
  ball: html`<path d="M8 4.5h8v4.5a4 4 0 0 1-8 0z" /><path d="M8 6.5H5.5a2.5 2.5 0 0 0 3 3.4M16 6.5h2.5a2.5 2.5 0 0 1-3 3.4M12 13v3.5M8.5 20h7M9.5 16.5h5V20h-5z" />`,
  globe: html`<circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17" />`,
  pin: html`<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" />`,
  news: html`<rect x="3.5" y="5" width="13" height="14" rx="2" /><path d="M16.5 9h3a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2h-2M7 9h6M7 12.5h6M7 16h4" />`,
  podcast: html`<circle cx="12" cy="10" r="2.5" /><path d="M10.8 14.5h2.4l-.6 6h-1.2z" /><path d="M7.2 14.2a6.5 6.5 0 1 1 9.6 0M4.5 16.5a10 10 0 1 1 15 0" />`,
  language: html`<path d="M4 6h10M9 4v2c0 4-2.5 7.5-5 9M6.5 10c1.3 2.2 3.4 4 6 5" /><path d="m12 20 4-9 4 9M13.4 17h5.2" />`,
  shortcut: html`<rect x="4" y="4" width="16" height="16" rx="4.5" /><path d="M9 12h6M12 9v6" />`,
  sun: html`<circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />`,
  warning: html`<path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17v.2" />`,
};

export function Icon({ name, size, class: cls = '', label }) {
  const content = P[name] || P.info;
  return html`<svg
    class=${`icon ${size || ''} ${cls}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden=${label ? undefined : 'true'}
    role=${label ? 'img' : undefined}
    aria-label=${label}
  >
    ${content}
  </svg>`;
}
