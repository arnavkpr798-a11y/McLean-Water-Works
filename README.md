# Airwave — your own SoundTouch app

Airwave brings back what the **Bose SoundTouch app** used to do for your SoundTouch 30 (and other SoundTouch speakers). That includes TuneIn radio, presets, favorites, Bluetooth/AUX switching and multi-room. It also adds alarms, sleep timers and Siri control. It does not need Bose's cloud, which Bose switched off on **6 May 2026**.

It has two parts:

| Part | What it is | Where it runs |
| --- | --- | --- |
| **Hub** (`server/`) | A small server ("the API"). It talks to your speakers and to TuneIn's station directory. It also runs alarms and timers. | Any always-on computer on your home Wi-Fi: Raspberry Pi, Mac, PC, NAS or Docker |
| **App** (`public/`) | A phone app you install from the browser (a PWA). It opens full-screen from your home screen like any other app. | iPhone, Android, iPad, any browser |

```
 Phone app ──Wi-Fi──▶ Airwave hub ──▶ SoundTouch speaker (port 8090 API, 8080 live updates)
                         │  ▲
                         │  └── speaker asks the hub "how do I play preset 3?" (replaces Bose's cloud)
                         └────▶ TuneIn directory (opml.radiotime.com)
```

---

## What happened to the Bose app (research summary)

- Bose ended SoundTouch cloud support on **6 May 2026**. It was first announced for 18 Feb 2026. The SoundTouch app was updated to "local-only" mode. Presets, browsing music services (including TuneIn), and starting content from the app **stopped working**. Bose also published the speaker's local Web API (port 8090) for third-party apps.
- The speaker still has its local controls. These are volume, power, sources (Bluetooth, AUX), presets storage, bass, name, multi-room zones and live WebSocket notifications. Airwave uses all of them.
- Radio broke because the speaker looks up *how to play a station* through a Bose "service registry". That registry no longer exists. Airwave can act as that registry. This is the same approach community projects use (OpenCloudTouch, soundtouch-localradio, AfterTouch, SoundCork). It is reversible, and nothing is installed on the speaker.

## Feature map: old Bose app → Airwave

| SoundTouch app feature | Airwave |
| --- | --- |
| Now Playing: art, station, song, play/pause, volume, mute | ✅ Live (pushed from the speaker instantly). Song titles come from the station's own stream metadata. |
| 6 presets: play, store, replace, clear | ✅ Tap to play, hold for options, "save what's playing", save from any station |
| Preset buttons **on the speaker / remote** play radio | ✅ After the one-time **Preset buttons & radio** setup (Settings → speaker) |
| Old TuneIn presets saved before the shutdown | ✅ Revived. The speaker's old presets play again, from the app and the buttons. |
| TuneIn: Local Radio, Music, News, Talk, Sports, By Location, By Language, Podcasts | ✅ Full TuneIn directory browsing |
| Search stations | ✅ With recent searches |
| Recents | ✅ Includes stations started from the speaker's buttons |
| Favorites | ✅ Unlimited, reorderable, shared by every phone in the house |
| Custom stations (stream URL) | ✅ With a "Test stream" check. Handles .pls/.m3u playlists, redirects, https and SHOUTcast. |
| Bluetooth: switch, pairing mode, clear pairings | ✅ |
| AUX input | ✅ |
| Power on/off, resume last station | ✅ |
| Multi-room ("Play everywhere", groups) | ✅ Create/edit/ungroup, per-speaker group volume |
| Speaker settings: rename, bass, auto-off, info | ✅ |
| Several speakers | ✅ Auto-discovery (mDNS, SSDP, network scan) or by IP |
| **New:** Alarms (wake to radio, fade-in, auto-off, weekdays…) | ✅ Run on the hub, so they work with your phone off |
| **New:** Sleep timer with fade-out | ✅ Restores your volume for next time |
| **New:** Siri / Shortcuts / Home Assistant | ✅ Simple URLs, e.g. `/api/quick/play?favorite=Jazz24` |
| Spotify, Pandora, Amazon, Deezer, iHeart, SiriusXM *inside* the app | ❌ These needed Bose's cloud accounts. Use Bluetooth, or AirPlay on models that have it. |

