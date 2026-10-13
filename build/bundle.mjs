// 把 app.mjs 及其依赖的 ES 模块合成一个 CommonJS 文件，供 Node 单文件可执行程序（SEA）使用。
// 只处理本项目用到的写法：具名 import / export function / export const。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const order = [];
const seen = new Set();

function parse(file) {
  const src = readFileSync(file, 'utf8');
  const deps = [];
  for (const m of src.matchAll(/^import \{([^}]*)\} from '(\.[^']+)';$/gm)) deps.push(resolve(dirname(file), m[2]));
  return { src, deps };
}

function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const { deps } = parse(file);
  deps.forEach(visit);
  order.push(file);
}

const key = (file) => relative(root, file).replace(/\\/g, '/');

function transform(file) {
  let { src } = parse(file);
  const exports = [];
  const bindings = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': ')).join(', ');
  src = src.replace(/^import \{([^}]*)\} from '(node:[^']+)';$/gm, (_m, names, mod) => `const { ${bindings(names)} } = require('${mod}');`);
  src = src.replace(/^import \{([^}]*)\} from '(\.[^']+)';$/gm, (_m, names, rel) => `const { ${bindings(names)} } = __modules['${key(resolve(dirname(file), rel))}'];`);
  src = src.replace(/^export (async function|function|const|let) ([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => { exports.push(name); return `${kind} ${name}`; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`${key(file)} 里有打包器不支持的 import/export 写法`);
  src = src.replaceAll('import.meta.url', `__url(${JSON.stringify(key(file))})`);
  return `__modules[${JSON.stringify(key(file))}] = (() => {\n${src}\nreturn { ${exports.join(', ')} };\n})();\n`;
}

const entry = join(root, 'app.mjs');
visit(entry);
const header = `'use strict';
// 由 build/bundle.mjs 生成，请勿手改。
const __path = require('node:path');
const __sea = (() => { try { return require('node:sea'); } catch { return null; } })();
const __isSea = Boolean(__sea && __sea.isSea());
// 程序所在目录：独立 exe 时是 exe 旁边，否则是这个 js 文件旁边。
globalThis.__VU_APP_DIR__ = __isSea ? __path.dirname(process.execPath) : __dirname;
if (__isSea) globalThis.__VU_PAGE__ = __sea.getAsset('index.html', 'utf8');
const __url = (file) => require('node:url').pathToFileURL(__path.join(globalThis.__VU_APP_DIR__, file)).href;
const __modules = {};
`;
const out = header + order.map(transform).join('\n');
const target = process.argv[2] ?? join(root, 'dist', 'app.cjs');
writeFileSync(target, out);
console.log(`已生成 ${target}（${order.length} 个模块）`);
