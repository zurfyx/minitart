// The dashboard. It draws what /api/events sends and posts settings back; it holds no state
// of its own beyond which log is open. Everything from GitHub (job, workflow and repo names)
// is text someone else wrote, so it only ever reaches the page as text nodes.

import { areaChart, columns, h, meter, timeline } from './charts.js';
import {
  compareProviders,
  dayLabel,
  daysCounted,
  everyDay,
  macCost,
  MONTH_DAYS,
  perMonth,
  totals,
  usd,
} from './cost.js';
import { GB, headline, lanes, stats } from './view.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const POOL = { linux: 'Linux', macos: 'macOS' };

/** A state is a glyph and a word, in the state's colour: never the colour alone. */
const STATES = {
  cloning: ['busy', '◌', 'Starting'],
  booting: ['busy', '◌', 'Booting'],
  waiting: ['muted', '○', 'Waiting for its job'],
  running: ['busy', '●', 'Running'],
  stopping: ['muted', '◌', 'Stopping'],
  queued: ['muted', '○', 'Queued'],
  success: ['ok', '✓', 'Passed'],
  failure: ['bad', '✕', 'Failed'],
  cancelled: ['muted', '–', 'Cancelled'],
  lost: ['bad', '✕', 'Lost'],
  watching: ['ok', '●', 'Watching'],
  off: ['muted', '○', 'Not served'],
  public: ['warn', '!', 'Public, skipped'],
  ok: ['ok', '✓', 'OK'],
  fix: ['warn', '!', 'To fix'],
  note: ['muted', '○', 'Note'],
};

function status(key, word) {
  // `key` can be a word from GitHub (a job's conclusion): only the table's own entries count.
  const [tone, glyph, label] = Object.hasOwn(STATES, key) ? STATES[key] : ['muted', '·', key];
  return h(
    'span',
    { class: `status ${tone}` },
    h('span', { 'aria-hidden': 'true' }, glyph),
    ` ${word ?? label}`,
  );
}

function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function ago(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** A time that keeps counting between updates: `tick` rewrites every one each second. */
function clock(since) {
  return h('time', { class: 'num', 'data-since': String(since) }, duration(Date.now() - since));
}

function jobName(job, fallback) {
  const name = job?.name ?? fallback;
  // Only ever a link to GitHub, whatever the URL says.
  return job?.url?.startsWith('https://github.com/')
    ? h('a', { href: job.url, target: '_blank', rel: 'noreferrer' }, name)
    : h('span', {}, name);
}

function row(...cells) {
  return h('div', { class: 'row' }, ...cells);
}

/** A job's name, and under it where it comes from and why it waits, if it does. */
function jobCell(name, repo, workflow, pool, note, actor) {
  return h(
    'span',
    { class: 'main' },
    name,
    h(
      'span',
      { class: 'meta' },
      [repo, workflow, POOL[pool]].filter(Boolean).join(' · '),
      actor ? [' · by ', author(actor)] : null,
    ),
    note ? h('span', { class: 'note' }, note) : null,
  );
}

/** Who a job runs for: a link to them on GitHub, when the name is one GitHub would give. */
function author(login) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)
    ? h(
        'a',
        {
          class: 'author',
          // A bot's page is its app's; a person's is their own.
          href: login.endsWith('[bot]')
            ? `https://github.com/apps/${login.slice(0, -'[bot]'.length)}`
            : `https://github.com/${login}`,
          target: '_blank',
          rel: 'noreferrer',
        },
        login,
      )
    : h('span', { class: 'author' }, login);
}

/** An empty state where a chart was: it is not drawn back over it when the page resizes. */
function emptyChart(id, text) {
  const root = $(id);
  root.redraw = null;
  root.replaceChildren(empty(text));
}

function empty(text) {
  return h('p', { class: 'empty' }, text);
}

const HOUR = 60 * 60_000;

/** The glyph a finished VM's bar ends in: the same as its state's. */
const GLYPHS = Object.fromEntries(
  ['success', 'failure', 'cancelled', 'lost'].map((key) => [key, [STATES[key][0], STATES[key][1]]]),
);

let state = null;
/** The newest finished job last drawn, to notice one more. */
let lastDone = '';
/** The last hour of CPU, memory and disk, read apart from the state (/api/resources). */
let resources = null;
/** The log on screen: a VM's own output, or a finished job's log from GitHub. */
let openLog = null;
let logTimer = null;

