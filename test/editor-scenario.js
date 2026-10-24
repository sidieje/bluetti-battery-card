/* Drives the card's visual editor through the mini ha-form harness.
 *
 * Run in a browser with test/editor-test.html, or headless with
 * test/editor-node-test.mjs (jsdom). Requires test/mini-ha-form.js first.
 */

const EDITOR_CONFIG = {
  title: 'Home UPS',
  unit: { soc_entity: 'sensor.battery_soc', power_entity: 'sensor.power_now' },
  pv: {
    entity: 'sensor.pv_power',
    name: 'PV',
    readings: [{ entity: 'sensor.pv_voltage', label: 'V', decimals: 1 }],
  },
  options: { size: 'compact', scale: 0.9 },
  header: {
    title: 'Home UPS',
    sensors: [{ entity: 'sensor.room_temp', label: 'Room' }],
  },
  footer: { show: false },
  buttons: [
    { entity: 'switch.fan', name: 'Fan' },
    { entity: 'switch.pump', name: 'Pump', confirmation: true },
  ],
};

async function runEditorTests(opts) {
  const o = opts || {};
  const step = o.step === undefined ? 99 : o.step;
  const recall = o.recall !== false; // Lovelace re-applies the config it just got
  const lines = [];
  let pass = 0;
  let fail = 0;
  const log = (msg, cls) => {
    lines.push({ msg, cls: cls || '' });
    if (o.el) {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = msg + '\n';
      o.el.appendChild(span);
    }
  };
  const check = (label, ok, extra) => {
    if (ok) { pass++; log('  ok   ' + label, 'pass'); } else { fail++; log('  FAIL ' + label + (extra ? ' -> ' + extra : ''), 'fail'); }
  };
  // Lovelace feeds each emitted config back into the editor; --no-recall skips
  // that, so the form is never re-rendered after a schema change and fields
  // that only appear for a new action do not exist yet. Those checks are
  // recall-only.
  const checkR = (label, ok, extra) => { if (recall) check(label, ok, extra); };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const flush = async (n) => { for (let i = 0; i < (n || 6); i++) await tick(); };

  function* walk(root) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }
  const deepAll = (sel) => [...walk(document)].filter((e) => e.matches && e.matches(sel));
  const section = (title) =>
    deepAll('mini-expandable').find((e) => e._schema && e._schema.title === title);
  const fieldInput = (expandable, name) => {
    if (!expandable || !expandable._form) return null;
    const entry = expandable._form._items.find((it) => it.el._schema && it.el._schema.name === name);
    return entry ? entry.el.shadowRoot.querySelector('input,select') : null;
  };
  const type = async (expandable, name, value) => {
    const input = fieldInput(expandable, name);
    if (!input) return null;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    return input;
  };
  const setCheck = async (expandable, name, checked) => {
    const input = fieldInput(expandable, name);
    if (!input) return null;
    input.checked = checked;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    return input;
  };
  const fieldLabel = (expandable, name) => {
    if (!expandable || !expandable._form) return null;
    const entry = expandable._form._items.find((it) => it.el._schema && it.el._schema.name === name);
    const lbl = entry && entry.el.shadowRoot && entry.el.shadowRoot.querySelector('.lbl');
    return lbl ? lbl.textContent : null;
  };

  const hass = { states: {}, callService: async () => {}, localize: () => '' };
  const host = document.getElementById('form');
  host.innerHTML = '';
  const configs = [];
  const editor = document.createElement('integrated-ups-flow-card-editor');
  editor.addEventListener('config-changed', (ev) => {
    configs.push(ev.detail.config);
    if (recall) editor.setConfig(JSON.parse(JSON.stringify(ev.detail.config)));
  });
  host.appendChild(editor);
  editor.setConfig(JSON.parse(JSON.stringify(EDITOR_CONFIG)));
  editor.hass = hass;
  await flush();

  log('--- schema shape ---');
  log('sections: ' + deepAll('mini-expandable').map((s) => s._schema.title).join(' | '));
  const b1 = section('Button 1');
  const b2 = section('Button 2');
  check('Button 1 section exists', Boolean(b1));
  check('Button 2 section exists', Boolean(b2));
  if (!b1 || !b2) return { lines, pass, fail };
  if (step < 1) return { lines, pass, fail };

  log('');
  log('--- 1. existing values prefill ---');
  check('button1 name shows "Fan"', fieldInput(b1, 'name').value === 'Fan', JSON.stringify(fieldInput(b1, 'name').value));
  check('button1 entity shows "switch.fan"', fieldInput(b1, 'entity').value === 'switch.fan', JSON.stringify(fieldInput(b1, 'entity').value));
  check('button2 name shows "Pump"', fieldInput(b2, 'name').value === 'Pump', JSON.stringify(fieldInput(b2, 'name').value));
  const opts2 = section('Options');
  check('options.size shows "compact"', opts2 && fieldInput(opts2, 'size').value === 'compact', opts2 && JSON.stringify(fieldInput(opts2, 'size').value));
  const pv = section('PV input (top-left)');
  check('pv reading1_entity prefills', pv && fieldInput(pv, 'reading1_entity').value === 'sensor.pv_voltage', pv && JSON.stringify(fieldInput(pv, 'reading1_entity').value));
  if (step < 2) return { lines, pass, fail };

  log('');
  log('--- 2. typing keeps the value (multi-character input) ---');
  const nameInput = await type(b1, 'name', 'Fan room');
  check('button1 name keeps 8 chars', nameInput.value === 'Fan room', JSON.stringify(nameInput.value));
  const again = await type(b1, 'name', 'Fan room 2');
  check('button1 name keeps 10 chars on a second edit', again.value === 'Fan room 2', JSON.stringify(again.value));
  if (step < 3) return { lines, pass, fail };

  log('');
  log('--- 3. edits to one button do not clobber another ---');
  await type(b2, 'name', 'Pump house');
  const last = configs[configs.length - 1];
  log('emitted buttons: ' + JSON.stringify(last.buttons));
  check('two buttons retained', Array.isArray(last.buttons) && last.buttons.length === 2, String(last.buttons && last.buttons.length));
  check('button1 kept its entity', last.buttons[0] && last.buttons[0].entity === 'switch.fan', JSON.stringify(last.buttons[0]));
  check('button1 kept its new name', last.buttons[0] && last.buttons[0].name === 'Fan room 2', JSON.stringify(last.buttons[0]));
  check('button2 kept its entity', last.buttons[1] && last.buttons[1].entity === 'switch.pump', JSON.stringify(last.buttons[1]));
  check('button2 kept its new name', last.buttons[1] && last.buttons[1].name === 'Pump house', JSON.stringify(last.buttons[1]));

  log('');
  log('--- 4. unrelated config survives ---');
  check('title survives', last.title === 'Home UPS', JSON.stringify(last.title));
  check('pv.readings survives', last.pv && Array.isArray(last.pv.readings) && last.pv.readings.length === 1, JSON.stringify(last.pv));
  check('options.size survives', last.options && last.options.size === 'compact', JSON.stringify(last.options));
  check('no slot keys leak into YAML', !('button1' in last) && !('reading1_entity' in (last.pv || {})), JSON.stringify(Object.keys(last)));
  if (step < 4) return { lines, pass, fail };

  log('');
  log('--- 5. adding a third button ---');
  const b3 = section('Button 3');
  check('Button 3 section appears once two are filled', Boolean(b3));
  if (b3) {
    await type(b3, 'entity', 'switch.kettle');
    const after = configs[configs.length - 1];
    log('emitted buttons: ' + JSON.stringify(after.buttons));
    check('three buttons retained', after.buttons.length === 3, String(after.buttons.length));
    check('button1 still intact', after.buttons[0].name === 'Fan room 2' && after.buttons[0].entity === 'switch.fan', JSON.stringify(after.buttons[0]));
  }

  log('');
  log('--- 6. changing an action swaps fields without losing values ---');
  const act = await type(b1, 'action', 'call-service');
  check('action set to call-service', act && act.value === 'call-service', act && act.value);
  const b1b = section('Button 1');
  checkR('service field now offered', Boolean(fieldInput(b1b, 'service')));
  check('name survived the schema change', fieldInput(b1b, 'name').value === 'Fan room 2', JSON.stringify(fieldInput(b1b, 'name').value));
  await type(b1b, 'service', 'switch.turn_on');
  const after2 = configs[configs.length - 1];
  log('emitted buttons: ' + JSON.stringify(after2.buttons));
  check('button1 has name + action', after2.buttons[0].name === 'Fan room 2' && after2.buttons[0].action === 'call-service', JSON.stringify(after2.buttons[0]));
  checkR('button1 kept the service typed after the schema change', after2.buttons[0].service === 'switch.turn_on', JSON.stringify(after2.buttons[0]));
  check('button2 untouched by button1 edit', after2.buttons[1].name === 'Pump house' && after2.buttons[1].entity === 'switch.pump', JSON.stringify(after2.buttons[1]));

  log('');
  log('--- 7. header / footer rows ---');
  const hdr = section('Header row (title + sensors)');
  check('header section exists', Boolean(hdr));
  check('footer section exists', Boolean(section('Footer row (sensors)')));
  if (hdr) {
    check('header title prefills', fieldInput(hdr, 'title').value === 'Home UPS', JSON.stringify(fieldInput(hdr, 'title').value));
    check('header title field relabelled', fieldLabel(hdr, 'title') === 'Header title', JSON.stringify(fieldLabel(hdr, 'title')));
    check('header sensor1 prefills', fieldInput(hdr, 'sensor1_entity').value === 'sensor.room_temp', JSON.stringify(fieldInput(hdr, 'sensor1_entity').value));
    check('header show prefills checked', fieldInput(hdr, 'show').checked === true, JSON.stringify(fieldInput(hdr, 'show').checked));
    await type(hdr, 'sensor2_entity', 'sensor.firmware');
    const after7 = configs[configs.length - 1];
    log('emitted header: ' + JSON.stringify(after7.header));
    check('header kept its title', after7.header && after7.header.title === 'Home UPS', JSON.stringify(after7.header));
    check('header sensor1 intact after adding sensor2', after7.header.sensors[0].entity === 'sensor.room_temp' && after7.header.sensors[0].label === 'Room', JSON.stringify(after7.header.sensors));
    check('header sensor2 added', after7.header.sensors.length === 2 && after7.header.sensors[1].entity === 'sensor.firmware', JSON.stringify(after7.header.sensors));
    check('no row slot keys leak', !('sensor1_entity' in after7.header), JSON.stringify(Object.keys(after7.header)));
  }
  const ftr = section('Footer row (sensors)');
  if (ftr) {
    check('footer show unchecked when hidden', fieldInput(ftr, 'show').checked === false, JSON.stringify(fieldInput(ftr, 'show').checked));
    await setCheck(ftr, 'show', true);
    const after7b = configs[configs.length - 1];
    log('emitted footer: ' + JSON.stringify(after7b.footer));
    check('empty footer block is not written', after7b.footer === undefined, JSON.stringify(after7b.footer));
    const ftr2 = section('Footer row (sensors)');
    await type(ftr2, 'sensor1_entity', 'sensor.co2');
    const after7c = configs[configs.length - 1];
    check('footer sensor added, no show flag', after7c.footer && JSON.stringify(after7c.footer) === JSON.stringify({ sensors: [{ entity: 'sensor.co2' }] }), JSON.stringify(after7c.footer));
    const ftr3 = section('Footer row (sensors)');
    await setCheck(ftr3, 'show', false);
    const after7d = configs[configs.length - 1];
    check('hiding the footer keeps its sensors', after7d.footer && after7d.footer.show === false && after7d.footer.sensors.length === 1 && after7d.footer.sensors[0].entity === 'sensor.co2', JSON.stringify(after7d.footer));
  }
  if (step < 7) return { lines, pass, fail };

  log('');
  log('--- 8. confirmation text ---');
  const b2b = section('Button 2');
  check('confirmation_text offered when confirmation is on', Boolean(fieldInput(b2b, 'confirmation_text')));
  await type(b2b, 'confirmation_text', 'Stop the pump?');
  const after8 = configs[configs.length - 1];
  check('confirmation_text saved', after8.buttons[1].confirmation_text === 'Stop the pump?', JSON.stringify(after8.buttons[1]));
  check('button2 kept its confirmation flag', after8.buttons[1].confirmation === true, JSON.stringify(after8.buttons[1]));
  checkR('button1 untouched by the confirmation edit', after8.buttons[0].name === 'Fan room 2' && after8.buttons[0].service === 'switch.turn_on', JSON.stringify(after8.buttons[0]));

  log('');
  log(fail === 0 ? 'ALL PASS' : 'FAILURES', fail === 0 ? 'pass' : 'fail');
  log('  ' + pass + ' ok, ' + fail + ' failed');
  return { lines, pass, fail };
}
