import { kv } from '@vercel/kv';

const KEY = 'club_network_state';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const state = await kv.get(KEY);
      res.status(200).json({ state: state || null });
      return;
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await kv.set(KEY, body);
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'DELETE') {
      await kv.del(KEY);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