function render() {
  if (!state) return;
  const { vms, queued, done, repos, settings, health } = state;

  $('machine').textContent =
    `${state.machine.name} · ${state.machine.cpus} cores · ${Math.round(state.machine.memoryBytes / GB)} GB`;

  $('setup').hidden = state.app !== null || state.repos.length > 0;
  $('drain').textContent = state.draining ? 'Resume' : 'Drain';

  const said = headline(state);
  // The headline says the most important thing; whatever else needs the owner is said here.
  const words = `${said.lead} ${said.point ?? ''}`.toLowerCase();
  const alerts = [];
  if (state.network === 'shared') {
    alerts.push('Started with --unsafe-shared-network: jobs can reach your LAN.');
  }
  if (state.blocked && !words.includes(state.blocked.toLowerCase())) {
    alerts.push(`No VM is started until this is put right. ${state.blocked}`);
  }
  if (state.githubError && !words.includes(state.githubError.toLowerCase())) {
    alerts.push(`GitHub: ${state.githubError}`);
  }
  if (state.draining && said.lead !== 'Draining.') {
    alerts.push('Draining: the jobs that are running finish, and no new one starts.');
  }
  if (state.shortOfMemory && !words.includes(state.shortOfMemory.toLowerCase())) {
    alerts.push(`${state.shortOfMemory}: jobs wait until there is room.`);
  }
  $('alerts').replaceChildren(
    ...alerts.map((text) => h('p', { class: 'alert' }, status('fix', text))),
  );

  $('headline').replaceChildren(
    said.lead,
    said.point ? ' ' : '',
    said.point ? h('em', {}, said.point) : '',
  );
  const figures = stats(state);
  $('stat-running').replaceChildren(
    String(figures.running),
    figures.running ? h('small', {}, ` · ${figures.linux} Linux, ${figures.macos} macOS`) : '',
  );
  $('stat-queued').textContent = String(figures.queued);
  $('stat-today').replaceChildren(
    String(figures.today),
    figures.lost ? h('small', {}, ` · ${figures.lost} lost`) : '',
  );
  $('stat-wait').replaceChildren(
    figures.medianWaitMs === null ? '–' : duration(figures.medianWaitMs),
  );

  drawTimeline();

  const jobs = [
    ...vms.map((vm) =>
      row(
        status(vm.status),
        jobCell(
          jobName(vm.job, vm.status === 'running' ? 'A job' : `For ${vm.repo}`),
          vm.repo,
          vm.job?.workflow,
          vm.pool,
          null,
          vm.job?.actor,
        ),
        clock(vm.jobAt ?? vm.createdAt),
        logButton({ kind: 'vm', name: vm.name, title: vm.name }),
      ),
    ),
    ...queued.map((job) =>
      row(
        status('queued'),
        jobCell(jobName(job), job.repo, job.workflow, job.pool, job.note, job.actor),
        clock(Date.parse(job.createdAt)),
      ),
    ),
    ...done.slice(0, 10).map((job) =>
      row(
        status(job.conclusion),
        jobCell(jobName(job.job), job.repo, job.job.workflow, job.pool, null, job.job.actor),
        // How long it took, as a running job shows how long it has run, and when it ended.
        h(
          'span',
          { class: 'took' },
          h('span', { class: 'num' }, duration(job.endedAt - (job.jobAt ?? job.startedAt))),
          h('span', { class: 'ended num' }, ago(state.now - job.endedAt)),
        ),
        job.job.id !== null
          ? logButton({ kind: 'job', id: job.job.id, title: `${job.job.name} · ${job.repo}` })
          : logButton({ kind: 'vm', name: job.vm, title: job.vm }),
      ),
    ),
  ];
  $('jobs').replaceChildren(...(jobs.length ? jobs : [empty('No job has run yet.')]));
  drawReposToday();
  // The Usage view's numbers can come before the state it also needs: drawn once both are in.
  if (costData && !costDrawn && route().view === 'usage') drawCost();

  // A job that ends shows on the first page of the Jobs view, if that is what is open.
  const newest = done[0]?.vm ?? '';
  if (newest !== lastDone) {
    lastDone = newest;
    const open = route();
    if (open.view === 'jobs' && open.page === 1) void loadJobs();
    if (open.view === 'jobs' || open.view === 'mac') void loadStorage();
    if (open.view === 'usage') void loadCost();
  }

  $('repos').replaceChildren(
    ...(repos.length
      ? repos.map((repo) =>
          row(
            status(repo.state),
            h(
              'span',
              { class: 'main' },
              repo.fullName,
              repo.error ? h('span', { class: 'note' }, status('fix', repo.error)) : null,
            ),
            repo.state !== 'public'
              ? h(
                  'button',
                  { type: 'button', class: 'quiet', onclick: () => toggleServed(repo) },
                  repo.state === 'watching' ? 'Stop serving' : 'Serve',
                )
              : null,
          ),
        )
      : [empty(state.app ? 'The GitHub App is not installed on any repo yet.' : 'No repos yet.')]),
  );
  const help = $('repos-help');
  help.replaceChildren();
  if (state.app) {
    help.append(
      'A repo is served when the GitHub App is installed on it and it is turned on here. ',
      h(
        'a',
        { href: `${state.app.htmlUrl}/installations/new`, target: '_blank', rel: 'noreferrer' },
        'Add or remove repos on GitHub',
      ),
      '.',
    );
  }

  $('health').replaceChildren(
    ...health.map((check) =>
      row(
        status(check.ok ? 'ok' : check.optional ? 'note' : 'fix', check.title),
        h(
          'span',
          { class: 'main' },
          check.detail,
          check.fix ? h('code', { class: 'fix' }, check.fix) : null,
        ),
      ),
    ),
  );

  const form = /** @type {HTMLFormElement} */ ($('settings'));
  // Never overwrite a field while it is being typed in.
  if (!form.contains(document.activeElement) && !form.dataset.dirty) {
    form.elements.linux.value = settings.linux.max;
    form.elements.macos.value = settings.macos.max;
    form.elements.cpu.value = settings.vm.cpu;
    form.elements.cpu.max = state.machine.cpus;
    form.elements.memory.value = Math.round(settings.vm.memoryMb / 1024);
    form.elements.poll.value = settings.pollSeconds;
    form.elements.idle.value = settings.idleSeconds;
    form.elements.public.checked = settings.allowPublicRepos;
    const keep = form.elements.keepCharts;
    const days = settings.keepChartsDays === null ? '' : String(settings.keepChartsDays);
    // A number of days set in the file by hand is shown as it is.
    if (![...keep.options].some((option) => option.value === days)) {
      keep.append(h('option', { value: days }, `${days} days`));
    }
    keep.value = days;
  }

  $('activity').replaceChildren(
    ...(state.log.length
      ? state.log
          .slice(-40)
          .reverse()
          .map((line) =>
            row(
              h('time', { class: 'muted num' }, new Date(line.at).toLocaleTimeString()),
              h('span', { class: line.level === 'warn' ? 'main warn-text' : 'main' }, line.text),
            ),
          )
      : [empty('Nothing has happened yet.')]),
  );
}

/**
 * Each repo served, or with a job today: how many of its jobs ended today, how many failed
 * or were lost, and how many run now. A row opens the repo's jobs of today.
 */
function drawReposToday() {
  // GitHub ignores case in names: one row a repo, under GitHub's own spelling when known.
  const today = new Map((state.today.repos ?? []).map((one) => [one.repo.toLowerCase(), one]));
  const spelled = new Map();
  for (const name of [
    ...state.settings.repos,
    ...(state.today.repos ?? []).map((one) => one.repo),
    ...state.vms.map((vm) => vm.repo),
  ]) {
    spelled.set(name.toLowerCase(), name);
  }
  const names = [...spelled.keys()].sort((a, b) => a.localeCompare(b));
  $('repos-today').replaceChildren(
    ...(names.length
      ? names.map((key) => {
          const name = spelled.get(key);
          const counts = today.get(key);
          const running = state.vms.filter(
            (vm) => vm.repo.toLowerCase() === key && vm.status === 'running',
          ).length;
          const facts = counts
            ? [
                `${counts.jobs} ${counts.jobs === 1 ? 'job' : 'jobs'}`,
                ...(counts.failed ? [`${counts.failed} failed`] : []),
                ...(counts.lost ? [`${counts.lost} lost`] : []),
              ].join(' · ')
            : 'No jobs yet';
          return row(
            h(
              'span',
              { class: 'main' },
              h('a', { href: jobsHash({ page: 1, repo: name, result: '', jobDays: 1 }) }, name),
              h('span', { class: 'meta' }, facts),
            ),
            h('span', { class: 'muted num' }, running ? `${running} running` : ''),
          );
        })
      : [empty('No repo is served yet.')]),
  );
}

