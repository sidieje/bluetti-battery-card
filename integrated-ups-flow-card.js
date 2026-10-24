/*
 * integrated-ups-flow-card
 * https://github.com/bigcspecv/bluetti-battery-card
 *
 * A Home Assistant Lovelace card for INTEGRATED UPS units — devices where
 * the battery, inverter, charger, and transfer switch all live in a single
 * sealed box (e.g. BLUETTI Elite 200 V2).
 *
 * Layout (v0.2):
 *
 *   [ PV   ]----,         ,----[ GRID ]
 *               |  ( SoC )  |
 *   [ DC   ]----'         '----[ AC   ]
 *
 * Four corner nodes (PV/Grid in, DC/AC out) with an arc gauge in the
 * middle showing battery state of charge. Lines from each corner are
 * L-shaped with rounded corners and animated when their flow is active.
 *
 * Plain Web Component, no build step, no external imports.
 *
 * v0.5.0 adds a "last updated / Xs ago" staleness indicator. Some
 * integrations (BLUETTI's cloud poller in particular) silently drop their
 * connection and leave entities holding their last value instead of going
 * `unavailable`. The indicator tracks the newest report timestamp across the
 * configured entities.
 *
 * v0.5.1 splits the two failure modes apart: the card's red border is driven
 * solely by the battery-level entity going `unavailable` (the clean-drop
 * signal), while `stale_threshold` (default 300 s) only controls when the
 * "Xs ago" text turns red (the frozen-value signal).
 *
 * v0.6.0 adds sizing controls, an action-button strip, and extra readings.
 * `options.size` (compact/normal/large) times `options.scale` (0.4–2.2) drives
 * a single `--ups-scale` custom property that every dimension in the sheet is
 * derived from, so the measured flow geometry follows along for free.
 * `buttons:` renders up to three per row under the diagram with per-button
 * actions (toggle / more-info / call-service / navigate / url), and each
 * corner takes a `readings:` list — PV voltage and current being the common
 * ask — whose units default to the sensor's own.
 *
 * v0.7.0 keeps text readable at every size: the size/scale knobs shrink the
 * layout, but text never shrinks below its normal size (it still grows when
 * you scale up). Adds `header:` and `footer:` rows for sensors that don't
 * belong to the power flow — each takes a `sensors:` list in the same shape
 * as a corner's readings, and each can be hidden with `show: false`.
 */

const CARD_VERSION = '0.7.0';
const CARD_TAG = 'integrated-ups-flow-card';
const EDITOR_TAG = `${CARD_TAG}-editor`;

console.info(
  `%c ${CARD_TAG} %c v${CARD_VERSION} `,
  'color: white; background: #03a9f4; font-weight: 700; padding: 1px 4px; border-radius: 3px 0 0 3px;',
  'color: #03a9f4; background: white; font-weight: 700; padding: 1px 4px; border: 1px solid #03a9f4; border-radius: 0 3px 3px 0;'
);

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c && c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: 'Integrated UPS Flow Card',
    description:
      'Four-corner power flow with a central battery arc for integrated UPS units (battery + inverter in one box) like BLUETTI Elite 200 V2.',
    preview: false,
    documentationURL: 'https://github.com/bigcspecv/bluetti-battery-card',
  });
}

const DEFAULTS = {
  idle_threshold: 5,
  max_power: 2600,
  // Seconds since the newest entity report before the "Xs ago" text turns
  // red. This controls the text color only — the card's red border is driven
  // separately, by the battery-level entity going `unavailable`. BLUETTI's
  // poll cadence sits well under this, so a healthy connection never trips it.
  stale_threshold: 300,
  size: 'normal',
  scale: 1,
};

// Overall card scale. Every dimension in the stylesheet is expressed as
// `calc(<base> * var(--ups-s))`, so one number resizes the whole card —
// corners, battery arc, fonts, padding and the flow-area height together.
// The flow-line geometry is measured from the DOM at render time, so it
// follows the scale automatically with no extra work.
const SIZE_PRESETS = {
  compact: 0.72,
  normal: 1,
  large: 1.25,
};
const SCALE_MIN = 0.4;
const SCALE_MAX = 2.2;

// Below this *card* width the stylesheet applies its own shrink factor, so a
// card in a narrow dashboard column scales down on its own. Kept in sync with
// the @container breakpoint in STYLES.
const NARROW_BREAKPOINT = 560;
const NARROW_FACTOR = 0.82;

// Lovelace masonry row height, used to convert the card's pixel height into
// the row count returned by getCardSize().
const LOVELACE_ROW_PX = 50;

// Buttons live in a fixed-height strip under the flow diagram, laid out three
// per row. One row fills the strip; two rows split it in half (the requested
// "full size vs half height" behaviour). Three or more rows keep the two-row
// button height and grow the strip instead, so buttons never get unusably
// small.
const BUTTON_COLS = 3;
const BUTTON_STRIP_PX = 72;
const BUTTON_MAX_SPLIT_ROWS = 2;

const BUTTON_ACTIONS = ['more-info', 'toggle', 'call-service', 'navigate', 'url', 'none'];

// Wording for the "ask for confirmation first" prompt, keyed by action, so a
// toggle asks "Toggle DC?" instead of the generic "Run DC?".
const ACTION_VERBS = {
  'more-info': 'Open',
  'toggle': 'Toggle',
  'call-service': 'Run',
  'navigate': 'Navigate to',
  'url': 'Open',
};

// How often (ms) the relative-age line is refreshed so "Xs ago" keeps ticking
// even when no new state arrives (a dropped integration stops pushing hass).
const FRESHNESS_TICK_MS = 1000;

// Flow animation: longer dur = slower; low power -> slow, high -> fast.
const ANIM_SLOW_S = 4.0;
const ANIM_FAST_S = 1.2;

// Arc gauge geometry (in viewBox units; the SVG is scaled to its container).
const ARC_VB = 200; // square viewBox edge
const ARC_CX = ARC_VB / 2;
const ARC_CY = ARC_VB / 2;
const ARC_R = 78;
const ARC_STROKE = 12;
const ARC_START_DEG = 225; // bottom-left
const ARC_SWEEP_DEG = 270; // clockwise through the top to bottom-right

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function isTemplate(value) {
  return typeof value === 'string' && (value.includes('{{') || value.includes('{%'));
}

function toNum(v, fallback = 0) {
  if (v === null || v === undefined) return fallback;
  if (v === 'unavailable' || v === 'unknown' || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fmtPower(w) {
  if (!Number.isFinite(w)) return '0 W';
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

function fmtRuntime(min) {
  if (!Number.isFinite(min) || min <= 0) return '';
  const total = Math.floor(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// One extra corner reading (voltage, current, temperature, ...). Numeric
// values are rounded to the configured decimals; anything else is shown
// verbatim so plain text sensors still work.
function fmtReading(raw, decimals, unit) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw === 'unavailable' || raw === 'unknown') return '—';
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return String(raw);
  const d = Number.isFinite(decimals) ? decimals : 1;
  const text = String(n.toFixed(d));
  return unit ? `${text} ${unit}` : text;
}

// Config -> normalized extra-readings list for one corner.
function normalizeReadings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r === 'object' && r.entity)
    .map((r) => ({
      entity: String(r.entity),
      label: r.label ?? r.name ?? null,
      unit: r.unit !== undefined && r.unit !== null ? String(r.unit) : null,
      decimals: Number.isFinite(r.decimals) ? clamp(Math.round(r.decimals), 0, 4) : null,
    }));
}

// Config -> one header or footer row: an optional title plus a list of
// sensors in the same shape as a corner's readings. `show: false` hides the
// row without throwing its configuration away.
function normalizeRow(row) {
  if (row === undefined || row === null) return null;
  if (typeof row === 'string') return { title: row, sensors: [], show: true };
  if (typeof row !== 'object' || Array.isArray(row)) return null;
  return {
    title: row.title !== undefined && row.title !== null ? String(row.title) : null,
    sensors: normalizeReadings(row.sensors ?? row.entities),
    show: row.show === undefined ? true : !!row.show,
  };
}

// Config -> normalized button list. `action` is inferred when omitted so the
// common cases stay short: a service means call-service, an entity alone
// means more-info.
function normalizeButtons(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && typeof b === 'object')
    .map((b) => {
      const entity = b.entity ? String(b.entity) : null;
      let action = b.action ? String(b.action) : null;
      if (!action) {
        if (b.service) action = 'call-service';
        else if (b.navigation_path) action = 'navigate';
        else if (b.url) action = 'url';
        else if (entity) action = 'more-info';
        else action = 'none';
      }
      if (!BUTTON_ACTIONS.includes(action)) action = 'none';
      return {
        entity,
        name: b.name !== undefined && b.name !== null ? String(b.name) : null,
        icon: b.icon ? String(b.icon) : null,
        action,
        service: b.service ? String(b.service) : null,
        service_data: b.service_data || b.data || null,
        navigation_path: b.navigation_path ? String(b.navigation_path) : null,
        url: b.url ? String(b.url) : null,
        color: b.color ? String(b.color) : null,
        confirmation: !!b.confirmation,
        confirmation_text:
          b.confirmation_text !== undefined && b.confirmation_text !== null
            ? String(b.confirmation_text)
            : null,
      };
    });
}

// Newest "this entity reported" time, in ms, from a frontend state object.
// Prefer last_reported (bumped on every report even when the value is
// unchanged, so a steady-but-alive poll still counts as fresh), then fall
// back to last_updated and last_changed for older HA cores.
function entityFreshnessMs(stateObj) {
  if (!stateObj) return null;
  const ts = stateObj.last_reported || stateObj.last_updated || stateObj.last_changed;
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

// Compact relative age: "12s ago", "4m ago", "1h 3m ago".
function fmtAgo(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m ago` : `${h}h ago`;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  // 0° = 12 o'clock, increases clockwise.
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function describeArc(cx, cy, r, startDeg, sweepDeg) {
  if (sweepDeg <= 0) return '';
  const startPt = polarToCartesian(cx, cy, r, startDeg);
  const endPt = polarToCartesian(cx, cy, r, startDeg + sweepDeg);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M ${startPt.x.toFixed(2)} ${startPt.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${endPt.x.toFixed(2)} ${endPt.y.toFixed(2)}`;
}

// L-shaped path from start to end with rounded corner at (start.x, end.y).
// All four corner-to-center paths use "vertical first, then horizontal"
// because the corners are placed above/below the center row.
function buildVThenHPath(start, end, cornerR) {
  if (Math.abs(start.x - end.x) < 0.5 && Math.abs(start.y - end.y) < 0.5) return '';
  const dirY = Math.sign(end.y - start.y) || 1;
  const dirX = Math.sign(end.x - start.x) || 1;
  // If the horizontal offset is too small to fit a rounded corner, fall back to a straight line.
  const vDist = Math.abs(end.y - start.y);
  const hDist = Math.abs(end.x - start.x);
  if (vDist < cornerR + 1 || hDist < cornerR + 1) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }
  const cx = start.x;
  const cy = end.y;
  const beforeY = cy - dirY * cornerR;
  const afterX = cx + dirX * cornerR;
  return `M ${start.x} ${start.y} L ${cx} ${beforeY} Q ${cx} ${cy} ${afterX} ${cy} L ${end.x} ${end.y}`;
}

