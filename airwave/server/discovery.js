import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import mdnsFactory from 'multicast-dns';
import { config } from './config.js';
import { lanInterfaces, tcpProbe } from './net.js';
import { logger } from './log.js';

const log = logger('discovery');

/**
 * Finds SoundTouch speakers on the LAN three ways, emitting 'candidate' with
 * an IP address for each hit (the manager confirms by calling /info):
 *  1. mDNS: _soundtouch._tcp.local (what the Bose app used)
 *  2. SSDP: UPnP media renderers
 *  3. Subnet scan of port 8090 (works when multicast is blocked)
 */
export class Discovery extends EventEmitter {
  constructor() {
    super();
    this.mdns = null;
    this.timer = null;
  }

  start() {
    if (!config.discovery) return;
    try {
      this.mdns = mdnsFactory();
      this.mdns.on('response', (res) => this.onMdns(res));
      this.mdns.on('error', (err) => log.debug(`mDNS: ${err.message}`));
    } catch (err) {
      log.warn(`mDNS unavailable: ${err.message}`);
      this.mdns = null;
    }
    this.searchOnce();
    this.timer = setInterval(() => this.searchOnce(), 60000);
  }

  stop() {
    clearInterval(this.timer);
    if (this.mdns) {
      try {
        this.mdns.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  searchOnce() {
    if (this.mdns) {
      try {
        this.mdns.query({ questions: [{ name: '_soundtouch._tcp.local', type: 'PTR' }] });
      } catch (err) {
        log.debug(`mDNS query failed: ${err.message}`);
      }
    }
    this.ssdp().catch((err) => log.debug(`SSDP: ${err.message}`));
  }

  onMdns(res) {
    const records = [...(res.answers || []), ...(res.additionals || [])];
    const isSoundTouch = records.some((r) => /_soundtouch\._tcp/i.test(r.name) || /_soundtouch\._tcp/i.test(String(r.data)));
    if (!isSoundTouch) return;
    for (const r of records) {
      if (r.type === 'A' && r.data) this.emit('candidate', r.data, 'mdns');
    }
  }

  ssdp(timeout = 3000) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const seen = new Set();
      const msg = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n',
      );
      sock.on('message', (buf, rinfo) => {
        const text = buf.toString();
        if (!/bose|soundtouch|MediaRenderer/i.test(text)) return;
        if (seen.has(rinfo.address)) return;
        seen.add(rinfo.address);
        this.emit('candidate', rinfo.address, 'ssdp');
      });
      sock.on('error', () => {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        resolve();
      });
      sock.bind(0, () => {
        try {
          sock.send(msg, 1900, '239.255.255.250');
          setTimeout(() => sock.send(msg, 1900, '239.255.255.250'), 500);
        } catch {
          /* ignore */
        }
      });
      setTimeout(() => {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        resolve();
      }, timeout);
    });
  }

  /** Probe every address in the hub's /24 network(s) for the SoundTouch API port. */
  async scanSubnets({ concurrency = 48 } = {}) {
    const targets = [];
    for (const iface of lanInterfaces()) {
      const parts = iface.address.split('.').map(Number);
      const prefix = parts.slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) {
        const ip = `${prefix}.${i}`;
        if (ip !== iface.address) targets.push(ip);
      }
    }
    const unique = [...new Set(targets)];
    const found = [];
    let index = 0;
    const worker = async () => {
      while (index < unique.length) {
        const ip = unique[index++];
        if (await tcpProbe(ip, config.speakerPorts.http, 700)) {
          found.push(ip);
          this.emit('candidate', ip, 'scan');
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return found;
  }
}