/** Whether the pointer or the keyboard is on `root`: then it is not redrawn under them. */
function inUse(root) {
  return root.matches(':hover') || root.contains(document.activeElement);
}

let timelineDrawn = '';
let timelineAt = 0;

function drawTimeline() {
  const root = $('timeline');
  const to = state.now;
  const from = to - HOUR;
  const laneList = lanes(state, from);
  // Redrawn when a VM comes, goes or takes its job, and every ten seconds as time moves.
  const drawn = JSON.stringify(
    laneList.map((lane) => lane.items.map((item) => [item.key, item.state, item.jobAt])),
  );
  if (drawn === timelineDrawn && to - timelineAt < 10_000) return;
  if (inUse(root)) return;
  timelineDrawn = drawn;
  timelineAt = to;
  timeline(root, {
    lanes: laneList,
    from,
    to,
    glyphs: GLYPHS,
    describe: (item) => [
      `${item.repo}${item.workflow ? ` · ${item.workflow}` : ''}${item.actor ? ` · by ${item.actor}` : ''}`,
      item.name ?? (item.jobAt === null ? 'Waiting for its job' : 'A job'),
      `Starting: ${duration((item.jobAt ?? item.endAt ?? to) - item.startAt)}`,
      ...(item.jobAt !== null ? [`Job: ${duration((item.endAt ?? to) - item.jobAt)}`] : []),
      STATES[item.state]?.[2] ?? item.state,
    ],
    onPick: (item) => showLog({ ...item.log, title: `${item.name ?? item.key} · ${item.repo}` }),
  });
}

/** Megabits a second from bytes a second, as the network chart writes them. */
function mbps(bytes) {
  const value = (bytes * 8) / 1e6;
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)} Mbit/s`;
}

/** A round top for a chart of `peak`: 1, 2 or 5 times a power of ten. */
function niceMax(peak) {
  if (!(peak > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(peak));
  return [1, 2, 5, 10].map((one) => one * power).find((one) => one >= peak) ?? 10 * power;
}

/** A disk chart's scale: the values' range with room around it, in round gigabytes. */
function diskRange(values, totalMb) {
  const known = values.filter((value) => value > 0);
  if (!known.length) return { min: 0, max: totalMb, ticks: [0, totalMb / 2, totalMb] };
  const low = Math.min(...known);
  const high = Math.max(...known);
  const pad = Math.max(8 * 1024, (high - low) * 0.5);
  const step = 4 * 1024;
  const min = Math.max(0, Math.floor((low - pad) / step) * step);
  const max = Math.min(totalMb, Math.ceil((high + pad) / step) * step);
  return { min, max, ticks: [min, (min + max) / 2, max] };
}

/** Gigabytes from megabytes, as the charts write them. */
function gb(mb) {
  const value = mb / 1024;
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)} GB`;
}

function drawResources() {
  if (!resources) return;
  const points = resources.points;
  const times = points.map((point) => point.at);
  // The hour up to the newest point, as the timeline shows it, however few points there are.
  const to = points.at(-1)?.at ?? Date.now();
  const span = { from: to - HOUR, to };
  const last = points.at(-1);
  const memoryGb = Math.round(resources.memoryBytes / GB);
  $('cpu-now').textContent = last ? `${Math.round(last.cpuVms + last.cpuOther)}% now` : '';
  $('memory-now').textContent = last
    ? `${gb(last.memVms + last.memOther)} of ${memoryGb} GB now`
    : '';
  const series = (vms, other) => [
    { name: 'Everything else', values: points.map(other), color: 'other' },
    { name: 'minitart VMs', values: points.map(vms), color: 'vm' },
  ];
  if (!inUse($('cpu'))) {
    areaChart($('cpu'), {
      ...span,
      times,
      series: series(
        (point) => point.cpuVms,
        (point) => point.cpuOther,
      ),
      max: 100,
      ticks: [0, 50, 100],
      format: (value) => `${Math.round(value)}%`,
      height: 150,
      label: `CPU over the last hour${last ? `, ${Math.round(last.cpuVms + last.cpuOther)}% now` : ''}`,
    });
  }
  if (!inUse($('memory'))) {
    areaChart($('memory'), {
      ...span,
      times,
      series: series(
        (point) => point.memVms,
        (point) => point.memOther,
      ),
      max: memoryGb * 1024,
      ticks: [0, (memoryGb / 2) * 1024, memoryGb * 1024],
      format: gb,
      height: 150,
      label: `Memory over the last hour${last ? `, ${gb(last.memVms + last.memOther)} now` : ''}`,
    });
  }

  // Down, by who: what a job fetches is what CI waits on. Up is in the heading.
  const down = (point) => (point.netVmsDown ?? 0) + (point.netOtherDown ?? 0);
  const up = (point) => (point.netVmsUp ?? 0) + (point.netOtherUp ?? 0);
  $('network-now').textContent = last ? `${mbps(down(last))} down · ${mbps(up(last))} up now` : '';
  if (!inUse($('network'))) {
    const top = niceMax((Math.max(0, ...points.map(down)) * 8) / 1e6) * (1e6 / 8);
    areaChart($('network'), {
      ...span,
      times,
      series: series(
        (point) => point.netVmsDown ?? 0,
        (point) => point.netOtherDown ?? 0,
      ),
      max: top,
      ticks: [0, top / 2, top],
      format: mbps,
      height: 150,
      label: `Network down over the last hour${last ? `, ${mbps(down(last))} now` : ''}`,
    });
  }

  // Space in use on the disk VMs are on: not split by who, since a VM shares its image's
  // blocks until it writes. The VMs show as rises while they run and drops when deleted.
  const diskTotalMb = resources.disk ? resources.disk.totalBytes / 1024 ** 2 : null;
  $('disk-now').textContent =
    last?.diskUsed !== undefined && diskTotalMb
      ? `${gb(diskTotalMb - last.diskUsed)} free of ${gb(diskTotalMb)}`
      : '';
  if (!diskTotalMb || !points.some((point) => point.diskUsed > 0)) {
    emptyChart('disk-chart', 'Not measured yet.');
  } else if (!inUse($('disk-chart'))) {
    areaChart($('disk-chart'), {
      ...span,
      times,
      series: [
        { name: 'In use', values: points.map((point) => point.diskUsed ?? 0), color: 'whole' },
      ],
      // The hour's range, not the whole disk: a VM's few gigabytes would not show on a terabyte.
      ...diskRange(
        points.map((point) => point.diskUsed ?? 0),
        diskTotalMb,
      ),
      format: gb,
      height: 150,
      label: `Disk in use over the last hour${last?.diskUsed !== undefined ? `, ${gb(last.diskUsed)} now` : ''}`,
    });
  }

  drawStorage();
}