class IntegratedUpsFlowCard extends HTMLElement {
  static async getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return {
      title: 'Integrated UPS',
      pv: { entity: '', name: 'PV', icon: 'mdi:solar-panel' },
      grid: { entity: '', name: 'Grid', icon: 'mdi:transmission-tower' },
      dc: { entity: '', name: 'DC', icon: 'mdi:current-dc' },
      ac: { entity: '', name: 'AC', icon: 'mdi:power-plug' },
      unit: {
        soc_entity: '',
      },
      display: {
        show_state: true,
        show_throughput: true,
        show_runtime: true,
        show_last_updated: true,
        runtime_entity: '',
        charge_time_entity: '',
      },
      options: {
        idle_threshold: 5,
        invert_battery_sign: false,
        max_power: 2600,
        stale_threshold: 300,
        size: 'normal',
        scale: 1,
      },
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._templateSubs = new Map();
    this._templateResults = new Map();
    this._initialized = false;
    this._renderQueued = false;
    this._resizeObserver = null;
    this._resizeTimer = null;
    this._freshnessTimer = null;
    this._buttonEls = [];
    this._buttonsSig = null;
  }

  // ----- Lovelace lifecycle -----

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');

    // Back-compat: v0.1 used `load:` for AC output. Accept it as an alias for `ac:`.
    const ac = config.ac || config.load || {};
    const grid = config.grid || {};
    const pv = config.pv || {};
    const dc = config.dc || {};
    const unit = config.unit || {};

    // No fields are required. Any/all of pv, grid, dc, ac can be omitted —
    // their corners (and flow lines) just don't render when absent.
    const opts = config.options || {};
    const display = config.display || {};

    const corner = (cfg, defName, defIcon) => ({
      entity: cfg.entity ? String(cfg.entity) : null,
      name: cfg.name || defName,
      icon: cfg.icon || defIcon,
      // Extra sub-readings under the corner's watts (voltage, current, ...).
      readings: normalizeReadings(cfg.readings),
    });

    this._config = {
      title: config.title ?? null,
      // Optional rows above/below the diagram for sensors that don't belong to
      // the power flow. A header, when present, takes over drawing the title
      // (it falls back to the top-level `title:`), so the two never duplicate.
      header: normalizeRow(config.header),
      footer: normalizeRow(config.footer),
      pv: corner(pv, 'PV', 'mdi:solar-panel'),
      grid: corner(grid, 'Grid', 'mdi:transmission-tower'),
      dc: corner(dc, 'DC', 'mdi:current-dc'),
      ac: corner(ac, 'AC', 'mdi:power-plug'),
      // Action buttons in a strip under the flow diagram, three per row.
      buttons: normalizeButtons(config.buttons),
      unit: {
        // name / icon are silently preserved for back-compat with v0.2/v0.3
        // configs but no longer rendered anywhere.
        name: unit.name || null,
        icon: unit.icon || null,
        soc_entity: unit.soc_entity ? String(unit.soc_entity) : null,
        power_entity: unit.power_entity ? String(unit.power_entity) : null,
      },
      display: {
        // Visibility toggles default to true so existing configs are unaffected.
        show_state: display.show_state !== false,
        show_throughput: display.show_throughput !== false,
        show_runtime: display.show_runtime !== false,
        // Last-updated / staleness line. On by default — it's the whole point
        // of the card for integrations that freeze instead of going offline.
        show_last_updated: display.show_last_updated !== false,
        // Optional overrides — when set, the rendered line uses the string
        // (templates allowed) instead of the computed default.
        state_template: display.state_template || null,
        throughput_template: display.throughput_template || null,
        runtime_template: display.runtime_template || null,
        // Runtime/charge-time sensors live alongside the show_runtime toggle.
        // For back-compat, v0.4 configs that placed them under `unit:` are
        // still accepted.
        runtime_entity:
          (display.runtime_entity && String(display.runtime_entity)) ||
          (unit.runtime_entity && String(unit.runtime_entity)) ||
          null,
        charge_time_entity:
          (display.charge_time_entity && String(display.charge_time_entity)) ||
          (unit.charge_time_entity && String(unit.charge_time_entity)) ||
          null,
      },
      options: {
        idle_threshold: Number.isFinite(opts.idle_threshold)
          ? opts.idle_threshold
          : DEFAULTS.idle_threshold,
        invert_battery_sign: !!opts.invert_battery_sign,
        max_power:
          Number.isFinite(opts.max_power) && opts.max_power > 0
            ? opts.max_power
            : DEFAULTS.max_power,
        stale_threshold:
          Number.isFinite(opts.stale_threshold) && opts.stale_threshold > 0
            ? opts.stale_threshold
            : DEFAULTS.stale_threshold,
        // Preset size, then an optional fine-tune multiplier on top of it.
        size: SIZE_PRESETS[opts.size] ? String(opts.size) : DEFAULTS.size,
        scale: clamp(toNum(opts.scale, DEFAULTS.scale), SCALE_MIN, SCALE_MAX),
      },
    };

    this._resetTemplateSubs();
    if (this._hass) this._setupTemplateSubs();

