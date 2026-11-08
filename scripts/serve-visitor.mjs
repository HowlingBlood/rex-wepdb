import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const portText = process.env.PORT ?? '4173';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  console.error('PORT 必须是 1 至 65535 之间的整数。'); process.exit(1);
}
let rootReal;
try { rootReal = await realpath(root); await stat(resolve(rootReal, 'index.html')); }
catch { console.error('请先运行 npm run build:visitor 生成 site 目录。'); process.exit(1); }
const port = Number(portText), host = '127.0.0.1', localUrl = `http://${host}:${port}`;
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.txt':'text/plain; charset=utf-8' };
const outside = path => { const rel=relative(rootReal,path); return rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel); };
const send = (response, code, message) => { response.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});response.end(message); };
const server = http.createServer(async (request,response) => {
  if (!['GET','HEAD'].includes(request.method)) { response.setHeader('Allow','GET, HEAD');send(response,405,'仅支持 GET 和 HEAD。');return; }
  try {
    const pathname=decodeURIComponent(new URL(request.url,localUrl).pathname);
    if(pathname.includes('\0')) { send(response,400,'无效路径。');return; }
    let target=resolve(rootReal,pathname.replace(/^[/\\]+/,''));
    if(outside(target)){send(response,403,'禁止访问此路径。');return;}
    let info=await stat(target);if(info.isDirectory()){target=resolve(target,'index.html');info=await stat(target);}
    target=await realpath(target);
    if(outside(target)||!info.isFile()){send(response,403,'禁止访问此路径。');return;}
    response.writeHead(200,{'Content-Type':mime[extname(target).toLowerCase()]??'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    response.end(request.method==='HEAD'?null:await readFile(target));
  }catch(error){if(error instanceof URIError||error.code==='ERR_INVALID_URL')send(response,400,'无效请求。');else if(['ENOENT','ENOTDIR'].includes(error.code))send(response,404,'文件不存在。');else send(response,500,'读取文件失败。');}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用，未停止或替换已有服务。`:`启动失败：${error.message}`);process.exitCode=1;});
server.listen(port,host,()=>{
  console.log('\nWEAPON ATLAS · 访客页');console.log(`Local: ${localUrl}`);console.log('保持此窗口打开。按 Ctrl+C 停止服务。\n');
  if(process.argv.includes('--open')&&process.platform==='win32'){
    const browser=spawn('cmd.exe',['/d','/s','/c',`start "" "${localUrl}"`],{detached:true,stdio:'ignore',windowsHide:true});
    browser.on('error',()=>console.error(`请手动打开：${localUrl}`));browser.unref();
  }
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
