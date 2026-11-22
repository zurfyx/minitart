// Builds the demo on the site (D28) into a folder of static files: the dashboard as minitart
// serves it, and src/demo-page.ts and what it imports with their types stripped, as Node
// strips them when it runs minitart (D07). No bundler: each file stays a module of its own.
//
// What a browser does not have, Node's own modules, is never called by the demo, but some
// files the demo needs also hold code that does. Each of those imports is pointed at a
// stand-in that throws if it is ever called.
//
//   node scripts/build-demo.mjs <folder>

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC } from '../src/server.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'src/demo-page.ts';
/** Where the stand-ins for Node's modules go, in the folder built. */
const NODE = 'node';

/**
 * Every import, and export `from`, at the start of a line: `import x, { y } from '…'`,
 * `import '…'`, `export * from '…'`. Not text in a string or a comment that looks like one.
 */
const SPECIFIER = /^(\s*(?:import|export)\b[^'";]*?\bfrom\s*|\s*import\s*)(['"])([^'"\n]+)\2/gm;
/** An import of a literal while the module runs, which the build would not follow. */
const DYNAMIC = /\bimport\s*\(\s*['"]/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function build(out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // The dashboard's files, at the paths the server serves them (server.ts), but its page
  // starts the demo, and it is not offered as an app to install.
  const dashboard = join(ROOT, 'dashboard');
  for (const [path, [file]] of Object.entries(STATIC)) {
    if (path === '/' || path === '/manifest.webmanifest') continue;
    mkdirSync(dirname(join(out, path)), { recursive: true });
    cpSync(join(dashboard, file), join(out, path));
  }
  writeFileSync(join(out, 'index.html'), page(readFileSync(join(dashboard, 'index.html'), 'utf8')));
  cpSync(join(ROOT, 'demo', 'demo.css'), join(out, 'demo.css'));

  // The demo's modules, from its entry, each with its types stripped.
  const node = new Map();
  const queue = [ENTRY];
  const done = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (done.has(file)) continue;
    done.add(file);
    const code = stripTypeScriptTypes(readFileSync(join(ROOT, file), 'utf8'), { mode: 'strip' });
    if (DYNAMIC.test(code)) throw new Error(`${file}: an import() of a literal is not followed`);
    const js = code.replace(SPECIFIER, (match, start, quote, specifier) => {
      if (specifier.startsWith('node:')) {
        const wanted = node.get(specifier) ?? new Set();
        for (const name of imported(file, start, specifier)) wanted.add(name);
        node.set(specifier, wanted);
        const stub = posix.join(NODE, `${specifier.slice(5).replaceAll('/', '-')}.js`);
        return `${start}${quote}${relativeTo(file, stub)}${quote}`;
      }
      if (!specifier.startsWith('.')) return match;
      if (!specifier.endsWith('.ts')) throw new Error(`${file}: ${specifier} is not a .ts file`);
      queue.push(posix.join(posix.dirname(file), specifier));
      return `${start}${quote}${specifier.replace(/\.ts$/, '.js')}${quote}`;
    });
    const target = join(out, file.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
  }

  // A stand-in for each of Node's modules imported: every name it is asked for throws.
  mkdirSync(join(out, NODE), { recursive: true });
  for (const [module, names] of node) {
    const stub = [...names]
      .map((name) => {
        const body = `() {\n  throw new Error('${module} ${name} is not in the demo');\n}\n`;
        return name === 'default'
          ? `export default function${body}`
          : `export function ${name}${body}`;
      })
      .join('');
    writeFileSync(join(out, NODE, `${module.slice(5).replaceAll('/', '-')}.js`), stub);
  }
  return { modules: [...done], node: [...node.keys()] };
}

/**
 * The names an import takes from one of Node's modules: `x` (its default), `* as x` (all of
 * it), `{ a, b as c }`. Any other form stops the build, rather than build a page that fails.
 */
function imported(file, statement, module) {
  const clause = /^\s*import\s+([^;]*?)\s*from\s*$/.exec(statement)?.[1];
  if (clause === undefined) throw new Error(`${file}: only import … from '${module}' is handled`);
  const names = new Set();
  const named = /\{([^}]*)\}/.exec(clause);
  for (const name of named ? named[1].split(',') : []) {
    const one = name.trim().split(/\s+as\s+/)[0];
    if (one) names.add(one);
  }
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '');
  // A default import, or all of it: a module of stand-ins has a default too.
  if (/[\w$]/.test(rest) || /\*\s*as/.test(clause)) names.add('default');
  for (const name of names) {
    if (name !== 'default' && !IDENTIFIER.test(name))
      throw new Error(`${file}: ${name} from '${module}' is not a name`);
  }
  return names;
}

/** The path from `file` to `target`, both from the folder's root, as an import names it. */
function relativeTo(file, target) {
  const path = relative(posix.dirname(file), target).split('\\').join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/** The dashboard's page, made the demo's: its script, its title, a line that says so. */
function page(html) {
  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`index.html no longer has ${from}`);
    html = html.replace(from, to);
  };
  replace('<title>minitart</title>', '<title>minitart demo</title>');
  replace('    <link rel="manifest" href="/manifest.webmanifest" />\n', '');
  replace(
    '<script type="module" src="/app.js"></script>',
    '<link rel="stylesheet" href="/demo.css" />\n    <script type="module" src="/src/demo-page.js"></script>',
  );
  replace(
    '  <body>\n',
    `  <body>
    <p class="demo-banner">
      A demo with simulated jobs.
      <a href="https://minitart.rovira.sh">What minitart is</a>
      <a href="https://github.com/zurfyx/minitart">GitHub</a>
    </p>
`,
  );
  return html;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/build-demo.mjs <folder>');
    process.exit(2);
  }
  const { modules, node } = build(out);
  console.log(`demo: ${modules.length} modules, stand-ins for ${node.join(', ')}, in ${out}`);
}
