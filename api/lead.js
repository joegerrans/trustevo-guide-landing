// TrustEvo guide landing pages: one endpoint for all three steps.
// Runs on Vercel (Node 18+). No packages needed.
//
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   AIRTABLE_TOKEN      Airtable personal access token (data.records:read + write on the TrustEvo base)
//   AIRTABLE_BASE       optional, defaults to the TrustEvo base
//   AIRTABLE_TABLE      optional, defaults to the Leads table
//   TWILIO_SID          Twilio Account SID
//   TWILIO_TOKEN        Twilio Auth Token
//   META_PIXEL_ID       Meta Pixel / dataset ID
//   META_CAPI_TOKEN     Conversions API access token
//   META_TEST_CODE      optional, Test Events code while testing
//   SIGNING_SECRET      any long random string
//   N8N_WEBHOOK         optional, every step is also posted here so existing n8n flows can pick it up
//
// With no AIRTABLE_TOKEN set, the endpoint runs in test mode and saves nothing.

const crypto = require('crypto');

const BASE = process.env.AIRTABLE_BASE || 'appBBex89YjawmRxB';
const TABLE = process.env.AIRTABLE_TABLE || 'tblXffD6uZWW4275I';

const GUIDES = {
  wtp: { name: 'The Wealth Turning Point', campaignFallback: 'Landing Page - The Wealth Turning Point' }
};

// Value per lead = meeting price x 0.70 contact x 0.20 booked x 0.65 held
const BANDS = {
  'u100':    { label: 'Under £100,000',       value: 1 },
  '100-250': { label: '£100,000 to £250,000', value: 36 },
  '250-350': { label: '£250,000 to £350,000', value: 45 },
  '350-500': { label: '£350,000 to £500,000', value: 55 },
  '500p':    { label: '£500,000+',            value: 64 }
};

// Airtable fields. The "new" ones need adding to the Leads table (see README).
// If a field is missing, the write still goes through without it.
const F = {
  name: 'Full Name', email: 'Email', phone: 'Phone', valid: 'Valid Number?', status: 'Lead Status',
  source: 'Funnel Source', campaign: 'Campaign Name', adset: 'Ad Set', adId: 'Meta Ad ID', platform: 'Platform',
  // new
  confirmed: 'LP Confirmed', confirmedAt: 'LP Confirmed At', confirmedPhone: 'Confirmed Phone',
  band: 'Self-Declared Band', consent: 'LP Consent'
};
const CONSENT_TEXT = 'I understand I will receive this guide and ongoing insights from TrustEvo by email, phone or SMS. You can opt out anytime.';

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const sign = (id) => crypto.createHmac('sha256', process.env.SIGNING_SECRET || 'dev').update(String(id)).digest('hex').slice(0, 32);

function normPhone(v) {
  let d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+44')) d = '0' + d.slice(3); else if (d.startsWith('0044')) d = '0' + d.slice(4);
  if (!/^07\d{9}$/.test(d) || /(\d)\1{7,}/.test(d)) return null;
  return '+44' + d.slice(1);
}

// ---------- Airtable ----------
async function at(method, path, body) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error && (j.error.message || j.error.type) || `Airtable ${r.status}`); e.at = j.error; throw e; }
  return j;
}
// write, dropping any field the table doesn't have yet
async function write(id, fields) {
  for (let i = 0; i < 6; i++) {
    try {
      return id
        ? await at('PATCH', `/${id}`, { fields, typecast: true })
        : await at('POST', '', { fields, typecast: true });
    } catch (e) {
      const m = /Unknown field name: "([^"]+)"/.exec(e.message || '');
      if (m && m[1] in fields) { delete fields[m[1]]; continue; }
      throw e;
    }
  }
}
async function findByEmail(email) {
  const f = encodeURIComponent(`LOWER(TRIM({${F.email}}))='${email.replace(/'/g, "\\'")}'`);
  const j = await at('GET', `?filterByFormula=${f}&maxRecords=1&sort%5B0%5D%5Bfield%5D=Date%20Captured&sort%5B0%5D%5Bdirection%5D=desc`);
  return j.records && j.records[0];
}