    if (this._initialized) {
      this._scheduleRender(true);
    } else if (this.isConnected) {
      this._buildDom();
      this._initialized = true;
      this._scheduleRender(true);
    }
  }

  set hass(hass) {
    const firstSet = !this._hass;
    this._hass = hass;
    if (firstSet && this._config) this._setupTemplateSubs();
    if (this._initialized) this._scheduleRender();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (this._config && !this._initialized) {
      this._buildDom();
      this._initialized = true;
    }
    if (this._initialized) {
      this._setupResizeObserver();
      this._startFreshnessTimer();
      this._scheduleRender(true);
    }
  }

  disconnectedCallback() {
    this._teardownResizeObserver();
    this._stopFreshnessTimer();
    this._resetTemplateSubs();
  }

  // Lovelace reserves this many rows in the masonry grid. v0.5 returned a
  // fixed 5 no matter how big the card actually was; now it tracks the
  // configured size/scale and the button strip, so a compact card stops
  // hogging half a dashboard.
  getCardSize() {
    if (!this._config) return 5;
    // Once the card is on screen, measure it — that includes the narrow-column
    // factor and any wrapping the browser did. The estimate below only covers
    // the first layout pass and the editor preview.
    const measured = this.offsetHeight;
    if (measured > 0) return Math.max(2, Math.ceil(measured / LOVELACE_ROW_PX));
    const s = this._effectiveScale();
    let h = (320 + 32) * s;
    // The header replaces the plain title row when configured.
    h += this._rowHeight(s, this._config.header) || (this._config.title ? 34 * s + 12 : 0);
    h += this._rowHeight(s, this._config.footer);
    h += this._buttonStripHeight(s);
    return Math.max(2, Math.round(h / LOVELACE_ROW_PX));
  }

  // ----- Size / scale -----

  // Effective scale = preset multiplier × the user's fine-tune. The stylesheet
  // multiplies this by --ups-narrow on narrow viewports.
  _effectiveScale() {
    if (!this._config) return 1;
    const preset = SIZE_PRESETS[this._config.options.size] ?? 1;
    const user = this._config.options.scale;
    return clamp(preset * (Number.isFinite(user) ? user : 1), SCALE_MIN, SCALE_MAX);
  }

  // Height of a single button row. One row fills the strip; two rows split it
  // in half (gaps included, so the strip stays the same height either way);
  // three or more keep the two-row height and grow the strip so buttons stay
  // tappable.
  _buttonRowHeight(scale) {
    const n = this._config ? this._config.buttons.length : 0;
    if (n === 0) return 0;
    const rows = Math.min(Math.ceil(n / BUTTON_COLS), BUTTON_MAX_SPLIT_ROWS);
    const gap = 8 * scale;
    return (BUTTON_STRIP_PX * scale - gap * (rows - 1)) / rows;
  }

  // Total vertical space the strip takes: rows + inner gaps + the top margin.
  _buttonStripHeight(scale) {
    const n = this._config ? this._config.buttons.length : 0;
    if (n === 0) return 0;
    const rows = Math.ceil(n / BUTTON_COLS);
    const gap = 8 * scale;
    return this._buttonRowHeight(scale) * rows + gap * rows;
  }

  // A header/footer row is one line of text (title and sensors share it) plus
  // its margin. Only used for the pre-layout getCardSize() estimate.
  _rowHeight(scale, row) {
    if (!row || !row.show) return 0;
    return 28 * scale + 10;
  }

  // Entities shown by the visible header/footer rows. Unlike the corner
  // readings these are unrelated sensors, so they take part in template
  // subscriptions but deliberately stay out of the staleness calculation — a
  // slow room temperature sensor shouldn't make the UPS look stale.
  _rowEntities() {
    if (!this._config) return [];
    const out = [];
    for (const key of ['header', 'footer']) {
      const row = this._config[key];
      if (!row || !row.show || !Array.isArray(row.sensors)) continue;
      for (const r of row.sensors) if (r.entity) out.push(r.entity);
    }
    return out;
  }

  // ----- Template subscriptions (real HA WS API) -----

  // Entity IDs behind every configured corner reading. They participate in
  // template subscriptions and in the staleness calculation just like the
  // power sensors, since they come from the same device.
  _readingEntities() {
    if (!this._config) return [];
    const out = [];
    for (const key of ['pv', 'grid', 'dc', 'ac']) {
      const cfg = this._config[key];
      if (!cfg || !Array.isArray(cfg.readings)) continue;
      for (const r of cfg.readings) if (r.entity) out.push(r.entity);
    }
    return out;
  }

  _templateFields() {
    if (!this._config) return [];
    const c = this._config;
    return [
      c.title,
      c.header && c.header.show ? c.header.title : null,
      c.footer && c.footer.show ? c.footer.title : null,
      c.pv.entity,
      c.grid.entity,
      c.dc.entity,
      c.ac.entity,
      ...this._readingEntities(),
      ...this._rowEntities(),
      c.unit.soc_entity,
      c.unit.power_entity,
      c.display.runtime_entity,
      c.display.charge_time_entity,
      c.display.state_template,
      c.display.throughput_template,
      c.display.runtime_template,
    ].filter((f) => f && isTemplate(f));
  }

  // Resolve a display-line override: if it's a template, return the latest
  // rendered value; if it's a plain string, return it as-is.
  _resolveOverride(value) {
    if (!value) return null;
    if (isTemplate(value)) {
      return this._templateResults.has(value) ? this._templateResults.get(value) : '';
    }
    return value;
  }

  _setupTemplateSubs() {
    if (!this._hass || !this._hass.connection || !this._config) return;
    for (const tpl of this._templateFields()) {
      if (this._templateSubs.has(tpl)) continue;
      try {
        const promise = this._hass.connection.subscribeMessage(
          (msg) => {
            const result =
              msg && Object.prototype.hasOwnProperty.call(msg, 'result') ? msg.result : msg;
            this._templateResults.set(tpl, result);
            this._scheduleRender();
          },
          { type: 'render_template', template: tpl }
        );
        this._templateSubs.set(tpl, promise);
      } catch (e) {
        console.error(`${CARD_TAG}: subscribeMessage failed for template`, tpl, e);
      }
    }
  }

  _resetTemplateSubs() {
    const subs = Array.from(this._templateSubs.values());
    this._templateSubs.clear();
    this._templateResults.clear();
    for (const p of subs) {
      Promise.resolve(p)
        .then((unsub) => {
          if (typeof unsub === 'function') {
            try {
              unsub();
            } catch (_) {}
          }
        })
        .catch(() => {});
    }
  }

  _getRaw(field) {
    if (!field) return null;
    if (isTemplate(field)) {
      return this._templateResults.has(field) ? this._templateResults.get(field) : null;
    }
    if (!this._hass || !this._hass.states) return null;
    const s = this._hass.states[field];
    return s ? s.state : null;
  }

  // ----- DOM construction (once) -----

  _buildDom() {
    const root = this.shadowRoot;
    root.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = STYLES;
    root.appendChild(style);

    const card = document.createElement('ha-card');
    card.className = 'ups-card';
    root.appendChild(card);
    this._card = card;

    // Header row: the card title plus optional sensors. Filled in by
    // _updateRow(); hidden entirely when there's nothing to show.
    this._header = this._createRow('header');
    card.appendChild(this._header.root);

    const wrap = document.createElement('div');
    wrap.className = 'ups-wrap';
    card.appendChild(wrap);
    this._wrap = wrap;

    // SVG overlay for all connection paths and the SoC arc.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ups-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    wrap.appendChild(svg);
    this._svg = svg;

    // One <g> for the four flow paths.
    const flowGroup = document.createElementNS(SVG_NS, 'g');
    flowGroup.setAttribute('class', 'flow-group');
    svg.appendChild(flowGroup);
    this._flowGroup = flowGroup;

    this._flowPaths = {};
    for (const key of ['pv', 'grid', 'dc', 'ac']) {
      const base = document.createElementNS(SVG_NS, 'path');
      base.setAttribute('class', `flow-base flow-base--${key}`);
      flowGroup.appendChild(base);
      const overlay = document.createElementNS(SVG_NS, 'path');
      overlay.setAttribute('class', `flow-overlay flow-overlay--${key}`);
      flowGroup.appendChild(overlay);
      this._flowPaths[key] = { base, overlay };
    }

    // HTML grid for the four corner nodes (the SVG center cell stays empty;
    // the battery info sits inside it as HTML on top of the SVG arc).
    const grid = document.createElement('div');
    grid.className = 'ups-grid';
    wrap.appendChild(grid);
    this._grid = grid;

    this._cornerNodes = {
      pv: this._createCornerNode('pv', 'tl'),
      grid: this._createCornerNode('grid', 'tr'),
      dc: this._createCornerNode('dc', 'bl'),
      ac: this._createCornerNode('ac', 'br'),
    };
    grid.appendChild(this._cornerNodes.pv.root);
    grid.appendChild(this._cornerNodes.grid.root);
    grid.appendChild(this._cornerNodes.dc.root);
    grid.appendChild(this._cornerNodes.ac.root);

    // Center battery info (overlaid on the SoC arc, which lives in SVG).
    this._battery = this._createBatteryCenter();
    grid.appendChild(this._battery.root);

    // Action-button strip under the diagram. Filled in by _syncButtons().
    const buttons = document.createElement('div');
    buttons.className = 'ups-buttons';
    buttons.style.display = 'none';
    card.appendChild(buttons);
    this._buttons = buttons;

    // Footer row: the last thing in the card, for readings that don't belong
    // to the power flow (and don't fit in a corner).
    this._footer = this._createRow('footer');
    card.appendChild(this._footer.root);
  }

  // One header/footer row: title element on the left, sensor items on the
  // right. The items themselves are created on demand by _syncReadingEls().
  _createRow(kind) {
    const root = document.createElement('div');
    root.className = `ups-row ups-row--${kind}`;
    root.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'ups-row__title';
    root.appendChild(title);

    const sensors = document.createElement('div');
    sensors.className = 'ups-row__sensors';
    sensors.style.display = 'none';
    root.appendChild(sensors);

    return { root, title, sensors };
  }

  _createCornerNode(key, position) {
    const root = document.createElement('div');
    root.className = `corner corner--${key} corner--${position}`;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'corner__icon-wrap';
    const icon = document.createElement('ha-icon');
    icon.className = 'corner__icon';
    iconWrap.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'corner__meta';
    const power = document.createElement('div');
    power.className = 'corner__power';
    const name = document.createElement('div');
    name.className = 'corner__name';
    // Row of extra readings (voltage / current / ...) under the name.
    const readings = document.createElement('div');
    readings.className = 'corner__readings';
    meta.appendChild(power);
    meta.appendChild(name);
    meta.appendChild(readings);

    if (position === 'tl' || position === 'bl') {
      root.appendChild(iconWrap);
      root.appendChild(meta);
    } else {
      root.appendChild(meta);
      root.appendChild(iconWrap);
    }

    root.addEventListener('click', (e) => this._handleCornerClick(key, e));

    return { root, icon, name, power, iconWrap, readings };
  }

  // Fire `hass-more-info` so the lovelace shell opens its standard dialog.
  _fireMoreInfo(entityId) {
    if (!entityId) return;
    const evt = new Event('hass-more-info', { bubbles: true, composed: true });
    evt.detail = { entityId };
    this.dispatchEvent(evt);
  }

  _handleCornerClick(key, event) {
    if (!this._config) return;
    const cfg = this._config[key];
    if (!cfg || !cfg.entity || isTemplate(cfg.entity)) return;
    event.stopPropagation();
    this._fireMoreInfo(cfg.entity);
  }

  _handleBatteryClick(event) {
    if (!this._config) return;
    const id = this._config.unit && this._config.unit.soc_entity;
    if (!id || isTemplate(id)) return;
    event.stopPropagation();
    this._fireMoreInfo(id);
  }

  _createBatteryCenter() {
    const root = document.createElement('div');
    root.className = 'battery-center';
    root.addEventListener('click', (e) => this._handleBatteryClick(e));

    // The SoC arc is rendered as its own inline SVG (separate from the
    // outer connection-paths SVG) so it can scale neatly via CSS.
    const arcSvg = document.createElementNS(SVG_NS, 'svg');
    arcSvg.setAttribute('class', 'soc-svg');
    arcSvg.setAttribute('viewBox', `0 0 ${ARC_VB} ${ARC_VB}`);
    arcSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const arcBg = document.createElementNS(SVG_NS, 'path');
    arcBg.setAttribute('class', 'soc-arc-bg');
    arcBg.setAttribute('d', describeArc(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, ARC_SWEEP_DEG));
    arcSvg.appendChild(arcBg);

    const arcFill = document.createElementNS(SVG_NS, 'path');
    arcFill.setAttribute('class', 'soc-arc-fill');
    arcFill.setAttribute('d', '');
    arcSvg.appendChild(arcFill);

    root.appendChild(arcSvg);

    const content = document.createElement('div');
    content.className = 'battery-content';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'battery-icon-wrap';
    const icon = document.createElement('ha-icon');
    icon.className = 'battery-icon';
    iconWrap.appendChild(icon);

    const soc = document.createElement('div');
    soc.className = 'battery-soc';
    const socUnit = document.createElement('span');
    socUnit.className = 'battery-soc-unit';
    socUnit.textContent = '%';
    soc.appendChild(document.createTextNode(''));
    soc.appendChild(socUnit);

    const state = document.createElement('div');
    state.className = 'battery-state';

    const throughput = document.createElement('div');
    throughput.className = 'battery-throughput';

    const runtime = document.createElement('div');
    runtime.className = 'battery-runtime';

    // Freshness / staleness line: a small clock icon + relative age. Turns
    // into an alert icon and warning color once the newest reading is older
    // than options.stale_threshold.
    const freshness = document.createElement('div');
    freshness.className = 'battery-freshness';
    const freshnessIcon = document.createElement('ha-icon');
    freshnessIcon.className = 'battery-freshness__icon';
    freshnessIcon.setAttribute('icon', 'mdi:clock-outline');
    const freshnessText = document.createElement('span');
    freshnessText.className = 'battery-freshness__text';
    freshness.appendChild(freshnessIcon);
    freshness.appendChild(freshnessText);

    content.appendChild(iconWrap);
    content.appendChild(soc);
    content.appendChild(state);
    content.appendChild(throughput);
    content.appendChild(runtime);
    content.appendChild(freshness);

    root.appendChild(content);

    return {
      root,
      arcSvg,
      arcBg,
      arcFill,
      icon,
      socText: soc.childNodes[0],
      socEl: soc,
      stateEl: state,
      throughputEl: throughput,
      runtimeEl: runtime,
      freshnessWrap: freshness,
      freshnessIcon,
      freshnessEl: freshnessText,
    };
  }

  // ----- Render -----

  _scheduleRender(immediate = false) {
    if (immediate) {
      this._renderQueued = false;
      this._render();
      return;
    }
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  _render() {
    if (!this._initialized || !this._config) return;
    const c = this._config;
    const opt = c.options;

    // Single knob the stylesheet multiplies every base dimension by.
    this.style.setProperty('--ups-scale', String(this._effectiveScale()));

    this._updateRow(this._header, c.header, c.title);
    this._updateRow(this._footer, c.footer, null);

    // Read raw values, clamping where the spec is "import only".
    const pvP = c.pv.entity ? Math.max(0, toNum(this._getRaw(c.pv.entity))) : 0;
    const gridP = Math.max(0, toNum(this._getRaw(c.grid.entity)));
    const dcP = c.dc.entity ? Math.max(0, toNum(this._getRaw(c.dc.entity))) : 0;
    const acP = Math.max(0, toNum(this._getRaw(c.ac.entity)));

    let battP;
    if (c.unit.power_entity) {
      battP = toNum(this._getRaw(c.unit.power_entity));
      if (opt.invert_battery_sign) battP = -battP;
    } else {
      // Charge = sources in - loads out. Sources: grid + pv. Loads: ac + dc.
      battP = gridP + pvP - acP - dcP;
    }

    const soc = c.unit.soc_entity ? clamp(toNum(this._getRaw(c.unit.soc_entity)), 0, 100) : null;
    const runtimeMin = c.display.runtime_entity
      ? toNum(this._getRaw(c.display.runtime_entity))
      : null;
    const chargeMin = c.display.charge_time_entity
      ? toNum(this._getRaw(c.display.charge_time_entity))
      : null;

    // ---- Corner nodes ----
    this._updateCorner('pv', c.pv, pvP, opt.idle_threshold, !!c.pv.entity);
    this._updateCorner('grid', c.grid, gridP, opt.idle_threshold, !!c.grid.entity);
    this._updateCorner('dc', c.dc, dcP, opt.idle_threshold, !!c.dc.entity);
    this._updateCorner('ac', c.ac, acP, opt.idle_threshold, !!c.ac.entity);

    // When only one side has corners, shift the battery toward the empty side
    // so the card doesn't look lopsided. With both / neither side populated,
    // the battery stays centered.
    const hasLeft = !!(c.pv.entity || c.dc.entity);
    const hasRight = !!(c.grid.entity || c.ac.entity);
    this._grid.classList.toggle('no-left', !hasLeft && hasRight);
    this._grid.classList.toggle('no-right', hasLeft && !hasRight);

    // ---- Battery center ----
    const batteryClickable = !!c.unit.soc_entity && !isTemplate(c.unit.soc_entity);
    this._battery.root.classList.toggle('is-clickable', batteryClickable);
    this._battery.icon.setAttribute('icon', this._batteryIconForState(soc, battP, opt.idle_threshold));
    if (soc === null) {
      this._battery.socText.nodeValue = '—';
      this._battery.arcFill.setAttribute('d', '');
    } else {
      this._battery.socText.nodeValue = String(Math.round(soc));
      this._battery.arcFill.setAttribute(
        'd',
        describeArc(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, (ARC_SWEEP_DEG * soc) / 100)
      );
    }

    let stateClass;
    let stateLabel;
    if (battP > opt.idle_threshold) {
      stateClass = 'charge';
      stateLabel = 'charging';
    } else if (battP < -opt.idle_threshold) {
      stateClass = 'discharge';
      stateLabel = 'discharging';
    } else {
      stateClass = 'idle';
      stateLabel = 'idle';
    }
    this._battery.root.classList.remove('state-charge', 'state-discharge', 'state-idle');
    this._battery.root.classList.add(`state-${stateClass}`);

    // Center display lines — each can be hidden via display.show_X, and each
    // can have its content overridden by a (template-aware) string.
    const stateOverride = this._resolveOverride(c.display.state_template);
    const throughputOverride = this._resolveOverride(c.display.throughput_template);
    const runtimeOverride = this._resolveOverride(c.display.runtime_template);

    const defaultThroughput =
      stateClass === 'idle'
        ? ''
        : `${stateClass === 'charge' ? '+' : '−'}${fmtPower(Math.abs(battP))}`;
    let defaultRuntime = '';
    if (stateClass === 'charge' && chargeMin && chargeMin > 0) {
      defaultRuntime = `${fmtRuntime(chargeMin)} to full`;
    } else if (stateClass === 'discharge' && runtimeMin && runtimeMin > 0) {
      defaultRuntime = `${fmtRuntime(runtimeMin)} left`;
    }

    this._setLine(this._battery.stateEl, c.display.show_state, stateOverride, stateLabel);
    this._setLine(
      this._battery.throughputEl,
      c.display.show_throughput,
      throughputOverride,
      defaultThroughput
    );
    this._setLine(
      this._battery.runtimeEl,
      c.display.show_runtime,
      runtimeOverride,
      defaultRuntime
    );

    // SoC level class drives the arc fill color.
    const socLevel =
      soc === null ? 'unknown' : soc > 60 ? 'high' : soc > 20 ? 'medium' : 'low';
    this._battery.root.classList.remove('soc-high', 'soc-medium', 'soc-low', 'soc-unknown');
    this._battery.root.classList.add(`soc-${socLevel}`);

    // ---- Flow paths active state & speed ----
    this._setFlowState('pv', pvP > opt.idle_threshold, pvP, opt.max_power);
    this._setFlowState('grid', gridP > opt.idle_threshold, gridP, opt.max_power);
    this._setFlowState('dc', dcP > opt.idle_threshold, dcP, opt.max_power);
    this._setFlowState('ac', acP > opt.idle_threshold, acP, opt.max_power);

    // ---- Action button strip ----
    this._syncButtons();

    // Recompute path geometry — node positions can shift on resize.
    this._updatePaths();

    // Refresh the staleness line on every hass push as well as on the timer.
    this._updateFreshness();
  }

  _batteryIconForState(soc, battP, idle) {
    const charging = battP > idle;
    const buckets = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    if (soc === null) return 'mdi:battery-unknown';
    let nearest = 100;
    for (const b of buckets) if (soc <= b) { nearest = b; break; }
    if (nearest === 100) return charging ? 'mdi:battery-charging-100' : 'mdi:battery';
    return charging ? `mdi:battery-charging-${nearest}` : `mdi:battery-${nearest}`;
  }

  _updateCorner(key, cfg, power, idle, present) {
    const node = this._cornerNodes[key];
    // When the entity isn't configured, hide the entire corner — and skip the
    // flow path (set in _updatePaths) — so the layout shows nothing at all.
    if (!present) {
      node.root.style.display = 'none';
      node.root.classList.remove('is-active', 'is-clickable');
      node.readings.style.display = 'none';
      return;
    }
    node.root.style.display = '';
    node.icon.setAttribute('icon', cfg.icon);
    node.name.textContent = cfg.name;
    node.power.textContent = fmtPower(power);
    this._updateReadings(node, cfg);
    const active = power > idle;
    node.root.classList.toggle('is-active', active);
    // Clickable only when the entity is a plain entity_id (templates have no
    // single entity to open a more-info dialog for).
    const clickable = !!cfg.entity && !isTemplate(cfg.entity);
    node.root.classList.toggle('is-clickable', clickable);
  }

  // Extra sub-readings under a corner.
  _updateReadings(node, cfg) {
    this._syncReadingEls(node.readings, (cfg && cfg.readings) || [], 'corner__reading');
  }

  // One reading's display text: optional label plus value, with an omitted
  // `unit:` falling back to whatever the sensor reports.
  _readingText(r) {
    let unit = r.unit;
    if (unit === null && !isTemplate(r.entity) && this._hass && this._hass.states) {
      const s = this._hass.states[r.entity];
      const uom = s && s.attributes && s.attributes.unit_of_measurement;
      if (uom) unit = String(uom);
    }
    const value = fmtReading(this._getRaw(r.entity), r.decimals, unit) || '—';
    return r.label ? `${r.label} ${value}` : value;
  }

  // Shared by the corner readings and the header/footer rows: rebuilds the
  // items only when the entities behind them change (so their click handlers
  // stay current), then refreshes every value. Each item opens the sensor's
  // more-info dialog, unless its entity is a template.
  _syncReadingEls(container, list, className) {
    if (list.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';

    const key = list.map((r) => r.entity).join('\u0000');
    if (container._readingKey !== key) {
      container._readingKey = key;
      container.innerHTML = '';
      for (const r of list) {
        const el = document.createElement('div');
        el.className = className;
        if (r.entity && !isTemplate(r.entity)) {
          el.classList.add('is-clickable');
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            this._fireMoreInfo(r.entity);
          });
        }
        container.appendChild(el);
      }
    }

    Array.from(container.children).forEach((el, i) => {
      el.textContent = this._readingText(list[i]);
    });
  }

  // Header / footer row: optional title on the left, sensors on the right.
  // `fallbackTitle` is the top-level `title:`, which a header row inherits
  // when it doesn't set its own — that way the two never render twice.
  _updateRow(row, cfg, fallbackTitle) {
    const title = cfg ? (cfg.title !== null ? cfg.title : fallbackTitle) : fallbackTitle;
    const visible = cfg ? cfg.show : !!fallbackTitle;
    if (!visible) {
      row.root.style.display = 'none';
      return;
    }
    row.root.style.display = '';

    const text = title ? this._resolveOverride(title) : '';
    row.title.textContent = text || '';
    row.title.style.display = text ? '' : 'none';

    this._syncReadingEls(row.sensors, (cfg && cfg.sensors) || [], 'ups-row__sensor');
  }

  _setFlowState(key, active, power, maxPower) {
    const p = this._flowPaths[key];
    if (!p) return;
    p.base.classList.toggle('is-active', active);
    p.overlay.classList.toggle('is-active', active);
    const dur = this._durFromPower(power, maxPower);
    p.overlay.style.setProperty('--flow-dur', `${dur.toFixed(2)}s`);
  }

  _durFromPower(p, maxP) {
    const ratio = clamp(Math.abs(p) / Math.max(1, maxP), 0, 1);
    return ANIM_SLOW_S - (ANIM_SLOW_S - ANIM_FAST_S) * ratio;
  }

  // Set the content of one center display line. Visibility honors `show`;
  // when an override is provided (string or rendered template) it wins over
  // the computed default.
  _setLine(el, show, override, fallback) {
    if (!show) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = '';
    const text = override !== null && override !== undefined ? String(override) : fallback;
    el.textContent = text || '';
  }

  // ----- Freshness / staleness -----

  // Plain entity IDs the card is displaying. Templates are skipped — they
  // don't map to a single state object with a report timestamp.
  _freshnessEntityIds() {
    const c = this._config;
    if (!c) return [];
    return [
      c.pv.entity,
      c.grid.entity,
      c.dc.entity,
      c.ac.entity,
      ...this._readingEntities(),
      c.unit.soc_entity,
      c.unit.power_entity,
      c.display.runtime_entity,
      c.display.charge_time_entity,
    ].filter((f) => f && !isTemplate(f));
  }

  // Newest report time (ms) across the displayed entities. These all come
  // from the same device, so a live integration keeps at least one of them
  // fresh every poll; a dropped one freezes them all together. Entities in
  // an unavailable/unknown state are ignored so flipping offline can't be
  // mistaken for a fresh report.
  _computeFreshnessMs() {
    if (!this._hass || !this._hass.states) return null;
    let newest = null;
    for (const id of this._freshnessEntityIds()) {
      const s = this._hass.states[id];
      if (!s || s.state === 'unavailable' || s.state === 'unknown') continue;
      const ms = entityFreshnessMs(s);
      if (ms !== null && (newest === null || ms > newest)) newest = ms;
    }
    return newest;
  }

  _updateFreshness() {
    if (!this._battery || !this._config) return;

    // --- Card red border: driven ONLY by the battery-level entity going
    // `unavailable`. This is the clean-drop signal (the integration dropped
    // and HA correctly marked the entity offline). The frozen-value case,
    // where the entity keeps its last reading, is caught by the staleness
    // text below instead.
    const socId = this._config.unit.soc_entity;
    let socUnavailable = false;
    if (socId && !isTemplate(socId) && this._hass && this._hass.states) {
      const s = this._hass.states[socId];
      socUnavailable = !!s && s.state === 'unavailable';
    }
    if (this._card) this._card.classList.toggle('is-disconnected', socUnavailable);

    // --- "Updated Xs ago" text + its threshold-driven coloring.
    const wrap = this._battery.freshnessWrap;
    const ids = this._freshnessEntityIds();

    // Nothing to measure (hidden, or every field is a template) -> no line.
    if (!this._config.display.show_last_updated || ids.length === 0) {
      wrap.style.display = 'none';
      wrap.classList.remove('is-stale');
      return;
    }
    wrap.style.display = '';

    const newest = this._computeFreshnessMs();
    if (newest === null) {
      // No usable reading at all — show the worst-case text treatment.
      this._battery.freshnessIcon.setAttribute('icon', 'mdi:clock-alert-outline');
      this._battery.freshnessEl.textContent = 'no data';
      wrap.classList.add('is-stale');
      return;
    }

    const ageSec = (Date.now() - newest) / 1000;
    const stale = ageSec >= this._config.options.stale_threshold;
    this._battery.freshnessEl.textContent = fmtAgo(ageSec);
    this._battery.freshnessIcon.setAttribute(
      'icon',
      stale ? 'mdi:alert-circle-outline' : 'mdi:clock-outline'
    );
    wrap.classList.toggle('is-stale', stale);
  }

  _startFreshnessTimer() {
    if (this._freshnessTimer) return;
    this._freshnessTimer = setInterval(() => this._updateFreshness(), FRESHNESS_TICK_MS);
  }

  _stopFreshnessTimer() {
    if (this._freshnessTimer) {
      clearInterval(this._freshnessTimer);
      this._freshnessTimer = null;
    }
  }

  // ----- Action buttons -----

  // Rebuilds the strip only when the button config changes; row height,
  // on/off state and accent color refresh on every render.
  _syncButtons() {
    if (!this._buttons || !this._config) return;
    const buttons = this._config.buttons;

    if (buttons.length === 0) {
      this._buttons.style.display = 'none';
      this._buttons.innerHTML = '';
      this._buttonEls = [];
      this._buttonsSig = null;
      return;
    }
    this._buttons.style.display = '';

    const sig = JSON.stringify(buttons);
    if (sig !== this._buttonsSig) {
      this._buttonsSig = sig;
      this._buildButtons(buttons);
    }

    const scale = this._effectiveScale();
    const rowH = this._buttonRowHeight(scale);
    // Letting the grid stack the rows (rather than fixing the strip height)
    // keeps the CSS gap — which also scales with --ups-narrow — accounted for.
    this._buttons.style.gridAutoRows = `${rowH}px`;
    // Two rows of three halves each button, so drop to a tighter look.
    this._buttons.classList.toggle('is-compact', rowH < 44 * scale + 0.5);

    buttons.forEach((b, i) => {
      const el = this._buttonEls[i];
      if (!el) return;
      el.classList.toggle('is-on', this._buttonIsOn(b));
      if (b.color) el.style.setProperty('--ups-btn-accent', b.color);
      else el.style.removeProperty('--ups-btn-accent');
    });
  }

  _buildButtons(buttons) {
    this._buttons.innerHTML = '';
    this._buttonEls = buttons.map((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ups-btn';

      const iconEl = document.createElement('ha-icon');
      iconEl.className = 'ups-btn__icon';
      iconEl.setAttribute('icon', b.icon || this._defaultButtonIcon(b));

      const label = document.createElement('span');
      label.className = 'ups-btn__label';
      label.textContent = b.name || this._defaultButtonLabel(b);

      btn.appendChild(iconEl);
      btn.appendChild(label);
      btn.addEventListener('click', (e) => this._handleButtonAction(b, e));
      this._buttons.appendChild(btn);
      return btn;
    });
  }

  _entityDomain(entityId) {
    if (!entityId || !entityId.includes('.')) return null;
    return entityId.split('.')[0];
  }

  _defaultButtonIcon(b) {
    const domain = this._entityDomain(b.entity);
    if (b.entity && domain && (b.action === 'more-info' || b.action === 'toggle')) {
      const s = this._hass && this._hass.states && this._hass.states[b.entity];
      if (s && s.attributes && s.attributes.icon && !isTemplate(b.entity)) {
        return s.attributes.icon;
      }
      const byDomain = {
        switch: 'mdi:toggle-switch',
        input_boolean: 'mdi:toggle-switch',
        light: 'mdi:lightbulb',
        fan: 'mdi:fan',
        lock: 'mdi:lock',
        cover: 'mdi:window-shutter',
      };
      if (byDomain[domain]) return byDomain[domain];
    }
    if (b.action === 'navigate') return 'mdi:arrow-right-circle-outline';
    if (b.action === 'url') return 'mdi:open-in-new';
    if (b.action === 'call-service') return 'mdi:cog-outline';
    return 'mdi:gesture-tap-button';
  }

  // Fall back to a humanized entity object id, then to the action name.
  _defaultButtonLabel(b) {
    if (b.entity && !isTemplate(b.entity)) {
      const tail = b.entity.split('.').slice(1).join('.');
      if (tail) {
        return tail.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
      }
    }
    return b.action;
  }

  _buttonIsOn(b) {
    if (!b.entity || !this._hass || !this._hass.states) return false;
    if (b.action !== 'toggle' && b.action !== 'more-info') return false;
    const s = this._hass.states[b.entity];
    return !!s && s.state === 'on';
  }

  async _handleButtonAction(button, event) {
    if (event) event.stopPropagation();
    if (button.action === 'none') return;
    if (button.confirmation) {
      // Word the prompt after what the button actually does, so a toggle asks
      // "Toggle DC?" instead of the generic "Run DC?".
      const label =
        button.name ||
        button.service ||
        button.entity ||
        button.navigation_path ||
        button.url ||
        button.action;
      const verb = ACTION_VERBS[button.action] || 'Run';
      const text = button.confirmation_text || `${verb} ${label}?`;
      if (!window.confirm(text)) return;
    }

    const hass = this._hass;
    switch (button.action) {
      case 'more-info':
        this._fireMoreInfo(button.entity);
        break;

      case 'toggle': {
        if (!button.entity) return;
        const domain = this._entityDomain(button.entity);
        if (!domain || !hass || typeof hass.callService !== 'function') {
          console.error(`${CARD_TAG}: cannot toggle ${button.entity} — no callService available`);
          return;
        }
        try {
          await hass.callService(domain, 'toggle', { entity_id: button.entity });
        } catch (err) {
          console.error(`${CARD_TAG}: toggle failed for ${button.entity}`, err);
        }
        break;
      }

      case 'call-service': {
        if (!button.service) return;
        const dot = button.service.indexOf('.');
        if (dot <= 0 || dot === button.service.length - 1) {
          console.error(`${CARD_TAG}: invalid service "${button.service}" — expected domain.service`);
          return;
        }
        if (!hass || typeof hass.callService !== 'function') {
          console.error(`${CARD_TAG}: cannot call ${button.service} — no callService available`);
          return;
        }
        const data = button.service_data ? { ...button.service_data } : {};
        // `service: switch.turn_on` + `entity:` is enough on its own.
        if (!data.entity_id && button.entity) data.entity_id = button.entity;
        try {
          await hass.callService(
            button.service.slice(0, dot),
            button.service.slice(dot + 1),
            Object.keys(data).length ? data : undefined
          );
        } catch (err) {
          console.error(`${CARD_TAG}: service call ${button.service} failed`, err);
        }
        break;
      }

      case 'navigate': {
        if (!button.navigation_path) return;
        const evt = new Event('hass-navigate', { bubbles: true, composed: true });
        evt.detail = { path: button.navigation_path };
        this.dispatchEvent(evt);
        break;
      }

      case 'url':
        if (button.url) window.open(button.url, '_blank', 'noopener');
        break;

      default:
        break;
    }
  }

  _updatePaths() {
    if (!this._wrap || !this._svg) return;
    const w = this._wrap.clientWidth;
    const h = this._wrap.clientHeight;
    if (w <= 0 || h <= 0) return;
    this._svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this._svg.setAttribute('width', String(w));
    this._svg.setAttribute('height', String(h));

    const wrapRect = this._wrap.getBoundingClientRect();

    const cornerRect = (key) => {
      const r = this._cornerNodes[key].iconWrap.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - wrapRect.left,
        y: r.top + r.height / 2 - wrapRect.top,
        w: r.width,
        h: r.height,
      };
    };

    const batteryRect = this._battery.arcSvg.getBoundingClientRect();
    const battCenter = {
      x: batteryRect.left + batteryRect.width / 2 - wrapRect.left,
      y: batteryRect.top + batteryRect.height / 2 - wrapRect.top,
    };
    // Effective arc radius in screen pixels (the SVG scales the viewBox).
    const arcScreenR = (Math.min(batteryRect.width, batteryRect.height) / ARC_VB) * ARC_R;

    // Anchor points sit just outside the arc, vertically biased toward the
    // corner that owns the line (inputs above center, outputs below) so each
    // L-path's vertical run is short and the line meets its corner naturally.
    const anchorGap = 6;
    const anchorR = arcScreenR + anchorGap;
    const yBias = arcScreenR * 0.45;
    const anchors = {
      pv: { x: battCenter.x - anchorR, y: battCenter.y - yBias },
      grid: { x: battCenter.x + anchorR, y: battCenter.y - yBias },
      dc: { x: battCenter.x - anchorR, y: battCenter.y + yBias },
      ac: { x: battCenter.x + anchorR, y: battCenter.y + yBias },
    };

    // Each path starts at the inner edge of the corner node (vertically
    // toward the middle row) and ends at the matching anchor. Skip absent
    // corners — their flow lines should be invisible.
    const cornerRadius = 18;
    for (const key of ['pv', 'grid', 'dc', 'ac']) {
      const cfg = this._config[key];
      const present = !!(cfg && cfg.entity);
      const p = this._flowPaths[key];
      if (!present) {
        p.base.style.display = 'none';
        p.overlay.style.display = 'none';
        continue;
      }
      p.base.style.display = '';
      p.overlay.style.display = '';
      const r = cornerRect(key);
      const onTop = key === 'pv' || key === 'grid';
      const start = { x: r.x, y: r.y + (onTop ? r.h / 2 : -r.h / 2) };
      const d = buildVThenHPath(start, anchors[key], cornerRadius);
      p.base.setAttribute('d', d);
      p.overlay.setAttribute('d', d);
    }
  }

  // ----- Resize handling -----

  _setupResizeObserver() {
    if (this._resizeObserver || typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._updatePaths();
      }, 100);
    });
    this._resizeObserver.observe(this);
  }

  _teardownResizeObserver() {
    if (this._resizeObserver) {
      try {
        this._resizeObserver.disconnect();
      } catch (_) {}
      this._resizeObserver = null;
    }
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
  }
}

