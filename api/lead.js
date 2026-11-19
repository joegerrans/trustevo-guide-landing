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
// Production hostnames. Anything else stays on the guide sent by the page, or wtp.
const GUIDE_HOSTS = {
  'guide-wtp.trustevo.co.uk': 'wtp',
  'guide-45c.trustevo.co.uk': '45c'
};

function requestHost(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-forwarded-host'] || headers.host || '';
  return String(raw).split(',')[0].trim().split(':')[0].toLowerCase();
}

// A known guide in the body wins, so the page's ?g= override is kept on preview hosts.
// An unknown value never throws: a known guide hostname is used, otherwise wtp.
function resolveGuide(host, guide) {
  const key = typeof guide === 'string' ? guide.trim().toLowerCase() : '';
  if (GUIDES[key]) return key;
  const fromHost = GUIDE_HOSTS[requestHost({ headers: { host: host } })];
  return fromHost || 'wtp';
}

// LP Consent marker. The n8n guide-email workflow matches "| guide-<key> |" and "| guide-<key>/access |".
function consentMarker(guide, route) {
  return `guide-${guide}${route === 'access' ? '/access' : ''}`;
}

// Value per lead = meeting price x 0.70 contact x 0.20 booked x 0.65 held
const BANDS = {
  'u100':    { label: 'Under £100,000',       value: 1 },
  '100-250': { label: '£100,000 to £250,000', value: 36 },
  '250-500': { label: '£250,000 to £500,000', value: 50 },
  '500p':    { label: '£500,000+',            value: 64 }
};

// Airtable fields. The "new" ones need adding to the Leads table (see README).
// If a field is missing, the write still goes through without it.
const F = {
  name: 'Full Name', email: 'Email', phone: 'Phone', valid: 'Valid Number?', status: 'Lead Status',
  source: 'Funnel Source', campaign: 'Campaign Name', adset: 'Ad Set', adId: 'Meta Ad ID', platform: 'Platform',
  // new
  confirmed: 'LP Confirmed', confirmedAt: 'LP Confirmed At', confirmedPhone: 'Confirmed Phone',
  band: 'Self-Declared Band', consent: 'LP Consent', duplicate: 'Duplicate',
  // single line text (Airtable fldlPmH1zaMbjfbiu): email typed on /access when it differs
  // from the Meta form email. The typed email is also kept at the end of LP Consent.
  lpEmail: 'LP Email'
};
// An /access visitor whose email doesn't match is linked to a Meta lead with the
// exact same full name captured in the last NAME_MATCH_MINUTES.
const NAME_MATCH_MINUTES = 10;
const PENDING_MS = 2 * 60 * 60 * 1000;
const CONSENT_TEXT = 'I understand I will receive this guide and ongoing insights from TrustEvo by email, phone or SMS. You can opt out anytime.';

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const signingKey = () => process.env.SIGNING_SECRET || 'dev';
const sign = (id) => crypto.createHmac('sha256', signingKey()).update(String(id)).digest('hex').slice(0, 32);
// One-time signature for an access-route record created at step 1 before deferred creation.
// Kept so a visitor already on the phone step during deploy can still finish.
const signNew = (id) => sign(`new:${id}`);

