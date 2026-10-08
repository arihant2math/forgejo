// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Serves a dev Forgejo under a sub-path, the way a reverse proxy does
// (nginx `location /git/ { proxy_pass http://127.0.0.1:3010/; }`): requests
// below /<prefix>/ are forwarded with the prefix stripped, WebSockets too.
// Forgejo's ROOT_URL must then be http://127.0.0.1:<port>/<prefix>/ (F3 notes).
//
//   node tools/subpath-proxy.ts [listen-port=3011] [target-port=3010] [prefix=git]

import http from 'node:http';
import net from 'node:net';

const [listen = '3011', target = '3010', prefix = 'git'] = process.argv.slice(2);
const strip = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  if (url === `/${prefix}`) return '/';
  return url.startsWith(`/${prefix}/`) ? url.slice(prefix.length + 1) : undefined;
};

const server = http.createServer((req, res) => {
  const path = strip(req.url);
  if (path === undefined) {
    res.writeHead(404).end(`outside /${prefix}/`);
    return;
  }
  const up = http.request({host: '127.0.0.1', port: Number(target), path, method: req.method, headers: req.headers}, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const path = strip(req.url);
  if (path === undefined) {
    socket.destroy();
    return;
  }
  const up = net.connect(Number(target), '127.0.0.1', () => {
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${String(v)}`).join('\r\n');
    up.write(`${req.method ?? 'GET'} ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
});

server.listen(Number(listen), '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${listen}/${prefix}/ → http://127.0.0.1:${target}/`);
});
