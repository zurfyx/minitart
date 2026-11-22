// The demo on the site (D28), apart from the page it runs in: the made-up Mac, as
// `minitart start --demo` makes it up, with its manager, history and API, and the stand-ins
// for what the dashboard asks a server for. demo-page.ts puts them in the page; the build's
// tests run them in Node, built as the page gets them.

import { createApi, type Api } from './api.ts';
import { demoSettings, demoWorld } from './demo.ts';
import { MemoryHistory } from './history.ts';
import { Manager } from './manager.ts';
import { STEP_MS } from './resources.ts';
import { Minutes } from './samples.ts';

const GB = 1024 ** 3;
/** A Mac mini with an M4 Pro, as the demo's numbers are drawn for. */
export const DEMO_MAC = { cpus: 14, memoryBytes: 64 * GB };

export interface Demo {
  api: Api;
  manager: Manager;
  history: MemoryHistory;
  /** Stops the manager, the made-up GitHub and the charts. */
  stop(): Promise<void>;
}

/** The made-up Mac, running: its manager polls, its jobs come and go, its charts are kept. */
export async function startDemo(machine = DEMO_MAC): Promise<Demo> {
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
    machineName: () => 'mac-mini.local',
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
  const sampling = setInterval(() => void sample(), STEP_MS);

  await manager.start();
  return {
    api,
    manager,
    history,
    stop: async () => {
      clearInterval(sampling);
      demo.stop();
      await manager.stop();
    },
  };
}

/**
 * A `fetch` that answers the dashboard's requests to the API as the server would (server.ts),
 * and sends anything else on with `sent`.
 */
export function demoFetch(api: Api, page: string, sent: typeof fetch): typeof fetch {
  const origin = new URL(page).origin;
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(input, page), init);
    const url = new URL(request.url);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return sent(input, init);
    let reply;
    try {
      // As the server answers: GET and POST, anything else is not allowed.
      if (request.method === 'GET') reply = await api.get(url.pathname, url.searchParams);
      else if (request.method === 'POST') reply = api.post(url.pathname, await request.text());
      else return new Response('Method not allowed', { status: 405 });
    } catch (error) {
      console.error(error);
      return new Response('Something went wrong', { status: 500 });
    }
    if (reply === null) return new Response('Not found', { status: 404 });
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
}

/** An `EventSource` that sends the state as /api/events does: at once, then on each change. */
export function demoEvents(demo: Pick<Demo, 'api' | 'manager'>) {
  return class DemoEvents extends EventTarget {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly #stop: () => void;

    constructor() {
      super();
      const push = () => {
        const event = new MessageEvent('message', { data: JSON.stringify(demo.api.state()) });
        this.onmessage?.(event);
        this.dispatchEvent(event);
      };
      let timer: ReturnType<typeof setTimeout> | null = null;
      const later = (ms: number) => {
        timer ??= setTimeout(() => {
          timer = null;
          push();
        }, ms);
      };
      // The state at once, as a server's first message, then a few times a second at most.
      later(0);
      const unsubscribe = demo.manager.onChange(() => later(250));
      this.#stop = () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
      };
    }

    close(): void {
      this.#stop();
    }
  };
}
