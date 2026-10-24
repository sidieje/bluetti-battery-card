/* Stand-ins for Home Assistant's form elements.
 *
 * Semantics copied from home-assistant/frontend
 * src/components/ha-form/ha-form.ts and ha-form-expandable.ts:
 *   - getValue: a named, non-flattened item reads obj[item.name]
 *   - items render by index and the element is reused while its tag is unchanged
 *   - a value-changed from a named section is wrapped under section.name and
 *     merged into the parent data, then re-fired upward
 *   - ha-form-expandable renders its inner ha-form unconditionally (collapsed
 *     sections still have their fields in the DOM) and does not listen for
 *     value-changed itself; the event bubbles to the parent form
 *   - lit only writes a bound property when the bound value changed, so a
 *     user-opened panel survives re-renders of an unchanged schema
 *
 * Loaded by test/editor-test.html (browser) and test/editor-node-test.mjs (jsdom).
 */

const getValue = (obj, item) =>
  obj ? (!item.name || item.flatten ? obj : obj[item.name]) : undefined;

const fireEvent = (el, type, detail) =>
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

class MiniForm extends HTMLElement {
  set schema(v) { this._schema = v; this._schedule(); }
  get schema() { return this._schema; }
  set data(v) { this._data = v; this._schedule(); }
  get data() { return this._data; }
  set hass(v) { this._hass = v; }
  set computeLabel(v) { this._computeLabel = v; }
  set computeHelper(v) { this._computeHelper = v; }

  connectedCallback() {
    if (!this._root) {
      this.attachShadow({ mode: 'open' });
      this._root = document.createElement('div');
      this._items = [];
      this.shadowRoot.appendChild(this._root);
      this._root.addEventListener('value-changed', (ev) => this._onValue(ev));
    }
    this._schedule();
  }

  // lit renders asynchronously; keep that so focus/timing match HA.
  _schedule() {
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => { this._queued = false; this._render(); });
  }

  _onValue(ev) {
    ev.stopPropagation();
    const schema = ev.target.schema;
    if (ev.target === this) return;
    const newValue =
      !schema.name || ('flatten' in schema && schema.flatten)
        ? ev.detail.value
        : { [schema.name]: ev.detail.value };
    this.data = { ...this._data, ...newValue };
    fireEvent(this, 'value-changed', { value: this._data });
  }

  _render() {
    if (!this._root || !this._schema) return;
    const items = this._schema;
    while (this._items.length > items.length) this._items.pop().el.remove();
    items.forEach((item, i) => {
      const tag = 'selector' in item ? 'mini-selector' : 'mini-' + item.type;
      let entry = this._items[i];
      if (!entry || entry.tag !== tag) {
        if (entry) entry.el.remove();
        const el = document.createElement(tag);
        this._root.appendChild(el);
        entry = { tag, el };
        this._items[i] = entry;
      }
      if ('selector' in item) {
        Object.assign(entry.el, {
          schema: item,
          value: getValue(this._data, item),
          label: this._computeLabel ? this._computeLabel(item, this._data) : item.name,
          helper: this._computeHelper ? this._computeHelper(item) : '',
        });
      } else {
        Object.assign(entry.el, {
          schema: item,
          data: getValue(this._data, item),
          hass: this._hass,
          computeLabel: this._computeLabel,
          computeHelper: this._computeHelper,
        });
      }
    });
  }
}
// The card editor builds a real <ha-form>, so this stand-in registers under that tag.
customElements.define('ha-form', MiniForm);

class MiniExpandable extends HTMLElement {
  set schema(v) { this._schema = v; this._render(); }
  get schema() { return this._schema; }
  set data(v) { this._data = v; if (this._form) this._form.data = v; }
  get data() { return this._data; }
  set hass(v) { this._hass = v; if (this._form) this._form.hass = v; }
  set computeLabel(v) { this._computeLabel = v; if (this._form) this._form.computeLabel = v; }
  set computeHelper(v) { this._computeHelper = v; if (this._form) this._form.computeHelper = v; }

  connectedCallback() {
    if (!this._hdr) {
      this.attachShadow({ mode: 'open' });
      this._hdr = document.createElement('div');
      this._hdr.className = 'hdr';
      this._body = document.createElement('div');
      this._body.className = 'body';
      this._form = document.createElement('ha-form');
      this._body.appendChild(this._form);
      this.shadowRoot.append(this._hdr, this._body);
      // ha-expansion-panel flips its own `expanded` property on header click.
      this._hdr.addEventListener('click', () => { this._open = !this._open; this._paint(); });
    }
    this._render();
  }

  _render() {
    if (!this._hdr || !this._schema) return;
    const bound = Boolean(this._schema.expanded);
    if (bound !== this._lastBound) {
      this._lastBound = bound;
      this._open = bound;
    }
    this._hdr.textContent =
      this._schema.title ||
      (this._computeLabel && this._computeLabel(this._schema)) ||
      this._schema.name;
    this._paint();
    this._form.schema = this._schema.schema;
    this._form.data = this._data;
    this._form.hass = this._hass;
    this._form.computeLabel = this._computeLabel;
    this._form.computeHelper = this._computeHelper;
  }

  _paint() { this._body.style.display = this._open ? '' : 'none'; }
}
customElements.define('mini-expandable', MiniExpandable);

class MiniSelector extends HTMLElement {
  set schema(v) { this._schema = v; this._build(); }
  get schema() { return this._schema; }
  set value(v) {
    this._value = v;
    if (!this._input) return;
    if (this._input.dataset.kind === 'boolean') {
      this._input.checked = Boolean(v);
      return;
    }
    const text = v === undefined || v === null ? '' : String(v);
    if (this._input.value !== text) this._input.value = text;
  }
  get value() { return this._value; }
  set label(v) { if (this._lbl) this._lbl.textContent = v; }
  set helper(v) { if (this._help) this._help.textContent = v || ''; }

  connectedCallback() { this._build(); }

  _build() {
    if (!this._schema) return;
    if (!this._input) {
      this.attachShadow({ mode: 'open' });
      this._lbl = document.createElement('span');
      this._lbl.className = 'lbl';
      this._help = document.createElement('span');
      this._help.className = 'lbl';
      const kind = Object.keys(this._schema.selector || {})[0];
      let input;
      if (kind === 'select') {
        input = document.createElement('select');
        for (const o of this._schema.selector.select.options) {
          const opt = typeof o === 'string' ? new Option(o, o) : new Option(o.label, o.value);
          input.appendChild(opt);
        }
      } else if (kind === 'boolean') {
        input = Object.assign(document.createElement('input'), { type: 'checkbox' });
      } else if (kind === 'number') {
        input = Object.assign(document.createElement('input'), { type: 'number' });
      } else {
        input = document.createElement('input');
      }
      input.dataset.kind = kind;
      this._input = input;
      this.shadowRoot.append(this._lbl, this._input, this._help);
      this._input.addEventListener('input', () => {
        const k = this._input.dataset.kind;
        const value =
          k === 'boolean' ? this._input.checked
            : k === 'number' ? (this._input.value === '' ? '' : Number(this._input.value))
              : this._input.value;
        this._value = value;
        fireEvent(this, 'value-changed', { value });
      });
    }
    this._lbl.textContent = this._schema.name;
    if (this._value !== undefined) this.value = this._value;
  }
}
customElements.define('mini-selector', MiniSelector);