---

## Setup (about 10 minutes, once)

### 1. Choose a computer to be the hub

It must be **on the same Wi-Fi/network as the speaker** and **stay on**. Alarms, timers and the speaker's preset buttons need it. Good choices:

- **Raspberry Pi** (any model with Wi-Fi/Ethernet). This is ideal: cheap and always on.
- A Mac or PC that stays on. Turn off automatic sleep.
- A NAS or home server with Docker.

Tip: in your router, reserve fixed IP addresses for the hub and the speaker (DHCP reservation). If the hub's address does change, Airwave notices and re-points the speaker by itself.

### 2. Install the hub

You need **Node.js 18 or newer** (or Docker).

**Raspberry Pi / Linux (starts automatically on boot):**
```sh
git clone https://github.com/arnavkpr798-a11y/airwave.git && cd airwave
sh deploy/install-linux.sh
```

**Mac (starts automatically at login):**
```sh
git clone https://github.com/arnavkpr798-a11y/airwave.git && cd airwave
sh deploy/install-mac.sh
```

**Docker (Linux host):** edit `TZ` in `docker-compose.yml`, then `docker compose up -d`.

**Windows / just trying it:**
```sh
git clone https://github.com/arnavkpr798-a11y/airwave.git && cd airwave
npm install
npm start
```
To start it automatically on Windows, add `node C:\path\to\airwave\server\index.js` as a Task Scheduler "At log on" task.

The hub prints the address to open, for example `http://192.168.1.10:8095`.

### 3. Install the app on your phone

Open that address on your phone while on home Wi-Fi:

- **iPhone:** Safari → Share → **Add to Home Screen**
- **Android:** Chrome → ⋮ → **Install app** / **Add to Home screen**

Your speaker appears automatically. If it doesn't, go to **Settings → Add a speaker → Search my network**, or type the speaker's IP address.

### 4. Bring back the speaker's preset buttons (recommended)

Go to **Settings → (your speaker) → Preset buttons & radio → Set up**. Airwave then:

1. Reads and **backs up** the speaker's current "radio lookup" setting (`bmxRegistryUrl`).
2. Points it at the hub, using the speaker's own maintenance console on port 17000. **Only this one setting changes.**
3. Checks the change took effect and restarts the speaker. This takes about a minute.

After that, the 1–6 buttons on the speaker and remote play radio again, including presets saved years ago in the Bose app. **Undo** restores the original setting at any time.

Without this step, radio still plays from the app. Airwave sends the stream to the speaker's built-in network player (UPnP). The physical buttons just won't work.

---

## Everyday use

- **Listen tab:** what's playing, play/pause, volume, ♥ favorite, ☆ save to preset, and Radio / Bluetooth / AUX / Sleep / Group chips. Below are your six presets. Tap to play, **hold** to change.
- **Browse tab:** TuneIn categories and search. Tap a station to play it. Tap ⋯ to play it on another speaker, save it to a preset, or see station info. Use **+** to add a station by URL.
- **Library tab:** favorites (Edit to reorder, rename, remove) and recently played.
- **Settings tab:** speakers, preset-button setup, bass, auto-off, Bluetooth pairing, groups, alarms, Siri shortcuts, theme.

### Siri & Shortcuts

In the iOS Shortcuts app, create a shortcut with **Get Contents of URL**. **Settings → Siri & Shortcuts** in the app lists ready-made links you can copy. Examples:

