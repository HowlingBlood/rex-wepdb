import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const portText = process.env.PORT ?? '4173';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  console.error('PORT 必须是 1 至 65535 之间的整数。');
  process.exit(1);
}
const port = Number(portText);
const host = '127.0.0.1';
const localUrl = `http://${host}:${port}`;
const rootReal = await realpath(root);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const outsideRoot = (path) => {
  const rel = relative(rootReal, path);
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);
};
const reply = (response, code, message) => {
  response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(message);
};

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    reply(response, 405, '仅支持 GET 和 HEAD 请求。');
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, localUrl).pathname);
    if (pathname.includes('\0')) {
      reply(response, 400, '无效路径。');
      return;
    }
    let target = resolve(rootReal, pathname.replace(/^[/\\]+/, ''));
    if (outsideRoot(target)) {
      reply(response, 403, '禁止访问此路径。');
      return;
    }
    let info = await stat(target);
    if (info.isDirectory()) {
      target = resolve(target, 'index.html');
      info = await stat(target);
    }
    target = await realpath(target);
    if (outsideRoot(target) || !info.isFile()) {
      reply(response, 403, '禁止访问此路径。');
      return;
    }
    const body = request.method === 'HEAD' ? null : await readFile(target);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch (error) {
    if (error instanceof URIError || error.code === 'ERR_INVALID_URL') {
      reply(response, 400, '无效请求。');
    } else if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      reply(response, 404, '文件不存在。');
    } else {
      console.error('读取文件失败：', error.message);
      reply(response, 500, '读取文件失败。');
    }
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。请检查是否已经启动本工具，或设置 PORT 环境变量后重新启动。`);
  } else {
    console.error(`启动失败：${error.message}`);
  }
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log('\nWEAPON ATLAS · 武器数据工坊');
  console.log(`Local: ${localUrl}`);
  console.log('保持此窗口打开。按 Ctrl+C 停止服务。\n');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    const browser = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${localUrl}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    browser.on('error', () => console.error(`请手动打开：${localUrl}`));
    browser.unref();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
