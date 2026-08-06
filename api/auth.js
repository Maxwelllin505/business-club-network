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

function findPendingByEmail(state, email) {
  if (!state || !Array.isArray(state.pendingAccounts)) return null;
  const target = email.trim().toLowerCase();
  const idx = state.pendingAccounts.findIndex(p => (p.contact || '').trim().toLowerCase() === target);
  return idx > -1 ? { member: state.pendingAccounts[idx], idx } : null;
}

// A friendly default display name derived from the local part of an email, e.g. "jane.doe@school.edu" -> "Jane Doe".
function nameFromEmail(email) {
  const local = email.split('@')[0] || 'New Member';
  const words = local.split(/[._\-+0-9]+/).filter(Boolean);
  if (!words.length) return 'New Member';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function memberPublicShape(m, club) {
  return { id: m.id, name: m.name, email: m.contact, club: club || null, accountLevels: m.accountLevels || [] };
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

      const auth = (await kv.get(AUTH_KEY)) || {};
      const key = email.toLowerCase();
      if (auth[key]) {
        res.status(200).json({ ok: false, error: 'An account already exists for this email. Enter your existing passcode instead.' });
        return;
      }

      const state = (await kv.get(STATE_KEY)) || {};
      const found = findMemberByEmail(state, email);

      let member, club, memberId;
      if (found) {
        // Email matches an existing roster member — tie the new credential to that member record.
        member = found.member;
        club = found.club;
        memberId = found.member.id;
      } else {
        // No existing roster entry for this email — create an open, Public-mode account that any
        // Administrator can later promote (via account levels) or add into a specific club's roster.
        if (!Array.isArray(state.pendingAccounts)) state.pendingAccounts = [];
        if (typeof state.nextId !== 'number') state.nextId = 1000;
        memberId = state.nextId++;
        member = {
          id: memberId, name: nameFromEmail(email), role: '', accountLevels: [], contact: email,
          grade: '', joined: '', bio: '', pastRoles: []
        };
        state.pendingAccounts.push(member);
        club = null;
        await kv.set(STATE_KEY, state);
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPasscode(passcode, salt);
      auth[key] = { salt, hash, memberId, club, email };
      await kv.set(AUTH_KEY, auth);

      const token = genToken();
      const sessions = (await kv.get(SESSION_KEY)) || {};
      sessions[token] = { email: key, memberId, club, createdAt: Date.now() };
      await kv.set(SESSION_KEY, sessions);

      res.status(200).json({ ok: true, token, member: memberPublicShape(member, club) });
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
      let member;
      if (record.club) {
        const members = (state && state.clubMembers && state.clubMembers[record.club]) || [];
        member = members.find(m => m.id === record.memberId);
      } else {
        const pending = (state && state.pendingAccounts) || [];
        member = pending.find(m => m.id === record.memberId);
      }
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
      let member;
      if (s.club) {
        const members = (state && state.clubMembers && state.clubMembers[s.club]) || [];
        member = members.find(m => m.id === s.memberId);
      } else {
        const pending = (state && state.pendingAccounts) || [];
        member = pending.find(m => m.id === s.memberId);
        if (!member) {
          // They may have since been added into a club's roster by an Administrator — search there too.
          const state2 = state || {};
          if (state2.clubMembers) {
            for (const c of Object.keys(state2.clubMembers)) {
              const m2 = (state2.clubMembers[c] || []).find(m => m.id === s.memberId);
              if (m2) { member = m2; s.club = c; break; }
            }
          }
        }
      }
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
