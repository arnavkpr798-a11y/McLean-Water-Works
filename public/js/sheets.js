import { html, useEffect, useState } from './lib.js';
import { Icon } from './icons.js';
import { get, post, put } from './api.js';
import { activeSpeaker, attempt, closeSheet, isFavorite, openSheet, setActiveSpeaker, state, toast, useStore } from './store.js';
import { clearPreset, describeNowPlaying, formatRemaining, playPreset, playStation, savePreset, speakerCall, toggleFavorite } from './actions.js';
import { Artwork, LiveSlider, Row, Sheet, Spinner, Switch } from './ui.js';

const enc = encodeURIComponent;

function SlotGrid({ speaker, onPick, highlight }) {
  return html`<div class="slot-grid">
    ${(speaker?.presets || []).map(
      (p) => html`<button class="slot" key=${p.slot} onClick=${() => onPick(p.slot)} style=${highlight === p.slot ? 'border-color:var(--accent)' : ''}>
        <b>${p.slot}</b><span>${p.empty ? 'Empty' : p.name}</span>
      </button>`,
    )}
  </div>`;
}

function StationSheet({ station }) {
  const s = useStore();
  const sp = activeSpeaker();
  const fav = isFavorite(station.key);
  const [info, setInfo] = useState(null);
  const others = s.speakers.filter((x) => x.id !== sp?.id && x.online);
  useEffect(() => {
    if (station.type === 'tunein') get(`/api/tunein/describe?id=${enc(station.id)}`).then(setInfo).catch(() => {});
  }, [station.key]);
  const details = info && [info.genre, info.location, info.frequency].filter(Boolean).join(' · ');
  return html`<${Sheet}
    title=${station.name}
    subtitle=${info?.slogan || station.subtitle || (station.type === 'url' ? station.url : '')}
    head=${html`<div class="thumb" style="width:52px;height:52px;border-radius:12px;overflow:hidden;flex:none"><${Artwork} src=${station.image || info?.image} name=${station.name} /></div>`}
  >
    <div class="list">
      <${Row}
        icon="play"
        title=${sp ? `Play on ${sp.name}` : 'Play'}
        chevron=${false}
        onClick=${() => {
          closeSheet();
          playStation(station);
        }}
      />
      ${others.map(
        (o) => html`<${Row}
          key=${o.id}
          icon="speaker"
          title=${`Play on ${o.name}`}
          chevron=${false}
          onClick=${() => {
            closeSheet();
            playStation(station, o.id);
          }}
        />`,
      )}
      <${Row} icon=${fav ? 'heartFill' : 'heart'} title=${fav ? 'Remove from favorites' : 'Add to favorites'} chevron=${false} onClick=${() => toggleFavorite(station)} />
    </div>
    ${sp &&
    html`<div class="list-label">Save to a preset on ${sp.name}</div>
      <${SlotGrid}
        speaker=${sp}
        onPick=${async (slot) => {
          const p = sp.presets.find((x) => x.slot === slot);
          if (!p.empty) {
            openSheet({
              type: 'confirm',
              title: `Replace preset ${slot}?`,
              message: `“${p.name}” will be replaced with “${station.name}”.`,
              confirmLabel: 'Replace',
              onConfirm: () => savePreset(slot, { station }),
            });
            return;
          }
          closeSheet();
          await savePreset(slot, { station });
        }}
      />
      <p class="list-foot">Presets match the 1–6 buttons on your speaker and remote.</p>`}
    ${(details || info?.description || info?.playing) &&
    html`<div class="list-label">About</div>
      <div class="card">
        ${info?.playing && html`<p><b>On air:</b> ${info.playing}</p>`}
        ${info?.description && html`<p>${info.description}</p>`}
        ${details && html`<p class="muted" style="margin:0">${details}</p>`}
      </div>`}
  <//>`;
}

