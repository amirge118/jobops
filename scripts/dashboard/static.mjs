import fs from 'node:fs';
import path from 'node:path';

const PAGE_ROUTES = new Map([
  ['/scan', 'scan.html'],
  ['/decisions', 'decisions.html'],
  ['/companies', 'companies.html'],
]);

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const SAFE_ASSET = /^\/(?:styles\.css|shared\/[a-z0-9-]+\.js|pages\/[a-z0-9-]+\.js)$/;

export function serveDashboardAsset(response, staticDir, pathname) {
  if (pathname === '/') {
    response.writeHead(302, { Location: '/scan', 'Cache-Control': 'no-store' });
    response.end();
    return true;
  }

  const page = PAGE_ROUTES.get(pathname);
  const relativePath = page || (SAFE_ASSET.test(pathname) ? pathname.slice(1) : null);
  if (!relativePath) return false;

  const filePath = path.join(staticDir, relativePath);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  return true;
}
