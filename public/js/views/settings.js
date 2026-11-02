import { html, useEffect, useState } from '../lib.js';
import { Icon } from '../icons.js';
import { del, get, post, put } from '../api.js';
import { activeSpeaker, attempt, openSheet, setActiveSpeaker, speakerById, toast, useStore } from '../store.js';
import { describeNowPlaying, formatClock, timeAgo } from '../actions.js';
import { Artwork, Empty, LiveSlider, Row, Spinner, Switch } from '../ui.js';

const enc = encodeURIComponent;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function Back({ title, to = '#/settings' }) {
  return html`<div class="page-title">
    <a class="icon-btn" href=${to} aria-label="Back"><${Icon} name="chevronLeft" /></a>
    <h2>${title}</h2>
  </div>`;
}

// ------------------------------------------------------------ index

export function SettingsView({ route }) {
  const sub = route.params.sub;
  if (sub === 'speaker') return html`<${SpeakerDetail} id=${route.params.id} />`;
  if (sub === 'add-speaker') return html`<div><${Back} title="Add a speaker" /><${AddSpeaker} /></div>`;
  if (sub === 'groups') return html`<${Groups} />`;
  if (sub === 'alarms') return html`<${Alarms} />`;
  if (sub === 'alarm') return html`<${AlarmEditor} id=${route.params.id} />`;
  if (sub === 'hub') return html`<${HubSettings} />`;
  if (sub === 'shortcuts') return html`<${Shortcuts} />`;
  return html`<${SettingsIndex} />`;
}

