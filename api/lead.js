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
  wtp: { name: 'The Wealth Turning Point', campaignFallback: 'Landing Page - The Wealth Turning Point', code: 'WTP' },
  '45c': { name: 'The 45% Club', campaignFallback: 'Landing Page - The 45% Club', code: '45C' }
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
// One-time signature for an access-route record created at step 1 (no email match yet).
const signNew = (id) => sign(`new:${id}`);

function readSession(recordId, sig) {
  if (!recordId || !sig) return null;
  const id = String(recordId);
  if (sig === signNew(id)) return { id, created: true };
  if (sig === sign(id)) return { id, created: false };
  return null;
}

function normPhone(v) {
  let d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+44')) d = '0' + d.slice(3);
  else if (d.startsWith('0044')) d = '0' + d.slice(4);
  else if (d.startsWith('44') && d.length === 12) d = '0' + d.slice(2);
  d = d.replace(/^0+(?=7)/, '0');
  if (!/^07\d{9}$/.test(d) || /(\d)\1{7,}/.test(d)) return null;
  return '+44' + d.slice(1);
}

function joinName(first, last) {
  return `${String(first || '').trim()} ${String(last || '').trim()}`.trim();
}

function guideCode(guide) {
  const g = GUIDES[guide];
  return g && g.code ? g.code : 'WTP';
}

function directCampaign(guide, campaignName) {
  const base = `${guideCode(guide)} Direct`;
  const extra = String(campaignName || '').trim();
  return extra ? `${base} | ${extra}` : base;
}

// Airtable formula string literal. Escapes the value so it cannot break out of the quotes.
function formulaString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

function metaWindow(selfId) {
  const parts = [
    `{${F.source}}='Meta'`,
    `DATETIME_DIFF(NOW(),{Date Captured},'minutes')>=0`,
    `DATETIME_DIFF(NOW(),{Date Captured},'minutes')<=120`
  ];
  if (selfId) parts.push(`RECORD_ID()!=${formulaString(selfId)}`);
  return parts.join(',');
}

function emailFormula(email) {
  return `LOWER(TRIM({${F.email}}))=${formulaString(String(email || '').trim().toLowerCase())}`;
}

function strippedPhoneExpr() {
  let expr = `{${F.phone}}`;
  for (const ch of [' ', '-', '(', ')']) expr = `SUBSTITUTE(${expr},${formulaString(ch)},'')`;
  return expr;
}

function phoneVariants(e164) {
  const digits = String(e164).replace(/\D/g, '');
  const national = digits.startsWith('44') ? `0${digits.slice(2)}` : digits;
  return [...new Set([e164, digits, national, `00${digits}`])];
}

function phoneFormula(e164, selfId) {
  const stripped = strippedPhoneExpr();
  const ors = phoneVariants(e164).map((v) => {
    const lit = formulaString(v);
    return `OR({${F.phone}}=${lit},${stripped}=${lit})`;
  }).join(',');
  return `AND(${metaWindow(selfId)},OR(${ors}))`;
}

function nameFormula(fullName, selfId) {
  const exact = `LOWER(TRIM({${F.name}}))=LOWER(${formulaString(String(fullName || '').trim())})`;
  return `AND(${exact},${metaWindow(selfId)})`;
}

