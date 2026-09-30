// Dismac Quiz · ranking general (Vercel Function + Upstash Redis)
// Variables de entorno: las crea Vercel al conectar Upstash Redis al proyecto
// (KV_REST_API_URL / KV_REST_API_TOKEN o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
const CATS = new Set(["lav-superior", "lav-frontal", "secadora", "refrigerador", "cocina", "televisor", "microondas", "aire", "mitos", "garantia", "nohagas"]);
const MAX_SCORE = 16000;   // 8 preguntas x 1.000 pts x racha x2
const KEEP = 1000;         // puntajes guardados por categoría
const PER_MINUTE = 12;     // envíos por IP por minuto

function conf() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

async function redis(cmds) {
  const { url, token } = conf();
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

function parseTop(arr) {
  const top = [];
  for (let i = 0; i < arr.length; i += 2) {
    const [name, id] = String(arr[i]).split('#');
    top.push({ name, id, score: Number(arr[i + 1]) });
  }
  return top;
}

function cleanName(v) {
  return String(v || '').normalize('NFC').toUpperCase()
    .replace(/[^A-Z0-9ÁÉÍÓÚÑÜ .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { url, token } = conf();
  if (!url || !token) return res.status(503).json({ error: 'ranking_not_configured' });

  try {
    if (req.method === 'GET') {
      const cat = String((req.query && req.query.cat) || '');
      if (!CATS.has(cat)) return res.status(400).json({ error: 'bad_category' });
      const key = 'dq:rank:' + cat;
      const [top, total] = await redis([['ZREVRANGE', key, '0', '9', 'WITHSCORES'], ['ZCARD', key]]);
      return res.status(200).json({ top: parseTop(top), total });
    }

    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};
      const cat = String(b.cat || '');
      const score = Math.round(Number(b.score));
      const name = cleanName(b.name);
      if (!CATS.has(cat) || !Number.isFinite(score) || score < 0 || score > MAX_SCORE || name.length < 2) {
        return res.status(400).json({ error: 'bad_input' });
      }
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rl = 'dq:rl:' + ip;
      const [hits] = await redis([['INCR', rl], ['EXPIRE', rl, '60', 'NX']]);
      if (hits > PER_MINUTE) return res.status(429).json({ error: 'too_many_requests' });

      const id = Math.random().toString(36).slice(2, 10);
      const key = 'dq:rank:' + cat;
      const member = name + '#' + id;
      const [, rank, top, total] = await redis([
        ['ZADD', key, String(score), member],
        ['ZREVRANK', key, member],
        ['ZREVRANGE', key, '0', '9', 'WITHSCORES'],
        ['ZCARD', key],
        ['ZREMRANGEBYRANK', key, '0', String(-(KEEP + 1))],
      ]);
      return res.status(200).json({ id, rank: rank + 1, total: Math.min(total, KEEP), top: parseTop(top) });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(502).json({ error: 'ranking_unavailable' });
  }
};
