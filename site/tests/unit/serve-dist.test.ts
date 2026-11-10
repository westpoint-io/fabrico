// The docs suite's static server: redirects, confinement to the build folder, and a failed read.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).
//
// Each test starts site/scripts/serve-dist.ts as a child process over a small folder in the OS
// temp folder, on a port the OS picked, and stops it by its process id.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SERVER = path.resolve(import.meta.dirname, '../../scripts/serve-dist.ts');

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** A build folder with an index page, one section folder, a file, and a file beside the folder. */
function makeSite(): { root: string; dist: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-dist-test-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'guide'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<p>home</p>');
  fs.writeFileSync(path.join(dist, '404.html'), '<p>not found</p>');
  fs.writeFileSync(path.join(dist, 'guide', 'index.html'), '<p>guide</p>');
  fs.writeFileSync(path.join(dist, 'assets', 'a.txt'), 'asset');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside the build');
  return { root, dist };
}

/** Starts the server over `dist` and resolves once it prints its listening line. */
async function start(dist: string): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--dist', dist, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('SERVE_DIST url=')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`serve-dist exited with ${code} before listening: ${err}`)));
  });
  return { child, port, stderr: () => err };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

/** One GET with the path sent exactly as written. */
async function get(port: number, rawPath: string): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

test('a folder with an index page, asked for without the slash, gets 301 to the slashed path with its query', async () => {
  const { root, dist } = makeSite();
  const { child, port } = await start(dist);
  try {
    assert.deepEqual(await get(port, '/fabrico/guide'), { status: 301, location: '/fabrico/guide/', body: '' });
    assert.deepEqual(await get(port, '/fabrico/guide?q=1&r=2'), { status: 301, location: '/fabrico/guide/?q=1&r=2', body: '' });
    assert.deepEqual(await get(port, '/fabrico'), { status: 301, location: '/fabrico/', body: '' });
    assert.equal((await get(port, '/fabrico/guide/')).body, '<p>guide</p>');
    assert.equal((await get(port, '/fabrico/assets/a.txt')).status, 200);
    // A folder with no index page is not redirected.
    assert.equal((await get(port, '/fabrico/assets')).status, 404);
    assert.equal((await get(port, '/fabrico/missing')).status, 404);
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path that would leave the build folder gets 404, with or without the slash', async () => {
  const { root, dist } = makeSite();
  const { child, port } = await start(dist);
  try {
    for (const rawPath of ['/fabrico/../secret.txt', '/fabrico/..%2fsecret.txt', '/fabrico/%2e%2e/secret.txt', '/fabrico/..%2f', '/fabrico/..', '/secret.txt']) {
      const answer = await get(port, rawPath);
      assert.equal(answer.status, 404, `${rawPath} status`);
      assert.equal(answer.location, undefined, `${rawPath} location`);
      assert.ok(!answer.body.includes('outside the build'), `${rawPath} body`);
    }
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file that fails to read gets 500, is logged, and the server keeps answering', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads a file whatever its mode, so this run cannot make a read fail');
    return;
  }
  const { root, dist } = makeSite();
  const locked = path.join(dist, 'assets', 'locked.txt');
  fs.writeFileSync(locked, 'locked');
  fs.chmodSync(locked, 0o000);
  const { child, port, stderr } = await start(dist);
  try {
    assert.equal((await get(port, '/fabrico/assets/locked.txt')).status, 500);
    assert.match(stderr(), /SERVE_DIST read error .*locked\.txt: EACCES/);
    assert.equal(child.exitCode, null, 'the server is still running');
    assert.equal((await get(port, '/fabrico/')).body, '<p>home</p>');
  } finally {
    await stop(child);
    fs.chmodSync(locked, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
