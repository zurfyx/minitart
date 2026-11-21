// What the dashboard says, worked out from the state alone: no page, no clock of its own.
// Kept apart from drawing so that it can be tested (view.test.mjs).

const POOL = { linux: 'Linux', macos: 'macOS' };

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The one sentence at the top: what needs the owner, most important first (docs/design.md).
 * Nothing can start; jobs wait, and why; all is flowing; idle. A resource is named only as
 * the reason a job waits. `{ lead, point }`: `point` is the part to look at, if any.
 */
export function headline(state) {
  if (state.blocked) return { lead: 'No job can start.', point: state.blocked };
  if (state.githubError) return { lead: 'minitart cannot read GitHub.', point: state.githubError };
  if (!state.app && state.repos.length === 0) {
    return { lead: 'Not connected to GitHub yet.', point: 'Create the GitHub App below.' };
  }
  const running = state.vms.filter((vm) => vm.status === 'running').length;
  if (state.draining) {
    return {
      lead: 'Draining.',
      point: running
        ? `${running} running ${running === 1 ? 'job finishes' : 'jobs finish'}; no new one starts.`
        : 'Nothing is running: it is safe to restart.',
    };
  }
  const stuck = state.queued.filter((job) => job.note);
  if (stuck.length) {
    // The reason most of them share speaks for all.
    const reasons = new Map();
    for (const job of stuck) reasons.set(job.note, (reasons.get(job.note) ?? 0) + 1);
    const reason = [...reasons].sort((a, b) => b[1] - a[1])[0][0];
    return {
      lead: running ? `${running} running.` : 'Nothing running.',
      point: `${stuck.length} waiting: ${lowerFirst(reason).replace(/\.$/, '')}.`,
    };
  }
  // A queued job with nothing against it has a VM on its way: the job and the VM are one.
  const coming = state.queued.length;
  if (running || coming) {
    const parts = [];
    if (running) parts.push(`${running} running`);
    if (coming) parts.push(`${coming} starting`);
    return { lead: `${parts.join(', ')}.`, point: null };
  }
  // Counted by minitart, by the Mac's clock: the page is sent only the newest jobs.
  const today = state.today.finished;
  return {
    lead: 'Idle.',
    point: today ? `${today} ${today === 1 ? 'job' : 'jobs'} today.` : null,
  };
}

/** The figures beside the headline. */
export function stats(state) {
  const running = state.vms.filter((vm) => vm.status === 'running');
  return {
    running: running.length,
    linux: running.filter((vm) => vm.pool === 'linux').length,
    macos: running.filter((vm) => vm.pool === 'macos').length,
    queued: state.queued.length,
    // Every job that ended today, and the ones the Mac lost (their VM ended first): what
    // minitart did, not how the code fared. An older minitart sends no `lost`.
    today: state.today.finished,
    lost: state.today.lost ?? 0,
    medianWaitMs: state.today.medianWaitMs,
  };
}

/**
 * The timeline's lanes: one per slot of each kind, macOS first, and as many more as VMs
 * that overlapped need (the limit was higher then). Each VM of the window goes in the first
 * lane of its kind that was free when it was cloned.
 */
export function lanes(state, from) {
  const items = [
    ...state.done
      .filter((job) => job.endedAt > from)
      .map((job) => ({
        key: job.vm,
        pool: job.pool,
        repo: job.repo,
        name: job.job.name,
        workflow: job.job.workflow,
        actor: job.job.actor ?? null,
        startAt: job.startedAt,
        // An entry older than 0.1.8 does not say when its job began: all of it was the job.
        jobAt: job.jobAt ?? job.startedAt,
        endAt: job.endedAt,
        state: job.conclusion,
        log: job.job.id !== null ? { kind: 'job', id: job.job.id } : { kind: 'vm', name: job.vm },
      })),
    ...state.vms.map((vm) => ({
      key: vm.name,
      pool: vm.pool,
      repo: vm.repo,
      name: vm.job?.name ?? null,
      workflow: vm.job?.workflow ?? '',
      actor: vm.job?.actor ?? null,
      startAt: vm.createdAt,
      jobAt: vm.jobAt,
      endAt: null,
      state: vm.status,
      log: { kind: 'vm', name: vm.name },
    })),
  ].sort((a, b) => a.startAt - b.startAt);

  const result = [];
  for (const pool of ['macos', 'linux']) {
    const rows = [];
    const ends = [];
    for (const item of items.filter((one) => one.pool === pool)) {
      let index = ends.findIndex((end) => end !== null && end <= item.startAt);
      if (index < 0) {
        index = rows.length;
        rows.push([]);
        ends.push(null);
      }
      rows[index].push(item);
      ends[index] = item.endAt;
    }
    const count = Math.max(state.settings[pool].max, rows.length);
    for (let index = 0; index < count; index++) {
      result.push({ name: `${POOL[pool]} ${index + 1}`, pool, items: rows[index] ?? [] });
    }
  }
  return result;
}

/** Labels along a time axis of `minutes`: every 15, or every 30 where they would crowd. */
export function timeTicks(minutes, width) {
  const step = width < 440 ? 30 : 15;
  const ticks = [];
  for (let ago = minutes; ago >= 0; ago -= step) {
    ticks.push({ ago, label: ago === 0 ? 'now' : `${ago} min ago` });
  }
  return ticks;
}

export const GB = 1024 ** 3;