function listQuery(formula) {
  return `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&sort%5B0%5D%5Bfield%5D=Date%20Captured&sort%5B0%5D%5Bdirection%5D=desc`;
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
const NOTE_FIELDS = ['Notes', 'Note', 'Comments', 'Comment', 'Lead Notes', 'Internal Notes'];
let noteFieldCache;

function resetNoteFieldCache() {
  noteFieldCache = undefined;
}

function isUnknownField(err) {
  return /Unknown field name:/i.test((err && err.message) || '') || (err && err.at && err.at.type === 'UNKNOWN_FIELD_NAME');
}

// Lead Status is left as it is. The note is written only when a text field with one of these names already exists.
async function writeMergeNote(fromId, intoId) {
  const note = `Merged into ${intoId}`;
  if (noteFieldCache === null) return;
  const fields = noteFieldCache ? [noteFieldCache] : NOTE_FIELDS;
  for (const field of fields) {
    try {
      await at('PATCH', `/${fromId}`, { fields: { [field]: note } });
      noteFieldCache = field;
      return;
    } catch (e) {
      if (isUnknownField(e)) continue;
      console.error('merge note', e.message);
      return;
    }
  }
  noteFieldCache = null;
}

async function findByEmail(email) {
  const j = await at('GET', listQuery(emailFormula(email)));
  return j.records && j.records[0];
}

async function findRecentMetaByPhone(e164, selfId) {
  const j = await at('GET', listQuery(phoneFormula(e164, selfId)));
  return j.records && j.records[0];
}

async function findRecentMetaByName(fullName, selfId) {
  const name = String(fullName || '').trim();
  if (!name) return null;
  const j = await at('GET', listQuery(nameFormula(name, selfId)));
  return j.records && j.records[0];
}

function otherRecord(rec, selfId) {
  if (!rec || !rec.id || rec.id === selfId) return null;
  return rec;
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
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const route = b.route === 'access' ? 'access' : 'ad';
  if (typeof b.guide === 'string') b.guide = b.guide.toLowerCase();
  if (!GUIDES[b.guide]) b.guide = 'wtp';
  const test = !process.env.AIRTABLE_TOKEN;

  try {
    // STEP 1: name, email, consent. Access route matches email only, then creates immediately.
    if (b.action === 'start') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !b.first || !b.last || !b.consent) return res.json({ ok: false, error: 'missing' });
      if (test) return res.json({ ok: true, test: true, recordId: 'test', sig: sign('test') });

      const t = b.track || {};
      const consent = `${new Date().toISOString()} | ${route === 'access' ? 'guide-wtp/access' : 'guide-wtp'} | ${CONSENT_TEXT}`;
      let rec = route === 'access' ? await findByEmail(email) : null;
      let created = false;
      if (rec) {
        // Meta form lead found: keep its name, source and campaign, just add consent
        rec = await write(rec.id, { [F.consent]: consent });
      } else {
        created = true;
        rec = await write(null, {
          [F.name]: joinName(b.first, b.last), [F.email]: email, [F.status]: 'New',
          [F.source]: route === 'access' ? 'Meta' : 'Meta LP',
          [F.campaign]: route === 'access'
            ? (t.campaign || GUIDES[b.guide].campaignFallback)
            : directCampaign(b.guide, t.campaign),
          [F.adset]: t.adset || undefined, [F.adId]: t.adId || undefined, [F.platform]: t.platform || undefined,
          [F.consent]: consent
        });
      }
      await n8n({ step: 'start', route, created, recordId: rec.id, email, first: b.first, last: b.last, track: t });
      const sig = route === 'access' && created ? signNew(rec.id) : sign(rec.id);
      return res.json({ ok: true, recordId: rec.id, sig });
    }

    // Later steps carry the signed record id. A new-record sig lets the phone step match a Meta lead.
    const session = readSession(b.recordId, b.sig);
    if (!session) return res.status(400).json({ ok: false, error: 'session' });

    // STEP 2: mobile. On a newly created access lead: phone match, then exact name, both within 2 hours.
    if (b.action === 'phone') {
      const e164 = normPhone(b.phone);
      if (!e164) return res.json({ ok: false, error: 'invalid' });
      const lk = await lookup(e164);
      if (!lk.valid) return res.json({ ok: false, error: 'invalid' });
      if (test) return res.json({ ok: true, test: true });

      let targetId = session.id;
      if (route === 'access' && session.created) {
        let hit = otherRecord(await findRecentMetaByPhone(e164, session.id), session.id);
        let current = null;
        if (!hit) {
          current = await at('GET', `/${session.id}`);
          const name = String((current.fields || {})[F.name] || '').trim();
          if (name) hit = otherRecord(await findRecentMetaByName(name, session.id), session.id);
        }
        if (hit) {
          if (!current) current = await at('GET', `/${session.id}`);
          const fields = {
            [F.confirmedPhone]: e164,
            [F.confirmed]: true,
            [F.confirmedAt]: new Date().toISOString()
          };
          const storedConsent = current.fields && current.fields[F.consent];
          if (storedConsent) fields[F.consent] = storedConsent;
          await write(hit.id, fields);
          await writeMergeNote(session.id, hit.id);
          targetId = hit.id;
        } else {
          await write(session.id, {
            [F.confirmedPhone]: e164,
            [F.confirmed]: true,
            [F.confirmedAt]: new Date().toISOString()
          });
        }
      } else {
        const fields = route === 'access'
          ? { [F.confirmedPhone]: e164, [F.confirmed]: true, [F.confirmedAt]: new Date().toISOString() }
          : { [F.phone]: e164, [F.valid]: true };
        await write(session.id, fields);
      }
      await n8n({ step: 'phone', route, recordId: targetId, phone: e164, lineStatus: lk.status || null });
      return res.json({ ok: true, recordId: targetId, sig: sign(targetId) });
    }

    // STEP 3: band, then tell Meta
    if (b.action === 'band') {
      if (!BANDS[b.band]) return res.json({ ok: false, error: 'band' });
      if (test) return res.json({ ok: true, test: true });
      const rec = await write(session.id, { [F.band]: BANDS[b.band].label });
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
}

handler.normPhone = normPhone;
handler.directCampaign = directCampaign;
handler.emailFormula = emailFormula;
handler.phoneFormula = phoneFormula;
handler.nameFormula = nameFormula;
handler.formulaString = formulaString;
handler.sign = sign;
handler.signNew = signNew;
handler.joinName = joinName;
handler.NOTE_FIELDS = NOTE_FIELDS;
handler.resetNoteFieldCache = resetNoteFieldCache;
module.exports = handler;