const STYLES = `
:host {
  display: block;
  /* --ups-scale is set inline from options.size × options.scale. Every
     dimension below is calc(<base> * var(--ups-s)), so one number resizes
     the whole card. The narrow-column rules at the bottom of the sheet
     re-derive --ups-s with an extra factor.
     --ups-t is the *text* knob: it never goes below 1, so shrinking the card
     (compact, or a small scale:) tightens the layout without making the
     numbers hard to read. It only follows the narrow-column factor, where a
     thin column genuinely has no room for full-size text.
     --ups-b sizes the big SoC readout, which lives inside the battery circle
     and so has to stay roughly proportional to it — it floors at 0.85. */
  --ups-scale: 1;
  --ups-s: calc(var(--ups-scale) * 1);
  --ups-t: max(1, var(--ups-scale));
  --ups-b: max(0.85, var(--ups-scale));
  /* Makes the card its own query container so the narrow shrink follows the
     column the card sits in, not the browser window. */
  container-type: inline-size;
}
.ups-card {
  padding: calc(16px * var(--ups-s));
  box-sizing: border-box;
}
/* Header / footer rows. The header carries the card title (and, when a
   "header:" block is configured, a row of extra sensors); the footer is the
   same row pinned to the bottom of the card. Both use --ups-t so their text
   stays readable at compact size. */
.ups-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: calc(2px * var(--ups-s)) calc(12px * var(--ups-s));
  padding: 0 4px;
}
.ups-row__title {
  font-size: calc(1.1rem * var(--ups-t));
  font-weight: 500;
  color: var(--primary-text-color, #212121);
}
.ups-row__sensors {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: calc(2px * var(--ups-s)) calc(12px * var(--ups-s));
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.ups-row__sensor {
  font-size: calc(0.8rem * var(--ups-t));
  color: var(--secondary-text-color, #727272);
  line-height: 1.3;
  white-space: nowrap;
}
.ups-row__sensor.is-clickable { cursor: pointer; }
.ups-row__sensor.is-clickable:hover { color: var(--primary-text-color, #212121); }
.ups-row--header {
  margin-bottom: calc(12px * var(--ups-s));
}
.ups-row--footer {
  margin-top: calc(10px * var(--ups-s));
  padding-top: calc(8px * var(--ups-s));
  border-top: 1px solid var(--divider-color, rgba(127, 127, 127, 0.32));
}
.ups-row--footer .ups-row__title {
  font-size: calc(0.9rem * var(--ups-t));
}
.ups-wrap {
  position: relative;
  width: 100%;
  min-height: calc(320px * var(--ups-s));
}
.ups-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
  overflow: visible;
}

/* Flow paths --------------------------------------------------------- */
.flow-base {
  fill: none;
  stroke: var(--divider-color, rgba(127, 127, 127, 0.35));
  stroke-width: calc(3px * var(--ups-s));
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke 0.3s ease, opacity 0.3s ease;
}
.flow-overlay {
  fill: none;
  stroke-width: calc(3.5px * var(--ups-s));
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 18 220;
  opacity: 0;
  transition: opacity 0.3s ease, stroke 0.3s ease;
}
.flow-overlay.is-active { opacity: 1; }

.flow-overlay--pv.is-active   { stroke: var(--success-color, #4caf50); animation: flow-in  var(--flow-dur, 2s) linear infinite; }
.flow-overlay--grid.is-active { stroke: var(--info-color, var(--primary-color, #03a9f4)); animation: flow-in  var(--flow-dur, 2s) linear infinite; }
.flow-overlay--ac.is-active   { stroke: var(--warning-color, #ff9800); animation: flow-out var(--flow-dur, 2s) linear infinite; }
.flow-overlay--dc.is-active   { stroke: var(--state-binary-sensor-power-on-color, #64b5f6); animation: flow-out var(--flow-dur, 2s) linear infinite; }

@keyframes flow-in  { from { stroke-dashoffset: 240; } to { stroke-dashoffset: 0; } }
@keyframes flow-out { from { stroke-dashoffset: 0; }   to { stroke-dashoffset: 240; } }

/* Grid layout -------------------------------------------------------- */
.ups-grid {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1.8fr 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "pv     .       grid"
    ".      battery .   "
    "dc     .       ac  ";
  align-items: center;
  z-index: 1;
  width: 100%;
  min-height: calc(320px * var(--ups-s));
  gap: calc(8px * var(--ups-s));
}
.corner--tl { grid-area: pv; justify-self: start; }
.corner--tr { grid-area: grid; justify-self: end; }
.corner--bl { grid-area: dc; justify-self: start; }
.corner--br { grid-area: ac; justify-self: end; }
.battery-center { grid-area: battery; justify-self: center; align-self: center; }

/* Balance the layout when only one side has corners: shift the battery
   toward the empty side so the card stops looking lopsided. */
.ups-grid.no-left {
  grid-template-columns: 3fr 0.5fr 1fr;
}
.ups-grid.no-left .battery-center {
  grid-column: 1 / 2;
  grid-row: 1 / 4;
  justify-self: center;
  align-self: center;
}
.ups-grid.no-right {
  grid-template-columns: 1fr 0.5fr 3fr;
}
.ups-grid.no-right .battery-center {
  grid-column: 3 / 4;
  grid-row: 1 / 4;
  justify-self: center;
  align-self: center;
}

/* Corner nodes ------------------------------------------------------- */
.corner {
  display: inline-flex;
  align-items: center;
  gap: calc(10px * var(--ups-s));
  min-width: 0;
  max-width: 100%;
}
.corner.is-clickable { cursor: pointer; }
.corner.is-clickable:hover .corner__icon-wrap {
  box-shadow: 0 0 0 2px var(--divider-color, rgba(127, 127, 127, 0.4));
}
.corner__icon-wrap {
  width: calc(44px * var(--ups-s));
  height: calc(44px * var(--ups-s));
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--secondary-background-color, rgba(127, 127, 127, 0.14));
  flex-shrink: 0;
  transition: background 0.3s ease, color 0.3s ease, box-shadow 0.3s ease;
}
.corner__icon {
  --mdc-icon-size: calc(24px * var(--ups-s));
  color: var(--secondary-text-color, #aaa);
  transition: color 0.3s ease;
}
.corner__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.corner--tr .corner__meta,
.corner--br .corner__meta { align-items: flex-end; text-align: right; }
.corner--tl .corner__meta,
.corner--bl .corner__meta { align-items: flex-start; text-align: left; }
.corner__power {
  font-size: calc(1.15rem * var(--ups-t));
  font-weight: 700;
  color: var(--primary-text-color, #fff);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.corner__name {
  font-size: calc(0.78rem * var(--ups-t));
  color: var(--secondary-text-color, #999);
  letter-spacing: 0.02em;
  margin-top: 1px;
}

/* Extra per-corner readings (voltage, current, temperature, ...). Shown as a
   compact row under the corner name; each one is clickable when it maps to a
   real entity. */
.corner__readings {
  display: flex;
  flex-wrap: wrap;
  gap: calc(3px * var(--ups-s)) calc(8px * var(--ups-s));
  margin-top: calc(3px * var(--ups-s));
  font-variant-numeric: tabular-nums;
}
.corner__reading {
  font-size: calc(0.72rem * var(--ups-t));
  color: var(--secondary-text-color, #999);
  line-height: 1.2;
  white-space: nowrap;
}
.corner__reading.is-clickable { cursor: pointer; }
.corner__reading.is-clickable:hover { color: var(--primary-text-color, #fff); }
.corner.is-absent .corner__power { color: var(--secondary-text-color, #999); }

/* Active highlighting matches the flow color for each direction. */
.corner--pv.is-active   .corner__icon-wrap { background: var(--success-color, #4caf50); }
.corner--grid.is-active .corner__icon-wrap { background: var(--info-color, var(--primary-color, #03a9f4)); }
.corner--ac.is-active   .corner__icon-wrap { background: var(--warning-color, #ff9800); }
.corner--dc.is-active   .corner__icon-wrap { background: var(--state-binary-sensor-power-on-color, #64b5f6); }
.corner.is-active .corner__icon { color: #ffffff; }

/* Battery center ---------------------------------------------------- */
.battery-center {
  position: relative;
  width: calc(200px * var(--ups-s));
  height: calc(200px * var(--ups-s));
  display: flex;
  align-items: center;
  justify-content: center;
}
.battery-center.is-clickable { cursor: pointer; }
.soc-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.soc-arc-bg {
  fill: none;
  stroke: var(--divider-color, rgba(127, 127, 127, 0.28));
  stroke-width: ${ARC_STROKE};
  stroke-linecap: round;
}
.soc-arc-fill {
  fill: none;
  stroke: var(--success-color, #4caf50);
  stroke-width: ${ARC_STROKE};
  stroke-linecap: round;
  transition: d 0.6s ease, stroke 0.3s ease;
}
.battery-center.soc-medium .soc-arc-fill { stroke: var(--warning-color, #ff9800); }
.battery-center.soc-low .soc-arc-fill    { stroke: var(--error-color, var(--label-badge-red, #f44336)); }
.battery-center.soc-unknown .soc-arc-fill { stroke: var(--secondary-text-color, #999); }

.battery-content {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  text-align: center;
  width: 70%;
}
.battery-icon-wrap {
  margin-bottom: calc(4px * var(--ups-s));
}
.battery-icon {
  --mdc-icon-size: calc(26px * var(--ups-s));
  color: var(--success-color, #4caf50);
  transition: color 0.3s ease;
}
.battery-center.soc-medium .battery-icon { color: var(--warning-color, #ff9800); }
.battery-center.soc-low .battery-icon    { color: var(--error-color, var(--label-badge-red, #f44336)); }
.battery-center.soc-unknown .battery-icon { color: var(--secondary-text-color, #999); }

.battery-soc {
  font-size: calc(2.6rem * var(--ups-b));
  font-weight: 700;
  color: var(--primary-text-color, #fff);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.battery-soc-unit {
  font-size: calc(1rem * var(--ups-t));
  margin-left: 2px;
  color: var(--secondary-text-color, #999);
  font-weight: 500;
}
.battery-state {
  font-size: calc(0.8rem * var(--ups-t));
  color: var(--secondary-text-color, #999);
  text-transform: capitalize;
  margin-top: calc(4px * var(--ups-s));
  letter-spacing: 0.03em;
}
.battery-center.state-charge .battery-state    { color: var(--success-color, #4caf50); }
.battery-center.state-discharge .battery-state { color: var(--warning-color, #ff9800); }
.battery-throughput {
  font-size: calc(0.85rem * var(--ups-t));
  font-weight: 600;
  color: var(--secondary-text-color, #999);
  margin-top: calc(2px * var(--ups-s));
  font-variant-numeric: tabular-nums;
  min-height: 1.1em;
}
.battery-center.state-charge .battery-throughput    { color: var(--success-color, #4caf50); }
.battery-center.state-discharge .battery-throughput { color: var(--warning-color, #ff9800); }
.battery-runtime {
  font-size: calc(0.78rem * var(--ups-t));
  color: var(--secondary-text-color, #999);
  margin-top: calc(2px * var(--ups-s));
  font-variant-numeric: tabular-nums;
  min-height: 1em;
}
.battery-freshness {
  display: inline-flex;
  align-items: center;
  gap: calc(3px * var(--ups-s));
  font-size: calc(0.72rem * var(--ups-t));
  color: var(--secondary-text-color, #999);
  margin-top: calc(4px * var(--ups-s));
  font-variant-numeric: tabular-nums;
  min-height: 1em;
  transition: color 0.3s ease;
}
.battery-freshness__icon {
  --mdc-icon-size: calc(13px * var(--ups-s));
  color: inherit;
}
.battery-freshness.is-stale {
  color: var(--error-color, var(--label-badge-red, #f44336));
  font-weight: 600;
}

/* Disconnected: the battery-level entity is unavailable. Ring the card and
   dim the (now-meaningless) readings so a dropped unit is obvious at a glance
   from the dashboard. This is separate from the "Xs ago" text staleness. */
.ups-card.is-disconnected {
  box-shadow: inset 0 0 0 2px var(--error-color, var(--label-badge-red, #f44336));
}
.ups-card.is-disconnected .corner__power,
.ups-card.is-disconnected .battery-soc,
.ups-card.is-disconnected .battery-state,
.ups-card.is-disconnected .battery-throughput,
.ups-card.is-disconnected .battery-runtime {
  opacity: 0.5;
  transition: opacity 0.3s ease;
}

/* Action buttons ------------------------------------------------------
   Three per row, in a strip of fixed total height: a single row of buttons
   fills the strip, two rows split it in half. The strip height and the
   compact flag are set inline from _syncButtons(). */
.ups-buttons {
  display: grid;
  grid-template-columns: repeat(${BUTTON_COLS}, 1fr);
  grid-auto-rows: 1fr;
  gap: calc(8px * var(--ups-s));
  margin-top: calc(8px * var(--ups-s));
}
.ups-btn {
  appearance: none;
  -webkit-appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: calc(6px * var(--ups-s));
  min-width: 0;
  margin: 0;
  padding: 0 calc(8px * var(--ups-s));
  border: none;
  border-radius: calc(8px * var(--ups-s));
  background: var(--secondary-background-color, rgba(127, 127, 127, 0.14));
  color: var(--primary-text-color, #fff);
  font-family: inherit;
  font-size: calc(0.82rem * var(--ups-t));
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}
.ups-btn:hover { background: rgba(127, 127, 127, 0.26); }
.ups-btn:active { transform: translateY(1px); }
.ups-btn__icon {
  --mdc-icon-size: calc(20px * var(--ups-s));
  flex-shrink: 0;
  color: var(--secondary-text-color, #999);
  transition: color 0.2s ease;
}
.ups-btn__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Toggle / more-info buttons bound to an entity light up while it is on. */
.ups-btn.is-on {
  box-shadow: inset 0 0 0 2px var(--ups-btn-accent, var(--primary-color, #03a9f4));
}
.ups-btn.is-on .ups-btn__icon {
  color: var(--ups-btn-accent, var(--primary-color, #03a9f4));
}
/* Half-height buttons (two rows of three) get tighter type. */
.ups-buttons.is-compact .ups-btn { font-size: calc(0.72rem * var(--ups-t)); }
.ups-buttons.is-compact .ups-btn__icon { --mdc-icon-size: calc(16px * var(--ups-s)); }

/* Responsive ---------------------------------------------------------
   A narrow *column* shrinks the whole card through the same --ups-s knob
   instead of overriding each dimension by hand. The host is the query
   container (see :host above), so the container query keys on the card's own
   width rather than the window's. The viewport-based rule is only useful where
   container queries are unsupported, so it is gated behind @supports to keep it
   from shrinking wide cards in a small window. */
@supports not (container-type: inline-size) {
  @media (max-width: ${NARROW_BREAKPOINT}px) {
    :host {
      --ups-s: calc(var(--ups-scale) * ${NARROW_FACTOR});
      --ups-t: calc(max(1, var(--ups-scale)) * ${NARROW_FACTOR});
      --ups-b: calc(max(0.85, var(--ups-scale)) * ${NARROW_FACTOR});
    }
    .ups-grid { grid-template-columns: 1fr 1.4fr 1fr; }
  }
}
@container (max-width: ${NARROW_BREAKPOINT}px) {
  .ups-card {
    --ups-s: calc(var(--ups-scale) * ${NARROW_FACTOR});
    --ups-t: calc(max(1, var(--ups-scale)) * ${NARROW_FACTOR});
    --ups-b: calc(max(0.85, var(--ups-scale)) * ${NARROW_FACTOR});
  }
  .ups-grid { grid-template-columns: 1fr 1.4fr 1fr; }
}
`;