// ---------- Twilio ----------
async function lookup(e164) {
  if (!process.env.TWILIO_SID) return { valid: true, skipped: true };
  try {
    const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_status`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64') }
    });
    if (r.status === 404) return { valid: false };
    if (!r.ok) return { valid: true, failed: true };           // Twilio problem: don't block a real person
    const j = await r.json();
    const status = j.line_status && j.line_status.status;
    return { valid: !!j.valid && status !== 'inactive', status };  // same rule as the Meta lead workflow
  } catch (e) { return { valid: true, failed: true }; }
}

// ---------- Meta CAPI ----------
async function capi(b, rec, req, eventName, value) {
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_TOKEN) return;
  const f = rec.fields || {};
  const [fn, ...rest] = String(f[F.name] || '').split(' ');
  const ud = {
    em: f[F.email] ? [sha(f[F.email])] : undefined,
    ph: b.phone || f[F.confirmedPhone] || f[F.phone] ? [sha(String(b.phone || f[F.confirmedPhone] || f[F.phone]).replace(/\D/g, ''))] : undefined,
    fn: fn ? [sha(fn)] : undefined, ln: rest.length ? [sha(rest.join(' '))] : undefined,
    country: [sha('gb')],
    external_id: [sha(rec.id)],
    fbp: b.fbp || undefined, fbc: b.fbc || undefined,
    client_ip_address: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
    client_user_agent: req.headers['user-agent'] || undefined
  };
  const body = {
    data: [{
      event_name: eventName, event_time: Math.floor(Date.now() / 1000), event_id: b.eventId,
      action_source: 'website', event_source_url: b.url,
      user_data: ud, custom_data: { currency: 'GBP', value, content_name: GUIDES[b.guide].name, lead_band: BANDS[b.band].label }
    }],
    access_token: process.env.META_CAPI_TOKEN
  };
  if (process.env.META_TEST_CODE) body.test_event_code = process.env.META_TEST_CODE;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${process.env.META_PIXEL_ID}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch (e) { /* never block the visitor on Meta */ }
}

async function n8n(payload) {
  if (!process.env.N8N_WEBHOOK) return;
  try { await fetch(process.env.N8N_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
}

// ---------- handler ----------
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const route = b.route === 'access' ? 'access' : 'ad';
  if (!GUIDES[b.guide]) b.guide = 'wtp';
  const test = !process.env.AIRTABLE_TOKEN;

  try {
    // STEP 1: name, email, consent
    if (b.action === 'start') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !b.first || !b.last || !b.consent) return res.json({ ok: false, error: 'missing' });
      if (test) return res.json({ ok: true, test: true, recordId: 'test', sig: sign('test') });

      const t = b.track || {};
      const consent = `${new Date().toISOString()} | ${route === 'access' ? 'guide-wtp/access' : 'guide-wtp'} | ${CONSENT_TEXT}`;
      let rec = route === 'access' ? await findByEmail(email) : null;
      let created = false;
      if (rec) {
        // Meta form lead found: keep its name and source, just add consent
        rec = await write(rec.id, { [F.consent]: consent });
      } else {
        created = true;
        rec = await write(null, {
          [F.name]: `${b.first} ${b.last}`.trim(), [F.email]: email, [F.status]: 'New',
          [F.source]: route === 'access' ? 'Meta' : 'Meta LP',
          [F.campaign]: t.campaign || GUIDES[b.guide].campaignFallback,
          [F.adset]: t.adset || undefined, [F.adId]: t.adId || undefined, [F.platform]: t.platform || undefined,
          [F.consent]: consent
        });
      }
      await n8n({ step: 'start', route, created, recordId: rec.id, email, first: b.first, last: b.last, track: t });
      return res.json({ ok: true, recordId: rec.id, sig: sign(rec.id) });
    }

    // every later step must carry the record id we issued
    if (!b.recordId || b.sig !== sign(b.recordId)) return res.status(400).json({ ok: false, error: 'session' });

    // STEP 2: mobile
    if (b.action === 'phone') {
      const e164 = normPhone(b.phone);
      if (!e164) return res.json({ ok: false, error: 'invalid' });
      const lk = await lookup(e164);
      if (!lk.valid) return res.json({ ok: false, error: 'invalid' });
      if (test) return res.json({ ok: true, test: true });

      const fields = route === 'access'
        ? { [F.confirmedPhone]: e164, [F.confirmed]: true, [F.confirmedAt]: new Date().toISOString() }
        : { [F.phone]: e164, [F.valid]: true };
      const rec = await write(b.recordId, fields);
      await n8n({ step: 'phone', route, recordId: rec.id, phone: e164, lineStatus: lk.status || null });
      return res.json({ ok: true });
    }

    // STEP 3: band, then tell Meta
    if (b.action === 'band') {
      if (!BANDS[b.band]) return res.json({ ok: false, error: 'band' });
      if (test) return res.json({ ok: true, test: true });
      const rec = await write(b.recordId, { [F.band]: BANDS[b.band].label });
      b.eventId = b.eventId || crypto.randomUUID();
      await capi(b, rec, req, route === 'access' ? 'ConfirmedLead' : 'Lead', BANDS[b.band].value);
      await n8n({ step: 'band', route, recordId: rec.id, band: BANDS[b.band].label, value: BANDS[b.band].value });
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false });
  } catch (e) {
    console.error('lead error', b.action, e.message);
    return res.status(500).json({ ok: false, error: 'server' });
  }
};
