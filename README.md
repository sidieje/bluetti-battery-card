# Integrated UPS Flow Card

A Home Assistant Lovelace card for **integrated UPS units** — portable power
stations and similar devices where the battery, inverter, charger, and transfer
switch all live in a single sealed box (e.g. **BLUETTI Elite 200 V2**, EcoFlow
Delta, Anker Solix, etc.).

```
   [ PV   ] ----,           ,---- [ GRID ]
                 \  ( SoC )  /
   [ DC   ] ----'           '---- [ AC   ]
```

Four corner nodes for the two inputs (PV, Grid) and two outputs (DC, AC), with
a semicircular state-of-charge gauge in the middle. Flow lines from each corner
animate when their input/output is active; their speed scales with wattage.

## Why does this exist?

The existing power-flow cards model the wrong topology for an integrated UPS:

- **`power-flow-card-plus`** assumes everything feeds a "home" node with the
  battery as a side branch.
- **`enhanced-power-flow-card`** assumes a Victron-style split inverter/charger
  where the inverter is a separate hub from the battery.

A portable power station is **neither**. It's a single integrated unit with two
inputs (grid, solar) and two outputs (DC, AC). The battery, inverter, charger,
and transfer switch all live inside one box. The natural model: four corners
plus a central battery state.

## Install (HACS)

1. In HACS, open **Frontend**.
2. Click the three-dot menu in the top right and choose **Custom repositories**.
3. Add this repo's URL with category **Lovelace**:
   ```
   https://github.com/bigcspecv/bluetti-battery-card
   ```
4. Find **Integrated UPS Flow Card** in the HACS list, click it, then **Download**.
5. Resource registration:
   - In **Settings → Dashboards → ⋮ → Resources**, add:
     - **URL:** `/hacsfiles/bluetti-battery-card/integrated-ups-flow-card.js`
     - **Resource type:** `JavaScript Module`
   - Or add the same URL to your YAML `lovelace.resources` block.
6. Hard-refresh your browser (Ctrl/Cmd+Shift+R).

> Note: the repo is named `bluetti-battery-card` (where the card was first
> built and tested against a BLUETTI Elite 200 V2), but the card itself
> (`integrated-ups-flow-card`) is generic and works with any single-box
> battery+inverter unit.

## Add to a dashboard

After installing, the card appears in the dashboard card picker as
**Integrated UPS Flow Card**. You can also add it via YAML — see the schema
below.

## Configuration

### Visual editor

The card ships with a Lovelace visual editor (added in **v0.3.0**). When you
add the card via the dashboard's "Add card" picker, or edit an existing card
and choose **Show visual editor**, you'll get an entity-picker form with
collapsible sections for each corner, the unit, the center display, and the
options. Since v0.6 each corner section also holds two extra-reading slots, and
the form grows up to six button sections as you fill them in. Since v0.7 there
are **Header row** and **Footer row** sections for sensors that sit outside the
power flow. YAML mode still works for everything the editor exposes, plus
anything Jinja that the editor's selectors don't render.

### Schema (v0.7)

