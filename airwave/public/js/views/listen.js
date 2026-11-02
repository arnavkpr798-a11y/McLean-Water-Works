import { html, useEffect, useRef, useState } from '../lib.js';
import { Icon } from '../icons.js';
import { post } from '../api.js';
import { activeSpeaker, closeSheet, isFavorite, openSheet, patchSpeaker, toast, useStore } from '../store.js';
import { describeNowPlaying, formatRemaining, playPreset, savePreset, speakerCall, toggleFavorite } from '../actions.js';
import { Artwork, Empty, LiveSlider, Sheet, Spinner } from '../ui.js';
import { AddSpeaker } from './settings.js';

const enc = encodeURIComponent;

export function ListenView() {
  const s = useStore();
  const sp = activeSpeaker();

  if (!s.loaded) {
    return html`<div class="center" style="padding-top:30vh"><${Spinner} lg /></div>`;
  }
  if (!sp) {
    return html`<div>
      <div class="topbar"><h1>Airwave</h1></div>
      <${Empty} icon="speaker" title="Let's find your SoundTouch">
        Make sure the speaker is plugged in and on the same Wi-Fi as the hub. It usually shows up here within a few seconds.
      <//>
      <${AddSpeaker} />
    </div>`;
  }

  return html`<div>
    <${Header} sp=${sp} />
    ${!sp.online && html`<div class="banner danger"><${Icon} name="warning" size="sm" /><div><b>${sp.name} is offline.</b> Check it's plugged in and connected to Wi-Fi. Airwave will reconnect automatically.</div></div>`}
    <${NowPlaying} sp=${sp} />
    <${Presets} sp=${sp} />
  </div>`;
}

function Header({ sp }) {
  const d = describeNowPlaying(sp);
  const [busy, setBusy] = useState(false);
  const togglePower = async () => {
    setBusy(true);
    await speakerCall('power', { on: d.standby });
    setBusy(false);
  };
  return html`<div class="topbar">
    <button class="speaker-switch" onClick=${() => openSheet({ type: 'speakers' })} aria-label="Choose speaker">
      <span class=${`dot ${sp.online ? 'on' : 'off'}`}></span>
      <span class="name">${sp.name}${sp.zone ? ` +${Math.max(0, sp.zone.members.length - 1)}` : ''}</span>
      <${Icon} name="chevronDown" size="sm" />
    </button>
    <span class="spacer"></span>
    <button class=${`icon-btn filled power ${d.standby ? '' : 'is-on'}`} aria-label=${d.standby ? 'Turn on' : 'Turn off'} disabled=${!sp.online || busy} onClick=${togglePower}>
      ${busy ? html`<${Spinner} />` : html`<${Icon} name="power" />`}
    </button>
  </div>`;
}

function NowPlaying({ sp }) {
  const s = useStore();
  const d = describeNowPlaying(sp);
  const vol = sp.volume?.level ?? 0;
  const muted = !!sp.volume?.muted;
  const hasAux = (sp.sources || []).some((x) => x.source === 'AUX');
  const lastStation = s.recents[0]?.station;
  const [starting, setStarting] = useState(false);

  const setVolume = (v, final) => {
    patchSpeaker(sp.id, (x) => ({ ...x, volume: { ...(x.volume || {}), level: v, muted: v > (x.volume?.level ?? 0) ? false : x.volume?.muted } }));
    const p = post(`/api/speakers/${enc(sp.id)}/volume`, { level: v });
    p.catch((err) => final && toast(err.message, { error: true }));
  };

  const resume = async () => {
    setStarting(true);
    await speakerCall('source', { source: 'RADIO' });
    setStarting(false);
  };

  if (d.standby) {
    return html`<section class="np">
      <div class="np-art standby"><${Icon} name="power" /></div>
      <div class="np-meta">
        <span class="chip-source"><${Icon} name="power" />Standby</span>
        <h2 class="np-title">${sp.name} is off</h2>
        <div class="np-sub">${lastStation ? `Last played: ${lastStation.name}` : 'Pick a preset or browse for a station'}</div>
      </div>
      <div class="btn-row">
        <button class="btn" disabled=${!sp.online} onClick=${() => speakerCall('power', { on: true })}><${Icon} name="power" size="sm" />Turn on</button>
        ${lastStation &&
        html`<button class="btn primary" disabled=${!sp.online || starting} onClick=${resume}>
          ${starting ? html`<${Spinner} light />` : html`<${Icon} name="play" size="sm" />`}Play ${lastStation.name}
        </button>`}
      </div>
      <${SourceChips} sp=${sp} d=${d} hasAux=${hasAux} />
    </section>`;
  }

  const fav = d.station && isFavorite(d.station.key);
  const playIcon = d.playing || d.buffering ? 'pause' : 'play';
  return html`<section class="np">
    ${d.art && html`<div class="np-bg" style=${`background-image:url("${String(d.art).replace(/"/g, '%22')}")`}></div>`}
    <div class="np-art"><${Artwork} src=${d.art} name=${d.title} size="lg" icon=${d.isRadio || d.art ? null : d.icon} /></div>
    <div class="np-meta" aria-live="polite">
      <span class="chip-source"><${Icon} name=${d.icon} />${d.label}</span>
      <h2 class="np-title">${d.title}</h2>
      <div class=${`np-sub ${d.error ? 'err' : ''}`}>
        ${d.error
          ? d.error
          : d.buffering
            ? 'Connecting…'
            : html`${d.isRadio && d.playing ? html`<span class="live" aria-hidden="true"></span>` : null}${d.subtitle}`}
      </div>
    </div>
    <div class="transport">
      ${d.station
        ? html`<button class=${`side-btn ${fav ? 'on' : ''}`} aria-label=${fav ? 'Remove from favorites' : 'Add to favorites'} onClick=${() => toggleFavorite(d.station)}>
            <${Icon} name=${fav ? 'heartFill' : 'heart'} />
          </button>`
        : d.skipPrev
          ? html`<button class="side-btn" aria-label="Previous" onClick=${() => speakerCall('transport', { action: 'prev' })}><${Icon} name="prev" /></button>`
          : html`<span class="side-btn"></span>`}
      <button class="play-btn" aria-label=${playIcon === 'pause' ? 'Pause' : 'Play'} onClick=${() => speakerCall('transport', { action: 'toggle' })}>
        ${d.buffering ? html`<span class="spinner lg"></span>` : html`<${Icon} name=${playIcon} />`}
      </button>
      ${d.skip
        ? html`<button class="side-btn" aria-label="Next" onClick=${() => speakerCall('transport', { action: 'next' })}><${Icon} name="next" /></button>`
        : d.presetable
          ? html`<button class="side-btn" aria-label="Save to a preset" onClick=${() => openSheet({ type: 'savePresetCurrent' })}><${Icon} name="star" /></button>`
          : html`<span class="side-btn"></span>`}
    </div>
    <div class="volume">
      <button
        class=${`icon-btn ${muted ? 'active' : ''}`}
        aria-label=${muted ? 'Unmute' : 'Mute'}
        onClick=${() => speakerCall('volume', { muted: !muted })}
      >
        <${Icon} name=${muted ? 'mute' : vol < 35 ? 'volumeLow' : 'volume'} />
      </button>
      <${LiveSlider} value=${vol} label="Volume" muted=${muted} onInput=${(v) => setVolume(v, false)} onCommit=${(v) => setVolume(v, true)} />
      <span class="value">${vol}</span>
    </div>
    <${SourceChips} sp=${sp} d=${d} hasAux=${hasAux} />
  </section>`;
}

function SourceChips({ sp, d, hasAux }) {
  const s = useStore();
  const sleep = sp.sleepTimer;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sleep) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [sleep?.endsAt]);
  return html`<div class="chips" role="toolbar" aria-label="Sources and timers">
    <button class=${`chip ${d.isRadio ? 'active' : ''}`} disabled=${!sp.online} onClick=${() => (d.isRadio ? (location.hash = '#/browse') : speakerCall('source', { source: 'RADIO' }))}>
      <${Icon} name="radio" />Radio
    </button>
    <button class=${`chip ${d.source === 'BLUETOOTH' ? 'active' : ''}`} disabled=${!sp.online} onClick=${() => openSheet({ type: 'bluetooth' })}>
      <${Icon} name="bluetooth" />Bluetooth
    </button>
    ${hasAux &&
    html`<button class=${`chip ${d.source === 'AUX' ? 'active' : ''}`} disabled=${!sp.online} onClick=${() => speakerCall('source', { source: 'AUX' })}>
      <${Icon} name="aux" />AUX
    </button>`}
    <button class=${`chip ${sleep ? 'active' : ''}`} disabled=${!sp.online} onClick=${() => openSheet({ type: 'sleep' })}>
      <${Icon} name="moon" />${sleep ? formatRemaining(sleep.endsAt - Date.now()) : 'Sleep'}
    </button>
    ${s.speakers.length > 1 &&
    html`<button class=${`chip ${sp.zone ? 'active' : ''}`} onClick=${() => (sp.zone ? openSheet({ type: 'groupVolume' }) : (location.hash = '#/settings/groups'))}>
      <${Icon} name="speakers" />${sp.zone ? 'Group' : 'Group…'}
    </button>`}
  </div>`;
}

function Presets({ sp }) {
  const s = useStore();
  const d = describeNowPlaying(sp);
  const anyRadioPreset = sp.presets.some((p) => p.station || p.legacyTuneIn);
  const needsSetup = sp.radio.status !== 'enabled' && anyRadioPreset;
  const repair = sp.radio.status === 'enabled' && (sp.radio.addressMismatch || sp.radio.nativeOk === false);
  return html`<section class="section">
    <div class="section-head">
      <h3>Presets</h3>
      <span class="hint">Hold to change</span>
    </div>
    <div class="presets">
      ${sp.presets.map((p) => html`<${PresetTile} key=${p.slot} p=${p} sp=${sp} playing=${!d.standby && p.station && d.station && p.station.key === d.station.key} busy=${s.pending.preset === p.slot} />`)}
    </div>
    ${needsSetup &&
    html`<a class="banner" href=${`#/settings/speaker/${enc(sp.id)}`} style="text-decoration:none">
      <${Icon} name="info" size="sm" />
      <div><b>Make the 1–6 buttons on your speaker work again.</b> They stopped when Bose shut down its cloud. Tap to set up (takes 30 seconds). Presets already work from this app.</div>
    </a>`}
    ${repair &&
    html`<a class="banner warn" href=${`#/settings/speaker/${enc(sp.id)}`} style="text-decoration:none">
      <${Icon} name="warning" size="sm" />
      <div><b>Speaker buttons need a quick repair.</b> The speaker isn't reaching the hub (its address may have changed). Tap to fix. Playback from this app still works.</div>
    </a>`}
  </section>`;
}

function PresetTile({ p, sp, playing, busy }) {
  const timer = useRef(null);
  const longPressed = useRef(false);
  const start = () => {
    longPressed.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      longPressed.current = true;
      navigator.vibrate?.(12);
      openSheet({ type: 'preset', slot: p.slot });
    }, 480);
  };
  const cancel = () => clearTimeout(timer.current);
  const click = () => {
    if (longPressed.current) return;
    if (p.empty) openSheet({ type: 'preset', slot: p.slot });
    else playPreset(p.slot);
  };
  return html`<button
    class=${`preset ${p.empty ? 'empty' : ''} ${playing ? 'playing' : ''}`}
    aria-label=${p.empty ? `Preset ${p.slot}, empty. Tap to set.` : `Preset ${p.slot}: ${p.name}. Hold for options.`}
    disabled=${!sp.online}
    onPointerDown=${start}
    onPointerUp=${cancel}
    onPointerLeave=${cancel}
    onPointerCancel=${cancel}
    onContextMenu=${(e) => {
      e.preventDefault();
      cancel();
      longPressed.current = true;
      openSheet({ type: 'preset', slot: p.slot });
    }}
    onClick=${click}
  >
    <div class="art">${p.empty ? html`<${Icon} name="plus" />` : html`<${Artwork} src=${p.art} name=${p.name} />`}</div>
    <span class="num">${p.slot}</span>
    ${busy && html`<div class="busy"><${Spinner} light /></div>`}
    <div class="label">${p.empty ? 'Empty' : p.name}</div>
  </button>`;
}

/** Sheet: save what's playing to a preset slot. */
export function SavePresetCurrentSheet() {
  const sp = activeSpeaker();
  useStore();
  if (!sp) return null;
  const d = describeNowPlaying(sp);
  return html`<${Sheet} title="Save to preset" subtitle=${d.title}>
    <div class="slot-grid">
      ${sp.presets.map(
        (p) => html`<button
          class="slot"
          key=${p.slot}
          onClick=${() => {
            closeSheet();
            savePreset(p.slot, { current: true });
          }}
        >
          <b>${p.slot}</b><span>${p.empty ? 'Empty' : p.name}</span>
        </button>`,
      )}
    </div>
  <//>`;
}
