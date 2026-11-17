// Copies the web client + shared modules into www/ and points the app at your API server.
// Usage: CHARTIST_API=https://api.yourbroker.in node build-web.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'www');
const api = process.env.CHARTIST_API || '';
if (!api) console.warn('⚠ CHARTIST_API not set — the app will call relative URLs, which only work in a browser served by the API server.');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(here, '../web'), out, { recursive: true, filter: (src) => !src.includes(`${path.sep}admin`) });
fs.cpSync(path.join(here, '../shared'), path.join(out, 'shared'), { recursive: true });
const idx = path.join(out, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<head>', `<head>\n  <script>window.CHARTIST_API = ${JSON.stringify(api)};</script>`));
console.log(`www/ ready (API: ${api || 'same origin'})`);