function PresetSheet({ slot }) {
  const s = useStore();
  const sp = activeSpeaker();
  const preset = sp?.presets.find((p) => p.slot === slot);
  const np = describeNowPlaying(sp);
  const [mode, setMode] = useState('menu');
  if (!sp || !preset) return null;
  const choose = (station) => {
    closeSheet();
    savePreset(slot, { station });
  };
  if (mode === 'choose') {
    return html`<${Sheet} title=${`Choose for preset ${slot}`} onClose=${closeSheet}>
      <${StationChooser} onPick=${choose} />
    <//>`;
  }
  return html`<${Sheet} title=${preset.empty ? `Preset ${slot}` : preset.name} subtitle=${preset.empty ? 'Empty' : `Preset ${slot}${preset.legacyTuneIn ? ' · saved in the Bose app' : ''}`}>
    <div class="list">
      ${!preset.empty &&
      html`<${Row}
        icon="play"
        title="Play"
        chevron=${false}
        onClick=${() => {
          closeSheet();
          playPreset(slot);
        }}
      />`}
      ${np.presetable &&
      html`<${Row}
        icon="star"
        title=${`Save “${np.title}” here`}
        sub="What's playing now"
        chevron=${false}
        onClick=${() => {
          closeSheet();
          savePreset(slot, { current: true });
        }}
      />`}
      <${Row} icon="radio" title=${preset.empty ? 'Choose a station' : 'Replace with another station'} onClick=${() => setMode('choose')} />
      ${preset.station &&
      html`<${Row} icon=${isFavorite(preset.station.key) ? 'heartFill' : 'heart'} title=${isFavorite(preset.station.key) ? 'In favorites' : 'Add to favorites'} chevron=${false} onClick=${() => toggleFavorite(preset.station)} />`}
      ${!preset.empty &&
      html`<${Row}
        icon="trash"
        title="Clear preset"
        danger
        chevron=${false}
        onClick=${() => {
          closeSheet();
          clearPreset(slot);
        }}
      />`}
    </div>
    ${s.speakers.length > 0 && sp.radio.status !== 'enabled' && html`<p class="list-foot">Tip: to make button ${slot} on the speaker itself play this, turn on <a href=${`#/settings/speaker/${enc(sp.id)}`} onClick=${closeSheet}>Preset buttons & radio</a> for ${sp.name}.</p>`}
  <//>`;
}

/** Pick a station from favorites, recents or a TuneIn search. */
export function StationChooser({ onPick }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => {
      get(`/api/tunein/search?q=${enc(q)}`)
        .then((r) => setResults(r.items.flatMap((i) => (i.kind === 'section' ? i.items : [i])).filter((i) => i.kind === 'station').map((i) => i.station)))
        .catch((err) => {
          toast(err.message, { error: true });
          setResults([]);
        })
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);
  const pickRow = (st) => html`<button class="row with-art" key=${st.key} onClick=${() => onPick(st)}>
    <span class="thumb"><${Artwork} src=${st.image} name=${st.name} size="sm" /></span>
    <div class="body"><div class="title">${st.name}</div>${st.subtitle && html`<div class="sub">${st.subtitle}</div>`}</div>
  </button>`;
  const recents = s.recents.map((r) => r.station).filter((st) => !s.favorites.some((f) => f.station.key === st.key));
  return html`<div>
    <div class="search-box" style="margin-bottom:12px">
      <${Icon} name="search" size="sm" />
      <input type="search" placeholder="Search TuneIn" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} enterkeyhint="search" />
      ${loading && html`<${Spinner} />`}
    </div>
    ${results
      ? html`<div class="list">${results.length ? results.map(pickRow) : html`<div class="text-row">No stations found</div>`}</div>`
      : html`
          ${s.favorites.length > 0 && html`<div class="list-label">Favorites</div><div class="list">${s.favorites.map((f) => pickRow(f.station))}</div>`}
          ${recents.length > 0 && html`<div class="list-label">Recently played</div><div class="list">${recents.slice(0, 15).map(pickRow)}</div>`}
          ${!s.favorites.length && !recents.length && html`<p class="muted center">Search for a station above.</p>`}
        `}
  </div>`;
}

function ChooseStationSheet({ title, onPick }) {
  return html`<${Sheet} title=${title || 'Choose a station'}>
    <${StationChooser}
      onPick=${(st) => {
        closeSheet();
        onPick(st);
      }}
    />
  <//>`;
}