// Step-1 details, signed with SIGNING_SECRET, valid for 2 hours. No record is created yet.
function signPending(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readPending(token) {
  if (typeof token !== 'string' || token.length < 3 || token.length > 4000) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;
  if (!GUIDES[payload.guide] || !payload.email || !payload.first || !payload.last || !payload.consent) return null;
  const age = Date.now() - payload.iat;
  if (age > PENDING_MS || age < -60 * 1000) return null;
  return payload;
}

function readSession(recordId, sig) {
  if (!sig) return null;
  if (!recordId) {
    const pending = readPending(sig);
    return pending ? { id: null, pending } : null;
  }
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

const META_UTM = new Set(['facebook', 'instagram', 'fb', 'ig']);

function normToken(value) {
  return String(value || '').trim().toLowerCase();
}

function trackSource(track) {
  return normToken(track && (track.platform || track.source));
}

function trackFbclid(track) {
  return String(track && track.fbclid || '').trim();
}

// Ad-route Funnel Source. fbclid counts; _fbc does not. Meta traffic stays on the ad route.
function funnelSource(track) {
  const src = trackSource(track);
  if (META_UTM.has(src) || trackFbclid(track)) return 'Meta';
  if (src === 'linkedin') return 'LinkedIn';
  if (src === 'google') return 'Google';
  if (src === 'email') return 'Website';
  return 'Other';
}

// Leads "Funnel Source" choices: Meta, Google, Website, LinkedIn, Referral, Partner, Other.
// A new /access record that matched no Meta lead must not be labelled Meta, and must not
// invent a choice (typecast would add one). Non-Meta visits already map onto an existing
// choice. A Meta-looking visit with no Meta lead is stored as Other.
function accessCreateSource(track) {
  const src = funnelSource(track);
  return src === 'Meta' ? 'Other' : src;
}

function sourceLabel(src) {
  if (src === 'linkedin') return 'LinkedIn';
  if (src === 'facebook' || src === 'fb') return 'Facebook';
  if (src === 'instagram' || src === 'ig') return 'Instagram';
  if (src === 'google') return 'Google';
  if (src === 'email') return 'Email';
  if (!src) return '';
  return src.charAt(0).toUpperCase() + src.slice(1);
}

function mediumLabel(medium) {
  const raw = String(medium || '').trim();
  if (!raw) return '';
  if (/^[a-z]{1,3}$/i.test(raw)) return raw.toUpperCase();
  return raw.toLowerCase();
}

// When utm_campaign is absent, keep source and medium in Campaign Name. An explicit campaign wins.
function adCampaign(guide, track) {
  const t = track || {};
  const explicit = String(t.campaign || '').trim();
  if (explicit) return directCampaign(guide, explicit);
  const channel = [sourceLabel(trackSource(t)), mediumLabel(t.medium)].filter(Boolean).join(' ');
  return channel || directCampaign(guide, '');
}

function headerCookie(req, name) {
  const headers = req && req.headers || {};
  const raw = headers.cookie || headers.Cookie || '';
  const match = String(raw).match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
}

// Which Meta event the band step sends. ConfirmedLead (/access) is the quality signal,
// so it is skipped for 'Under £100,000' answers. The ad-route Lead still fires for every band.
function metaEventFor(route, band) {
  if (route === 'access') return band === 'u100' ? null : 'ConfirmedLead';
  return 'Lead';
}

// Lead and ConfirmedLead only. _fbc counts here; it does not change Funnel Source.
function metaTraffic(track, fbc) {
  return META_UTM.has(trackSource(track)) || !!trackFbclid(track) || !!String(fbc || '').trim();
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
  const cutoff = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  const parts = [
    `{${F.source}}='Meta'`,
    `IS_AFTER({Date Captured}, DATETIME_PARSE(${formulaString(cutoff)}))`
  ];
  if (selfId) parts.push(`RECORD_ID()!=${formulaString(selfId)}`);
  return parts.join(',');
}

function emailFormula(email) {
  const cleaned = String(email || '').trim().toLowerCase();
  const at = cleaned.lastIndexOf('@');
  const local = at > 0 ? cleaned.slice(0, at) : '';
  const domain = at > 0 ? cleaned.slice(at + 1) : '';
  const values = (domain === 'gmail.com' || domain === 'googlemail.com')
    ? [`${local}@gmail.com`, `${local}@googlemail.com`]
    : [cleaned];
  // Email and LP Email, any age. gmail.com and googlemail.com stay the same address.
  const checks = [];
  for (const value of values) {
    const lit = formulaString(value);
    checks.push(`LOWER(TRIM({${F.email}}))=${lit}`);
    checks.push(`LOWER(TRIM({${F.lpEmail}}))=${lit}`);
  }
  return checks.length === 1 ? checks[0] : `OR(${checks.join(',')})`;
}

// Only the fixed Meta completion-screen labels. Every other campaign and ad set is stored as sent.
const ACCESS_LABELS = {
  'WTP LP access test v1': 'WTP Confirmed Route',
  'WTP LP access test v1 adset': 'WTP Confirmed Route',
  '45C LP access test v1': '45% Club Confirmed Route',
  '45C LP access test v1 adset': '45% Club Confirmed Route',
  '45% Club LP access test v1': '45% Club Confirmed Route',
  '45% Club LP access test v1 adset': '45% Club Confirmed Route'
};

function accessLabel(value) {
  const raw = String(value == null ? '' : value);
  return ACCESS_LABELS[raw.trim()] || raw;
}

function accessCampaign(guide, campaign) {
  const raw = String(campaign || '');
  if (!raw.trim()) return GUIDES[guide].campaignFallback;
  return accessLabel(raw);
}

function accessAdset(adset) {
  const raw = String(adset || '');
  if (!raw.trim()) return undefined;
  return accessLabel(raw);
}

function pendingPayload(b, email, consent, track) {
  const t = track || {};
  return {
    iat: Date.now(),
    first: String(b.first).trim(),
    last: String(b.last).trim(),
    email,
    consent,
    guide: b.guide,
    track: {
      campaign: t.campaign || '',
      medium: t.medium || '',
      adset: t.adset || '',
      ad: t.ad || '',
      adId: t.adId || '',
      platform: t.platform || '',
      source: t.source || '',
      fbclid: t.fbclid || ''
    }
  };
}

function accessNewFields(pending, e164) {
  const t = pending.track || {};
  const source = accessCreateSource(t);
  const fields = {
    [F.name]: joinName(pending.first, pending.last),
    [F.email]: pending.email,
    [F.status]: 'New',
    [F.campaign]: accessCampaign(pending.guide, t.campaign),
    [F.adset]: accessAdset(t.adset),
    [F.adId]: t.adId || undefined,
    [F.platform]: t.platform || undefined,
    [F.consent]: pending.consent,
    [F.confirmedPhone]: e164,
    [F.confirmed]: true,
    [F.confirmedAt]: new Date().toISOString()
  };
  if (source) fields[F.source] = source;
  return fields;
}

function strippedFieldExpr(fieldName) {
  let expr = `{${fieldName}}`;
  for (const ch of [' ', '-', '(', ')']) expr = `SUBSTITUTE(${expr},${formulaString(ch)},'')`;
  return expr;
}

function strippedPhoneExpr() {
  return strippedFieldExpr(F.phone);
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
    return `OR({${F.phone}}=${lit},{Phone Clean}=${lit},${stripped}=${lit})`;
  }).join(',');
  return `AND(${metaWindow(selfId)},OR(${ors}))`;
}