```yaml
type: custom:integrated-ups-flow-card
title: Elite 200 V2          # optional header

header:                      # optional — title row + extra sensors (v0.7)
  title: Elite 200 V2        # defaults to the card title above
  show: true                 # false hides the row, title included
  sensors:
    - entity: sensor.elite_200_v2_01_cabinet_temperature
      label: Cabinet
    - entity: sensor.elite_200_v2_01_cycle_count
      decimals: 0

# Inputs (top corners)
pv:                          # optional — top-left corner
  entity: sensor.elite_200_v2_01_photovoltaics_input_power
  name: PV
  icon: mdi:solar-panel
  readings:                  # optional — extra lines under the watts (v0.6)
    - entity: sensor.elite_200_v2_01_photovoltaics_input_voltage
    - entity: sensor.elite_200_v2_01_photovoltaics_input_current
      label: I
      decimals: 1
grid:                        # optional — top-right corner
  entity: sensor.elite_200_v2_01_grid_input_power
  name: Grid
  icon: mdi:transmission-tower

# Outputs (bottom corners)
dc:                          # optional — bottom-left corner
  entity: sensor.elite_200_v2_01_direct_current_out_power
  name: DC
  icon: mdi:current-dc
ac:                          # optional — bottom-right corner
  entity: sensor.elite_200_v2_01_alternating_current_out_power
  name: AC
  icon: mdi:power-plug

# Battery (center)
unit:
  soc_entity: sensor.elite_200_v2_01_battery_level                          # optional but recommended
  power_entity: ~                                                           # optional, advanced (see below)

# Center display lines (added in v0.3) — show/hide and/or override
display:
  show_state: true           # charging / discharging / idle label
  show_throughput: true      # ± W line below the state label
  show_runtime: true         # runtime / charge-time line
  show_last_updated: true    # "Xs ago" freshness / staleness line (added in v0.5)
  state_template: ~          # optional plain string or Jinja override
  throughput_template: ~     # optional plain string or Jinja override
  runtime_entity: sensor.elite_200_v2_01_battery_time_in_minutes            # optional, used while discharging
  charge_time_entity: sensor.elite_200_v2_01_full_charge_time_in_minutes    # optional, used while charging
  runtime_template: ~        # optional plain string or Jinja override

options:
  size: normal               # compact | normal | large (added in v0.6)
  scale: 1                   # 0.4–2.2 fine-tune, multiplied by size (v0.6)
  idle_threshold: 5          # W deadband around zero (default 5)
  invert_battery_sign: false # flip if power_entity uses discharge-positive
  max_power: 2600            # W — used to scale flow animation speed
  stale_threshold: 300       # s — the "Xs ago" text turns red past this (added in v0.5)

# Action buttons under the diagram (added in v0.6)
buttons:
  - name: AC outlet
    icon: mdi:power-plug
    entity: switch.elite_200_v2_01_ac_outlet
    action: toggle
  - name: Solar bypass
    entity: switch.elite_200_v2_01_solar_pass
    action: toggle
    confirmation: true          # asks "Toggle Solar bypass?" first
  - name: Energy
    icon: mdi:transmission-tower
    action: navigate
    navigation_path: /lovelace/energy

footer:                        # optional — sensor row under the buttons (v0.7)
  show: true
  sensors:
    - entity: sensor.house_living_room_temperature
      label: Living room
    - entity: sensor.house_co2
      label: CO2
      decimals: 0
```

### Field reference

