// Builds the demo on the site (D28) into a folder of static files: the dashboard as minitart
// serves it, and src/demo-page.ts and what it imports with their types stripped, as Node
// strips them when it runs minitart (D07). No bundler: each file stays a module of its own.
//
// What a browser does not have, Node's own modules, is never called by the demo, but some
// files the demo needs also hold code that does. Each of those imports is pointed at a
// stand-in that throws if it is ever called.
//
//   node scripts/build-demo.mjs <folder>

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'src/demo-page.ts';
/** Where the stand-ins for Node's modules go, in the folder built. */
const NODE = 'node';

/** Every import and export `from` in a module, and dynamic imports of a literal. */
const SPECIFIER =
  /(\b(?:import|export)\s*(?:[\w*{}\s,$]*?\sfrom\s*)?|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;
/** The names a module imports from one of Node's: `import { a, b as c } from 'node:x'`. */
const NAMED = /import\s*\{([^}]*)\}\s*from\s*['"](node:[^'"]+)['"]/g;

export function build(out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // The dashboard, as the server serves it (server.ts), but the page starts the demo.
  const dashboard = join(ROOT, 'dashboard');
  for (const name of readdirSync(dashboard)) {
    if (name.endsWith('.test.mjs') || name === 'index.html' || name === 'manifest.webmanifest')
      continue;
    cpSync(join(dashboard, name), join(out, name), { recursive: true });
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
    for (const [, names, module] of code.matchAll(NAMED)) {
      const wanted = node.get(module) ?? new Set();
      for (const name of names.split(',')) {
        const imported = name.trim().split(/\s+as\s+/)[0];
        if (imported) wanted.add(imported);
      }
      node.set(module, wanted);
    }
    const js = code.replace(SPECIFIER, (match, start, quote, specifier) => {
      if (specifier.startsWith('node:')) {
        node.set(specifier, node.get(specifier) ?? new Set());
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
      .map(
        (name) =>
          `export function ${name}() {\n  throw new Error('${module} ${name} is not in the demo');\n}\n`,
      )
      .join('');
    writeFileSync(join(out, NODE, `${module.slice(5).replaceAll('/', '-')}.js`), stub);
  }
  return { modules: [...done], node: [...node.keys()] };
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
      A demo: a made-up Mac running made-up jobs, in your browser.
      <a href="https://minitart.rovira.sh">What minitart is</a>
      <a href="https://github.com/zurfyx/minitart">GitHub</a>
    </p>
`,
  );
  return html;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/build-demo.mjs <folder>');
    process.exit(2);
  }
  const { modules, node } = build(out);
  console.log(`demo: ${modules.length} modules, stand-ins for ${node.join(', ')}, in ${out}`);
}