async function loadResources() {
  try {
    const response = await fetch('/api/resources');
    if (!response.ok) return;
    resources = await response.json();
    drawResources();
  } catch {
    // The state's own connection says when minitart cannot be reached.
  }
}

function logButton(target) {
  return h('button', { type: 'button', class: 'quiet', onclick: () => showLog(target) }, 'Log');
}

async function loadLog() {
  if (!openLog) return;
  const target = openLog;
  const url = target.kind === 'vm' ? `/api/vms/${target.name}/log` : `/api/jobs/${target.id}/log`;
  const pre = $('log');
  try {
    const response = await fetch(url);
    const text = await response.text();
    if (openLog !== target) return;
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = response.ok
      ? text || 'Nothing printed yet.'
      : `Could not read the log: ${text}`;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch {
    if (openLog === target) pre.textContent = 'Could not reach minitart.';
  }
}

function showLog(target) {
  openLog = target;
  $('log-title').textContent = `Log · ${target.title}`;
  $('log').textContent = 'Loading…';
  if (!logDialog.open) logDialog.showModal();
  clearInterval(logTimer);
  // A VM's log grows while it runs; a finished job's log does not.
  if (target.kind === 'vm') logTimer = setInterval(loadLog, 2000);
  void loadLog().then(() => {
    $('log').scrollTop = $('log').scrollHeight;
  });
}

const logDialog = /** @type {HTMLDialogElement} */ ($('log-dialog'));
$('log-close').addEventListener('click', () => logDialog.close());
// Closed by its button, by Escape, or by a click outside it: one that starts and ends on
// the backdrop, so that selecting the log's text and letting go outside it closes nothing.
const outside = (event) => {
  const box = logDialog.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
};
let pressedOutside = false;
logDialog.addEventListener('pointerdown', (event) => {
  pressedOutside = outside(event);
});
logDialog.addEventListener('click', (event) => {
  if (pressedOutside && outside(event)) logDialog.close();
  pressedOutside = false;
});
logDialog.addEventListener('close', () => {
  openLog = null;
  clearInterval(logTimer);
});

async function saveSettings(patch) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await response.text());
  state = await response.json();
  render();
}

async function setDraining(draining) {
  const response = await fetch('/api/drain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draining }),
  });
  if (!response.ok) return alert(await response.text());
  state = await response.json();
  render();
}

function toggleServed(repo) {
  // Names ignore case on GitHub, so the list is matched that way too.
  const name = repo.fullName.toLowerCase();
  const served = new Set(state.settings.repos.filter((listed) => listed.toLowerCase() !== name));
  if (repo.state !== 'watching') served.add(repo.fullName);
  saveSettings({ repos: [...served].sort() }).catch((error) => alert(error.message));
}

const settingsForm = /** @type {HTMLFormElement} */ ($('settings'));
settingsForm.addEventListener('input', () => {
  settingsForm.dataset.dirty = 'yes';
  $('settings-note').textContent = '';
});
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = (name) => Number(settingsForm.elements[name].value);
  const now = state.settings;
  // Only what this form changed is sent, so a save here never undoes a change made in
  // another window since the form was filled in.
  const patch = {};
  if (value('linux') !== now.linux.max) patch.linux = { max: value('linux') };
  if (value('macos') !== now.macos.max) patch.macos = { max: value('macos') };
  const vm = {};
  if (value('cpu') !== now.vm.cpu) vm.cpu = value('cpu');
  if (value('memory') * 1024 !== now.vm.memoryMb) vm.memoryMb = value('memory') * 1024;
  if (Object.keys(vm).length > 0) patch.vm = vm;
  if (value('poll') !== now.pollSeconds) patch.pollSeconds = value('poll');
  if (value('idle') !== now.idleSeconds) patch.idleSeconds = value('idle');
  const allowPublic = settingsForm.elements.public.checked;
  if (allowPublic !== now.allowPublicRepos) patch.allowPublicRepos = allowPublic;
  const keep = settingsForm.elements.keepCharts.value;
  const keepDays = keep === '' ? null : Number(keep);
  if (keepDays !== now.keepChartsDays) patch.keepChartsDays = keepDays;
  if (Object.keys(patch).length === 0) {
    delete settingsForm.dataset.dirty;
    $('settings-note').textContent = 'Nothing to save.';
    return;
  }
  saveSettings(patch).then(
    () => {
      delete settingsForm.dataset.dirty;
      $('settings-note').textContent = 'Saved. New VMs use it.';
    },
    (error) => {
      $('settings-note').textContent = error.message;
    },
  );
});

// Creating the GitHub App: ask minitart for the manifest, then post it to GitHub as a form,
// which is how GitHub's manifest flow takes it.
$('create-app').addEventListener('submit', async (event) => {
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  if (form.dataset.ready) return;
  event.preventDefault();
  const response = await fetch('/setup/manifest');
  if (!response.ok) return alert(await response.text());
  const { action, manifest } = await response.json();
  form.action = action;
  form.elements.manifest.value = manifest;
  form.dataset.ready = 'yes';
  form.submit();
});

$('drain').addEventListener('click', () => {
  if (state) void setDraining(!state.draining);
});

// Views: Now, Jobs and This Mac, one at a time, named in the address so that a link, the
// back button and an installed app's reload all land where they were.

/** The History view's ranges, in days. */
const HISTORY_RANGES = [1, 7, 30, 90, 365];

/** The Jobs view's ranges, in days: today, and back from it. */
const JOB_RANGES = [1, 7, 30, 90];