// Phone or Confirmed Phone, any age, any funnel. No self record exists yet on the deferred path.
function phoneAnyFormula(e164) {
  const phone = strippedPhoneExpr();
  const confirmed = strippedFieldExpr(F.confirmedPhone);
  const ors = phoneVariants(e164).map((v) => {
    const lit = formulaString(v);
    return `OR({${F.phone}}=${lit},{Phone Clean}=${lit},${phone}=${lit},{${F.confirmedPhone}}=${lit},${confirmed}=${lit})`;
  }).join(',');
  return `OR(${ors})`;
}

function duplicatePhoneFormula(e164, selfId) {
  const stripped = strippedPhoneExpr();
  const ors = phoneVariants(e164).map((v) => {
    const lit = formulaString(v);
    return `OR({${F.phone}}=${lit},${stripped}=${lit})`;
  }).join(',');
  return `AND(RECORD_ID()!=${formulaString(selfId)},OR(${ors}))`;
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

function normName(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// People sometimes type an email into the surname box. Drop the @ and everything after it
// before an exact name comparison, on both the typed name and the stored name.
function nameForMatch(value) {
  const raw = String(value || '');
  const at = raw.indexOf('@');
  return normName(at === -1 ? raw : raw.slice(0, at));
}

function strippedNameExpr() {
  const field = `{${F.name}}&""`;
  const at = formulaString('@');
  return `LOWER(TRIM(IF(FIND(${at},${field}),LEFT(${field},FIND(${at},${field})-1),${field})))`;
}

// Exact full name (case-insensitive, trimmed), Meta instant-form lead only, last 10 minutes.
function nameFormula(fullName) {
  const cutoff = new Date(Date.now() - NAME_MATCH_MINUTES * 60 * 1000).toISOString();
  return `AND({${F.source}}='Meta',{Meta Leadgen ID}!='',` +
    `IS_AFTER({Date Captured}, DATETIME_PARSE(${formulaString(cutoff)})),` +
    `${strippedNameExpr()}=${formulaString(nameForMatch(fullName))})`;
}

// Exact full name at any age, used when the phone step still has no record.
function exactNameFormula(fullName) {
  return `${strippedNameExpr()}=${formulaString(nameForMatch(fullName))}`;
}

async function findRecentMetaByName(fullName) {
  if (!nameForMatch(fullName)) return null;
  const j = await at('GET', listQuery(nameFormula(fullName)));
  return j.records && j.records[0];
}

async function findByExactName(fullName) {
  if (!nameForMatch(fullName)) return null;
  const j = await at('GET', listQuery(exactNameFormula(fullName)));
  return j.records && j.records[0];
}

function sameEmail(a, b) {
  const n = (v) => String(v || '').trim().toLowerCase().replace(/@googlemail\.com$/, '@gmail.com');
  return n(a) === n(b);
}

// Keep a different typed email without overwriting Email: LP Email (if the field exists)
// plus a suffix on LP Consent. The suffix sits after the marker, so the n8n FIND() still works.
function typedEmailFields(consent, typed, storedEmail) {
  if (!typed || sameEmail(typed, storedEmail)) return { [F.consent]: consent };
  return { [F.consent]: `${consent} | typed email: ${typed}`, [F.lpEmail]: typed };
}

async function findRecentMetaByPhone(e164, selfId) {
  const j = await at('GET', listQuery(phoneFormula(e164, selfId)));
  return j.records && j.records[0];
}

async function findByPhoneAny(e164) {
  const j = await at('GET', listQuery(phoneAnyFormula(e164)));
  return j.records && j.records[0];
}

function confirmOn(consent, typedEmail, storedEmail, e164) {
  return Object.assign({
    [F.confirmedPhone]: e164,
    [F.confirmed]: true,
    [F.confirmedAt]: new Date().toISOString()
  }, typedEmailFields(consent, typedEmail, storedEmail));
}

// Deferred /access phone step. Phone, then exact name, otherwise one new record.
async function settleAccessPhone(pending, e164) {
  const fullName = joinName(pending.first, pending.last);
  const byPhone = await findByPhoneAny(e164);
  const hit = byPhone || await findByExactName(fullName);
  if (hit) {
    const storedEmail = hit.fields && hit.fields[F.email];
    await write(hit.id, confirmOn(pending.consent, pending.email, storedEmail, e164));
    return hit.id;
  }
  const created = await write(null, accessNewFields(pending, e164));
  return created.id;
}

async function findOtherByPhone(e164, selfId) {
  const j = await at('GET', listQuery(duplicatePhoneFormula(e164, selfId)));
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
  b.guide = resolveGuide(requestHost(req), b.guide);
  const test = !process.env.AIRTABLE_TOKEN;

  try {
    // STEP 1: name, email, consent. The ad route always creates a new lead.
    // /access updates an existing lead by Email or LP Email, then by a recent Meta name.
    // If neither matches, nothing is created; the phone step carries a signed token.
    if (b.action === 'start') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !b.first || !b.last || !b.consent) return res.json({ ok: false, error: 'missing' });
      if (test) return res.json({ ok: true, test: true, recordId: 'test', sig: sign('test') });

      const t = b.track || {};
      const consent = `${new Date().toISOString()} | ${consentMarker(b.guide, route)} | ${CONSENT_TEXT}`;
      let emailDuplicate = false;
      if (route !== 'access') {
        try { emailDuplicate = !!(await findByEmail(email)); } catch (e) { emailDuplicate = false; }
      }
      let rec = route === 'access' ? await findByEmail(email) : null;
      // No email match: an exact-name Meta lead from the last 10 minutes is the same person.
      if (!rec && route === 'access') {
        try { rec = await findRecentMetaByName(joinName(b.first, b.last)); } catch (e) { rec = null; }
      }
      let created = false;
      if (rec) {
        // Existing lead: keep its name, email, source and campaign, just add consent.
        // A different typed email goes to LP Email. Email itself is never overwritten.
        const storedEmail = rec.fields && rec.fields[F.email];
        rec = await write(rec.id, typedEmailFields(consent, email, storedEmail));
      } else if (route === 'access') {
        const sig = signPending(pendingPayload(b, email, consent, t));
        await n8n({ step: 'start', guide: b.guide, route, created: false, recordId: null, email, first: b.first, last: b.last, track: t, sig });
        return res.json({ ok: true, recordId: null, sig });
      } else {
        created = true;
        const fields = {
          [F.name]: joinName(b.first, b.last), [F.email]: email, [F.status]: 'New',
          [F.source]: funnelSource(t),
          [F.campaign]: adCampaign(b.guide, t),
          [F.adset]: t.adset || undefined, [F.adId]: t.adId || undefined, [F.platform]: t.platform || undefined,
          [F.consent]: consent
        };
        if (emailDuplicate) fields[F.duplicate] = true;
        rec = await write(null, fields);
      }
      await n8n({ step: 'start', guide: b.guide, route, created, recordId: rec.id, email, first: b.first, last: b.last, track: t });
      const sig = route === 'access' && created ? signNew(rec.id) : sign(rec.id);
      return res.json({ ok: true, recordId: rec.id, sig });
    }

    // Later steps carry the signed record id, or the step-1 token when no record exists yet.
    const session = readSession(b.recordId, b.sig);
    if (!session) return res.status(400).json({ ok: false, error: 'session' });

    // STEP 2: mobile. A deferred access visit matches Phone / Confirmed Phone, then exact name.
    if (b.action === 'phone') {
      const e164 = normPhone(b.phone);
      if (!e164) return res.json({ ok: false, error: 'invalid' });
      const lk = await lookup(e164);
      if (!lk.valid) return res.json({ ok: false, error: 'invalid' });
      if (test) return res.json({ ok: true, test: true });

      let targetId = session.id;
      if (session.pending) {
        if (route !== 'access') return res.status(400).json({ ok: false, error: 'session' });
        targetId = await settleAccessPhone(session.pending, e164);
      } else if (route === 'access' && session.created) {
        const hit = otherRecord(await findRecentMetaByPhone(e164, session.id), session.id);
        if (hit) {
          const current = await at('GET', `/${session.id}`);
          const fields = {
            [F.confirmedPhone]: e164,
            [F.confirmed]: true,
            [F.confirmedAt]: new Date().toISOString()
          };
          const storedConsent = current.fields && current.fields[F.consent];
          const typed = current.fields && current.fields[F.email];
          if (storedConsent) Object.assign(fields, typedEmailFields(storedConsent, typed, hit.fields && hit.fields[F.email]));
          await write(hit.id, fields);
          // The step-1 record can't be deleted. Tick Duplicate so it is filtered out of calling.
          await write(session.id, { [F.duplicate]: true });
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
        if (route !== 'access') {
          try {
            const other = otherRecord(await findOtherByPhone(e164, session.id), session.id);
            if (other) fields[F.duplicate] = true;
          } catch (e) { /* a failed duplicate lookup must not block the lead */ }
        }
        await write(session.id, fields);
      }
      await n8n({ step: 'phone', guide: b.guide, route, recordId: targetId, phone: e164, lineStatus: lk.status || null });
      return res.json({ ok: true, recordId: targetId, sig: sign(targetId) });
    }

    // STEP 3: band, then tell Meta. A deferred visit has no record until the phone step.
    if (b.action === 'band') {
      if (!BANDS[b.band]) return res.json({ ok: false, error: 'band' });
      if (!session.id) return res.status(400).json({ ok: false, error: 'session' });
      if (test) return res.json({ ok: true, test: true });
      const rec = await write(session.id, { [F.band]: BANDS[b.band].label });
      const fbc = headerCookie(req, '_fbc') || b.fbc || '';
      const eventName = metaEventFor(route, b.band);
      if (eventName && metaTraffic(b.track, fbc)) {
        if (!b.fbc) b.fbc = fbc;
        b.eventId = b.eventId || crypto.randomUUID();
        await capi(b, rec, req, eventName, BANDS[b.band].value);
      }
      await n8n({ step: 'band', guide: b.guide, route, recordId: rec.id, band: BANDS[b.band].label, value: BANDS[b.band].value });
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
handler.funnelSource = funnelSource;
handler.adCampaign = adCampaign;
handler.metaTraffic = metaTraffic;
handler.metaEventFor = metaEventFor;
handler.emailFormula = emailFormula;
handler.accessCampaign = accessCampaign;
handler.accessAdset = accessAdset;
handler.phoneFormula = phoneFormula;
handler.formulaString = formulaString;
handler.sign = sign;
handler.signNew = signNew;
handler.signPending = signPending;
handler.readPending = readPending;
handler.joinName = joinName;
handler.nameFormula = nameFormula;
handler.nameForMatch = nameForMatch;
handler.exactNameFormula = exactNameFormula;
handler.phoneAnyFormula = phoneAnyFormula;
handler.accessCreateSource = accessCreateSource;
handler.resolveGuide = resolveGuide;
handler.requestHost = requestHost;
handler.consentMarker = consentMarker;
handler.typedEmailFields = typedEmailFields;
handler.NOTE_FIELDS = NOTE_FIELDS;
handler.resetNoteFieldCache = resetNoteFieldCache;
module.exports = handler;
