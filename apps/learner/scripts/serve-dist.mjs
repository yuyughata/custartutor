// Tiny static server with SPA fallback, for checking the web export locally.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const root = process.argv[2];
const port = +process.argv[3];
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};
createServer((req, res) => {
  let p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(port, '127.0.0.1', () => console.log('listening', port));