/** The view and, for Jobs, the page and filters, from `#jobs?page=2&repo=octo/app`. */
function route() {
  const [name, query = ''] = location.hash.replace(/^#/, '').split('?');
  const view = ['now', 'jobs', 'history', 'usage', 'mac'].includes(name) ? name : 'now';
  const params = new URLSearchParams(query);
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const days = Number(params.get('days'));
  return {
    view,
    page,
    repo: params.get('repo') ?? '',
    result: params.get('result') ?? '',
    days: RANGES.includes(days) ? days : 30,
    // The Jobs view's range: a few days back, or every job kept.
    jobDays: JOB_RANGES.includes(days) ? days : 0,
    // The History view's: a day by default, and where it ends, now unless stepped back.
    historyDays: HISTORY_RANGES.includes(days) ? days : 1,
    historyEnd: Number.parseInt(params.get('end') ?? '', 10) || null,
  };
}

function jobsHash({ page, repo, result, jobDays }) {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (result) params.set('result', result);
  if (jobDays) params.set('days', String(jobDays));
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return `#jobs${query ? `?${query}` : ''}`;
}

function showView() {
  const { view } = route();
  for (const main of document.querySelectorAll('main[data-view]')) {
    main.hidden = main.dataset.view !== view;
  }
  for (const link of document.querySelectorAll('nav.views a')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'jobs') void loadJobs();
  // Jobs says what the history takes, and This Mac lists it.
  if (view === 'jobs' || view === 'mac') void loadStorage();
  if (view === 'usage') void loadCost();
  if (view === 'history') void loadHistory();
  // Charts drawn while hidden have no width: draw them again now that they show.
  if (view === 'now') {
    timelineDrawn = '';
    if (state) drawTimeline();
    drawResources();
  }
}

/** The History view's range on screen, and what was last asked for. */
let historyData = null;
let historyAsked = '';

async function loadHistory() {
  const { historyDays, historyEnd } = route();
  const params = new URLSearchParams({ days: String(historyDays) });
  if (historyEnd) params.set('end', String(historyEnd));
  const asked = params.toString();
  historyAsked = asked;
  // Another range ends where this one does, so a step back stays back.
  for (const link of document.querySelectorAll('#history-range a')) {
    link.href = historyHash(Number(link.dataset.days), historyEnd);
    if (Number(link.dataset.days) === historyDays) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  try {
    const response = await fetch(`/api/history?${asked}`);
    const body = response.ok ? await response.json() : null;
    if (historyAsked !== asked) return;
    if (!body) {
      emptyChart('history-vms', 'Could not read the history.');
      return;
    }
    historyData = body;
    drawHistory();
  } catch {
    if (historyAsked === asked) emptyChart('history-vms', 'Could not reach minitart.');
  }
}

function historyHash(days, end) {
  const params = new URLSearchParams({ days: String(days) });
  if (end) params.set('end', String(end));
  return `#history?${params}`;
}

function drawHistory() {
  const data = historyData;
  if (!data) return;
  // A step with nothing kept is left as a gap, not drawn across.
  const span = {
    from: data.from,
    to: data.to,
    dates: data.stepMs >= 24 * 60 * 60_000 ? 'days' : true,
    gapMs: data.stepMs * 1.5,
  };
  const day = (at, withYear) =>
    new Date(at).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
      hour: '2-digit',
      minute: '2-digit',
    });
  const minutes = Math.round(data.stepMs / 60_000);
  const date = (at) =>
    new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  // A point a day runs from a midnight to the day before the last one's.
  $('history-span').textContent =
    minutes >= 1440
      ? `${date(data.from)} to ${date(data.to - 1)} · a point a day`
      : `${day(data.from, true)} to ${day(data.to)} · a point every ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}`;

  // Earlier, as far back as anything is kept; later, up to now.
  const length = data.days * 24 * 60 * 60_000;
  const earlier = data.oldestAt !== null && data.from > data.oldestAt;
  // The last step holds now, so a range ending at it or after is the latest.
  const atNow = data.to >= Date.now();
  $('history-pager').replaceChildren(
    earlier
      ? h('a', { href: historyHash(data.days, data.from) }, '← Earlier')
      : h('span', { class: 'muted' }, '← Earlier'),
    atNow
      ? h('span')
      : h(
          'a',
          {
            href: historyHash(data.days, data.to + length >= Date.now() ? null : data.to + length),
          },
          'Later →',
        ),
  );

  // VMs up, by kind, from the jobs kept.
  const vmTimes = data.vms.map((step) => step.at);
  const busiest = Math.max(0, ...data.vms.map((step) => step.most));
  $('history-vms-peak').textContent = busiest ? `busiest: ${busiest} at once` : '';
  // Drawn as each step's average, so its top is the highest average, not the most at once.
  const vmTop = Math.max(1, Math.ceil(Math.max(0, ...data.vms.map((s) => s.linux + s.macos))));
  if (!data.vms.length) emptyChart('history-vms', 'Nothing kept for this range yet.');
  else
    areaChart($('history-vms'), {
      ...span,
      times: vmTimes,
      series: [
        {
          name: 'Linux',
          values: data.vms.map((step) => step.linux),
          peaks: data.vms.map((step) => step.linuxMost),
          color: 'linux',
        },
        {
          name: 'macOS',
          values: data.vms.map((step) => step.macos),
          peaks: data.vms.map((step) => step.macosMost),
          color: 'macos',
        },
      ],
      max: vmTop,
      ticks: [0, vmTop / 2, vmTop],
      format: (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1)),
      height: 160,
      label: `VMs up from ${day(data.from)} to ${day(data.to)}`,
    });

  const samples = data.samples;
  const times = samples.map((one) => one.at);
  const none = !samples.length;
  const chart = (id, options) => {
    if (none) {
      emptyChart(id, 'Nothing kept for this range yet.');
      return;
    }
    areaChart($(id), { ...span, times, height: 150, ...options });
  };
  const pair = (vms, other) => [
    {
      name: 'Everything else',
      values: samples.map((one) => one[other]),
      peaks: samples.map((one) => one[`${other}Max`]),
      color: 'other',
    },
    {
      name: 'minitart VMs',
      values: samples.map((one) => one[vms]),
      peaks: samples.map((one) => one[`${vms}Max`]),
      color: 'vm',
    },
  ];
  const peakOf = (key) => Math.max(0, ...samples.map((one) => one[`${key}Max`]));
  $('history-cpu-now').textContent = none ? '' : `peak ${Math.round(peakOf('cpuVms'))}% by the VMs`;
  chart('history-cpu', {
    series: pair('cpuVms', 'cpuOther'),
    max: 100,
    ticks: [0, 50, 100],
    format: (value) => `${Math.round(value)}%`,
    label: 'CPU over the range',
  });
  const memoryGb = data.memoryBytes ? Math.round(data.memoryBytes / GB) : null;
  $('history-memory-now').textContent = none
    ? ''
    : `peak ${gb(peakOf('memVms'))} by the VMs${memoryGb ? `, of ${memoryGb} GB` : ''}`;
  chart('history-memory', {
    series: pair('memVms', 'memOther'),
    max: (memoryGb ?? 64) * 1024,
    ticks: [0, ((memoryGb ?? 64) / 2) * 1024, (memoryGb ?? 64) * 1024],
    format: gb,
    label: 'Memory over the range',
  });
  const netTop =
    niceMax((Math.max(0, ...samples.map((one) => one.netVmsDown + one.netOtherDown)) * 8) / 1e6) *
    (1e6 / 8);
  $('history-network-now').textContent = none
    ? ''
    : `peak ${mbps(peakOf('netVmsDown'))} down by the VMs`;
  chart('history-network', {
    series: pair('netVmsDown', 'netOtherDown'),
    max: netTop,
    ticks: [0, netTop / 2, netTop],
    format: mbps,
    label: 'Network down over the range',
  });
  const diskTotalMb = data.diskBytes ? data.diskBytes / 1024 ** 2 : null;
  $('history-disk-now').textContent =
    none || !diskTotalMb ? '' : `most in use ${gb(peakOf('diskUsed'))}, of ${gb(diskTotalMb)}`;
  const used = samples.map((one) => one.diskUsed);
  if (!diskTotalMb || !used.some((value) => value > 0)) {
    emptyChart('history-disk', 'Not measured for this range.');
  } else {
    chart('history-disk', {
      series: [
        {
          name: 'In use',
          values: used,
          peaks: samples.map((one) => one.diskUsedMax),
          color: 'whole',
        },
      ],
      ...diskRange(used, diskTotalMb),
      format: gb,
      label: 'Disk in use over the range',
    });
  }
}

