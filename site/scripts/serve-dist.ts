// serve-dist.ts - serves a built docs site the way GitHub Pages will, for the docs suite.
//
//   node site/scripts/serve-dist.ts --dist <folder> --port <n>
//
// The site is built with the base /fabrico, so every link in it starts with /fabrico/, while Astro
// writes the files at the top of the folder. This server mounts the folder at /fabrico/:
// /fabrico/x/ serves <folder>/x/index.html and /fabrico/x.png serves <folder>/x.png. A path outside
// /fabrico/, a path that would leave the folder, and a file that isn't there all get status 404
// with <folder>/404.html as the body, as Pages does. It listens on 127.0.0.1 only and prints one
// line once it is listening:
//
//   SERVE_DIST url=http://127.0.0.1:<port>/fabrico/
//
// Plain Node, no packages.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const BASE = '/fabrico/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined || value === '') {
    console.error('usage: node site/scripts/serve-dist.ts --dist <folder> --port <n>');
    process.exit(2);
  }
  return value;
}

const dist = path.resolve(arg('--dist'));
const port = Number(arg('--port'));
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`serve-dist: --port must be a port number (it is ${process.argv[process.argv.indexOf('--port') + 1]})`);
  process.exit(2);
}

/** The MIME type for a file name. Pagefind's index files (.pf_meta, .pf_index, .pf_fragment) are binary. */
function typeOf(file: string): string {
  const ext = path.extname(file);
  if (ext.startsWith('.pf_')) return 'application/octet-stream';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** The file a request path names inside the folder, or null for a path outside /fabrico/ or outside the folder. */
function fileFor(urlPath: string): string | null {
  if (!urlPath.startsWith(BASE)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.slice(BASE.length));
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(dist, rel);
  if (full !== dist && !full.startsWith(dist + path.sep)) return null;
  return full;
}

function notFound(res: http.ServerResponse): void {
  const page = path.join(dist, '404.html');
  res.statusCode = 404;
  res.setHeader('content-type', TYPES['.html']);
  res.end(fs.existsSync(page) ? fs.readFileSync(page) : 'Not found');
}

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
  const file = fileFor(urlPath);
  if (file === null || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    notFound(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', typeOf(file));
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`SERVE_DIST url=http://127.0.0.1:${port}${BASE}`);
});
