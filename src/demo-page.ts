// The demo on the site (D28): the dashboard, run in a browser against the same made-up Mac
// as `minitart start --demo`. Nothing is served: the manager, its history and the API run
// here, in the page, and the dashboard's requests are answered by them instead of a server.
// Each visitor has a Mac of their own; what they do to it is gone when they close the page.

import { demoEvents, demoFetch, startDemo } from './demo-browser.ts';

/** Only what this page needs of a browser's own, as Node's types do not have it. */
declare const location: { href: string };

const demo = await startDemo();
globalThis.fetch = demoFetch(demo.api, location.href, globalThis.fetch.bind(globalThis));
Object.assign(globalThis, { EventSource: demoEvents(demo) });
// The dashboard itself, as minitart serves it, once everything it asks is answered here.
const dashboard = '/app.js';
await import(dashboard);
