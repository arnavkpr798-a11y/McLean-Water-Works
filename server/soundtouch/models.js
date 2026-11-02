import { attr, bool, num, text } from './xml.js';

const PLAY_STATUS = {
  PLAY_STATE: 'playing',
  PAUSE_STATE: 'paused',
  STOP_STATE: 'stopped',
  BUFFERING_STATE: 'buffering',
};

export const SOURCE_LABELS = {
  STANDBY: 'Standby',
  BLUETOOTH: 'Bluetooth',
  AUX: 'AUX',
  AIRPLAY: 'AirPlay',
  SPOTIFY: 'Spotify',
  TUNEIN: 'TuneIn',
  LOCAL_INTERNET_RADIO: 'Internet radio',
  INTERNET_RADIO: 'Internet radio',
  RADIOPLAYER: 'Radio',
  UPNP: 'Network stream',
  STORED_MUSIC: 'Music library',
  LOCAL_MUSIC: 'Music library',
  PANDORA: 'Pandora',
  DEEZER: 'Deezer',
  IHEART: 'iHeartRadio',
  AMAZON: 'Amazon Music',
  SIRIUSXM: 'SiriusXM',
  PRODUCT: 'TV',
  NOTIFICATION: 'Notification',
  QPLAY: 'QPlay',
  INVALID_SOURCE: 'Unavailable',
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || (source ? source.charAt(0) + source.slice(1).toLowerCase().replace(/_/g, ' ') : '');
}

export function normalizeContentItem(ci) {
  if (!ci || typeof ci !== 'object') return null;
  return {
    source: attr(ci, 'source') || '',
    type: attr(ci, 'type') || '',
    location: attr(ci, 'location') || '',
    sourceAccount: attr(ci, 'sourceAccount') || '',
    isPresetable: bool(attr(ci, 'isPresetable')),
    name: text(ci.itemName),
    art: text(ci.containerArt),
  };
}

export function normalizeInfo(doc) {
  const info = doc.info || {};
  const components = info.components?.component || [];
  const scm = components.find((c) => text(c.componentCategory) === 'SCM') || components[0] || {};
  const networks = Array.isArray(info.networkInfo) ? info.networkInfo : info.networkInfo ? [info.networkInfo] : [];
  const net = networks.find((n) => attr(n, 'type') === 'SCM') || networks[0] || {};
  const version = text(scm.softwareVersion);
  return {
    id: attr(info, 'deviceID') || text(net.macAddress) || '',
    name: text(info.name),
    type: text(info.type),
    accountId: text(info.margeAccountUUID),
    firmware: version.split(' ')[0] || version,
    firmwareFull: version,
    serial: text(scm.serialNumber),
    mac: text(net.macAddress) || attr(info, 'deviceID') || '',
    ip: text(net.ipAddress),
    region: text(info.regionCode),
    variant: text(info.variant),
  };
}

export function normalizeNowPlaying(doc) {
  const np = doc.nowPlaying || doc;
  if (!np || typeof np !== 'object') return null;
  const source = attr(np, 'source') || '';
  const status = source === 'STANDBY' ? 'standby' : PLAY_STATUS[text(np.playStatus)] || (source ? 'unknown' : 'standby');
  const artNode = np.art;
  const artStatus = attr(artNode, 'artImageStatus');
  const art = artStatus === 'IMAGE_PRESENT' || (!artStatus && text(artNode)) ? text(artNode) : '';
  return {
    source,
    sourceAccount: attr(np, 'sourceAccount') || '',
    sourceLabel: sourceLabel(source),
    status,
    item: normalizeContentItem(np.ContentItem),
    track: text(np.track),
    artist: text(np.artist),
    album: text(np.album),
    stationName: text(np.stationName),
    art,
    description: text(np.description),
    stationLocation: text(np.stationLocation),
    streamType: text(np.streamType),
    skipEnabled: np.skipEnabled !== undefined,
    skipPreviousEnabled: np.skipPreviousEnabled !== undefined,
    shuffle: text(np.shuffleSetting),
    repeat: text(np.repeatSetting),
    connectionStatus: attr(np.connectionStatusInfo, 'status') || '',
    connectionDevice: attr(np.connectionStatusInfo, 'deviceName') || '',
  };
}

export function normalizeVolume(doc) {
  const v = doc.volume || doc;
  return {
    level: num(v.actualvolume, num(v.targetvolume, 0)),
    target: num(v.targetvolume, null),
    muted: bool(text(v.muteenabled)),
  };
}

export function normalizePresets(doc) {
  const list = doc.presets?.preset || [];
  return list
    .map((p) => ({
      slot: Number.parseInt(attr(p, 'id'), 10),
      createdOn: Number.parseInt(attr(p, 'createdOn'), 10) || null,
      updatedOn: Number.parseInt(attr(p, 'updatedOn') || attr(p, 'updateOn'), 10) || null,
      item: normalizeContentItem(p.ContentItem),
    }))
    .filter((p) => p.slot >= 1 && p.slot <= 6 && p.item);
}

export function normalizeSources(doc) {
  const list = doc.sources?.sourceItem || [];
  return list.map((s) => ({
    source: attr(s, 'source') || '',
    account: attr(s, 'sourceAccount') || '',
    status: attr(s, 'status') || '',
    local: bool(attr(s, 'isLocal')),
    multiroom: bool(attr(s, 'multiroomallowed')),
    label: text(s) || sourceLabel(attr(s, 'source')),
  }));
}

export function normalizeBass(doc) {
  const b = doc.bass || {};
  return { level: num(b.actualbass, num(b.targetbass, 0)) };
}

export function normalizeBassCaps(doc) {
  const c = doc.bassCapabilities || doc.bassCapabilties || {};
  return {
    available: bool(text(c.bassAvailable)),
    min: num(c.bassMin, -9),
    max: num(c.bassMax, 0),
    default: num(c.bassDefault, 0),
  };
}

export function normalizeZone(doc) {
  const z = doc.zone;
  if (!z || typeof z !== 'object') return null;
  const master = attr(z, 'master');
  if (!master) return null;
  const members = (z.member || []).map((m) => ({
    id: text(m).replace(/"/g, '').trim(),
    ip: attr(m, 'ipaddress') || '',
    role: attr(m, 'role') || '',
  }));
  return { master, senderIp: attr(z, 'senderIPAddress') || '', members };
}

export function normalizeCapabilities(doc) {
  const c = doc.capabilities || {};
  const caps = (c.capability || []).map((x) => attr(x, 'name')).filter(Boolean);
  return {
    list: caps,
    clockDisplay: text(c.clockDisplay) === 'true',
  };
}
