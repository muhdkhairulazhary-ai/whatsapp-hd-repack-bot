import { timingSafeEqual } from 'node:crypto';

export function createBaileysHandler(connection, token) {
  const expected = Buffer.from(token);
  return (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const [pathname, query] = req.url.split('?', 2);
    if (pathname === '/pairing' && req.method === 'POST') {
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
      const supplied = Buffer.from(bearer?.[1] || '');
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return json(403, { error: 'Forbidden' });
      }
      const result = connection.requestPairing(new URLSearchParams(query).get('refresh') === '1');
      if (result.status === 'connecting' || result.status === 'waiting_for_whatsapp') {
        res.setHeader('retry-after', '2');
        return json(202, result);
      }
      return json(200, result);
    }
    if (pathname === '/health' && req.method === 'GET') return json(200, { status: 'ok' });
    return json(404, { error: 'Not found' });
  };
}
