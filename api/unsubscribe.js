// TrustEvo one-click unsubscribe (emails only).
// POST /api/unsubscribe  body: { "r": "<Airtable record id>" }
//
// Sets exactly what the existing n8n WATCHER sets on an unsubscribe:
//   Unsubscribed = true, Sequence Stopped = true, Sequence Stop Reason = "Unsubscribed"
// It only ever PATCHes an existing record; it never creates one.
// Unknown record ids get the same friendly response, so nothing is revealed.
//
// Environment variables (same names as api/lead.js):
//   AIRTABLE_TOKEN   Airtable personal access token (records write on the TrustEvo base)
//   AIRTABLE_BASE    optional, defaults to the TrustEvo base
//   AIRTABLE_TABLE   optional, defaults to the Leads table

const BASE = process.env.AIRTABLE_BASE || 'appBBex89YjawmRxB';
const TABLE = process.env.AIRTABLE_TABLE || 'tblXffD6uZWW4275I';
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const DONE = "You've been unsubscribed. You won't receive any more TrustEvo emails. This doesn't affect anything else.";

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (e) { return {}; } }
  return typeof b === 'object' ? b : {};
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  const r = String(parseBody(req).r || '').trim();
  if (!RECORD_ID.test(r)) return res.status(400).json({ ok: false, error: 'invalid' });

  if (!process.env.AIRTABLE_TOKEN) return res.status(503).json({ ok: false, error: 'unavailable' });

  try {
    const resp = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}/${r}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { 'Unsubscribed': true, 'Sequence Stopped': true, 'Sequence Stop Reason': 'Unsubscribed' },
        typecast: true
      })
    });
    if (resp.ok) return res.status(200).json({ ok: true, message: DONE });

    const j = await resp.json().catch(() => ({}));
    const type = String((j && j.error && (j.error.type || j.error)) || '');
    // Record doesn't exist (deleted, or a made-up id): answer the same way.
    if (resp.status === 404 || /NOT_FOUND|ROW_DOES_NOT_EXIST/i.test(type)) {
      return res.status(200).json({ ok: true, message: DONE });
    }
    console.error('unsubscribe: airtable', resp.status, type);
    return res.status(502).json({ ok: false, error: 'server' });
  } catch (e) {
    console.error('unsubscribe: error', e && e.message);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}

handler.RECORD_ID = RECORD_ID;
handler.DONE = DONE;
module.exports = handler;
