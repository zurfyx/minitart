// The dashboard's charts, in plain SVG (D23). Everything named in them came from GitHub or
// from Tart, so it reaches the page through text nodes only.

import { timeTicks } from './view.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Builds an element: `h('a', { href }, 'text', child)`. Strings become text nodes. */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') element.className = value;
    // Through the style object: the page's policy refuses style attributes.
    else if (name === 'style') element.style.cssText = value;
    else if (name === 'onclick') element.addEventListener('click', value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return element;
}

function s(tag, attrs = {}, text) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The legend under a chart: a swatch that mirrors the mark, and a name. */
export function legend(items) {
  return h(
    'div',
    { class: 'legend' },
    items.map(([series, name]) =>
      h('span', { class: 'legend-item' }, h('span', { class: `swatch ${series}` }), name),
    ),
  );
}

/** Redraws `draw` whenever `root` changes width. */
function sized(root, draw) {
  let width = 0;
  const redraw = () => {
    if (root.clientWidth === width) return;
    width = root.clientWidth;
    draw(Math.max(260, width));
  };
  if (!root.observer) {
    root.observer = new ResizeObserver(() => root.redraw?.());
    root.observer.observe(root);
  }
  root.redraw = redraw;
  width = 0;
  redraw();
}

function placeTip(tip, x, width) {
  tip.hidden = false;
  const left = x + 14;
  tip.style.left = `${left + tip.offsetWidth > width ? Math.max(0, x - tip.offsetWidth - 14) : left}px`;
}

/**
 * A stacked area chart of the last hour, with a crosshair whose tooltip lists every series
 * at the pointer. `series`, bottom up: `{ name, values, color }`, `color` 'vm' or 'other'.
 */
