// Copies the browser builds of Preact, Preact hooks and htm into public/vendor
// (run after `npm install` when upgrading them; the copies are committed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = (p) => path.join(root, 'public', 'vendor', p);

fs.mkdirSync(out(''), { recursive: true });
fs.copyFileSync(nm('preact/dist/preact.module.js'), out('preact.mjs'));
fs.writeFileSync(out('hooks.mjs'), fs.readFileSync(nm('preact/hooks/dist/hooks.module.js'), 'utf8').replace(/from\s*["']preact["']/g, 'from"./preact.mjs"'));
fs.copyFileSync(nm('htm/dist/htm.module.js'), out('htm.mjs'));
console.log('Vendored preact, hooks and htm into public/vendor');
