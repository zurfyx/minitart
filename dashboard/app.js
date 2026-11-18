// The dashboard. It draws what /api/events sends and posts settings back; it holds no state
// of its own beyond which log is open. Everything from GitHub (job, workflow and repo names)
// is text someone else wrote, so it only ever reaches the page as text nodes.

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** Builds an element: `h('a', { href }, 'text', child)`. Strings become text nodes. */
function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'onclick') element.addEventListener('click', value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined));
  return element;
}

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
  paused: ['muted', '○', 'Paused'],
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

function empty(text) {
  return h('p', { class: 'empty' }, text);
}

let state = null;
/** The log on screen: a VM's own output, or a finished job's log from GitHub. */
let openLog = null;
let logTimer = null;

function render() {
  if (!state) return;
  const { vms, queued, done, repos, settings, health, canEdit } = state;

  $('machine').textContent =
    `${state.machine.name} · ${state.machine.cpus} CPUs · ${Math.round(state.machine.memoryBytes / 1024 ** 3)} GB`;

  // What needs the owner's attention, said once, at the top.
  const alerts = [];
  if (state.network === 'shared') {
    alerts.push('Started with --unsafe-shared-network: jobs can reach your LAN.');
  }
  if (state.githubError) alerts.push(`GitHub: ${state.githubError}`);
  $('alerts').replaceChildren(
    ...alerts.map((text) => h('p', { class: 'alert' }, status('fix', text))),
  );

  $('setup').hidden = state.app !== null || state.repos.length > 0;
  $('create-app').hidden = !canEdit;
  $('setup-remote').hidden = canEdit;

  $('slots').replaceChildren(
    ...['macos', 'linux'].map((pool) => {
      const used = vms.filter((vm) => vm.pool === pool).length;
      const max = settings[pool].max;
      const pips = Array.from({ length: Math.max(max, used) }, (_, index) =>
        h('span', { class: index < used ? 'pip on' : 'pip' }),
      );
      return h(
        'div',
        { class: 'slot' },
        h('span', { class: 'slot-name' }, POOL[pool]),
        h('span', { class: 'pips', 'aria-hidden': 'true' }, ...pips),
        h(
          'span',
          { class: 'muted num' },
          !state.images[pool] ? 'no image yet' : max === 0 ? 'off' : `${used} of ${max} in use`,
        ),
      );
    }),
  );

  $('running-count').textContent = vms.length ? String(vms.length) : '';
  $('running').replaceChildren(
    ...(vms.length
      ? vms.map((vm) =>
          row(
            status(vm.status),
            h(
              'span',
              { class: 'main' },
              jobName(vm.job, vm.status === 'running' ? 'A job' : `For ${vm.repo}`),
              h('span', { class: 'muted' }, ` ${vm.job ? vm.repo : ''} ${vm.job?.workflow ?? ''}`),
            ),
            h('span', { class: 'muted' }, POOL[vm.pool]),
            h('code', {}, vm.name),
            clock(vm.createdAt),
            logButton({ kind: 'vm', name: vm.name, title: vm.name }),
          ),
        )
      : [empty('Nothing is running.')]),
  );

  $('queued-count').textContent = queued.length ? String(queued.length) : '';
  $('queued').replaceChildren(
    ...(queued.length
      ? queued.map((job) =>
          row(
            status('queued'),
            h(
              'span',
              { class: 'main' },
              jobName(job),
              h('span', { class: 'muted' }, ` ${job.repo} ${job.workflow}`),
              job.note ? h('span', { class: 'note' }, status('fix', job.note)) : null,
            ),
            h('span', { class: 'muted' }, job.pool ? POOL[job.pool] : ''),
            clock(Date.parse(job.createdAt)),
          ),
        )
      : [empty('Nothing is waiting.')]),
  );

  $('done-count').textContent = done.length ? String(done.length) : '';
  $('done').replaceChildren(
    ...(done.length
      ? done
          .slice(0, 30)
          .map((job) =>
            row(
              status(job.conclusion),
              h(
                'span',
                { class: 'main' },
                jobName(job.job),
                h('span', { class: 'muted' }, ` ${job.repo} ${job.job.workflow}`),
              ),
              h('span', { class: 'muted' }, POOL[job.pool]),
              h('span', { class: 'muted num' }, duration(job.endedAt - job.startedAt)),
              h('span', { class: 'muted num' }, ago(state.now - job.endedAt)),
              job.job.id !== null
                ? logButton({ kind: 'job', id: job.job.id, title: `${job.job.name} · ${job.repo}` })
                : logButton({ kind: 'vm', name: job.vm, title: job.vm }),
            ),
          )
      : [empty('No job has run yet.')]),
  );

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
            canEdit && repo.state !== 'public'
              ? h(
                  'button',
                  { type: 'button', class: 'quiet', onclick: () => togglePause(repo) },
                  repo.state === 'paused' ? 'Resume' : 'Pause',
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
      'The list is the repos the GitHub App is installed on. ',
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
  form.hidden = !canEdit;
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

function togglePause(repo) {
  const paused = new Set(state.settings.pausedRepos);
  if (repo.state === 'paused') paused.delete(repo.fullName);
  else paused.add(repo.fullName);
  saveSettings({ pausedRepos: [...paused] }).catch((error) => alert(error.message));
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