| Field | Required | Description |
| --- | --- | --- |
| `title` | no | Header text. Omit to hide. A `header:` block can replace it (see [Header & footer sensor rows](#header--footer-sensor-rows)). |
| `header` | no | Title row above the diagram, with optional sensors beside the title (see [Header & footer sensor rows](#header--footer-sensor-rows)). Added in v0.7. |
| `header.title` | no | Row title. Defaults to the top-level `title`. Accepts a Jinja template. |
| `header.show` | no | `false` hides the whole row — the card title goes with it. Default `true`. |
| `header.sensors` | no | Sensor entries on the right of the row. Same fields as [reading entries](#reading-entries). |
| `footer` | no | Sensor row under the button strip. Same `show` / `sensors` fields; `footer.title` is YAML-only. Added in v0.7. |
| `pv.entity` | no | Solar input watts. Import-only — clamped to ≥ 0. Corner shows "—" when omitted. |
| `pv.name` / `pv.icon` | no | Display name / MDI icon. Defaults: `PV` / `mdi:solar-panel`. |
| `grid.entity` | no | Grid input watts. Import-only — clamped to ≥ 0. Omit to hide the Grid corner and its flow line. |
| `grid.name` / `grid.icon` | no | Defaults: `Grid` / `mdi:transmission-tower`. |
| `dc.entity` | no | DC output watts. Corner shows "—" when omitted. |
| `dc.name` / `dc.icon` | no | Defaults: `DC` / `mdi:current-dc`. |
| `ac.entity` | no | AC output watts. (`load.entity` from v0.1 still accepted as an alias.) Omit to hide the AC corner and its flow line. |
| `ac.name` / `ac.icon` | no | Defaults: `AC` / `mdi:power-plug`. |
| `<corner>.readings` | no | List of extra sensors shown under the corner's watts (see [Extra readings](#extra-readings)). Added in v0.6. |
| `unit.soc_entity` | no | Battery SoC 0–100. Drives the arc fill and SoC text. Recommended. |
| `unit.power_entity` | no | Battery throughput in watts. Positive = charging, negative = discharging. Most integrations don't expose this — leave empty and the card derives `(grid + pv) − (ac + dc)`. |
| `display.show_state` | no | Show the charging / discharging / idle label inside the arc. Default `true`. |
| `display.show_throughput` | no | Show the ± W throughput line inside the arc. Default `true`. |
| `display.show_runtime` | no | Show the runtime / charge-time line inside the arc. Default `true`. |
| `display.show_last_updated` | no | Show the "Xs ago" freshness line (see [Staleness indicator](#staleness-indicator)). Default `true`. |
| `display.runtime_entity` | no | Time remaining while *discharging*, in minutes. Many integrations (BLUETTI included) report 0 while charging. Shown as `Xh Ym left`. |
| `display.charge_time_entity` | no | Time to full while *charging*, in minutes (e.g. BLUETTI's `full_charge_time_in_minutes`). When set and charging, the runtime line shows `Xh Ym to full`. |
| `display.state_template` | no | Override the state label. Accepts either a plain string or a Jinja template. |
| `display.throughput_template` | no | Override the throughput line. Plain string or Jinja template. |
| `display.runtime_template` | no | Override the runtime line. Plain string or Jinja template. |
| `options.size` | no | `compact` (0.72×), `normal` (1×) or `large` (1.25×). Default `normal`. See [Sizing](#sizing). |
| `options.scale` | no | Free multiplier from `0.4` to `2.2`, applied on top of `size`. Default `1`. |
| `options.idle_threshold` | no | Watts deadband used for active/idle decisions. Default `5`. |
| `options.invert_battery_sign` | no | Set `true` if your `power_entity` reports discharge as positive. |
| `options.max_power` | no | Watts used as the upper bound for animation-speed scaling. Default `2600`. |
| `options.stale_threshold` | no | Seconds since the newest reading before the "Xs ago" text turns red. Text color only — the card's red border is driven separately, by the battery-level entity going `unavailable`. Default `300`. |
| `buttons` | no | List of buttons rendered in a strip under the diagram (see [Buttons](#buttons)). Added in v0.6. |

#### Reading entries

Each entry in a corner's `readings:` list:

| Field | Required | Description |
| --- | --- | --- |
| `entity` | yes | Sensor to display. Also accepts a Jinja template. |
| `label` | no | Short prefix rendered before the value (`V`, `I`, `W`). Omit to show the value alone. |
| `unit` | no | Unit suffix. Defaults to the sensor's own `unit_of_measurement`; set it to `""` to suppress the unit entirely. |
| `decimals` | no | Round the value to this many decimals (0–4). Default `1`. |

### Templates

**Every entity field also accepts a Jinja template string** (anything containing
`{{ … }}` or `{% … %}`). Templates are evaluated by Home Assistant via the
real WebSocket `render_template` API — full Jinja, all standard HA helpers
(`states`, `state_attr`, `is_state`, `expand`, `|abs`, `|round`, `|float`,
`{% if %}`, etc.).

Example — clamp a noisy sensor:

```yaml
grid:
  entity: "{{ [states('sensor.grid_input_power') | float(0), 0] | max }}"
```

Example — sum two PV strings:

```yaml
pv:
  entity: >-
    {{ (states('sensor.pv_string_1') | float(0)
        + states('sensor.pv_string_2') | float(0)) | round(0) }}
```

## Interactivity

Each of the four corners (PV, Grid, DC, AC) and the central battery is
clickable and opens Home Assistant's standard more-info dialog for the
configured entity — `pv.entity`, `grid.entity`, `dc.entity`, `ac.entity`, and
`unit.soc_entity` respectively. Corners whose entity is configured as a Jinja
template are non-clickable (a template doesn't map to a single entity). The
extra readings under a corner and the sensors in the [header and footer
rows](#header--footer-sensor-rows) are clickable in the same way, each opening
its own entity.

## Sizing

Added in **v0.6.0**; text behaviour changed in **v0.7.0**. The size preset
scales the layout — corners, battery circle, icons, flow lines, spacing and the
center stack — from one knob, so shrinking it never breaks the layout. **Text
does not shrink with the preset**: labels, watts and row sensors stay at their
normal size, because the card's width comes from the dashboard column and a
compact card has just as much horizontal room for words. Only the SoC number
inside the battery circle scales down with the circle (never below 0.85×), and
in a genuinely narrow column (below 560 px) the text shrinks too, so it keeps
fitting.

```yaml
options:
  size: compact   # compact | normal | large
  scale: 0.9      # optional fine-tune, 0.4 – 2.2
```

| `size` | Multiplier |
| --- | --- |
| `compact` | 0.72× |
| `normal` (default) | 1× |
| `large` | 1.25× |

`scale` is multiplied on top of the preset, so `size: compact` with
`scale: 1.2` lands at ~0.86×. The product is clamped to 0.4–2.2.

Below 560 px of card width an extra 0.82× is applied automatically, so the same
config stays readable in a narrow dashboard column.

Lovelace reserves vertical space from the card's measured height, so a compact
card asks for about five rows where a normal one asks for seven. If a browser
still clips it, pin the height explicitly with
`view_layout: { grid_rows: 7 }`.

## Extra readings

Added in **v0.6.0**. Any corner can carry extra sensors under its watts — the
usual ask being PV voltage and current:

```yaml
pv:
  entity: sensor.elite_200_v2_01_photovoltaics_input_power
  readings:
    - entity: sensor.elite_200_v2_01_photovoltaics_input_voltage
    - entity: sensor.elite_200_v2_01_photovoltaics_input_current
      label: I
      decimals: 1
```

which renders as `238.4 V` and `I 4.6 A` under the PV power line. See the
[reading entry reference](#reading-entries) for the fields.

Readings inherit the corner's behaviour: each one opens its own more-info
dialog on click, they count towards the "Xs ago" freshness line, and their
`entity` fields accept Jinja templates like every other field. A reading whose
sensor goes `unavailable` shows `—`.

The visual editor exposes two reading slots per corner; a second slot appears
once the first names a sensor. YAML takes as many as you want.

## Header & footer sensor rows

Added in **v0.7.0**. Some sensors don't belong to the power flow — cabinet
temperature, cycle count, firmware, a room sensor next to the unit. They go in
one of two rows: a **header** row above the diagram (which also carries the
card title) and a **footer** row under the button strip.

```yaml
title: Elite 200 V2

header:
  title: Elite 200 V2 — home UPS   # defaults to the title above
  show: true
  sensors:
    - entity: sensor.elite_200_v2_01_cabinet_temperature
      label: Cabinet
    - entity: sensor.elite_200_v2_01_cycle_count
      decimals: 0
    - entity: sensor.elite_200_v2_01_firmware

footer:
  sensors:
    - entity: sensor.house_living_room_temperature
      label: Living room
    - entity: sensor.house_co2
      label: CO2
      decimals: 0
```

The title sits on the left, the sensors on the right, wrapping onto extra lines
when the column is tight. Each entry uses the same fields as a corner
[reading](#reading-entries) (`entity`, `label`, `unit`, `decimals`), accepts
Jinja templates, and opens its own more-info dialog on click. `sensors:` is the
key; `entities:` works as an alias.

- **The header row replaces the plain title line.** If it has no `title:` of
  its own it inherits the top-level `title:`, so the title never renders twice.
- **`show: false` hides a row entirely.** On the header row that hides the title
  too — handy when the dashboard view already names the card.
- The footer row is separated from the buttons by a divider line, and it only
  appears when it has something to show.
- Row sensors are subscribed like any other entity, but they are **not**
  counted by the ["Xs ago" freshness line](#staleness-indicator) — an unrelated
  slow sensor shouldn't make the UPS look stale.
- `getCardSize()` accounts for both rows, so Lovelace reserves the height.

The visual editor gives each row four sensor slots (the next appears once the
previous names a sensor) and a **Show row** checkbox; YAML takes as many as you
want.

## Buttons

Added in **v0.6.0**. `buttons:` renders a strip under the diagram, three per
row:

```yaml
buttons:
  - name: AC outlet
    icon: mdi:power-plug
    entity: switch.elite_200_v2_01_ac_outlet
    action: toggle
  - name: Solar bypass
    entity: switch.elite_200_v2_01_solar_pass
    action: toggle
    confirmation: true
  - name: Energy
    icon: mdi:transmission-tower
    action: navigate
    navigation_path: /lovelace/energy
```

The strip is a fixed height, so the row count decides how tall each button is:
three buttons fill it, six split it into two half-height rows, and seven or
more keep the half-height rows and grow the strip so they stay tappable.

| `action` | Extra fields | Behaviour |
| --- | --- | --- |
| `toggle` | `entity` | Calls `<domain>.toggle` on the entity. |
| `more-info` | `entity` | Opens the standard more-info dialog. |
| `call-service` | `service`, `service_data` | Calls `service` (e.g. `notify.persist_notification`) with `service_data`. `entity` is injected into the data if you don't set it yourself. |
| `navigate` | `navigation_path` | In-app navigation, e.g. `/lovelace/energy`. |
| `url` | `url` | Opens an external URL in a new tab. |
| `none` | — | Renders the button inert (useful as a spacer or label). |

`action` is optional and inferred from what you did provide: `service` →
`call-service`, `navigation_path` → `navigate`, `url` → `url`, `entity` alone →
`more-info`, otherwise `toggle`.

Other fields:

- `name` — label. Defaults to a humanized version of the entity's object ID
  (`switch.ac_outlet` → "Ac outlet"), falling back to the action name.
- `icon` — MDI icon. Defaults to the entity's own icon when it has one, then to
  one that matches the entity's domain or the action.
- `color` — any CSS color; used for the on-state ring and icon instead of
  `--primary-color`.
- `confirmation: true` — asks before firing, for anything that cuts the solar
  input or restarts the unit. Since **v0.7** the question uses the action verb,
  so a toggle asks `Toggle Solar bypass?`, a more-info button asks `Open BMS?`,
  a navigate button asks `Navigate to Energy?` and a service call asks
  `Run Log?`. The label is the button's `name`, falling back to its service,
  entity or target. Override it with `confirmation_text`.

Buttons whose action is `toggle` or `more-info` light up with an accent ring
while their entity is `on`, so a switched outlet reads its real state at a
glance.

The visual editor offers six button slots; the next slot appears once the
previous one has any content. YAML takes as many as you want.

## Staleness indicator

Added in **v0.5.0**; refined in **v0.5.1**. Some integrations — BLUETTI's cloud
poller in particular — drop their connection in one of two ways:

1. **Clean drop:** Home Assistant marks the entities `unavailable`.
2. **Frozen:** the entities keep their *last* value, so the card shows numbers
   that look live but aren't.

The card flags each case differently.

**Frozen values → red "Xs ago" text.** The card shows a small "updated
**Xs ago**" line under the center column, measuring the **newest report time
across every displayed entity** (each entity's `last_reported`, falling back to
`last_updated` then `last_changed`). Because all the corners and the battery
come from the same device, a healthy poll keeps at least one of them fresh; a
frozen connection lets the age climb. Once it passes `options.stale_threshold`
(default **300 s**), the clock becomes a red alert icon and the line turns red.
The line ticks once a second on its own, so the age keeps counting even while
the integration pushes no updates. This affects the text only — no ring, no
dimming. Entities currently in `unavailable` / `unknown` are skipped (so
flipping offline can't masquerade as a fresh report); if nothing usable is
present the line reads "no data". Hide it with `display.show_last_updated:
false`. Template entity fields are skipped — they don't map to a single state
object with a report timestamp.

**Clean drop → red card border.** When the **battery-level entity
(`unit.soc_entity`) reports `unavailable`**, the whole card gets a red inset
ring and its readings dim, so a dropped unit is unmistakable at a glance from
the dashboard. This is independent of `stale_threshold` and of
`show_last_updated` — it keys solely on the battery entity's state. (Only
`unavailable` triggers it, not `unknown`.)

## Flow logic

Once values are resolved:

```
pv_power      = max(0, pv.entity)            (or 0 if pv not set)
grid_power    = max(0, grid.entity)
dc_power      = max(0, dc.entity)            (or 0 if dc not set)
ac_power      = max(0, ac.entity)
battery_power = unit.power_entity (if set, optionally inverted)
                else (grid_power + pv_power) − (ac_power + dc_power)
```

Each flow is **active** when its corner's wattage exceeds `idle_threshold`.

- Active inflows (PV → battery, Grid → battery) animate from the corner toward
  the center.
- Active outflows (battery → AC, battery → DC) animate from the center toward
  the corner.
- Inactive flows are grayed out, not hidden.
- Animation speed scales with `power / max_power`.

Battery state inside the unit:

- `charging` when `battery_power > idle_threshold` (success color, charging icon)
- `discharging` when `battery_power < -idle_threshold` (warning color, draining icon)
- `idle` otherwise (neutral)

The SoC arc fill color follows battery-level conventions:

- **Green** when SoC > 60
- **Amber** when SoC ≤ 60
- **Red** when SoC ≤ 20

## Example: BLUETTI Elite 200 V2

```yaml
type: custom:integrated-ups-flow-card
title: Elite 200 V2
pv:
  entity: sensor.elite_200_v2_01_photovoltaics_input_power
  name: PV
  icon: mdi:solar-panel
  readings:
    - entity: sensor.elite_200_v2_01_photovoltaics_input_voltage
    - entity: sensor.elite_200_v2_01_photovoltaics_input_current
      label: I
      decimals: 1
grid:
  entity: sensor.elite_200_v2_01_grid_input_power
  name: Grid
  icon: mdi:transmission-tower
dc:
  entity: sensor.elite_200_v2_01_direct_current_out_power
  name: DC
  icon: mdi:current-dc
ac:
  entity: sensor.elite_200_v2_01_alternating_current_out_power
  name: AC
  icon: mdi:power-plug
unit:
  soc_entity: sensor.elite_200_v2_01_battery_level
display:
  runtime_entity: sensor.elite_200_v2_01_battery_time_in_minutes
  charge_time_entity: sensor.elite_200_v2_01_full_charge_time_in_minutes
options:
  size: compact
  idle_threshold: 5
  max_power: 2600
buttons:
  - name: AC outlet
    icon: mdi:power-plug
    entity: switch.elite_200_v2_01_ac_outlet
    action: toggle
  - name: DC outlet
    icon: mdi:current-dc
    entity: switch.elite_200_v2_01_dc_outlet
    action: toggle
  - name: Energy
    icon: mdi:transmission-tower
    action: navigate
    navigation_path: /lovelace/energy
  - name: Solar bypass
    entity: switch.elite_200_v2_01_solar_pass
    action: toggle
    confirmation: true
header:
  sensors:
    - entity: sensor.elite_200_v2_01_cabinet_temperature
      label: Cabinet
    - entity: sensor.elite_200_v2_01_cycle_count
      decimals: 0
footer:
  sensors:
    - entity: sensor.elite_200_v2_01_firmware
      label: FW
```

## Theming

The card uses Home Assistant CSS custom properties so it inherits your active
theme. Properties it reads:

- `--ha-card-background` / `--card-background-color` — card background
- `--primary-text-color`, `--secondary-text-color` — labels
- `--primary-color` / `--info-color` — Grid inflow accent
- `--success-color` — PV inflow accent, charging state
- `--warning-color` — AC outflow accent, discharging state
- `--state-binary-sensor-power-on-color` — DC outflow accent
- `--error-color` — low-SoC arc fill
- `--divider-color` — inactive flow lines and arc background
- `--secondary-background-color` — corner icon chip background

## Compatibility notes

- Plain JS, no build step — works on any modern Home Assistant frontend.
- Uses `ResizeObserver` (debounced) and CSS `stroke-dashoffset` animation.
- Cleans up template subscriptions and observers on `disconnectedCallback`.
- `load.entity` from the v0.1 schema is still accepted as an alias for
  `ac.entity` — existing v0.1 configs render in the new layout with the AC
  corner populated and PV/DC shown as "—".

## License

[MIT](./LICENSE)