| Say / run | URL |
| --- | --- |
| Play a favorite | `http://<hub>:8095/api/quick/play?favorite=Jazz24` |
| Play preset 3 | `http://<hub>:8095/api/quick/play?preset=3` |
| Search & play | `http://<hub>:8095/api/quick/play?search=classic%20rock` |
| Resume / turn on | `http://<hub>:8095/api/quick/play` |
| Turn off | `http://<hub>:8095/api/quick/power?state=off` |
| Volume | `http://<hub>:8095/api/quick/volume?level=30` (or `up`, `down`, `mute`, `unmute`) |
| Bluetooth | `http://<hub>:8095/api/quick/bluetooth` (`?pair=1` for pairing mode) |
| Sleep timer | `http://<hub>:8095/api/quick/sleep?minutes=30` |
| What's playing | `http://<hub>:8095/api/quick/status` |

Add `&speaker=Kitchen` to pick a speaker. Otherwise the one you used last in the app is used.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| App says "Can't reach the Airwave hub" | The hub computer is off or asleep, or your phone isn't on home Wi-Fi (or is on a guest network). |
| Speaker not found | Use Settings → Add a speaker → type its IP (find it in your router's device list). The speaker and hub must be on the same network. Docker on Mac/Windows can't discover speakers; run Node directly there. |
| A station won't play | Some stations only offer HLS streams, which SoundTouch can't play. Airwave tells you this. Try another entry for the same station. |
| A station keeps dropping out | Settings → Hub & playback → Stream delivery → **Through hub**. The hub then reconnects to the station automatically. |
| Preset buttons stopped working | Settings → speaker → Preset buttons & radio → **Repair**. Also make sure the hub is running. |
| Alarm went off at the wrong time | Alarms use the hub's clock and time zone (shown on the Alarms page). Set `TZ` (for example `TZ=Europe/London`) for the hub. |
| Speaker was factory-reset | Set it up on Wi-Fi with the Bose app first (Bose says basic setup still works). App playback works in any case. Native radio may be refused on an un-registered speaker. |

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8095` | Port for the app and for speaker callbacks |
| `DATA_DIR` | `./data` | Where favorites, alarms and setup backups are stored (`airwave.json`) |
| `TZ` | system | Time zone for alarms |
| `SPEAKERS` | – | Comma-separated speaker IPs to always connect to |
| `PUBLIC_ADDRESS` | auto | The hub's LAN IP as the speaker should see it (only if auto-detection is wrong) |
| `DISCOVERY` | `on` | `off` disables automatic discovery |
| `LOG_LEVEL` | `info` | `debug` for detailed logs |

## Privacy & security

- Everything stays on your home network. The hub only contacts TuneIn's directory and the radio stations you play. No accounts, no tracking.
- Like the speaker's own API, the hub has no password. Anyone on your Wi-Fi can use it. **Don't expose port 8095 to the internet** (no port forwarding).
- Relay links are signed, so the hub can't be used as an open proxy.

## For developers

```sh
npm install
npm test        # 50 tests: unit + end-to-end against simulated speakers
npm run demo    # full app against two simulated speakers + fake TuneIn: http://localhost:8095
```

- `server/`: zero-framework Node. `hub.js` handles playback engines, sessions and presets. `bmx.js` provides the endpoints the speaker calls. `radiosetup.js` handles console setup. `resolver.js` / `stream.js` handle stream resolution, the relay and ICY metadata. `scheduler.js` runs alarms and sleep timers.
- `public/`: Preact + htm, vendored, so there is no build step.
- `dev/fake-speaker.js`: a SoundTouch simulator (Web API, WebSocket, UPnP, console, and native radio via the registry).

How playback works:
- **Native:** the hub `POST`s `/select` with a `LOCAL_INTERNET_RADIO` item whose location is `/station?data=<base64 station>`. The speaker fetches `<registry baseUrl>/station?data=…` from the hub and gets `{"audio":{"streamUrl":…}}` back. The hub resolves TuneIn at that moment, so stream links never go stale.
- **UPnP fallback:** `SetAVTransportURI` + `Play` on port 8091 with a plain-http URL. https streams are relayed through the hub. If the native path doesn't call back within 7 s, Airwave falls back automatically.

> Airwave is an independent project, not affiliated with Bose or TuneIn. Bose and SoundTouch are trademarks of Bose Corporation. TuneIn is a trademark of TuneIn, Inc.
