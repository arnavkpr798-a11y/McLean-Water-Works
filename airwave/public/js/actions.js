import { del, post, put } from './api.js';
import { activeSpeaker, attempt, isFavorite, setPending, state, toast } from './store.js';

const enc = encodeURIComponent;

export function requireSpeaker() {
  const sp = activeSpeaker();
  if (!sp) {
    toast('No speaker found yet. Add one in Settings.', { error: true });
    return null;
  }
  if (!sp.online) {
    toast(`${sp.name} is offline. Check it is plugged in and on Wi-Fi.`, { error: true });
    return null;
  }
  return sp;
}

export async function playStation(station, speakerId) {
  const sp = speakerId ? state.speakers.find((s) => s.id === speakerId) : requireSpeaker();
  if (!sp) return;
  setPending('play', station.key);
  try {
    await attempt(() => post(`/api/speakers/${enc(sp.id)}/play`, { station }));
  } finally {
    setPending('play', null);
  }
}

export function toggleFavorite(station) {
  if (isFavorite(station.key)) {
    return attempt(() => del(`/api/favorites/${enc(station.key)}`), { success: 'Removed from favorites' });
  }
  return attempt(() => post('/api/favorites', { station }), { success: 'Added to favorites' });
}

export async function savePreset(slot, payload, speakerId) {
  const sp = speakerId ? state.speakers.find((s) => s.id === speakerId) : requireSpeaker();
  if (!sp) return;
  return attempt(() => put(`/api/speakers/${enc(sp.id)}/presets/${slot}`, payload), { success: `Saved to preset ${slot}` });
}

export async function clearPreset(slot) {
  const sp = requireSpeaker();
  if (!sp) return;
  return attempt(() => del(`/api/speakers/${enc(sp.id)}/presets/${slot}`), { success: `Preset ${slot} cleared` });
}

export async function playPreset(slot) {
  const sp = requireSpeaker();
  if (!sp) return;
  setPending('preset', slot);
  try {
    await attempt(() => post(`/api/speakers/${enc(sp.id)}/presets/${slot}/play`));
  } finally {
    setPending('preset', null);
  }
}

export function speakerCall(path, body, opts) {
  const sp = requireSpeaker();
  if (!sp) return Promise.resolve();
  return attempt(() => post(`/api/speakers/${enc(sp.id)}/${path}`, body), opts);
}

const SOURCE_ICONS = {
  BLUETOOTH: 'bluetooth',
  AUX: 'aux',
  AIRPLAY: 'wifi',
  SPOTIFY: 'music',
  STANDBY: 'power',
};

/** Everything the UI needs to show what's playing on a speaker. */
export function describeNowPlaying(sp) {
  const np = sp?.nowPlaying;
  if (!sp || !np || np.source === 'STANDBY') {
    return { standby: true, title: sp?.online === false ? 'Offline' : 'Standby', subtitle: '', art: '', source: 'STANDBY', label: 'Standby', icon: 'power' };
  }
  const st = np.station;
  const isRadio = !!st || ['TUNEIN', 'LOCAL_INTERNET_RADIO', 'INTERNET_RADIO', 'UPNP', 'RADIOPLAYER'].includes(np.source);
  let title = '';
  let subtitle = '';
  if (np.source === 'BLUETOOTH') {
    title = np.track || np.stationName || np.connectionDevice || 'Bluetooth';
    subtitle = np.track ? [np.artist, np.album].filter(Boolean).join(' · ') : np.status === 'playing' ? 'Connected' : 'Ready to pair — open Bluetooth on your phone';
  } else if (np.source === 'AUX') {
    title = np.item?.name || 'AUX input';
    subtitle = 'Playing from the AUX socket';
  } else if (st) {
    title = st.name;
    subtitle = np.streamTitle || (np.artist && np.track ? `${np.artist} – ${np.track}` : np.track) || st.subtitle || np.description || '';
  } else {
    title = np.stationName || np.item?.name || np.track || np.sourceLabel;
    subtitle = [np.artist, np.track && np.stationName ? np.track : ''].filter(Boolean).join(' – ') || np.description || '';
  }
  const label = isRadio ? 'Radio' : np.source === 'BLUETOOTH' ? `Bluetooth${np.connectionDevice ? ` · ${np.connectionDevice}` : ''}` : np.sourceLabel;
  return {
    standby: false,
    title,
    subtitle,
    art: st?.image || np.art || np.item?.art || '',
    station: st,
    source: np.source,
    label,
    icon: SOURCE_ICONS[np.source] || 'radio',
    isRadio,
    playing: np.status === 'playing',
    buffering: np.status === 'buffering',
    paused: np.status === 'paused' || np.status === 'stopped',
    skip: np.skipEnabled,
    skipPrev: np.skipPreviousEnabled,
    presetable: !!st || !!np.item?.isPresetable,
    error: np.error,
  };
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatRemaining(ms) {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  return `${m} min`;
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