customElements.define(CARD_TAG, IntegratedUpsFlowCard);

/* =========================================================================
 * Visual editor — exposes the YAML schema as a ha-form so the card can be
 * added and tuned from the Lovelace UI without writing YAML.
 *
 * ha-form is provided by the Home Assistant frontend. We just render one,
 * give it our schema + the current config as `data`, and forward its
 * `value-changed` event as a `config-changed` event the Lovelace editor
 * pipeline understands.
 * ========================================================================= */

const ENTITY_SELECTOR = { entity: { filter: { domain: 'sensor' } } };
const CONTROL_ENTITY_SELECTOR = { entity: {} };
const TEMPLATE_SELECTOR = { template: {} };

// ha-form has no repeatable list, so the editor exposes fixed slots instead:
// `<corner>.reading1_*` / `.reading2_*` for extra readings, `header.sensor1_*`
// / `footer.sensor1_*` for the row sensors, and top-level `button1`..`button6`
// for the button strip. configToFormSlots / formSlotsToConfig translate between
// those slots and the YAML arrays.
const CORNER_KEYS = ['pv', 'grid', 'dc', 'ac'];
const ROW_KEYS = ['header', 'footer'];
const MAX_EDITOR_READINGS = 2;
const MAX_EDITOR_SENSORS = 4;
const MAX_EDITOR_BUTTONS = 6;

