import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the browser app's functions and components are defined (client/src), so "Explain this error" can tell Claude
// which file each name in a crash report comes from. The build keeps function names (vite.config.js), so component
// stacks name them. Read once; empty when the source isn't there.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFINITION =
  /(?:^|\s)(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:^|\s)const\s+([A-Z][\w$]*)\s*=\s*(?:\(|async|lazyPage|memo)/gm;
const MAX_NAMES = 20;

let index = null;

async function build(root) {
  const names = new Map();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.jsx?$/.test(entry.name)) {
        const file = relative(REPO, path);
        for (const m of (await readFile(path, 'utf8')).matchAll(DEFINITION)) {
          const name = m[1] ?? m[2];
          const files = names.get(name) ?? [];
          if (!files.includes(file)) names.set(name, [...files, file]);
        }
      }
    }
  }
  try {
    await walk(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return names;
}

// The names a report mentions: components ("at QuestionCard") and stack frames ("at Product (…)", "Product@…").
export function namesIn({ stack, componentStack }) {
  const found = new Set();
  for (const line of `${componentStack ?? ''}\n${stack ?? ''}`.split('\n')) {
    const m = /^\s*at (?:new )?([A-Za-z_$][\w$]*)\b/.exec(line) ?? /^\s*([A-Za-z_$][\w$]*)@/.exec(line);
    if (m) found.add(m[1]);
  }
  return [...found].slice(0, MAX_NAMES);
}

// [[name, "client/src/… or …"]] for the names in `report` that the app defines.
export async function placesFor(report, root = join(REPO, 'client', 'src')) {
  index ??= await build(root);
  return namesIn(report)
    .filter((n) => index.has(n))
    .map((n) => [n, index.get(n).join(' or ')]);
}
