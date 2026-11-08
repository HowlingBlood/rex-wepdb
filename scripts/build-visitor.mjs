import { cp, mkdir, readFile, readdir, realpath, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDatabase, normalizeDatabase } from '../dist/engine.js';
import { validateCatalog } from '../visitor/data-core.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(project, 'visitor');
const dataRoot = resolve(project, 'weapon_db');
const output = resolve(project, 'site');
const marker = '.weapon-atlas-build';
const sharedFiles = ['engine.js', 'visuals.js', 'styles.css', 'visuals.css', 'favicon.svg'];
const visitorExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico']);
const inside = (parent, target) => { const rel = relative(parent, target); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
const fail = message => { throw new Error(message); };

async function json(path) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { fail(`${relative(project, path)} 不是可读取的 JSON：${error.message}`); }
}
async function dataFile(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[?#:%]/.test(name) || isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..') || extname(name) !== '.json') fail(`数据库路径不合法：${name}`);
  const target = resolve(dataRoot, name);
  if (!inside(dataRoot, target)) fail(`数据库路径越界：${name}`);
  const actual = await realpath(target);
  if (!inside(await realpath(dataRoot), actual) || !(await stat(actual)).isFile()) fail(`数据库路径不是目录内的普通文件：${name}`);
  return actual;
}
async function validateData() {
  const catalog = await json(resolve(dataRoot, 'index.json'));
  const report = validateCatalog(catalog);
  if (!report.valid) fail(`版本清单未通过校验：\n${report.errors.join('\n')}`);
  const loaded = new Map();
  const load = async name => {
    if (!loaded.has(name)) {
      const value = await json(await dataFile(name));
      const result = validateDatabase(value);
      if (!result.valid) fail(`${name} 未通过数据库校验：\n${result.errors.join('\n')}`);
      loaded.set(name, normalizeDatabase(value));
    }
    return loaded.get(name);
  };
  for (const mode of catalog.modes) {
    const latest = await load(mode.latest);
    for (const version of mode.versions) await load(version.file);
    if (mode.available !== false) {
      const current = mode.versions.find(version => version.id === mode.currentVersion);
      if (!current) fail(`${mode.label} 缺少当前版本对应的历史快照。`);
      if (latest.weapons.length === 0) fail(`${mode.label} 已启用，但最新数据库没有武器。`);
      if (canonical(latest) !== canonical(await load(current.file))) fail(`${mode.label} 的 ${mode.latest} 与当前历史快照不一致，请同时更新清单、latest 和对应快照。`);
    }
  }
  return { modes: catalog.modes.length, databases: loaded.size };
}

async function copyTree(from, to, filter) {
  const sourceInfo = await lstat(from);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) fail(`发布资源目录必须是普通目录：${relative(project, from)}`);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const input = resolve(from, entry.name), target = resolve(to, entry.name);
    if (entry.isSymbolicLink()) fail(`发布资源不允许符号链接：${relative(project, input)}`);
    if (entry.isDirectory()) await copyTree(input, target, filter);
    else if (entry.isFile() && (!filter || filter(entry.name, input))) await cp(input, target);
  }
}

try {
  for (const directory of [source, dataRoot, resolve(project, 'assets', 'fonts')]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`发布资源目录必须是普通目录：${relative(project, directory)}`);
  }
  const result = await validateData();
  for (const required of ['index.html', 'visitor-app.js']) await stat(resolve(source, required));
  for (const required of ['sarasa-ui-sc-regular.woff2', 'sarasa-mono-sc-regular.woff2', 'LICENSE-Sarasa-Gothic.txt']) await stat(resolve(project, 'assets', 'fonts', required));
  if (relative(project, output) !== 'site' || !inside(project, output)) fail('输出目录必须是项目内的 site。');
  const existing = await lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail('site 必须是普通目录，不能是链接。');
    const names = await readdir(output);
    if (names.length && !names.includes(marker)) fail('site 目录含有未标记的文件；请先保留这些文件，再使用空输出目录。');
    // The exact absolute path was checked above; only our marked build output is removed.
    await rm(output, { recursive: true, force: true });
  }
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, marker), 'Generated by scripts/build-visitor.mjs.\n');
  await copyTree(source, output, name => visitorExtensions.has(extname(name)) && !['engine.js', 'visuals.js'].includes(name));
  for (const name of sharedFiles) {
    const input = resolve(project, 'dist', name), info = await lstat(input);
    if (!info.isFile() || info.isSymbolicLink()) fail(`共享资源必须是普通文件：dist/${name}`);
    await cp(input, resolve(output, name));
  }
  await copyTree(dataRoot, resolve(output, 'weapon_db'), name => extname(name) === '.json');
  await copyTree(resolve(project, 'assets', 'fonts'), resolve(output, 'assets', 'fonts'));
  await writeFile(resolve(output, '.nojekyll'), '');
  console.log(`访客页已构建：${output}`);
  console.log(`已校验 ${result.modes} 个模式、${result.databases} 份数据库；仅发布访客页面及其共享资源。`);
} catch (error) {
  console.error(`访客页构建失败：${error.message}`);
  process.exitCode = 1;
}