// Top-level field labels (shown on the form input)
const EDITOR_LABELS = {
  title: 'Card title',
  pv: 'PV input (top-left)',
  grid: 'Grid input (top-right)',
  dc: 'DC output (bottom-left)',
  ac: 'AC output (bottom-right)',
  unit: 'Battery (center)',
  display: 'Center display lines',
  options: 'Options',
  entity: 'Entity',
  name: 'Display name',
  icon: 'Icon',
  soc_entity: 'Battery level (state of charge)',
  runtime_entity: 'Runtime remaining sensor (minutes, while discharging)',
  charge_time_entity: 'Time-to-full sensor (minutes, while charging)',
  power_entity: 'Battery power sensor (± W, optional)',
  show_state: 'Show charging / discharging / idle label',
  show_throughput: 'Show battery throughput (± W)',
  show_runtime: 'Show estimated runtime',
  show_last_updated: 'Show last-updated / staleness indicator',
  state_template: 'Override the state label',
  throughput_template: 'Override the throughput line',
  runtime_template: 'Override the runtime line',
  idle_threshold: 'Idle threshold (W)',
  max_power: 'Max power for animation scaling (W)',
  stale_threshold: 'Stale threshold (seconds)',
  invert_battery_sign: 'Invert sign of battery power sensor',
  size: 'Card size',
  scale: 'Fine-tune scale (multiplier)',
  action: 'Action on tap',
  service: 'Service (domain.service)',
  service_data: 'Service data',
  navigation_path: 'Navigation path',
  url: 'URL to open',
  color: 'Accent color',
  confirmation: 'Ask for confirmation first',
  confirmation_text: 'Confirmation text',
  header: 'Header row',
  footer: 'Footer row',
  show: 'Show this row',
};

