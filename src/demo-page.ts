// The demo on the site (D28): the dashboard, run in a browser against the same made-up Mac
// as `minitart start --demo`. Nothing is served: the manager, its history and the API run
// here, in the page, and the dashboard's requests are answered by them instead of a server.
// Each visitor has a Mac of their own; what they do to it is gone when they close the page.

import { createApi } from './api.ts';
import { demoSettings, demoWorld } from './demo.ts';
import { MemoryHistory } from './history.ts';
import { Manager } from './manager.ts';
import { STEP_MS } from './resources.ts';
import { Minutes } from './samples.ts';

/** Only what this page needs of a browser's own, as Node's types do not have it. */
declare const location: { href: string; origin: string };

const GB = 1024 ** 3;
/** A Mac mini with an M4 Pro, as the demo's numbers are drawn for. */
const machine = { cpus: 14, memoryBytes: 64 * GB };

const demo = demoWorld(machine);
const history = new MemoryHistory(demo.history, demo.samples);
const manager = new Manager({
  github: () => demo.github,
  tart: demo.tart,
  network: 'softnet',
  settings: demoSettings(machine),
  saveSettings: () => {},
  history,
});
const resources = demo.resources(() => manager.snapshot().vms);
const api = createApi({
  manager,
  github: () => demo.github,
  app: () => null,
  health: () => [],
  resources: () => resources.view(),
  history,
  logs: () => ({ files: 0, bytes: 0, kept: 50 }),
  machine,
  machineName: 'mac-mini.local',
});

// Each minute of points is kept for the History view, as minitart does (D27).
const minutes = new Minutes();
const sample = () =>
  resources
    .sample()
    .then(() => {
      const newest = resources.view().points.at(-1);
      const minute = newest ? minutes.add(newest) : null;
      if (minute) history.addSample(minute);
    })
    .catch((error: unknown) => console.error(error));
void sample();
setInterval(() => void sample(), STEP_MS);

// The dashboard's requests to the API are answered here; anything else goes out as it would.
const sent = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return sent(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  const reply =
    method === 'GET'
      ? await api.get(url.pathname, url.searchParams)
      : method === 'POST'
        ? api.post(url.pathname, typeof init?.body === 'string' ? init.body : '')
        : null;
  if (reply === null) return new Response('Not in the demo', { status: 404 });
  return 'json' in reply
    ? new Response(JSON.stringify(reply.json), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      })
    : new Response(reply.text, {
        status: reply.status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
};

/** The state as /api/events sends it: when it changes, a few times a second at most. */
class DemoEvents extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #stop: () => void;

  constructor() {
    super();
    const push = () => {
      const event = new MessageEvent('message', { data: JSON.stringify(api.state()) });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.#stop = manager.onChange(() => {
      timer ??= setTimeout(() => {
        timer = null;
        push();
      }, 250);
    });
    setTimeout(push, 0);
  }

  close(): void {
    this.#stop();
  }
}
Object.assign(globalThis, { EventSource: DemoEvents });

await manager.start();
// The dashboard itself, as minitart serves it, once everything it asks is answered here.
const dashboard = '/app.js';
await import(dashboard);
