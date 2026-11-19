// The dashboard. It draws what /api/events sends and posts settings back; it holds no state
// of its own beyond which log is open. Everything from GitHub (job, workflow and repo names)
// is text someone else wrote, so it only ever reaches the page as text nodes.

import { areaChart, h, legend, meter, timeline } from './charts.js';
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
function jobCell(name, repo, workflow, pool, note) {
  return h(
    'span',
    { class: 'main' },
    name,
    h('span', { class: 'meta' }, [repo, workflow, POOL[pool]].filter(Boolean).join(' · ')),
    note ? h('span', { class: 'note' }, note) : null,
  );
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
  $('stat-passed').replaceChildren(
    String(figures.passed),
    h('small', {}, ` of ${figures.finished}`),
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
        ),
        clock(vm.jobAt ?? vm.createdAt),
        logButton({ kind: 'vm', name: vm.name, title: vm.name }),
      ),
    ),
    ...queued.map((job) =>
      row(
        status('queued'),
        jobCell(jobName(job), job.repo, job.workflow, job.pool, job.note),
        clock(Date.parse(job.createdAt)),
      ),
    ),
    ...done
      .slice(0, 20)
      .map((job) =>
        row(
          status(job.conclusion),
          jobCell(jobName(job.job), job.repo, job.job.workflow, job.pool),
          h('span', { class: 'muted num' }, ago(state.now - job.endedAt)),
          job.job.id !== null
            ? logButton({ kind: 'job', id: job.job.id, title: `${job.job.name} · ${job.repo}` })
            : logButton({ kind: 'vm', name: job.vm, title: job.vm }),
        ),
      ),
  ];
  $('jobs').replaceChildren(...(jobs.length ? jobs : [empty('No job has run yet.')]));

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
      `${item.repo}${item.workflow ? ` · ${item.workflow}` : ''}`,
      item.name ?? (item.jobAt === null ? 'Waiting for its job' : 'A job'),
      `Starting: ${duration((item.jobAt ?? item.endAt ?? to) - item.startAt)}`,
      ...(item.jobAt !== null ? [`Job: ${duration((item.endAt ?? to) - item.jobAt)}`] : []),
      STATES[item.state]?.[2] ?? item.state,
    ],
    onPick: (item) => showLog({ ...item.log, title: `${item.name ?? item.key} · ${item.repo}` }),
  });
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

  const disk = resources.disk;
  if (!disk) {
    $('disk-free').textContent = '';
    $('disk').replaceChildren(empty('Not measured yet.'));
    return;
  }
  const used = disk.totalBytes - disk.freeBytes;
  const size = (bytes) => `${Math.round(bytes / GB)} GB`;
  $('disk-free').textContent = `${size(disk.freeBytes)} free of ${size(disk.totalBytes)}`;
  $('disk').replaceChildren(
    meter(
      [
        { value: used, color: 'other' },
        { value: disk.freeBytes, color: 'free' },
      ],
      `${size(used)} used, ${size(disk.freeBytes)} free`,
    ),
    legend([
      ['other', `Used, ${size(used)}`],
      ['free', `Free, ${size(disk.freeBytes)}`],
    ]),
    h('p', { class: 'disk-head' }, 'What Tart keeps'),
    ...disk.tart.map((entry) =>
      h(
        'div',
        { class: 'disk-row' },
        h('span', {}, entry.name),
        h('span', { class: 'num' }, size(entry.bytes)),
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      'A clone shares space with what it was cloned from, so these can add up to more than they take.',
    ),
  );
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
  $('log-panel').hidden = false;
  clearInterval(logTimer);
  // A VM's log grows while it runs; a finished job's log does not.
  if (target.kind === 'vm') logTimer = setInterval(loadLog, 2000);
  void loadLog().then(() => {
    $('log').scrollTop = $('log').scrollHeight;
    $('log-panel').scrollIntoView({ block: 'nearest' });
  });
}

$('log-close').addEventListener('click', () => {
  openLog = null;
  clearInterval(logTimer);
  $('log-panel').hidden = true;
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
void loadResources();
setInterval(() => void loadResources(), 10_000);