function SettingsIndex() {
  const s = useStore();
  const active = activeSpeaker();
  const nextAlarm = s.alarms
    .filter((a) => a.enabled && a.nextFire)
    .sort((a, b) => a.nextFire - b.nextFire)[0];
  return html`<div>
    <div class="topbar"><h1>Settings</h1></div>
    <div class="list-label">Speakers</div>
    <div class="list">
      ${s.speakers.map((sp) => {
        const d = describeNowPlaying(sp);
        return html`<${Row}
          key=${sp.id}
          icon="speaker"
          title=${sp.name}
          sub=${`${sp.model || 'SoundTouch'} · ${!sp.online ? 'Offline' : d.standby ? 'Standby' : d.title}`}
          href=${`#/settings/speaker/${enc(sp.id)}`}
          trail=${html`${active?.id === sp.id ? html`<span class="status-pill ok">Active</span>` : null}<span class=${`dot ${sp.online ? 'on' : 'off'}`} style="margin:0 6px"></span>`}
        />`;
      })}
      <${Row} icon="plus" title="Add a speaker" href="#/settings/add-speaker" />
    </div>

    <div class="list-label">Listening</div>
    <div class="list">
      <${Row} icon="alarm" title="Alarms" sub=${nextAlarm ? `Next: ${new Date(nextAlarm.nextFire).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Wake up to the radio'} href="#/settings/alarms" />
      ${s.speakers.length > 1 && html`<${Row} icon="speakers" title="Group speakers" sub="Play the same thing in several rooms" href="#/settings/groups" />`}
      <${Row} icon="shortcut" title="Siri & Shortcuts" sub="“Hey Siri, play Jazz24”" href="#/settings/shortcuts" />
    </div>

    <div class="list-label">Hub</div>
    <div class="list">
      <${Row} icon="settings" title="Hub & playback" sub=${s.hub ? `Airwave ${s.hub.version} · ${s.connected ? 'connected' : 'reconnecting…'}` : ''} href="#/settings/hub" />
    </div>
    <p class="list-foot">Airwave replaces the discontinued Bose SoundTouch app. Radio directory by TuneIn. Not affiliated with Bose or TuneIn.</p>
  </div>`;
}

// ------------------------------------------------------------ add speaker

export function AddSpeaker() {
  const [ip, setIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const s = useStore();
  const scan = async () => {
    setScanning(true);
    const r = await attempt(() => post('/api/speakers/scan'));
    setScanning(false);
    if (r) toast(r.found ? `Found ${r.found} speaker${r.found === 1 ? '' : 's'}` : 'No speakers found on this network', { error: !r.found });
  };
  const add = async (e) => {
    e.preventDefault();
    setAdding(true);
    const sp = await attempt(() => post('/api/speakers', { ip: ip.trim() }), { success: (r) => `Added ${r.name}` });
    setAdding(false);
    if (sp) {
      setActiveSpeaker(sp.id);
      setIp('');
      location.hash = '#/';
    }
  };
  return html`<div>
    <button class="btn primary block" disabled=${scanning} onClick=${scan}>
      ${scanning ? html`<${Spinner} light />Searching your network…` : html`<${Icon} name="search" size="sm" />Search my network`}
    </button>
    <div class="list-label">Or enter its IP address</div>
    <form class="row-gap" onSubmit=${add}>
      <input class="input" inputmode="decimal" placeholder="192.168.1.40" value=${ip} onInput=${(e) => setIp(e.currentTarget.value)} aria-label="Speaker IP address" />
      <button class="btn" style="flex:none" disabled=${!ip.trim() || adding}>${adding ? html`<${Spinner} />` : 'Add'}</button>
    </form>
    <div class="card mt">
      <h4>Finding your speaker's IP address</h4>
      <ol class="steps">
        <li>Open your Wi-Fi router's app or web page and look for a device called “SoundTouch” or your speaker's name.</li>
        <li>Make sure the speaker and the hub are on the same network (not a guest Wi-Fi).</li>
        <li>Tip: reserve that address in your router (DHCP reservation) so it never changes.</li>
      </ol>
    </div>
    ${s.hub && !s.hub.discovery && html`<p class="list-foot">Automatic discovery is turned off on this hub (DISCOVERY=off).</p>`}
  </div>`;
}

// ------------------------------------------------------------ speaker detail

function SpeakerDetail({ id }) {
  useStore();
  const sp = speakerById(id);
  const [name, setName] = useState(sp?.name || '');
  useEffect(() => setName(sp?.name || ''), [sp?.name]);
  if (!sp) return html`<div><${Back} title="Speaker" /><${Empty} icon="speaker" title="Speaker not found" /></div>`;
  const call = (path, body, opts) => attempt(() => post(`/api/speakers/${enc(sp.id)}/${path}`, body), opts);
  const rename = (e) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== sp.name) call('name', { name: name.trim() }, { success: 'Renamed' });
  };
  return html`<div>
    <${Back} title=${sp.name} />
    ${!sp.online && html`<div class="banner danger"><${Icon} name="warning" size="sm" /><div><b>Offline.</b> Last seen ${sp.lastSeen ? timeAgo(sp.lastSeen) : 'a while ago'} at ${sp.ip}.</div></div>`}

    <div class="list-label">Name</div>
    <form class="row-gap" onSubmit=${rename}>
      <input class="input" value=${name} maxlength="40" onInput=${(e) => setName(e.currentTarget.value)} aria-label="Speaker name" />
      <button class="btn" style="flex:none" disabled=${!sp.online || !name.trim() || name.trim() === sp.name}>Save</button>
    </form>

    <${RadioSetupCard} sp=${sp} />

    ${sp.bass &&
    html`<div class="list-label">Sound</div>
      <div class="card">
        <div class="row-gap" style="justify-content:space-between"><b>Bass</b><span class="muted">${sp.bass.level === sp.bass.default ? 'Default' : sp.bass.level}</span></div>
        <div class="volume">
          <span class="muted" style="font-size:13px">Less</span>
          <${LiveSlider} value=${sp.bass.level} min=${sp.bass.min} max=${sp.bass.max} label="Bass" onCommit=${(v) => call('bass', { level: v })} />
          <span class="muted" style="font-size:13px">More</span>
        </div>
        ${sp.bass.level !== sp.bass.default && html`<button class="link-btn" onClick=${() => call('bass', { level: sp.bass.default })}>Reset to default</button>`}
      </div>`}

    <div class="list-label">Power & Bluetooth</div>
    <div class="list">
      ${sp.powerSaving !== null &&
      html`<${Row} icon="power" title="Auto-off" sub="Switch to standby after a while with nothing playing" chevron=${false} trail=${html`<${Switch} checked=${sp.powerSaving} label="Auto-off" disabled=${!sp.online} onChange=${(v) => call('power-saving', { enabled: v })} />`} />`}
      <${Row} icon="bluetooth" title="Pair a new Bluetooth device" chevron=${false} onClick=${() => call('bluetooth', { action: 'pair' }, { success: `${sp.name} is ready to pair` })} />
      <${Row}
        icon="trash"
        title="Forget paired Bluetooth devices"
        danger
        chevron=${false}
        onClick=${() => openSheet({ type: 'confirm', title: 'Forget all paired devices?', message: 'Phones will need to pair with the speaker again.', confirmLabel: 'Forget', danger: true, onConfirm: () => call('bluetooth', { action: 'clear' }, { success: 'Pairing list cleared' }) })}
      />
    </div>

    <div class="list-label">About</div>
    <div class="card">
      <dl class="kv">
        <dt>Model</dt><dd>${sp.model || '—'}</dd>
        <dt>Firmware</dt><dd>${sp.firmware || '—'}</dd>
        <dt>IP address</dt><dd>${sp.ip}</dd>
        <dt>MAC / ID</dt><dd>${sp.mac}</dd>
        ${sp.serial && html`<dt>Serial</dt><dd>${sp.serial}</dd>`}
        <dt>Playback mode</dt><dd>${sp.engine === 'native' ? 'Native radio' : 'Network stream (UPnP)'}</dd>
      </dl>
    </div>

    <div class="btn-row">
      <button class="btn" onClick=${() => call('refresh', {}, { success: 'Refreshed' })}><${Icon} name="refresh" size="sm" />Refresh</button>
      <button
        class="btn danger"
        onClick=${() =>
          openSheet({
            type: 'confirm',
            title: `Forget ${sp.name}?`,
            message: 'It will be removed from Airwave. If it is still on your network it will be found again automatically.',
            confirmLabel: 'Forget',
            danger: true,
            onConfirm: async () => {
              await attempt(() => del(`/api/speakers/${enc(sp.id)}`));
              location.hash = '#/settings';
            },
          })}
      >
        Forget
      </button>
    </div>
  </div>`;
}

function RadioSetupCard({ sp }) {
  const r = sp.radio;
  const [busy, setBusy] = useState(null);
  const [check, setCheck] = useState(null);
  const run = async (action, reboot) => {
    setBusy(action);
    const res = await attempt(() => post(`/api/speakers/${enc(sp.id)}/radio-setup`, { action, reboot }), {
      success: action === 'enable' ? (reboot ? 'Done. The speaker is restarting (about a minute).' : 'Preset buttons are set up') : action === 'disable' ? 'Original Bose setting restored' : 'Restarting speaker…',
    });
    setBusy(null);
    if (res) setCheck(null);
  };
  const runCheck = async () => {
    setBusy('check');
    const res = await attempt(() => get(`/api/speakers/${enc(sp.id)}/radio-setup`));
    setBusy(null);
    if (res) setCheck(res);
  };
  const enabled = r.status === 'enabled';
  const needsRepair = enabled && (r.addressMismatch || r.nativeOk === false);
  const working = enabled && r.lastStationFetchAt && !needsRepair;
  return html`<div>
    <div class="list-label">Preset buttons & radio</div>
    <div class="card">
      <div class="row-gap" style="justify-content:space-between;margin-bottom:8px">
        <h4 style="margin:0">Speaker buttons 1–6</h4>
        <span class=${`status-pill ${working ? 'ok' : needsRepair ? 'warn' : enabled ? 'ok' : ''}`}>${working ? 'Working' : needsRepair ? 'Needs repair' : enabled ? 'Set up' : 'Off'}</span>
      </div>
      ${!enabled &&
      html`<p>Bose's shutdown stopped the preset buttons and remote from playing radio. Airwave can fix that by pointing the speaker's “radio lookup” setting at this hub. Nothing is installed on the speaker, and you can undo it any time.</p>
        <p class="muted" style="font-size:13.5px">Without this, radio still plays from this app (as a network stream). Keep the hub running so the buttons keep working.</p>`}
      ${enabled &&
      html`<p>
        ${needsRepair
          ? r.addressMismatch
            ? "The hub's network address changed. Tap Repair so the speaker can find it again."
            : "The speaker didn't contact the hub last time. Tap Repair, then restart the speaker."
          : r.lastStationFetchAt
            ? html`The speaker last used the hub ${timeAgo(r.lastStationFetchAt)}. Press a preset button on the speaker any time.`
            : 'Set up. Press a preset button (or play a station) to confirm it works. If nothing plays, restart the speaker.'}
      </p>`}
      <div class="btn-row">
        ${!enabled &&
        html`<button class="btn primary" disabled=${!sp.online || busy} onClick=${() => run('enable', true)}>${busy === 'enable' ? html`<${Spinner} light />` : 'Set up'}</button>`}
        ${enabled &&
        html`<button class=${`btn ${needsRepair ? 'primary' : ''}`} disabled=${!sp.online || busy} onClick=${() => run('enable', true)}>${busy === 'enable' ? html`<${Spinner} />` : 'Repair'}</button>
          <button class="btn" disabled=${!sp.online || busy} onClick=${() => openSheet({ type: 'confirm', title: 'Restore the Bose setting?', message: "The speaker's preset buttons will stop playing radio again (as after Bose's shutdown). Playback from this app keeps working.", confirmLabel: 'Restore', danger: true, onConfirm: () => run('disable', true) })}>
            ${busy === 'disable' ? html`<${Spinner} />` : 'Undo'}
          </button>`}
        <button class="btn" disabled=${!sp.online || busy} onClick=${runCheck}>${busy === 'check' ? html`<${Spinner} />` : 'Check'}</button>
      </div>
      ${check &&
      html`<dl class="kv mt">
        <dt>Speaker console</dt><dd>${check.consoleReachable ? 'Reachable' : 'Not reachable'}</dd>
        <dt>Firmware</dt><dd>${check.firmware || '—'}${check.firmwareOk ? '' : ' (update recommended)'}</dd>
        <dt>Points to this hub</dt><dd>${check.pointsToHub == null ? 'Unknown' : check.pointsToHub ? 'Yes' : 'No'}</dd>
        <dt>Current setting</dt><dd class="mono">${check.currentRegistryUrl || 'unknown'}</dd>
        ${check.managedByOtherTool && html`<dt>Warning</dt><dd>${check.managedByOtherTool}</dd>`}
        ${!check.accountLinked && html`<dt>Note</dt><dd>Speaker looks factory-reset; native radio may be refused. App playback still works.</dd>`}
      </dl>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------ groups

function Groups() {
  const s = useStore();
  const online = s.speakers.filter((x) => x.online);
  const groups = s.speakers.filter((x) => x.zone && x.zone.master === x.id);
  const [master, setMaster] = useState(activeSpeaker()?.id || online[0]?.id);
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : [...members, id]);
  const create = async () => {
    setBusy(true);
    const ok = await attempt(() => post('/api/zones', { masterId: master, memberIds: members }), { success: 'Speakers grouped' });
    setBusy(false);
    if (ok !== undefined) setMembers([]);
  };
  return html`<div>
    <${Back} title="Group speakers" />
    ${groups.map((g) => {
      const mem = g.zone.members.filter((m) => m.id !== g.id).map((m) => speakerById(m.id) || { id: m.id, name: m.ip });
      return html`<div class="card" style="margin-bottom:12px" key=${g.id}>
        <div class="row-gap" style="justify-content:space-between"><h4 style="margin:0">${g.name} group</h4><span class="status-pill ok">${mem.length + 1} speakers</span></div>
        <p class="muted" style="margin:6px 0 10px">${g.name} leads; the others play the same thing in sync.</p>
        <div class="list">
          ${mem.map((m) => html`<${Row} key=${m.id} icon="speaker" title=${m.name} chevron=${false} trail=${html`<button class="link-btn" style="color:var(--danger)" onClick=${() => attempt(() => del(`/api/zones/${enc(g.id)}/members/${enc(m.id)}`))}>Remove</button>`} />`)}
        </div>
        <div class="btn-row">
          ${online
            .filter((x) => x.id !== g.id && !g.zone.members.some((m) => m.id === x.id))
            .map((x) => html`<button class="btn" key=${x.id} onClick=${() => attempt(() => post(`/api/zones/${enc(g.id)}/members`, { memberId: x.id }))}><${Icon} name="plus" size="sm" />${x.name}</button>`)}
        </div>
        <button class="btn danger block mt" onClick=${() => attempt(() => del(`/api/zones/${enc(g.id)}`), { success: 'Group ended' })}>Ungroup</button>
      </div>`;
    })}
    ${online.length < 2
      ? html`<${Empty} icon="speakers" title="You need two speakers online">Grouping plays the same thing on several SoundTouch speakers at once.<//>`
      : html`<div class="card">
          <h4>New group</h4>
          <div class="list-label" style="margin-top:8px">Lead speaker (keeps playing what it's playing)</div>
          <div class="list">
            ${online.map((x) => html`<button class="row" key=${x.id} onClick=${() => { setMaster(x.id); setMembers(members.filter((m) => m !== x.id)); }}><span class="lead-icon"><${Icon} name="speaker" size="sm" /></span><div class="body"><div class="title">${x.name}</div></div><div class="trail">${master === x.id && html`<${Icon} name="check" class="active" />`}</div></button>`)}
          </div>
          <div class="list-label">Add these speakers</div>
          <div class="list">
            ${online.filter((x) => x.id !== master).map((x) => html`<div class="row" key=${x.id}><span class="lead-icon"><${Icon} name="speaker" size="sm" /></span><div class="body"><div class="title">${x.name}</div></div><${Switch} checked=${members.includes(x.id)} label=${`Add ${x.name}`} onChange=${() => toggle(x.id)} /></div>`)}
          </div>
          <button class="btn primary block mt" disabled=${!members.length || busy} onClick=${create}>${busy ? html`<${Spinner} light />` : 'Group speakers'}</button>
        </div>`}
  </div>`;
}

// ------------------------------------------------------------ alarms

function describeDays(days) {
  if (!days.length) return 'Once';
  if (days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

function describeTarget(t, sp) {
  if (!t) return '';
  if (t.kind === 'station') return t.station.name;
  if (t.kind === 'preset') {
    const p = sp?.presets.find((x) => x.slot === t.slot);
    return `Preset ${t.slot}${p && !p.empty ? ` (${p.name})` : ''}`;
  }
  return 'Last station';
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return formatClock(d.getTime());
}

function Alarms() {
  const s = useStore();
  return html`<div>
    <${Back} title="Alarms" />
    ${s.alarms.length === 0
      ? html`<${Empty} icon="alarm" title="Wake up to the radio" action=${html`<a class="btn primary" href="#/settings/alarm/new">New alarm</a>`}>
          The hub turns your speaker on, starts a station and gently raises the volume. Works with your phone switched off.
        <//>`
      : html`<div class="list">
            ${s.alarms.map((a) => {
              const sp = speakerById(a.speakerId);
              return html`<div class="row" key=${a.id}>
                <a class="body" href=${`#/settings/alarm/${a.id}`} style="text-decoration:none;color:inherit">
                  <div class="title" style=${`font-size:26px;font-weight:650;${a.enabled ? '' : 'color:var(--muted)'}`}>${formatTime(a.time)}</div>
                  <div class="sub">${[a.label, describeDays(a.days), describeTarget(a.target, sp), sp?.name].filter(Boolean).join(' · ')}</div>
                  ${a.lastResult && !a.lastResult.ok && html`<div class="sub" style="color:var(--danger)">Last time: ${a.lastResult.error}</div>`}
                </a>
                <${Switch} checked=${a.enabled} label="Alarm on" onChange=${(v) => attempt(() => put(`/api/alarms/${a.id}`, { enabled: v }))} />
              </div>`;
            })}
          </div>
          <a class="btn primary block mt" href="#/settings/alarm/new"><${Icon} name="plus" size="sm" />New alarm</a>`}
    ${s.hub && html`<p class="list-foot">Alarms use the hub's clock: it's ${formatClock(Date.now())} there (${s.hub.timezone}). If that's wrong, set the TZ setting on the hub.</p>`}
  </div>`;
}

function AlarmEditor({ id }) {
  const s = useStore();
  const existing = id !== 'new' ? s.alarms.find((a) => a.id === id) : null;
  const [a, setA] = useState(
    () =>
      existing || {
        label: '',
        time: '07:00',
        days: [1, 2, 3, 4, 5],
        speakerId: activeSpeaker()?.id,
        target: s.favorites[0] ? { kind: 'station', station: s.favorites[0].station } : { kind: 'resume' },
        volume: 22,
        fadeIn: true,
        autoOffMinutes: null,
        enabled: true,
      },
  );
  const [busy, setBusy] = useState(false);
  if (id !== 'new' && !existing) return html`<div><${Back} title="Alarm" to="#/settings/alarms" /><${Empty} title="Alarm not found" /></div>`;
  const sp = speakerById(a.speakerId);
  const set = (patch) => setA({ ...a, ...patch });
  const toggleDay = (d) => set({ days: a.days.includes(d) ? a.days.filter((x) => x !== d) : [...a.days, d].sort() });
  const save = async () => {
    setBusy(true);
    const body = { label: a.label, time: a.time, days: a.days, speakerId: a.speakerId, target: a.target, volume: a.volume, fadeIn: a.fadeIn, autoOffMinutes: a.autoOffMinutes, enabled: a.enabled };
    const ok = await attempt(() => (existing ? put(`/api/alarms/${existing.id}`, body) : post('/api/alarms', body)), { success: 'Alarm saved' });
    setBusy(false);
    if (ok) location.hash = '#/settings/alarms';
  };
  return html`<div>
    <${Back} title=${existing ? 'Edit alarm' : 'New alarm'} to="#/settings/alarms" />
    <label class="field"><span>Time</span><input class="input" type="time" value=${a.time} onInput=${(e) => set({ time: e.currentTarget.value })} /></label>
    <div class="field"><span>Repeat · ${describeDays(a.days)}</span>
      <div class="days">${DAY_LETTERS.map((l, d) => html`<button key=${d} class=${a.days.includes(d) ? 'on' : ''} aria-pressed=${a.days.includes(d)} aria-label=${DAY_NAMES[d]} onClick=${() => toggleDay(d)}>${l}</button>`)}</div>
      <div class="chips">
        <button class="chip" onClick=${() => set({ days: [1, 2, 3, 4, 5] })}>Weekdays</button>
        <button class="chip" onClick=${() => set({ days: [0, 6] })}>Weekends</button>
        <button class="chip" onClick=${() => set({ days: [0, 1, 2, 3, 4, 5, 6] })}>Every day</button>
        <button class="chip" onClick=${() => set({ days: [] })}>Once</button>
      </div>
    </div>
    <label class="field"><span>Speaker</span>
      <select class="input" value=${a.speakerId} onChange=${(e) => set({ speakerId: e.currentTarget.value })}>
        ${s.speakers.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
      </select>
    </label>
    <div class="field"><span>Play</span>
      <div class="list">
        <button class="row with-art" onClick=${() => openSheet({ type: 'chooseStation', title: 'Wake up to…', onPick: (st) => set({ target: { kind: 'station', station: st } }) })}>
          <span class="thumb">${a.target.kind === 'station' ? html`<${Artwork} src=${a.target.station.image} name=${a.target.station.name} size="sm" />` : html`<${Artwork} name=${describeTarget(a.target, sp)} icon="radio" size="sm" />`}</span>
          <div class="body"><div class="title">${describeTarget(a.target, sp)}</div><div class="sub">Tap to choose a station</div></div>
          <div class="trail"><${Icon} name="chevronRight" size="sm" /></div>
        </button>
      </div>
      <div class="chips">
        ${[1, 2, 3, 4, 5, 6].map((n) => html`<button key=${n} class=${`chip ${a.target.kind === 'preset' && a.target.slot === n ? 'active' : ''}`} onClick=${() => set({ target: { kind: 'preset', slot: n } })}>Preset ${n}</button>`)}
        <button class=${`chip ${a.target.kind === 'resume' ? 'active' : ''}`} onClick=${() => set({ target: { kind: 'resume' } })}>Last station</button>
      </div>
    </div>
    <div class="field"><span>Volume · ${a.volume}</span>
      <div class="volume"><${Icon} name="volumeLow" /><${LiveSlider} value=${a.volume} label="Alarm volume" onInput=${(v) => set({ volume: v })} onCommit=${(v) => set({ volume: v })} /><${Icon} name="volume" /></div>
    </div>
    <div class="list">
      <${Row} title="Fade in gently" sub="Starts quietly and rises over a minute" chevron=${false} trail=${html`<${Switch} checked=${a.fadeIn} label="Fade in" onChange=${(v) => set({ fadeIn: v })} />`} />
      <div class="row">
        <div class="body"><div class="title">Turn off after</div></div>
        <select class="input" style="width:auto;height:38px" value=${a.autoOffMinutes ?? ''} onChange=${(e) => set({ autoOffMinutes: e.currentTarget.value ? Number(e.currentTarget.value) : null })}>
          <option value="">Never</option>
          ${[15, 30, 45, 60, 90, 120].map((m) => html`<option value=${m}>${m} min</option>`)}
        </select>
      </div>
    </div>
    <label class="field mt"><span>Label (optional)</span><input class="input" maxlength="40" placeholder="Wake up" value=${a.label} onInput=${(e) => set({ label: e.currentTarget.value })} /></label>
    <button class="btn primary block" disabled=${busy || !a.speakerId} onClick=${save}>${busy ? html`<${Spinner} light />` : 'Save alarm'}</button>
    ${existing &&
    html`<div class="btn-row">
      <button class="btn" onClick=${() => attempt(() => post(`/api/alarms/${existing.id}/test`), { success: 'Playing it now' })}>Test now</button>
      <button class="btn danger" onClick=${async () => {
        await attempt(() => del(`/api/alarms/${existing.id}`), { success: 'Alarm deleted' });
        location.hash = '#/settings/alarms';
      }}>Delete</button>
    </div>`}
  </div>`;
}

// ------------------------------------------------------------ hub

function HubSettings() {
  const s = useStore();
  const set = (patch) => attempt(() => put('/api/settings', patch), { success: 'Saved' });
  const mode = s.settings.streamMode || 'auto';
  const engine = s.settings.playbackEngine || 'auto';
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('airwave.theme') || 'system';
    } catch {
      return 'system';
    }
  });
  const applyTheme = (t) => {
    setTheme(t);
    try {
      localStorage.setItem('airwave.theme', t);
    } catch {
      /* ignore */
    }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };
  return html`<div>
    <${Back} title="Hub & playback" />
    <div class="list-label">Appearance</div>
    <div class="segmented">
      ${['system', 'dark', 'light'].map((t) => html`<button key=${t} class=${theme === t ? 'on' : ''} onClick=${() => applyTheme(t)}>${t[0].toUpperCase() + t.slice(1)}</button>`)}
    </div>
    <div class="list-label">How radio starts</div>
    <div class="segmented">
      ${[['auto', 'Automatic'], ['native', 'Native'], ['upnp', 'Network stream']].map(([v, l]) => html`<button key=${v} class=${engine === v ? 'on' : ''} onClick=${() => set({ playbackEngine: v })}>${l}</button>`)}
    </div>
    <p class="list-foot">Automatic uses the speaker's own radio when “Preset buttons & radio” is set up, and a network stream otherwise. If one doesn't work, the other is tried.</p>
    <div class="list-label">Stream delivery</div>
    <div class="segmented">
      ${[['auto', 'Automatic'], ['direct', 'Direct'], ['relay', 'Through hub']].map(([v, l]) => html`<button key=${v} class=${mode === v ? 'on' : ''} onClick=${() => set({ streamMode: v })}>${l}</button>`)}
    </div>
    <p class="list-foot">Automatic sends secure (https) streams through the hub so the speaker can play them. “Through hub” helps with stations that keep dropping out.</p>
    <div class="list-label">About this hub</div>
    <div class="card">
      ${s.hub &&
      html`<dl class="kv">
        <dt>Version</dt><dd>${s.hub.version}</dd>
        <dt>App address</dt><dd>${location.host}</dd>
        <dt>Hub time</dt><dd>${formatClock(s.hub.time)} (${s.hub.timezone})</dd>
        <dt>Discovery</dt><dd>${s.hub.discovery ? 'On' : 'Off'}</dd>
        <dt>Streams relayed now</dt><dd>${s.hub.activeRelays}</dd>
        <dt>Connection</dt><dd>${s.connected ? 'Live' : 'Reconnecting…'}</dd>
      </dl>`}
    </div>
    <div class="card mt">
      <h4>Install on your phone</h4>
      <ol class="steps">
        <li><b>iPhone:</b> in Safari, tap Share → <i>Add to Home Screen</i>.</li>
        <li><b>Android:</b> in Chrome, tap ⋮ → <i>Add to Home screen</i> / <i>Install app</i>.</li>
      </ol>
    </div>
  </div>`;
}

function Shortcuts() {
  const s = useStore();
  const base = `${location.protocol}//${location.host}`;
  const fav = s.favorites[0]?.station.name || 'Jazz24';
  const examples = [
    ['Play a favorite', `${base}/api/quick/play?favorite=${enc(fav)}`],
    ['Play preset 1', `${base}/api/quick/play?preset=1`],
    ['Search and play', `${base}/api/quick/play?search=${enc('classic rock')}`],
    ['Resume / turn on', `${base}/api/quick/play`],
    ['Pause', `${base}/api/quick/pause`],
    ['Turn off', `${base}/api/quick/power?state=off`],
    ['Volume to 30', `${base}/api/quick/volume?level=30`],
    ['Volume up / down', `${base}/api/quick/volume?level=up`],
    ['Switch to Bluetooth', `${base}/api/quick/bluetooth`],
    ['Sleep in 30 min', `${base}/api/quick/sleep?minutes=30`],
    ["What's playing?", `${base}/api/quick/status`],
  ];
  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(
      () => toast('Copied'),
      () => toast(text),
    );
  };
  return html`<div>
    <${Back} title="Siri & Shortcuts" />
    <div class="card">
      <h4>“Hey Siri, play Jazz24 in the living room”</h4>
      <ol class="steps">
        <li>Open the <b>Shortcuts</b> app → <b>+</b> → <i>Add Action</i> → <b>Get Contents of URL</b>.</li>
        <li>Paste one of the links below (tap to copy).</li>
        <li>Name the shortcut — that name is what you say to Siri.</li>
      </ol>
      <p class="muted" style="margin-top:10px;font-size:13.5px">Add <code>&speaker=Kitchen</code> to target a specific speaker; otherwise the one you used last is used. Works on your home Wi-Fi.</p>
    </div>
    <div class="list mt">
      ${examples.map(([t, u]) => html`<button class="row" key=${t} onClick=${() => copy(u)}><div class="body"><div class="title">${t}</div><div class="sub mono" style="background:none;padding:0">${u}</div></div><div class="trail"><${Icon} name="link" size="sm" /></div></button>`)}
    </div>
  </div>`;
}