function SpeakersSheet() {
  const s = useStore();
  const active = activeSpeaker();
  return html`<${Sheet} title="Speakers">
    <div class="list">
      ${s.speakers.map((sp) => {
        const d = describeNowPlaying(sp);
        return html`<button
          key=${sp.id}
          class="row"
          onClick=${() => {
            setActiveSpeaker(sp.id);
            closeSheet();
          }}
        >
          <span class="lead-icon"><${Icon} name="speaker" size="sm" /></span>
          <div class="body">
            <div class="title">${sp.name}</div>
            <div class="sub">${!sp.online ? 'Offline' : d.standby ? 'Standby' : `${d.label} · ${d.title}`}</div>
          </div>
          <div class="trail">
            <span class=${`dot ${sp.online ? 'on' : 'off'}`}></span>
            ${active?.id === sp.id && html`<${Icon} name="check" size="sm" class="active" />`}
          </div>
        </button>`;
      })}
    </div>
    <div class="btn-row">
      ${s.speakers.length > 1 &&
      html`<a class="btn" href="#/settings/groups" onClick=${closeSheet}><${Icon} name="speakers" size="sm" />Group</a>`}
      <a class="btn" href="#/settings/add-speaker" onClick=${closeSheet}><${Icon} name="plus" size="sm" />Add speaker</a>
    </div>
  <//>`;
}

function SleepSheet() {
  const sp = activeSpeaker();
  useStore();
  if (!sp) return null;
  const t = sp.sleepTimer;
  const set = (minutes) => {
    closeSheet();
    speakerCall('sleep', { minutes }, { success: minutes ? `${sp.name} will turn off in ${formatRemaining(minutes * 60000)}` : 'Sleep timer off' });
  };
  return html`<${Sheet} title="Sleep timer" subtitle=${t ? `Turns off at ${new Date(t.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${formatRemaining(t.endsAt - Date.now())} left)` : `Fades out, then turns ${sp.name} off`}>
    <div class="list">
      ${[15, 30, 45, 60, 90, 120].map((m) => html`<${Row} key=${m} icon="moon" title=${formatRemaining(m * 60000)} chevron=${false} onClick=${() => set(m)} />`)}
      ${t && html`<${Row} icon="close" title="Turn off sleep timer" danger chevron=${false} onClick=${() => set(null)} />`}
    </div>
  <//>`;
}

function GroupVolumeSheet() {
  const s = useStore();
  const sp = activeSpeaker();
  if (!sp?.zone) return null;
  const members = sp.zone.members.map((m) => s.speakers.find((x) => x.id === m.id)).filter(Boolean);
  return html`<${Sheet} title="Group volume" subtitle=${`${members.length} speakers playing together`}>
    ${members.map(
      (m) => html`<div class="card" style="margin-bottom:10px" key=${m.id}>
        <div class="row-gap" style="justify-content:space-between"><b>${m.name}</b><span class="muted">${m.volume?.level ?? '–'}</span></div>
        <div class="volume">
          <${LiveSlider}
            value=${m.volume?.level ?? 0}
            label=${`${m.name} volume`}
            onInput=${(v) => post(`/api/speakers/${enc(m.id)}/volume`, { level: v }).catch(() => {})}
            onCommit=${(v) => attempt(() => post(`/api/speakers/${enc(m.id)}/volume`, { level: v }))}
          />
        </div>
      </div>`,
    )}
    <a class="btn block" href="#/settings/groups" onClick=${closeSheet}>Edit group</a>
  <//>`;
}

function CustomStationSheet({ initial }) {
  const [name, setName] = useState(initial?.name || '');
  const [url, setUrl] = useState(initial?.url || '');
  const [image, setImage] = useState(initial?.image || '');
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      setTest(await post('/api/stations/test', { url: url.trim() }));
    } catch (err) {
      setTest({ ok: false, error: err.message });
    } finally {
      setBusy(false);
    }
  };
  const station = () => ({ type: 'url', url: url.trim(), name: name.trim() || test?.name || '', image: image.trim() || undefined });
  const save = async (andPlay) => {
    if (!/^https?:\/\//i.test(url.trim())) {
      toast('Enter a stream address starting with http:// or https://', { error: true });
      return;
    }
    if (initial?.key) {
      await attempt(() => put(`/api/favorites/${enc(initial.key)}`, { name: name.trim(), image: image.trim() }), { success: 'Saved' });
    } else {
      const saved = await attempt(() => post('/api/favorites', { station: station() }), { success: 'Added to favorites' });
      if (!saved) return;
      if (andPlay) playStation(saved);
    }
    closeSheet();
  };
  return html`<${Sheet} title=${initial?.key ? 'Edit station' : 'Add a station by URL'} subtitle="For stations that aren't on TuneIn">
    <label class="field"><span>Stream address</span>
      <input class="input" type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="http://stream.example.com/live.mp3" value=${url} disabled=${!!initial?.key} onInput=${(e) => {
        setUrl(e.currentTarget.value);
        setTest(null);
      }} />
    </label>
    <label class="field"><span>Name</span>
      <input class="input" placeholder=${test?.name || 'My station'} value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
    </label>
    <label class="field"><span>Logo URL (optional)</span>
      <input class="input" type="url" inputmode="url" autocapitalize="off" placeholder="https://…/logo.png" value=${image} onInput=${(e) => setImage(e.currentTarget.value)} />
    </label>
    ${!initial?.key &&
    html`<button class="btn block" disabled=${busy || !url.trim()} onClick=${runTest}>${busy ? html`<${Spinner} />` : html`<${Icon} name="check" size="sm" />`} Test stream</button>`}
    ${test &&
    html`<div class=${`banner ${test.ok ? '' : 'danger'}`}>
      <${Icon} name=${test.ok ? 'check' : 'warning'} size="sm" />
      <div>${test.ok ? html`<b>Stream works.</b> ${test.contentType}${test.bitrate ? ` · ${test.bitrate} kbps` : ''}${test.https ? ' · will be relayed by the hub' : ''}` : html`<b>That didn't work.</b> ${test.error}`}</div>
    </div>`}
    <div class="btn-row">
      <button class="btn" onClick=${() => save(false)}>Save</button>
      ${!initial?.key && html`<button class="btn primary" onClick=${() => save(true)}>Save & play</button>`}
    </div>
    <p class="list-foot">Tip: radio station websites often list a “listen with your own player” link ending in .mp3, .aac, .pls or .m3u — those work. HLS (.m3u8) streams don’t play on SoundTouch speakers.</p>
  <//>`;
}