export function areaChart(root, { from, to, times, series, max, ticks, format, height, label }) {
  sized(root, (width) => {
    const m = { top: 8, right: 8, bottom: 22, left: 44 };
    const w = width - m.left - m.right;
    const ht = height - m.top - m.bottom;
    const minutes = Math.round((to - from) / 60_000);
    const x = (t) => m.left + ((t - from) / Math.max(1, to - from)) * w;
    const y = (v) => m.top + ht - (Math.min(v, max) / max) * ht;
    const svg = s('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': label,
      tabindex: '0',
    });
    for (const tick of ticks) {
      svg.append(
        s('line', { x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick), class: 'grid' }),
        s(
          'text',
          { x: m.left - 8, y: y(tick) + 4, class: 'tick', 'text-anchor': 'end' },
          format(tick),
        ),
      );
    }
    for (const tick of timeTicks(minutes, w)) {
      const anchor = tick.ago === minutes ? 'start' : tick.ago === 0 ? 'end' : 'middle';
      svg.append(
        s(
          'text',
          { x: x(to - tick.ago * 60_000), y: height - 4, class: 'tick', 'text-anchor': anchor },
          tick.label,
        ),
      );
    }
    const stacks = [];
    if (times.length > 1) {
      let below = times.map(() => 0);
      for (const one of series) {
        const top = one.values.map((value, index) => below[index] + value);
        stacks.push(top);
        const line = top
          .map((v, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`)
          .join('');
        let back = '';
        for (let i = below.length - 1; i >= 0; i--)
          back += `L${x(times[i]).toFixed(1)},${y(below[i]).toFixed(1)}`;
        svg.append(
          s('path', { d: `${line}${back}Z`, class: `area ${one.color}` }),
          s('path', { d: line, class: `line ${one.color}` }),
        );
        below = top;
      }
    }
    const cross = s('line', { y1: m.top, y2: m.top + ht, class: 'cross', visibility: 'hidden' });
    svg.append(cross);
    const dots = series.map((one) => {
      const dot = s('circle', { r: 4, class: `dot ${one.color}`, visibility: 'hidden' });
      svg.append(dot);
      return dot;
    });
    const tip = h('div', { class: 'tip', hidden: true });
    root.replaceChildren(svg, tip);
    if (times.length < 2) {
      root.append(h('p', { class: 'chart-empty' }, 'The first points arrive within a minute.'));
      return;
    }

    let index = times.length - 1;
    const show = (wanted) => {
      index = Math.max(0, Math.min(times.length - 1, wanted));
      const at = x(times[index]);
      cross.setAttribute('x1', at);
      cross.setAttribute('x2', at);
      cross.setAttribute('visibility', 'visible');
      series.forEach((_, k) => {
        dots[k].setAttribute('cx', at);
        dots[k].setAttribute('cy', y(stacks[k][index]));
        dots[k].setAttribute('visibility', 'visible');
      });
      const total = series.reduce((sum, one) => sum + one.values[index], 0);
      const minutesAgo = Math.round((to - times[index]) / 60_000);
      tip.replaceChildren(
        h(
          'div',
          { class: 'tip-time' },
          minutesAgo === 0 ? 'now' : `${minutesAgo} min ago`,
          ' · ',
          new Date(times[index]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ),
        ...[...series]
          .reverse()
          .map((one) =>
            h(
              'div',
              { class: 'tip-row' },
              h('span', { class: `key ${one.color}` }),
              h('strong', { class: 'num' }, format(one.values[index])),
              h('span', { class: 'muted' }, one.name),
            ),
          ),
        h(
          'div',
          { class: 'tip-row total' },
          h('span', { class: 'key' }),
          h('strong', { class: 'num' }, format(total)),
          h('span', { class: 'muted' }, 'in all'),
        ),
      );
      tip.style.top = `${m.top}px`;
      placeTip(tip, at, width);
    };
    const hide = () => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      for (const dot of dots) dot.setAttribute('visibility', 'hidden');
    };
    svg.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const t = from + ((event.clientX - box.left - m.left) / w) * (to - from);
      let nearest = 0;
      for (let i = 1; i < times.length; i++)
        if (Math.abs(times[i] - t) < Math.abs(times[nearest] - t)) nearest = i;
      show(nearest);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(index));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') show(index - 1);
      if (event.key === 'ArrowRight') show(index + 1);
    });
  });
}

/**
 * The VMs of the last hour, a lane per slot: light while a VM starts, solid while it runs
 * its job, and the glyph of how the job ended. A bar opens its log.
 */
export function timeline(root, { lanes, from, to, glyphs, describe, onPick }) {
  sized(root, (width) => {
    const labelWidth = width < 560 ? 64 : 92;
    const lane = 26;
    const m = { top: 4, bottom: 22, right: 14 };
    const height = m.top + lanes.length * lane + m.bottom;
    const w = width - labelWidth - m.right;
    const x = (t) => labelWidth + ((Math.max(t, from) - from) / (to - from)) * w;
    const svg = s('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'group',
      'aria-label': 'VMs over the last hour, one lane per slot',
    });
    const minutes = Math.round((to - from) / 60_000);
    for (const tick of timeTicks(minutes, w)) {
      const at = x(to - tick.ago * 60_000);
      const anchor = tick.ago === minutes ? 'start' : tick.ago === 0 ? 'end' : 'middle';
      svg.append(
        s('line', { x1: at, x2: at, y1: m.top, y2: height - m.bottom, class: 'grid' }),
        s('text', { x: at, y: height - 6, class: 'tick', 'text-anchor': anchor }, tick.label),
      );
    }
    const tip = h('div', { class: 'tip', hidden: true });
    lanes.forEach((one, k) => {
      const top = m.top + k * lane;
      svg.append(
        s('text', { x: 0, y: top + lane / 2 + 4, class: 'lane-name' }, one.name),
        s('line', {
          x1: labelWidth,
          x2: width - m.right,
          y1: top + lane / 2,
          y2: top + lane / 2,
          class: 'lane-rule',
        }),
      );
      for (const item of one.items) {
        const end = item.endAt ?? to;
        const jobAt = item.jobAt ?? end;
        const group = s('g', { class: 'vm-bar', tabindex: '0', role: 'button' });
        group.setAttribute('aria-label', describe(item).join(', '));
        const y0 = top + 5;
        const barHeight = lane - 10;
        group.append(
          // Wider than it looks, so that a short VM can still be pointed at.
          s('rect', {
            x: x(item.startAt) - 3,
            y: top,
            width: Math.max(8, x(end) - x(item.startAt) + 6),
            height: lane,
            class: 'hit',
          }),
          s('rect', {
            x: x(item.startAt),
            y: y0,
            width: Math.max(2, x(jobAt) - x(item.startAt) - 1),
            height: barHeight,
            rx: 3,
            class: 'phase-start',
          }),
        );
        if (item.jobAt !== null) {
          group.append(
            s('rect', {
              x: x(jobAt) + 1,
              y: y0,
              width: Math.max(2, x(end) - x(jobAt) - 1),
              height: barHeight,
              rx: 3,
              class: 'phase-job',
            }),
          );
        }
        const glyph = item.endAt !== null ? glyphs[item.state] : null;
        if (glyph)
          group.append(
            s(
              'text',
              { x: x(end) + 3, y: top + lane / 2 + 4, class: `end-mark ${glyph[0]}` },
              glyph[1],
            ),
          );
        const show = () => {
          tip.replaceChildren(
            ...describe(item).map((line, i) =>
              h('div', { class: i ? 'tip-row' : 'tip-time' }, line),
            ),
          );
          tip.style.top = `${top + lane + 2}px`;
          placeTip(tip, x(item.startAt), width);
        };
        group.addEventListener('pointerenter', show);
        group.addEventListener('focus', show);
        group.addEventListener('pointerleave', () => (tip.hidden = true));
        group.addEventListener('blur', () => (tip.hidden = true));
        group.addEventListener('click', () => onPick(item));
        group.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick(item);
          }
        });
        svg.append(group);
      }
    });
    root.replaceChildren(svg, tip);
  });
}

/** One ratio against its whole: the used part and the free part, 2px apart. */
export function meter(parts, label) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return h(
    'div',
    { class: 'meter', role: 'img', 'aria-label': label },
    parts.map((part) =>
      h('span', { class: `meter-part ${part.color}`, style: `flex: ${part.value / total} 0 0` }),
    ),
  );
}

/**
 * Stacked columns, one a day: each series a block, 2px apart, the top one's end rounded. A
 * column is the pointer's and the keyboard's target; its tooltip lists every series.
 * `days`: [{ label, values: { [key]: number } }]; `series`, bottom up: { key, name, color }.
 */
export function columns(root, { days, series, format, height, label }) {
  sized(root, (width) => {
    const m = { top: 8, right: 8, bottom: 22, left: 44 };
    const w = width - m.left - m.right;
    const ht = height - m.top - m.bottom;
    const totals = days.map((day) =>
      series.reduce((sum, one) => sum + (day.values[one.key] ?? 0), 0),
    );
    const max = niceMax(Math.max(1, ...totals));
    const y = (v) => m.top + ht - (v / max) * ht;
    const slot = w / Math.max(1, days.length);
    const bar = Math.max(1, Math.min(24, slot - 2));
    const svg = s('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'group',
      'aria-label': label,
    });
    for (const tick of [0, max / 2, max]) {
      svg.append(
        s('line', { x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick), class: 'grid' }),
        s(
          'text',
          { x: m.left - 8, y: y(tick) + 4, class: 'tick', 'text-anchor': 'end' },
          format(tick),
        ),
      );
    }
    // A label every so many days, so that they never crowd.
    const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(w / 70))));
    const tip = h('div', { class: 'tip', hidden: true });
    days.forEach((day, index) => {
      const x = m.left + index * slot + (slot - bar) / 2;
      // Every so many days, and the last; a regular one too near the last gives way to it.
      const last = index === days.length - 1;
      if (last || (index % every === 0 && days.length - 1 - index >= every)) {
        svg.append(
          s(
            'text',
            { x: x + bar / 2, y: height - 4, class: 'tick', 'text-anchor': 'middle' },
            day.label,
          ),
        );
      }
      const group = s('g', { class: 'column', tabindex: '0', role: 'img' });
      group.setAttribute(
        'aria-label',
        `${day.label}: ${series.map((one) => `${one.name} ${format(day.values[one.key] ?? 0)}`).join(', ')}`,
      );
      group.append(
        s('rect', { x: m.left + index * slot, y: m.top, width: slot, height: ht, class: 'hit' }),
      );
      let below = 0;
      const drawn = series.filter((one) => (day.values[one.key] ?? 0) > 0);
      drawn.forEach((one, k) => {
        const value = day.values[one.key] ?? 0;
        const top = y(below + value);
        // 2px of surface between blocks; the top block's end is rounded, the baseline square.
        const gap = k > 0 ? 2 : 0;
        const blockHeight = Math.max(1, y(below) - top - gap);
        const last = k === drawn.length - 1;
        group.append(
          s('path', {
            d: columnPath(x, top, bar, blockHeight, last ? Math.min(4, bar / 2, blockHeight) : 0),
            class: `block ${one.color}`,
          }),
        );
        below += value;
      });
      const show = () => {
        tip.replaceChildren(
          h('div', { class: 'tip-time' }, day.label),
          ...[...series]
            .reverse()
            .map((one) =>
              h(
                'div',
                { class: 'tip-row' },
                h('span', { class: `key ${one.color}` }),
                h('strong', { class: 'num' }, format(day.values[one.key] ?? 0)),
                h('span', { class: 'muted' }, one.name),
              ),
            ),
        );
        tip.style.top = `${m.top}px`;
        placeTip(tip, x + bar, width);
      };
      group.addEventListener('pointerenter', show);
      group.addEventListener('focus', show);
      group.addEventListener('pointerleave', () => (tip.hidden = true));
      group.addEventListener('blur', () => (tip.hidden = true));
      svg.append(group);
    });
    root.replaceChildren(svg, tip);
  });
}

/** A rectangle from the baseline up, its top corners rounded by `r`. */
function columnPath(x, top, width, height, r) {
  const bottom = top + height;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`;
}

/**
 * A round top for an axis, at or above `value` and at least 2, whose half is a whole number
 * too: 2, 4, 6, 10, 20, 40, 60, 100 and so on.
 */
function niceMax(value) {
  const wanted = Math.max(2, value);
  const power = 10 ** Math.floor(Math.log10(wanted));
  for (const step of [1, 2, 4, 6, 10]) {
    const top = step * power;
    if (top >= wanted && top % 2 === 0) return top;
  }
  return 10 * power;
}