// Per-field helper text rendered under the input.
const EDITOR_HELPERS = {
  title: 'Optional header shown at the top of the card.',
  entity: 'A sensor reading watts. Switch to YAML if you need a Jinja template here.',
  soc_entity: 'Optional, but recommended. Without it the SoC arc and percentage are blank.',
  runtime_entity:
    "Reports time remaining while discharging (e.g. BLUETTI's battery_time_in_minutes). Reads 0 when not discharging.",
  charge_time_entity:
    "Reports time to full while charging (e.g. BLUETTI's full_charge_time_in_minutes). When set, the runtime line shows 'Xh Ym to full' during charging and 'Xh Ym left' during discharging.",
  power_entity:
    'Advanced. Most integrations do not expose this directly — leave empty and the card will derive battery throughput as (PV + Grid) − (AC + DC). Set only if your integration provides a single ± W battery sensor.',
  state_template:
    'Plain string or Jinja template. Empty = use the default (charging / discharging / idle).',
  throughput_template:
    'Plain string or Jinja template. Empty = use the default (+1.10 kW / −0.35 kW).',
  runtime_template:
    'Plain string or Jinja template. Empty = use the default runtime line (charge-time or runtime, see above).',
  idle_threshold:
    'Power values below this are treated as no flow (line stays gray). Default 5 W.',
  max_power:
    'Wattage that maps to the fastest dot animation. Higher wattages clamp to this; lower wattages slow proportionally. Default 2600 W.',
  show_last_updated:
    'Shows how long ago the displayed entities last reported. Useful when an integration silently drops and entities keep their last value instead of going unavailable.',
  stale_threshold:
    'When the newest reading is older than this many seconds, the "Xs ago" text turns red. Text color only — the card\'s red border is separate, and appears when the battery-level entity goes unavailable. Default 300 s.',
  invert_battery_sign:
    "Only relevant when 'Battery power sensor' above is set. Toggle on if that sensor reports discharge as positive (some integrations).",
  size:
    'Scales the whole card — corners, battery arc, fonts and height together. Compact is about 70% of normal and reserves fewer dashboard rows.',
  scale:
    'Optional multiplier on top of the preset above. 0.8 is 20% smaller than the preset; 1 leaves it alone.',
  action:
    'more-info opens the entity dialog, toggle switches it on/off, call-service runs the service below, navigate jumps to a dashboard path, url opens a link.',
  service:
    'Service to call, written as domain.service (e.g. switch.turn_on). Leave entity above set and it is passed automatically.',
  service_data:
    'Extra service data as key/value pairs. The entity_id is filled in from the entity field unless you set it here.',
  navigation_path:
    'Dashboard path to jump to, e.g. /lovelace/energy or /config/devices.',
  url: 'Full https:// link to open in a new tab.',
  color:
    'Accent color for this button (hex or CSS color). Used for the icon and the "on" outline.',
  confirmation:
    'Shows a confirm prompt before running the action. Worth enabling for anything that turns the unit off.',
  confirmation_text:
    'Custom prompt text. Leave empty and the card asks using the action, e.g. "Toggle DC?" or "Run switch.turn_on?".',
  header:
    'A line above the diagram: the card title on the left, extra sensors on the right. Hiding it also hides the card title.',
  footer:
    'A line at the bottom of the card for sensors that do not belong to the power flow (room temperature, firmware, ...).',
  show: 'Turn this off to hide the row without deleting the sensors behind it.',
};

// Labels/helpers for the per-corner reading slots — generated because the same
// slot names are reused inside every corner section.
for (let i = 1; i <= MAX_EDITOR_READINGS; i++) {
  EDITOR_LABELS[`reading${i}_entity`] = `Reading ${i} — sensor`;
  EDITOR_LABELS[`reading${i}_label`] = `Reading ${i} — prefix label`;
  EDITOR_LABELS[`reading${i}_unit`] = `Reading ${i} — unit`;
  EDITOR_LABELS[`reading${i}_decimals`] = `Reading ${i} — decimal places`;
  EDITOR_HELPERS[`reading${i}_entity`] =
    "Shown as a small line under the corner name. Clicking it opens this sensor's more-info dialog.";
  EDITOR_HELPERS[`reading${i}_label`] =
    'Optional text in front of the value, e.g. "PV" so it reads "PV 231.4 V". Leave empty to show just the number.';
  EDITOR_HELPERS[`reading${i}_unit`] =
    'Leave empty to use whatever unit the sensor itself reports.';
  EDITOR_HELPERS[`reading${i}_decimals`] =
    'Leave empty to default to 1 decimal place.';
}

// Same for the header/footer sensor slots (shared by both rows).
for (let i = 1; i <= MAX_EDITOR_SENSORS; i++) {
  EDITOR_LABELS[`sensor${i}_entity`] = `Sensor ${i} — entity`;
  EDITOR_LABELS[`sensor${i}_label`] = `Sensor ${i} — prefix label`;
  EDITOR_LABELS[`sensor${i}_unit`] = `Sensor ${i} — unit`;
  EDITOR_LABELS[`sensor${i}_decimals`] = `Sensor ${i} — decimal places`;
  EDITOR_HELPERS[`sensor${i}_entity`] =
    "Shown in the row. Clicking it opens this sensor's more-info dialog.";
  EDITOR_HELPERS[`sensor${i}_label`] =
    'Optional text in front of the value, e.g. "Room" so it reads "Room 21.5 °C".';
  EDITOR_HELPERS[`sensor${i}_unit`] =
    'Leave empty to use whatever unit the sensor itself reports.';
  EDITOR_HELPERS[`sensor${i}_decimals`] =
    'Leave empty to default to 1 decimal place.';
}

// Build the form schema dynamically so override fields only appear when their
// corresponding toggle is on, and `invert_battery_sign` is only offered when
// a `power_entity` is configured.
// YAML stores extra readings and buttons as arrays; ha-form can't render a
// repeatable list, so the editor works with fixed slots. These two helpers
// convert in each direction and are kept idempotent so either form can be fed
// back into the other.
function configToFormSlots(config) {
  const c = { ...(config || {}) };

  for (const key of CORNER_KEYS) {
    if (!c[key] || typeof c[key] !== 'object') continue;
    const corner = { ...c[key] };
    // Only re-expand from the array when the array is present. Feeding an
    // already-expanded config back in must keep what the user typed.
    if (Array.isArray(corner.readings)) {
      for (let i = 0; i < MAX_EDITOR_READINGS; i++) {
        const r = corner.readings[i] || {};
        corner[`reading${i + 1}_entity`] = r.entity ?? '';
        corner[`reading${i + 1}_label`] = r.label ?? '';
        corner[`reading${i + 1}_unit`] = r.unit ?? '';
        corner[`reading${i + 1}_decimals`] = Number.isFinite(r.decimals) ? r.decimals : undefined;
      }
      delete corner.readings;
    }
    for (let i = 1; i <= MAX_EDITOR_READINGS; i++) {
      if (corner[`reading${i}_entity`] === undefined) corner[`reading${i}_entity`] = '';
    }
    c[key] = corner;
  }

  // Header / footer rows get the same slot treatment. `show` is materialised
  // as a real boolean so the checkbox reflects the default (shown) even when
  // the block is absent from the YAML.
  for (const key of ROW_KEYS) {
    const row = c[key] && typeof c[key] === 'object' ? { ...c[key] } : {};
    if (Array.isArray(row.sensors)) {
      for (let i = 0; i < MAX_EDITOR_SENSORS; i++) {
        const s = row.sensors[i] || {};
        row[`sensor${i + 1}_entity`] = s.entity ?? '';
        row[`sensor${i + 1}_label`] = s.label ?? '';
        row[`sensor${i + 1}_unit`] = s.unit ?? '';
        row[`sensor${i + 1}_decimals`] = Number.isFinite(s.decimals) ? s.decimals : undefined;
      }
      delete row.sensors;
    }
    if (row.show === undefined) row.show = true;
    c[key] = row;
  }

  const buttons = Array.isArray(c.buttons) ? c.buttons : null;
  for (let i = 0; i < MAX_EDITOR_BUTTONS; i++) {
    const key = `button${i + 1}`;
    if (buttons) c[key] = { ...(buttons[i] || {}) };
    else if (!c[key] || typeof c[key] !== 'object') c[key] = {};
  }
  if (buttons) delete c.buttons;

  return c;
}