function ConfirmSheet({ title, message, confirmLabel = 'OK', danger, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return html`<${Sheet} title=${title}>
    ${message && html`<p style="margin:0 0 6px;color:var(--text-2);line-height:1.5">${message}</p>`}
    <div class="btn-row">
      <button class="btn" onClick=${closeSheet}>Cancel</button>
      <button
        class=${`btn ${danger ? 'danger' : 'primary'}`}
        disabled=${busy}
        onClick=${async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            closeSheet();
          }
        }}
      >
        ${busy ? html`<${Spinner} />` : confirmLabel}
      </button>
    </div>
  <//>`;
}

function BluetoothSheet() {
  const sp = activeSpeaker();
  if (!sp) return null;
  return html`<${Sheet} title="Bluetooth" subtitle=${sp.name}>
    <div class="list">
      <${Row}
        icon="bluetooth"
        title="Switch to Bluetooth"
        sub="Play from a phone that's already paired"
        chevron=${false}
        onClick=${() => {
          closeSheet();
          speakerCall('source', { source: 'BLUETOOTH' });
        }}
      />
      <${Row}
        icon="plus"
        title="Pair a new device"
        sub=${`Then pick “${sp.name}” in your phone's Bluetooth settings`}
        chevron=${false}
        onClick=${() => {
          closeSheet();
          speakerCall('bluetooth', { action: 'pair' }, { success: `${sp.name} is ready to pair` });
        }}
      />
    </div>
  <//>`;
}

const SHEETS = {
  station: StationSheet,
  preset: PresetSheet,
  speakers: SpeakersSheet,
  sleep: SleepSheet,
  groupVolume: GroupVolumeSheet,
  custom: CustomStationSheet,
  confirm: ConfirmSheet,
  chooseStation: ChooseStationSheet,
  bluetooth: BluetoothSheet,
};

export function registerSheet(type, component) {
  SHEETS[type] = component;
}

export function SheetHost() {
  const s = useStore();
  if (!s.sheet) return null;
  const C = SHEETS[s.sheet.type];
  return C ? html`<${C} key=${s.sheet.type + (s.sheet.station?.key || s.sheet.slot || '')} ...${s.sheet} />` : null;
}

