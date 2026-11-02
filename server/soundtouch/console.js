import net from 'node:net';
import { sleep } from '../net.js';

/**
 * Session on the speaker's plain-text maintenance console (TCP 17000). It has
 * no prompt; the speaker answers each command after roughly a second, so we
 * pause between commands and collect everything it prints.
 */
export async function runConsole(host, commands, { port = 17000, delay = 2000, connectTimeout = 5000 } = {}) {
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`Speaker console (port ${port}) did not answer`));
    }, connectTimeout);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Speaker console (port ${port}) is not reachable: ${err.code || err.message}`));
    });
  });

  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (d) => {
    buffer += d;
  });
  socket.on('error', () => {});

  const outputs = [];
  try {
    await sleep(Math.min(delay, 500));
    for (const cmd of commands) {
      if (/[\r\n]/.test(cmd)) throw new Error('Console commands must be a single line');
      const before = buffer.length;
      socket.write(`${cmd}\r\n`);
      if (cmd === 'sys reboot') {
        await sleep(500);
        outputs.push(buffer.slice(before).replace(/\r/g, ''));
        break;
      }
      // Wait for output to settle: at least `delay`, then until quiet for 400 ms (max 3x delay).
      const start = Date.now();
      let lastLen = buffer.length;
      let lastChange = Date.now();
      while (Date.now() - start < delay * 3) {
        await sleep(100);
        if (buffer.length !== lastLen) {
          lastLen = buffer.length;
          lastChange = Date.now();
        }
        if (Date.now() - start >= delay && Date.now() - lastChange >= 400) break;
      }
      outputs.push(buffer.slice(before).replace(/\r/g, ''));
    }
  } finally {
    socket.end();
    socket.destroy();
  }
  return outputs;
}

const URL_KEYS = ['margeServerUrl', 'statsServerUrl', 'swUpdateUrl', 'bmxRegistryUrl'];

/**
 * Parse `getpdo CurrentSystemConfiguration` output. Firmware variants print it
 * as key=value lines, protobuf text (`key {\n text: "v"\n}`) or XML.
 */
export function parseSystemConfiguration(output) {
  const out = {};
  const src = String(output || '');
  for (const key of URL_KEYS) {
    const patterns = [
      new RegExp(`<${key}>\\s*([^<\\s]+)\\s*</${key}>`),
      new RegExp(`${key}\\s*\\{\\s*text:\\s*"([^"]*)"`),
      new RegExp(`${key}\\s*[=:]\\s*"?([^\\s"<]+)`),
    ];
    for (const re of patterns) {
      const m = src.match(re);
      if (m && m[1]) {
        out[key] = m[1].trim();
        break;
      }
    }
  }
  return out;
}

export const CANONICAL_BOSE_URLS = {
  margeServerUrl: 'https://streaming.bose.com',
  swUpdateUrl: 'https://worldwide.bose.com/updates/soundtouch',
  bmxRegistryUrl: 'https://content.api.bose.io/bmx/registry/v1/services',
};

/** URLs written to the console must be clean single tokens. */
export function isSafeConsoleUrl(value) {
  if (!value || /[\s"'`;\\|&$<>(){}]/.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.search && !u.hash;
  } catch {
    return false;
  }
}