/** The page of the Jobs view on screen, and what was last asked for. */
let jobPage = null;
let jobsAsked = '';

async function loadJobs() {
  const wanted = route();
  const params = new URLSearchParams({ page: String(wanted.page) });
  if (wanted.repo) params.set('repo', wanted.repo);
  if (wanted.result) params.set('result', wanted.result);
  if (wanted.jobDays) params.set('days', String(wanted.jobDays));
  const asked = params.toString();
  jobsAsked = asked;
  try {
    const response = await fetch(`/api/jobs?${asked}`);
    // Each await is a moment for a newer ask to start: only the newest is drawn.
    const body = response.ok ? await response.json() : await response.text();
    if (jobsAsked !== asked) return;
    if (!response.ok) {
      $('history').replaceChildren(empty(`Could not read the jobs: ${body}`));
      return;
    }
    // A page past the end (an old link, or jobs gone a year on) becomes the last one.
    if (body.total > 0 && wanted.page > body.pages) {
      location.replace(jobsHash({ ...wanted, page: body.pages }));
      return;
    }
    jobPage = body;
    drawJobs(wanted);
  } catch {
    if (jobsAsked === asked) $('history').replaceChildren(empty('Could not reach minitart.'));
  }
}

function dateTime(at) {
  return new Date(at).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function drawJobs(wanted) {
  const form = /** @type {HTMLFormElement} */ ($('job-filters'));
  const repoSelect = /** @type {HTMLSelectElement} */ (form.elements.namedItem('repo'));
  repoSelect.replaceChildren(
    h('option', { value: '' }, 'Every repo'),
    ...jobPage.repos.map((name) => h('option', { value: name }, name)),
  );
  // A repo asked for that has no job kept yet is still shown as the one picked.
  if (wanted.repo && !jobPage.repos.includes(wanted.repo)) {
    repoSelect.append(h('option', { value: wanted.repo }, wanted.repo));
  }
  repoSelect.value = wanted.repo;
  const resultSelect = /** @type {HTMLSelectElement} */ (form.elements.namedItem('result'));
  // Each result with how many of the repo's jobs ended that way, whichever result is shown.
  const counts = jobPage.results ?? {};
  for (const option of resultSelect.options) {
    option.dataset['label'] ??= option.text;
    const n = option.value
      ? (counts[option.value] ?? 0)
      : Object.values(counts).reduce((sum, one) => sum + one, 0);
    option.text = `${option.dataset['label']} · ${n.toLocaleString()}`;
  }
  resultSelect.value = wanted.result;
  /** @type {HTMLSelectElement} */ (form.elements.namedItem('days')).value = wanted.jobDays
    ? String(wanted.jobDays)
    : '';
  const first = (jobPage.page - 1) * jobPage.per + 1;
  const last = Math.min(jobPage.total, jobPage.page * jobPage.per);
  $('jobs-count').textContent =
    jobPage.total === 0 ? '' : `${first}–${last} of ${jobPage.total.toLocaleString()}`;

  $('history').replaceChildren(
    ...(jobPage.jobs.length
      ? jobPage.jobs.map((job) => {
          const waited =
            job.jobAt !== undefined && job.queuedAt !== undefined
              ? `waited ${duration(job.jobAt - job.queuedAt)}`
              : null;
          const took = `took ${duration(job.endedAt - (job.jobAt ?? job.startedAt))}`;
          return row(
            status(job.conclusion),
            jobCell(jobName(job.job), job.repo, job.job.workflow, job.pool, null, job.job.actor),
            h('span', { class: 'muted num times' }, [waited, took].filter(Boolean).join(' · ')),
            h(
              'time',
              { class: 'muted num', datetime: new Date(job.endedAt).toISOString() },
              dateTime(job.endedAt),
            ),
            job.job.id !== null
              ? logButton({ kind: 'job', id: job.job.id, title: `${job.job.name} · ${job.repo}` })
              : logButton({ kind: 'vm', name: job.vm, title: job.vm }),
          );
        })
      : [
          empty(
            wanted.repo || wanted.result || wanted.jobDays
              ? 'No job matches.'
              : 'No job has run yet.',
          ),
        ]),
  );

  const link = (page, text, rel) =>
    page < 1 || page > jobPage.pages
      ? h('span', { class: 'muted' }, text)
      : h('a', { href: jobsHash({ ...wanted, page }), rel }, text);
  $('pager').replaceChildren(
    ...(jobPage.pages > 1
      ? [
          link(jobPage.page - 1, '← Newer', 'prev'),
          h(
            'span',
            { class: 'muted num' },
            `Page ${jobPage.page} of ${jobPage.pages.toLocaleString()}`,
          ),
          link(jobPage.page + 1, 'Older →', 'next'),
        ]
      : []),
  );
}

$('job-filters').addEventListener('change', (event) => {
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  location.hash = jobsHash({
    page: 1,
    repo: /** @type {HTMLSelectElement} */ (form.elements.namedItem('repo')).value,
    result: /** @type {HTMLSelectElement} */ (form.elements.namedItem('result')).value,
    jobDays: Number(/** @type {HTMLSelectElement} */ (form.elements.namedItem('days')).value) || 0,
  });
});

/** The history's and the logs' size, from /api/storage. */
let storage = null;

async function loadStorage() {
  try {
    const response = await fetch('/api/storage');
    if (!response.ok) return;
    storage = await response.json();
    drawStorage();
  } catch {
    // The state's own connection says when minitart cannot be reached.
  }
}

/** Bytes as the page writes them: KB under a megabyte, MB under a gigabyte, then GB. */
function bytes(value) {
  if (value === 0) return 'none';
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < GB) return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(value / GB).toFixed(value < 10 * GB ? 1 : 0)} GB`;
}

/** The charts' minutes kept, and for how long. */
function chartsKept(history) {
  const minutes = history.samples ?? 0;
  const since = history.samplesOldestAt
    ? ` since ${new Date(history.samplesOldestAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`
    : '';
  const days = state?.settings.keepChartsDays ?? null;
  return `${minutes.toLocaleString()} ${minutes === 1 ? 'minute' : 'minutes'} of charts${since}, kept ${days === null ? 'forever' : `${days} days`}`;
}

function drawStorage() {
  const history = storage?.history ?? null;
  const since = history?.oldestAt
    ? ` since ${new Date(history.oldestAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`
    : '';
  const count = history
    ? `${history.entries.toLocaleString()} ${history.entries === 1 ? 'job' : 'jobs'}${since}`
    : '';
  $('history-summary').textContent = history
    ? `${count}${history.bytes === null ? '' : ` · ${bytes(history.bytes)} on disk`} · each kept ${storage.keepDays} days`
    : '';

  const disk = resources?.disk ?? null;
  $('storage-free').textContent = disk
    ? `${bytes(disk.freeBytes)} free of ${bytes(disk.totalBytes)}`
    : '';
  $('storage-disk').replaceChildren(
    ...(disk
      ? [
          meter(
            [
              { value: disk.totalBytes - disk.freeBytes, color: 'other' },
              { value: disk.freeBytes, color: 'free' },
            ],
            `${bytes(disk.totalBytes - disk.freeBytes)} used, ${bytes(disk.freeBytes)} free`,
          ),
        ]
      : []),
  );
  const line = (name, detail, size) =>
    row(
      h('span', { class: 'main' }, name, h('span', { class: 'meta' }, detail)),
      h('span', { class: 'num' }, size),
    );
  const lines = [];
  if (history) {
    lines.push(
      line(
        'History',
        `${count}, each kept ${storage.keepDays} days; ${chartsKept(history)} · ~/.minitart/history.db`,
        history.bytes === null ? 'in memory' : bytes(history.bytes),
      ),
    );
  }
  if (storage?.logs) {
    lines.push(
      line(
        'VM logs',
        storage.logs.files
          ? `The newest ${storage.logs.files} VMs’ output, of at most ${storage.logs.kept} · ~/.minitart/logs`
          : `None yet: the output of the newest ${storage.logs.kept} VMs · ~/.minitart/logs`,
        bytes(storage.logs.bytes),
      ),
    );
  }
  for (const log of storage?.own ?? []) {
    lines.push(
      line(
        'minitart’s own log',
        `What the Activity list shows, as it happened, kept whole · ${log.path.replace(/^\/Users\/[^/]+/, '~')}`,
        bytes(log.bytes),
      ),
    );
  }
  for (const entry of disk?.tart ?? []) {
    lines.push(
      line(
        entry.name,
        entry.name === 'Downloaded images'
          ? 'What Tart pulled to build the images from · ~/.tart/cache'
          : 'An image job VMs are cloned from',
        bytes(entry.bytes),
      ),
    );
  }
  $('storage').replaceChildren(...(lines.length ? lines : [empty('Not measured yet.')]));
}

// The Usage view (D25): the minutes run here, and for reference what they are listed at
// elsewhere, and what this Mac costs.

const RANGES = [7, 30, 90, 365];
/** The days, usage and prices on screen, and what was last asked for. */
let costData = null;
/** Whether the view has been drawn with the state it needs: until then, the state draws it. */
let costDrawn = false;
/** Changes to the providers compared, saved one after another so none undoes another. */
let costSaving = Promise.resolve();
let costAsked = '';

async function loadCost() {
  const { days } = route();
  const asked = String(days);
  costAsked = asked;
  try {
    const response = await fetch(`/api/usage?days=${days}`);
    const body = response.ok ? await response.json() : null;
    if (costAsked !== asked || body === null) return;
    costData = body;
    drawCost();
  } catch {
    // The state's own connection says when minitart cannot be reached.
  }
}

function drawCost() {
  if (!costData || !state) return;
  costDrawn = true;
  const { days, dates, usage, oldestDay, prices } = costData;
  const cost = state.settings.cost;
  for (const link of document.querySelectorAll('#cost-range a')) {
    if (Number(link.dataset.days) === days) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const counted = daysCounted(dates, oldestDay);
  const sum = totals(usage);
  const minutes = sum.linux.minutes + sum.macos.minutes;
  $('cost-summary').textContent =
    counted < days
      ? `The last ${days} days; minitart has its history for ${counted} of them, and a month is worked out from those.`
      : `The last ${days} days.`;
  $('cost-minutes').textContent = minutes.toLocaleString();
  $('cost-split').textContent =
    `${sum.linux.minutes.toLocaleString()} Linux · ${sum.macos.minutes.toLocaleString()} macOS`;
  $('cost-jobs').textContent = (sum.linux.jobs + sum.macos.jobs).toLocaleString();
  const vmHours = (sum.linux.vmMinutes + sum.macos.vmMinutes) / 60;
  $('cost-vm').replaceChildren(
    vmHours < 10 ? vmHours.toFixed(1) : Math.round(vmHours).toLocaleString(),
    h('small', {}, ' h'),
  );

  // The providers shown are the ones in `compare`, each at the runners picked for it.
  const entryOf = (provider) => cost.compare.find((entry) => entry.provider === provider.id);
  const shown = prices.providers.filter((provider) => entryOf(provider));
  const rows = compareProviders(sum, prices.providers, cost.compare);
  const ownMonth = macCost(cost, MONTH_DAYS);
  $('cost-own').textContent = ownMonth.usd === null ? '–' : usd(ownMonth.usd);
  $('cost-own-split').textContent =
    ownMonth.usd === null
      ? 'Its price and power, below'
      : [
          ownMonth.mac === null ? null : `${usd(ownMonth.mac)} the Mac`,
          ownMonth.power === null ? null : `${usd(ownMonth.power)} power`,
        ]
          .filter(Boolean)
          .join(' · ');

  if (!inUse($('minutes-chart'))) {
    columns($('minutes-chart'), {
      days: everyDay(usage, dates).map((day) => ({
        label: dayLabel(day.day),
        values: { linux: day.linux, macos: day.macos },
      })),
      series: [
        { key: 'linux', name: 'Linux', color: 'linux' },
        { key: 'macos', name: 'macOS', color: 'macos' },
      ],
      format: (value) => `${Math.round(value).toLocaleString()} min`,
      height: 180,
      label: `Minutes run a day over the last ${days} days`,
    });
  }

  // Drawn again after each change: the menu that had the keyboard gets it back.
  const focused = /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.key;
  /** Saves the runners picked, one change after another, each from what is saved. */
  const saveCompare = (change) => {
    // Whatever goes wrong is said, the page goes back to what is saved, and the next change
    // is still saved.
    costSaving = costSaving
      .then(() => saveSettings({ cost: { compare: change(state.settings.cost.compare) } }))
      .then(drawCost, (error) => {
        alert(error.message);
        drawCost();
      })
      .catch((error) => alert(error.message));
  };

  // The Providers menu: a box each, in the price list's order. Unticked, a provider is not in
  // the table or its notes.
  $('provider-count').textContent = `${shown.length} of ${prices.providers.length}`;
  $('provider-list').replaceChildren(
    ...prices.providers.map((provider) => {
      const box = h('input', {
        type: 'checkbox',
        checked: Boolean(entryOf(provider)),
        'data-key': `show ${provider.id}`,
      });
      // What the box shows is what is asked for, whatever was saved before.
      box.addEventListener('change', () => {
        const wanted = box.checked;
        saveCompare((current) => {
          const others = current.filter((entry) => entry.provider !== provider.id);
          const kept = current.find((entry) => entry.provider === provider.id);
          if (!wanted) return others;
          return [
            ...others,
            kept ?? {
              provider: provider.id,
              linux: provider.linux[0].id,
              macos: provider.macos[0].id,
            },
          ];
        });
      });
      return h('label', {}, box, provider.name);
    }),
  );

  $('compare').replaceChildren(
    ...(shown.length ? [] : [empty('No provider is shown. Pick some under Providers.')]),
    ...shown.map((provider) => {
      const on = entryOf(provider);
      const row = rows.find((one) => one.provider.id === provider.id);
      const runner = (kind) => {
        const select = h(
          'select',
          {
            'aria-label': `${provider.name} runner for ${POOL[kind]} jobs`,
            'data-key': `runner ${provider.id} ${kind}`,
          },
          ...provider[kind].map((one) =>
            h(
              'option',
              { value: one.id, selected: on[kind] === one.id },
              `${one.name} · $${one.usd}/min`,
            ),
          ),
        );
        select.addEventListener('change', () =>
          saveCompare((current) =>
            current.map((entry) =>
              entry.provider === provider.id ? { ...entry, [kind]: select.value } : entry,
            ),
          ),
        );
        return select;
      };
      const monthly = row ? perMonth(row.usd, counted) : null;
      return h(
        'div',
        { class: 'row' },
        h(
          'span',
          { class: 'provider' },
          h('a', { href: provider.source, target: '_blank', rel: 'noreferrer' }, provider.name),
        ),
        h('span', { class: 'runners' }, runner('linux'), runner('macos')),
        h(
          'span',
          { class: 'num price' },
          row ? h('b', {}, usd(row.usd)) : null,
          row
            ? h(
                'span',
                { class: 'meta' },
                `${usd(row.linuxUsd)} Linux · ${usd(row.macosUsd)} macOS`,
              )
            : null,
        ),
        h(
          'span',
          { class: 'num price' },
          row ? h('b', {}, `${usd(monthly)} a month`) : null,
          row ? h('span', { class: 'meta' }, 'at this range’s pace') : null,
        ),
      );
    }),
  );
  if (focused) {
    for (const element of document.querySelectorAll(
      '#compare [data-key], #provider-list [data-key]',
    )) {
      if (/** @type {HTMLElement} */ (element).dataset.key === focused) {
        /** @type {HTMLElement} */ (element).focus();
      }
    }
  }
  $('compare-notes').replaceChildren(
    ...(shown.length
      ? [
          h(
            'p',
            {},
            `For reference only: what each provider lists for these minutes, as published on ${prices.checked}. ` +
              'Not a quote. Free minutes, plans and discounts are not counted, and runners differ in speed, ' +
              'so the same job can take more or fewer minutes elsewhere. Each job is counted from when its ' +
              'runner took it, rounded up to a whole minute.',
          ),
          ...shown.map((provider) => h('p', {}, h('b', {}, `${provider.name}: `), provider.note)),
        ]
      : []),
  );

  const form = /** @type {HTMLFormElement} */ ($('own'));
  if (!form.contains(document.activeElement) && !form.dataset.dirty) {
    for (const name of ['macUsd', 'lifeMonths', 'watts', 'kwhUsd']) {
      form.elements.namedItem(name).value = cost[name] === null ? '' : String(cost[name]);
    }
  }
}

// The Providers menu closes as a menu does: Escape, or a click anywhere else.
const providerMenu = /** @type {HTMLDetailsElement} */ ($('provider-menu'));
document.addEventListener('click', (event) => {
  if (providerMenu.open && !providerMenu.contains(/** @type {Node} */ (event.target))) {
    providerMenu.open = false;
  }
});
providerMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && providerMenu.open) {
    providerMenu.open = false;
    providerMenu.querySelector('summary')?.focus();
  }
});
// And when the keyboard leaves it.
providerMenu.addEventListener('focusout', (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (providerMenu.open && next && !providerMenu.contains(next)) providerMenu.open = false;
});

const ownForm = /** @type {HTMLFormElement} */ ($('own'));
ownForm.addEventListener('input', () => {
  ownForm.dataset.dirty = 'yes';
  $('own-note').textContent = '';
});
ownForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = (name) => {
    const text = ownForm.elements.namedItem(name).value.trim();
    return text === '' ? null : Number(text);
  };
  const patch = {
    macUsd: value('macUsd'),
    lifeMonths: value('lifeMonths') ?? 36,
    watts: value('watts'),
    kwhUsd: value('kwhUsd'),
  };
  saveSettings({ cost: patch }).then(
    () => {
      delete ownForm.dataset.dirty;
      $('own-note').textContent = 'Saved.';
      drawCost();
    },
    (error) => {
      $('own-note').textContent = error.message;
    },
  );
});

window.addEventListener('hashchange', showView);

function tick() {
  for (const time of document.querySelectorAll('time[data-since]')) {
    time.textContent = duration(Date.now() - Number(time.dataset.since));
  }
}
setInterval(tick, 1000);

function connect() {
  const live = $('live');
  const events = new EventSource('/api/events');
  events.onmessage = (event) => {
    state = JSON.parse(event.data);
    live.replaceChildren(status('watching', 'Live'));
    render();
  };
  events.onerror = () => {
    // EventSource reconnects by itself; say so meanwhile.
    live.replaceChildren(status('fix', 'Reconnecting'));
  };
}
connect();
showView();
void loadResources();
setInterval(() => void loadResources(), 10_000);
