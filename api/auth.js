import { kv } from '@vercel/kv';
import crypto from 'crypto';

const STATE_KEY = 'club_network_state';
const AUTH_KEY = 'club_network_auth';
const SESSION_KEY = 'club_network_sessions';

function hashPasscode(passcode, salt) {
  return crypto.pbkdf2Sync(passcode, salt, 100000, 32, 'sha256').toString('hex');
}

function findMemberByEmail(state, email) {
  if (!state || !state.clubMembers) return null;
  const target = email.trim().toLowerCase();
  for (const club of Object.keys(state.clubMembers)) {
    const members = state.clubMembers[club] || [];
    for (const m of members) {
      if ((m.contact || '').trim().toLowerCase() === target) {
        return { member: m, club };
      }
    }
  }
  return null;
}

function memberPublicShape(m, club) {
  return { id: m.id, name: m.name, email: m.contact, club, accountLevels: m.accountLevels || [] };
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const action = body && body.action;

    if (action === 'signup') {
      const email = (body.email || '').trim();
      const passcode = body.passcode || '';
      if (!email || !passcode) { res.status(400).json({ ok: false, error: 'Email and passcode are required.' }); return; }

      const state = await kv.get(STATE_KEY);
      const found = findMemberByEmail(state, email);
      if (!found) {
        res.status(200).json({ ok: false, error: "We couldn't find that email in the club roster. Ask your club officer to add you as a member first." });
        return;
      }

      const auth = (await kv.get(AUTH_KEY)) || {};
      const key = email.toLowerCase();
      if (auth[key]) {
        res.status(200).json({ ok: false, error: 'An account already exists for this email. Enter your existing passcode instead.' });
        return;
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPasscode(passcode, salt);
      auth[key] = { salt, hash, memberId: found.member.id, club: found.club, email };
      await kv.set(AUTH_KEY, auth);

      const token = genToken();
      const sessions = (await kv.get(SESSION_KEY)) || {};
      sessions[token] = { email: key, memberId: found.member.id, club: found.club, createdAt: Date.now() };
      await kv.set(SESSION_KEY, sessions);

      res.status(200).json({ ok: true, token, member: memberPublicShape(found.member, found.club) });
      return;
    }

    if (action === 'login') {
      const email = (body.email || '').trim();
      const passcode = body.passcode || '';
      if (!email || !passcode) { res.status(400).json({ ok: false, error: 'Email and passcode are required.' }); return; }

      const auth = (await kv.get(AUTH_KEY)) || {};
      const key = email.toLowerCase();
      const record = auth[key];
      if (!record) {
        res.status(200).json({ ok: false, reason: 'no-account' });
        return;
      }

      const hash = hashPasscode(passcode, record.salt);
      if (hash !== record.hash) {
        res.status(200).json({ ok: false, reason: 'wrong-passcode' });
        return;
      }

      const state = await kv.get(STATE_KEY);
      const members = (state && state.clubMembers && state.clubMembers[record.club]) || [];
      const member = members.find(m => m.id === record.memberId);
      if (!member) {
        res.status(200).json({ ok: false, error: 'Your member profile could not be found. Ask your Administrator to check the roster.' });
        return;
      }

      const token = genToken();
      const sessions = (await kv.get(SESSION_KEY)) || {};
      sessions[token] = { email: key, memberId: record.memberId, club: record.club, createdAt: Date.now() };
      await kv.set(SESSION_KEY, sessions);

      res.status(200).json({ ok: true, token, member: memberPublicShape(member, record.club) });
      return;
    }

    if (action === 'session') {
      const token = body.token;
      if (!token) { res.status(200).json({ ok: false }); return; }
      const sessions = (await kv.get(SESSION_KEY)) || {};
      const s = sessions[token];
      if (!s) { res.status(200).json({ ok: false }); return; }

      const state = await kv.get(STATE_KEY);
      const members = (state && state.clubMembers && state.clubMembers[s.club]) || [];
      const member = members.find(m => m.id === s.memberId);
      if (!member) { res.status(200).json({ ok: false }); return; }

      res.status(200).json({ ok: true, member: memberPublicShape(member, s.club) });
      return;
    }

    if (action === 'logout') {
      const token = body.token;
      if (token) {
        const sessions = (await kv.get(SESSION_KEY)) || {};
        delete sessions[token];
        await kv.set(SESSION_KEY, sessions);
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