function formSlotsToConfig(config) {
  const c = { ...(config || {}) };

  for (const key of CORNER_KEYS) {
    if (!c[key] || typeof c[key] !== 'object') continue;
    const corner = { ...c[key] };
    const readings = [];
    for (let i = 1; i <= MAX_EDITOR_READINGS; i++) {
      const entity = corner[`reading${i}_entity`];
      const label = corner[`reading${i}_label`];
      const unit = corner[`reading${i}_unit`];
      const decimals = corner[`reading${i}_decimals`];
      delete corner[`reading${i}_entity`];
      delete corner[`reading${i}_label`];
      delete corner[`reading${i}_unit`];
      delete corner[`reading${i}_decimals`];
      if (!entity) continue;
      const r = { entity };
      if (label) r.label = label;
      if (unit) r.unit = unit;
      if (Number.isFinite(decimals)) r.decimals = decimals;
      readings.push(r);
    }
    if (readings.length) corner.readings = readings;
    else delete corner.readings;
    c[key] = corner;
  }

  for (const key of ROW_KEYS) {
    if (!c[key] || typeof c[key] !== 'object') continue;
    const row = { ...c[key] };
    const sensors = [];
    for (let i = 1; i <= MAX_EDITOR_SENSORS; i++) {
      const entity = row[`sensor${i}_entity`];
      const label = row[`sensor${i}_label`];
      const unit = row[`sensor${i}_unit`];
      const decimals = row[`sensor${i}_decimals`];
      delete row[`sensor${i}_entity`];
      delete row[`sensor${i}_label`];
      delete row[`sensor${i}_unit`];
      delete row[`sensor${i}_decimals`];
      if (!entity) continue;
      const s = { entity };
      if (label) s.label = label;
      if (unit) s.unit = unit;
      if (Number.isFinite(decimals)) s.decimals = decimals;
      sensors.push(s);
    }
    if (sensors.length) row.sensors = sensors;
    else delete row.sensors;
    if (!row.title) delete row.title;
    // Shown is the default, so only an unchecked box is worth writing to YAML.
    if (row.show !== false) delete row.show;
    // Never leave an empty `header:` / `footer:` block behind.
    if (Object.keys(row).length) c[key] = row;
    else delete c[key];
  }

  const buttons = [];
  for (let i = 1; i <= MAX_EDITOR_BUTTONS; i++) {
    const slot = c[`button${i}`];
    delete c[`button${i}`];
    if (!slot || typeof slot !== 'object') continue;
    const b = {};
    for (const [k, v] of Object.entries(slot)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      b[k] = v;
    }
    if (Object.keys(b).length === 0) continue;
    buttons.push(b);
  }
  if (buttons.length) c.buttons = buttons;
  else delete c.buttons;

  return c;
}

// One button slot. The fields shown depend on the chosen action, so a
// call-service button isn't offered a navigation path and vice versa.
function buttonSection(n, b) {
  const action =
    b.action ||
    (b.service
      ? 'call-service'
      : b.navigation_path
        ? 'navigate'
        : b.url
          ? 'url'
          : b.entity
            ? 'more-info'
            : 'toggle');

  const schema = [
    { name: 'name', selector: { text: {} } },
    { name: 'icon', selector: { icon: {} } },
    { name: 'entity', selector: CONTROL_ENTITY_SELECTOR },
    {
      name: 'action',
      selector: {
        select: { mode: 'dropdown', options: BUTTON_ACTIONS.filter((a) => a !== 'none') },
      },
    },
  ];
  if (action === 'call-service') {
    schema.push({ name: 'service', selector: { text: {} } });
    schema.push({ name: 'service_data', selector: { object: {} } });
  }
  if (action === 'navigate') {
    schema.push({ name: 'navigation_path', selector: { text: {} } });
  }
  if (action === 'url') {
    schema.push({ name: 'url', selector: { text: {} } });
  }
  schema.push({ name: 'color', selector: { text: {} } });
  schema.push({ name: 'confirmation', selector: { boolean: {} } });
  if (b.confirmation) {
    schema.push({ name: 'confirmation_text', selector: { text: {} } });
  }

  return { name: `button${n}`, type: 'expandable', title: `Button ${n}`, schema };
}

function buildEditorSchema(config) {
  const c = config || {};
  const u = c.unit || {};
  const d = c.display || {};

  const displaySchema = [];
  displaySchema.push({ name: 'show_state', selector: { boolean: {} } });
  if (d.show_state !== false) {
    displaySchema.push({ name: 'state_template', selector: TEMPLATE_SELECTOR });
  }
  displaySchema.push({ name: 'show_throughput', selector: { boolean: {} } });
  if (d.show_throughput !== false) {
    displaySchema.push({ name: 'throughput_template', selector: TEMPLATE_SELECTOR });
  }
  displaySchema.push({ name: 'show_runtime', selector: { boolean: {} } });
  if (d.show_runtime !== false) {
    displaySchema.push({ name: 'runtime_entity', selector: ENTITY_SELECTOR });
    displaySchema.push({ name: 'charge_time_entity', selector: ENTITY_SELECTOR });
    displaySchema.push({ name: 'runtime_template', selector: TEMPLATE_SELECTOR });
  }
  displaySchema.push({ name: 'show_last_updated', selector: { boolean: {} } });

  const optionsSchema = [
    {
      name: 'size',
      selector: { select: { mode: 'dropdown', options: ['compact', 'normal', 'large'] } },
    },
    {
      name: 'scale',
      selector: { number: { min: 0.4, max: 2.2, step: 0.05, mode: 'slider' } },
    },
    {
      name: 'idle_threshold',
      selector: {
        number: { min: 0, max: 200, step: 1, mode: 'box', unit_of_measurement: 'W' },
      },
    },
    {
      name: 'max_power',
      selector: {
        number: { min: 100, max: 20000, step: 100, mode: 'box', unit_of_measurement: 'W' },
      },
    },
    {
      name: 'stale_threshold',
      selector: {
        number: { min: 10, max: 3600, step: 5, mode: 'box', unit_of_measurement: 's' },
      },
    },
  ];
  if (u.power_entity) {
    optionsSchema.push({ name: 'invert_battery_sign', selector: { boolean: {} } });
  }

  // Corner sections carry the entity/name/icon fields plus the extra-reading
  // slots. A slot only appears once the previous one names a sensor.
  const cornerSections = [
    ['pv', 'PV input (top-left)'],
    ['grid', 'Grid input (top-right)'],
    ['dc', 'DC output (bottom-left)'],
    ['ac', 'AC output (bottom-right)'],
  ].map(([key, title]) => {
    const corner = c[key] || {};
    const schema = [
      { name: 'entity', selector: ENTITY_SELECTOR },
      { name: 'name', selector: { text: {} } },
      { name: 'icon', selector: { icon: {} } },
    ];
    for (let i = 1; i <= MAX_EDITOR_READINGS; i++) {
      if (i > 1 && !corner[`reading${i - 1}_entity`]) break;
      schema.push({ name: `reading${i}_entity`, selector: ENTITY_SELECTOR });
      if (!corner[`reading${i}_entity`]) continue;
      schema.push({ name: `reading${i}_label`, selector: { text: {} } });
      schema.push({ name: `reading${i}_unit`, selector: { text: {} } });
      schema.push({
        name: `reading${i}_decimals`,
        selector: { number: { min: 0, max: 4, step: 1, mode: 'box' } },
      });
    }
    return { name: key, type: 'expandable', title, schema };
  });

  // Header / footer rows: a hide toggle plus the shared sensor slots. As with
  // the corners, a slot only appears once the previous one names a sensor.
  const rowSections = [
    ['header', 'Header row (title + sensors)'],
    ['footer', 'Footer row (sensors)'],
  ].map(([key, sectionTitle]) => {
    const row = c[key] || {};
    const schema = [];
    if (key === 'header') {
      schema.push({
        name: 'title',
        label: 'Header title',
        helper:
          'Leave empty to use the card title above. When a header row is configured it replaces that plain title line, so set it here or above, not both.',
        selector: { text: {} },
      });
    }
    schema.push({ name: 'show', selector: { boolean: {} } });
    for (let i = 1; i <= MAX_EDITOR_SENSORS; i++) {
      if (i > 1 && !row[`sensor${i - 1}_entity`]) break;
      schema.push({ name: `sensor${i}_entity`, selector: ENTITY_SELECTOR });
      if (!row[`sensor${i}_entity`]) continue;
      schema.push({ name: `sensor${i}_label`, selector: { text: {} } });
      schema.push({ name: `sensor${i}_unit`, selector: { text: {} } });
      schema.push({
        name: `sensor${i}_decimals`,
        selector: { number: { min: 0, max: 4, step: 1, mode: 'box' } },
      });
    }
    return { name: key, type: 'expandable', title: sectionTitle, schema };
  });

  const buttonSections = [];
  for (let i = 1; i <= MAX_EDITOR_BUTTONS; i++) {
    if (i > 1) {
      const prev = c[`button${i - 1}`];
      const filled =
        prev && Object.values(prev).some((v) => v !== undefined && v !== null && v !== '' && v !== false);
      if (!filled) break;
    }
    buttonSections.push(buttonSection(i, c[`button${i}`] || {}));
  }

  return [
    { name: 'title', selector: { text: {} } },
    rowSections[0],
    ...cornerSections,
    {
      name: 'unit',
      type: 'expandable',
      title: 'Battery (center)',
      schema: [
        { name: 'soc_entity', selector: ENTITY_SELECTOR },
        { name: 'power_entity', selector: ENTITY_SELECTOR },
      ],
    },
    {
      name: 'display',
      type: 'expandable',
      title: 'Center display lines',
      schema: displaySchema,
    },
    {
      name: 'options',
      type: 'expandable',
      title: 'Options',
      schema: optionsSchema,
    },
    rowSections[1],
    ...buttonSections,
  ];
}

class IntegratedUpsFlowCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = this._normalize(config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    if (!this._form) {
      const style = document.createElement('style');
      style.textContent = `
        :host { display: block; }
        ha-form { display: block; padding: 8px 0; }
        .hint {
          font-size: 0.8rem;
          color: var(--secondary-text-color, #888);
          padding: 4px 8px 12px;
        }
      `;
      this.shadowRoot.appendChild(style);

      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent =
        'Every field is optional. Configured corners are clickable (opens the entity more-info dialog); unconfigured corners are hidden along with their flow line. Extra sensors go in the reading slots of a corner, sensors outside the power flow go in the Header or Footer row, and buttons go in the Button sections (or a buttons: list in YAML).';
      this.shadowRoot.appendChild(hint);

      const form = document.createElement('ha-form');
      this.shadowRoot.appendChild(form);
      this._form = form;

      form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        const raw = ev.detail && ev.detail.value ? ev.detail.value : {};
        // Collapse the reading/button slots back into YAML arrays before the
        // config leaves the editor.
        const newConfig = formSlotsToConfig(raw);
        this._config = newConfig;
        this.dispatchEvent(
          new CustomEvent('config-changed', {
            detail: { config: newConfig },
            bubbles: true,
            composed: true,
          })
        );
      });
    }
    this._render();
  }

  _normalize(config) {
    const c = { ...(config || {}) };

    // v0.1 used `load:` for AC output. Surface it in the editor as `ac:` and
    // drop `load:` so saves write only the modern key.
    if (c.load && !c.ac) {
      c.ac = c.load;
    }
    delete c.load;

    // v0.4 placed runtime/charge_time sensors under `unit:`. v0.4.1 moved them
    // under `display:` next to the show_runtime toggle. Migrate so the form
    // populates from existing configs and saves only the new location.
    const unit = { ...(c.unit || {}) };
    const display = { ...(c.display || {}) };
    if (unit.runtime_entity && !display.runtime_entity) {
      display.runtime_entity = unit.runtime_entity;
    }
    if (unit.charge_time_entity && !display.charge_time_entity) {
      display.charge_time_entity = unit.charge_time_entity;
    }
    delete unit.runtime_entity;
    delete unit.charge_time_entity;
    c.unit = unit;
    c.display = display;

    // Keep `_config` in its YAML (array) form. `_render` expands it into the
    // form's fixed reading/button slots; expanding here too would run the
    // expansion twice, and the second pass would wipe every slot because the
    // first one already deleted the `readings:`/`buttons:` arrays.
    return c;
  }

  _render() {
    if (!this._form) return;
    const data = configToFormSlots(this._config || {});
    this._form.hass = this._hass;
    this._form.schema = buildEditorSchema(data);
    this._form.data = data;
    this._form.computeLabel = (schema) => schema.label || EDITOR_LABELS[schema.name] || schema.name;
    this._form.computeHelper = (schema) => schema.helper || EDITOR_HELPERS[schema.name] || undefined;
  }
}

customElements.define(EDITOR_TAG, IntegratedUpsFlowCardEditor);
