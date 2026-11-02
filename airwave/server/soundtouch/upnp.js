import { httpRequest } from '../net.js';
import { escapeXml } from './xml.js';

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

function envelope(inner) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body>${inner}</s:Body></s:Envelope>`
  );
}

/** DIDL-Lite metadata so the speaker can show the station name and logo. */
export function didl({ title, image, url, mime = 'audio/mpeg' }) {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="airwave" parentID="0" restricted="1">' +
    `<dc:title>${escapeXml(title || 'Radio')}</dc:title>` +
    '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
    (image ? `<upnp:albumArtURI>${escapeXml(image)}</upnp:albumArtURI>` : '') +
    `<res protocolInfo="http-get:*:${escapeXml(mime)}:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

/**
 * UPnP AVTransport control of the speaker's built-in media renderer
 * (port 8091). Works on an unmodified speaker, but only accepts plain
 * http:// URLs, which is why the hub relays streams for this path.
 */
export class UpnpTransport {
  constructor(host, { port = 8091, timeout = 8000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
  }

  async action(name, inner) {
    const res = await httpRequest({
      host: this.host,
      port: this.port,
      method: 'POST',
      path: '/AVTransport/Control',
      timeout: this.timeout,
      body: envelope(inner),
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${AVT}#${name}"`,
      },
    });
    if (res.status !== 200) {
      const fault = (res.body.match(/<errorDescription>([^<]*)<\/errorDescription>/) || [])[1];
      const err = new Error(`UPnP ${name} failed (HTTP ${res.status}${fault ? `: ${fault}` : ''})`);
      err.status = res.status;
      throw err;
    }
    return res.body;
  }

  async setUri(url, metadata = '') {
    if (!/^http:\/\//i.test(url)) throw new Error('The speaker only accepts http:// stream URLs over UPnP');
    await this.action(
      'SetAVTransportURI',
      `<u:SetAVTransportURI xmlns:u="${AVT}"><InstanceID>0</InstanceID>` +
        `<CurrentURI>${escapeXml(url)}</CurrentURI>` +
        `<CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData></u:SetAVTransportURI>`,
    );
  }

  async play() {
    await this.action('Play', `<u:Play xmlns:u="${AVT}"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>`);
  }

  async pause() {
    await this.action('Pause', `<u:Pause xmlns:u="${AVT}"><InstanceID>0</InstanceID></u:Pause>`);
  }

  async stop() {
    await this.action('Stop', `<u:Stop xmlns:u="${AVT}"><InstanceID>0</InstanceID></u:Stop>`);
  }

  /** Load a URL and start playback, retrying without metadata if the speaker rejects it. */
  async playUrl(url, meta) {
    try {
      await this.setUri(url, meta ? didl({ ...meta, url }) : '');
    } catch (err) {
      if (!meta) throw err;
      await this.setUri(url, '');
    }
    try {
      await this.play();
    } catch (err) {
      // Current firmware auto-plays after SetAVTransportURI; a failing explicit
      // Play (e.g. "transition not available") is not fatal in that case.
      if (err.status !== 500) throw err;
    }
  }
}
