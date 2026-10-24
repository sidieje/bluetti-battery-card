/* Headless run of the visual-editor harness.
 *   node test/editor-node-test.mjs [--step=N] [--no-recall]
 *
 * Replays the card editor against test/mini-ha-form.js inside jsdom, so the
 * editor can be asserted without a Home Assistant instance. jsdom is a local
 * development aid, not a dependency of the card: install it somewhere outside
 * this repo and point at it, e.g.
 *   npm install jsdom
 *   node test/editor-node-test.mjs
 * (run from a directory that can resolve `jsdom`, or set JSDOM_PATH to the
 * directory containing its node_modules).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let JSDOM;
for (const p of ['jsdom', ...(process.env.JSDOM_PATH ? [path.join(process.env.JSDOM_PATH, 'jsdom')] : [])]) {
  try { ({ JSDOM } = require(p)); break; } catch { /* try next */ }
}
if (!JSDOM) {
  console.error('jsdom not found. `npm install jsdom` outside the repo, or set JSDOM_PATH to a node_modules parent.');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const stepArg = argv.find((a) => a.startsWith('--step'));
const step = stepArg && Number.isFinite(Number(stepArg.split('=')[1])) ? Number(stepArg.split('=')[1]) : 99;
const recall = !argv.includes('--no-recall');

const dom = new JSDOM(
  '<!doctype html><html><body><div id="form"></div><pre id="log"></pre></body></html>',
  { runScripts: 'dangerously', pretendToBeVisual: true }
);
const { window } = dom;

// Bits the card touches that jsdom does not implement.
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.confirm = () => true;

const load = (rel) => {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  try {
    window.eval(code);
  } catch (err) {
    console.error(`loading ${rel} failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
};

load('integrated-ups-flow-card.js');
load('test/mini-ha-form.js');
load('test/editor-scenario.js');

if (!window.customElements.get('integrated-ups-flow-card-editor')) {
  console.error('editor element was not registered by the card file');
  process.exit(1);
}

const el = window.document.getElementById('log');
const result = await window.runEditorTests({ el, step, recall });
for (const l of result.lines) console.log(l.msg);
console.log(`\nrecall=${recall} step=${step} -> ${result.pass} ok, ${result.fail} failed`);
process.exit(result.fail === 0 ? 0 : 1);
