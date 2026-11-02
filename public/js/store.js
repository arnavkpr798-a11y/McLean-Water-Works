import { useEffect, useState } from './lib.js';
import { connectEvents, put } from './api.js';

/** Global app state, fed by the hub's live event stream. */
const listeners = new Set();

export const state = {
  connected: false,
  loaded: false,
  hub: null,
  settings: {},
  speakers: [],
  favorites: [],
  recents: [],
  alarms: [],
  activeId: readLocal('airwave.speaker'),
  toasts: [],
  sheet: null,
  pending: {}, // e.g. { play: stationKey } for spinners
};

function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const l of listeners) l();
}

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return state;
}

export function activeSpeaker() {
  const list = state.speakers;
  return list.find((s) => s.id === state.activeId) || list.find((s) => s.id === state.settings.activeSpeakerId) || list[0] || null;
}

export function setActiveSpeaker(id) {
  writeLocal('airwave.speaker', id);
  setState({ activeId: id });
  // Remember on the hub too, so Siri Shortcuts act on the speaker you last used.
  put('/api/settings', { activeSpeakerId: id }).catch(() => {});
}

export function speakerById(id) {
  return state.speakers.find((s) => s.id === id) || null;
}

let toastSeq = 0;
export function toast(message, { error = false, ms } = {}) {
  const id = ++toastSeq;
  setState({ toasts: [...state.toasts.slice(-2), { id, message, error }] });
  setTimeout(() => setState({ toasts: state.toasts.filter((t) => t.id !== id) }), ms || (error ? 5200 : 2600));
}

export function openSheet(sheet) {
  setState({ sheet });
}

export function closeSheet() {
  setState({ sheet: null });
}

/** Run an async action, showing errors as toasts. Returns the result or undefined. */
export async function attempt(fn, { success } = {}) {
  try {
    const r = await fn();
    if (success) toast(typeof success === 'function' ? success(r) : success);
    return r;
  } catch (err) {
    toast(err.message || 'Something went wrong', { error: true });
    return undefined;
  }
}

export function setPending(key, value) {
  setState({ pending: { ...state.pending, [key]: value } });
}

/** Patch one speaker locally (optimistic UI) until the hub confirms. */
export function patchSpeaker(id, fn) {
  setState({ speakers: state.speakers.map((s) => (s.id === id ? fn(structuredClone(s)) : s)) });
}

export function start() {
  connectEvents({
    onStatus: (connected) => {
      if (connected !== state.connected) setState({ connected });
    },
    onState: (s) => {
      setState({
        loaded: true,
        hub: s.hub,
        settings: s.settings || {},
        speakers: s.speakers || [],
        favorites: s.favorites || [],
        recents: s.recents || [],
        alarms: s.alarms || [],
      });
    },
    onSpeaker: (sp) => {
      const exists = state.speakers.some((s) => s.id === sp.id);
      setState({ speakers: exists ? state.speakers.map((s) => (s.id === sp.id ? sp : s)) : [...state.speakers, sp] });
    },
  });
}

export function isFavorite(key) {
  return state.favorites.some((f) => f.station.key === key);
}
