const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

for (const key of ['TWILIO_SID', 'TWILIO_TOKEN', 'META_PIXEL_ID', 'META_CAPI_TOKEN', 'META_TEST_CODE', 'N8N_WEBHOOK']) {
  delete process.env[key];
}
process.env.AIRTABLE_TOKEN = 'pat-test';
process.env.SIGNING_SECRET = 'test-signing-secret';

const lead = require('../api/lead');
const originalFetch = global.fetch;
const CONSENT = 'I understand I will receive this guide and ongoing insights from TrustEvo by email, phone or SMS. You can opt out anytime.';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

async function post(body) {
  const res = mockRes();
  await lead({ method: 'POST', body, headers: {} }, res);
  return res;
}

function parseCall(url, opts = {}) {
  const u = new URL(String(url));
  const parts = u.pathname.split('/');
  const last = parts[parts.length - 1];
  return {
    url: String(url),
    method: opts.method || 'GET',
    body: opts.body ? JSON.parse(opts.body) : undefined,
    formula: u.searchParams.get('filterByFormula'),
    recordId: /^rec/.test(last) ? last : null,
    maxRecords: u.searchParams.get('maxRecords'),
    sortField: u.searchParams.get('sort[0][field]'),
    sortDir: u.searchParams.get('sort[0][direction]')
  };
}

function installAirtable(opts = {}) {
  const emailRecords = opts.emailRecords || [];
  const phoneRecords = opts.phoneRecords || [];
  const nameRecords = opts.nameRecords || [];
  const recordFields = opts.recordFields || {};
  const noteStatus = opts.noteStatus == null ? 422 : opts.noteStatus;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = parseCall(url, init);
    calls.push(call);
    if (call.method === 'DELETE') throw new Error('refusing to delete');
    let status = 200;
    let json;
    if (call.method === 'GET' && call.formula) {
      assert.equal(call.maxRecords, '1');
      assert.equal(call.sortField, 'Date Captured');
      assert.equal(call.sortDir, 'desc');
      if (call.formula.includes('{Email}')) json = { records: emailRecords };
      else if (call.formula.includes('{Phone}')) json = { records: phoneRecords };
      else if (call.formula.includes('{Full Name}')) json = { records: nameRecords };
      else throw new Error(`unexpected formula ${call.formula}`);
    } else if (call.method === 'GET' && call.recordId) {
      json = { id: call.recordId, fields: recordFields[call.recordId] || {} };
    } else if (call.method === 'POST') {
      json = { id: 'recNEW', fields: call.body.fields };
    } else if (call.method === 'PATCH') {
      const keys = Object.keys(call.body.fields || {});
      const noteKey = keys.find((key) => lead.NOTE_FIELDS.includes(key));
      if (noteKey && keys.length === 1 && noteStatus !== 200) {
        status = noteStatus;
        json = { error: { type: 'UNKNOWN_FIELD_NAME', message: `Unknown field name: "${noteKey}"` } };
      } else {
        json = { id: call.recordId, fields: call.body.fields };
      }
    } else {
      throw new Error(`unexpected ${call.method} ${call.url}`);
    }
    return { ok: status < 300, status, json: async () => json };
  };
  return calls;
}

function startBody(over = {}) {
  return Object.assign({
    action: 'start',
    route: 'access',
    guide: 'wtp',
    first: 'Jane',
    last: 'Doe',
    email: 'jane@example.com',
    consent: true,
    track: {}
  }, over);
}

beforeEach(() => {
  lead.resetNoteFieldCache();
  global.fetch = async () => { throw new Error('unexpected fetch'); };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('normPhone writes UK mobiles as +447 E.164', () => {
  const samples = [
    '07700900123',
    '07700 900123',
    '+44 7700 900123',
    '+447700900123',
    '447700900123',
    '00447700900123',
    '0044 7700 900123',
    '+44 (0)7700 900123',
    '44 7700 900 123'
  ];
  for (const sample of samples) assert.equal(lead.normPhone(sample), '+447700900123', sample);
  assert.equal(lead.normPhone('07111111111'), null);
  assert.equal(lead.normPhone('07777777777'), null);
  assert.equal(lead.normPhone('02079460958'), null);
  assert.equal(lead.normPhone(''), null);
});

test('matching does not use a name formula', () => {
  assert.equal(lead.nameFormula, undefined);
  const phone = lead.phoneFormula('+447700900123', 'recNEW');
  assert.equal(phone.includes('Full Name'), false);
  assert.match(phone, /\{Phone\}/);
});

test('formula values cannot break out of the string literal', () => {
  assert.equal(lead.formulaString("O'Brien"), "'O\\'Brien'");
  assert.equal(lead.formulaString('a\\b'), "'a\\\\b'");
  assert.equal(lead.formulaString("Ann'); TRUE()"), "'Ann\\'); TRUE()'");
  const phone = lead.phoneFormula("+447700900123", "rec'X");
  for (const variant of ['+447700900123', '447700900123', '07700900123', '00447700900123']) {
    assert.ok(phone.includes(lead.formulaString(variant)), variant);
  }
  assert.match(phone, /RECORD_ID\(\)!='rec\\'X'/);
  assert.match(phone, /\{Funnel Source\}='Meta'/);
  assert.equal(phone.includes("'Meta LP'"), false);
});

test('email formula keeps the existing most-recent email match and direct campaigns are labelled', () => {
  assert.equal(lead.emailFormula(" o'brien@example.com "), "LOWER(TRIM({Email}))='o\\'brien@example.com'");
  assert.equal(lead.emailFormula('jane@example.com').includes('Funnel Source'), false);
  assert.equal(lead.directCampaign('wtp', ''), 'WTP Direct');
  assert.equal(lead.directCampaign('wtp', '   '), 'WTP Direct');
  assert.equal(lead.directCampaign('wtp', ' Spring Sale '), 'WTP Direct | Spring Sale');
  assert.equal(lead.directCampaign('45c', ''), '45C Direct');
  assert.equal(lead.directCampaign('45c', 'Launch'), '45C Direct | Launch');
  assert.equal(lead.joinName('  Jane ', ' Doe '), 'Jane Doe');
  assert.equal(lead.joinName('Mary Ann', 'Smith'), 'Mary Ann Smith');
});

test('access start uses an email match and leaves name, source and campaign untouched', async () => {
  const calls = installAirtable({
    emailRecords: [{ id: 'recMETA', fields: { 'Full Name': 'Existing', 'Funnel Source': 'Meta', 'Campaign Name': 'Ad Name' } }]
  });
  const res = await post(startBody({ email: "o'brien@example.com", first: 'Pat', last: 'Meta' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.recordId, 'recMETA');
  assert.equal(res.body.sig, lead.sign('recMETA'));
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
  assert.match(calls[0].formula, /LOWER\(TRIM\(\{Email\}\)\)='o\\'brien@example.com'/);
  assert.equal(calls[0].formula.includes('{Phone}'), false);
  assert.equal(calls[0].formula.includes('Full Name'), false);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(Object.keys(patch.body.fields), ['LP Consent']);
  assert.match(patch.body.fields['LP Consent'], /guide-wtp\/access \| /);
  assert.match(patch.body.fields['LP Consent'], new RegExp(CONSENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(calls.some((call) => call.method === 'POST' || call.method === 'DELETE'), false);
});

test('access start with no email match creates the record immediately', async () => {
  const calls = installAirtable();
  const res = await post(startBody({ first: ' Jane ', last: ' Doe ', track: { campaign: 'Form Ad', adset: 'Broad' } }));
  assert.equal(res.body.recordId, 'recNEW');
  assert.equal(res.body.sig, lead.signNew('recNEW'));
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(calls[0].formula.includes('{Phone}'), false);
  assert.equal(calls[0].formula.includes('Full Name'), false);
  const created = calls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created['Full Name'], 'Jane Doe');
  assert.equal(created.Email, 'jane@example.com');
  assert.equal(created['Lead Status'], 'New');
  assert.equal(created['Funnel Source'], 'Meta');
  assert.equal(created['Campaign Name'], 'Form Ad');
  assert.equal(created['Ad Set'], 'Broad');
  assert.match(created['LP Consent'], /guide-wtp\/access/);
});

test('access no-match without a track campaign keeps the guide fallback', async () => {
  const calls = installAirtable();
  await post(startBody({ guide: '45c' }));
  const created = calls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created['Campaign Name'], 'Landing Page - The 45% Club');
  assert.equal(created['Funnel Source'], 'Meta');
  assert.equal(created['Campaign Name'].includes('Direct'), false);
});

test('direct ad route labels new Meta LP records with the guide and utm campaign', async () => {
  const calls = installAirtable();
  const res = await post(startBody({
    route: 'ad',
    guide: '45C',
    track: { campaign: 'Launch', adId: 'ad9', platform: 'facebook' }
  }));
  assert.equal(calls.some((call) => call.method === 'GET'), false);
  assert.equal(res.body.sig, lead.sign('recNEW'));
  const created = calls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created['Funnel Source'], 'Meta LP');
  assert.equal(created['Campaign Name'], '45C Direct | Launch');
  assert.equal(created['Meta Ad ID'], 'ad9');
  assert.equal(created.Platform, 'facebook');

  const plain = installAirtable();
  await post(startBody({ route: 'ad', guide: 'wtp', track: { campaign: '   ' } }));
  assert.equal(plain.find((call) => call.method === 'POST').body.fields['Campaign Name'], 'WTP Direct');
});

test('phone and confirmed phone are stored as E.164 and a new access lead is kept when nothing matches', async () => {
  const rawNumbers = ['07700900123', '07700 900123', '+44 7700 900123', '447700900123', '00447700900123', '+447700900123'];
  for (const raw of rawNumbers) {
    const calls = installAirtable();
    const start = await post(startBody({ route: 'ad', email: `p${raw.length}@example.com` }));
    const phone = await post({
      action: 'phone', route: 'ad', guide: 'wtp', phone: raw,
      recordId: start.body.recordId, sig: start.body.sig
    });
    assert.equal(phone.body.ok, true, raw);
    assert.equal(phone.body.recordId, 'recNEW');
    assert.equal(phone.body.sig, lead.sign('recNEW'));
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.equal(patch.body.fields.Phone, '+447700900123', raw);
    assert.equal(patch.body.fields['Valid Number?'], true);
    assert.equal(calls.some((call) => call.formula && call.formula.includes('{Phone}')), false);
  }

  const calls = installAirtable({
    recordFields: { recNEW: { 'Full Name': 'Jane Doe', 'LP Consent': 'stored consent' } }
  });
  const start = await post(startBody());
  const phone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07700 900123',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(phone.body.ok, true);
  assert.equal(phone.body.recordId, 'recNEW');
  assert.equal(phone.body.sig, lead.sign('recNEW'));
  const kinds = calls.filter((call) => call.formula).map((call) => (
    call.formula.includes('{Phone}') ? 'phone' : call.formula.includes('{Full Name}') ? 'name' : 'email'
  ));
  assert.deepEqual(kinds, ['email', 'phone']);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.recordId, 'recNEW');
  assert.equal(patch.body.fields['Confirmed Phone'], '+447700900123');
  assert.equal(patch.body.fields['LP Confirmed'], true);
  assert.match(patch.body.fields['LP Confirmed At'], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
});

test('a new access lead adopts a recent Meta phone match and the next step uses that record', async () => {
  const calls = installAirtable({
    phoneRecords: [{ id: 'recPHONE', fields: { Phone: '+447700900123', 'Funnel Source': 'Meta', 'Campaign Name': 'Keep Me' } }],
    recordFields: {
      recNEW: {
        'Full Name': 'Jane Doe',
        'Funnel Source': 'Meta',
        'Campaign Name': 'Form Ad',
        'LP Consent': `2026-01-01T00:00:00.000Z | guide-wtp/access | ${CONSENT}`
      }
    },
    noteStatus: 200
  });
  const start = await post(startBody({ track: { campaign: 'Form Ad' } }));
  const phone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07700 900123',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(phone.body.ok, true);
  assert.equal(phone.body.recordId, 'recPHONE');
  assert.equal(phone.body.sig, lead.sign('recPHONE'));
  assert.equal(calls.some((call) => call.formula && call.formula.includes('{Full Name}')), false);
  const phoneGet = calls.find((call) => call.formula && call.formula.includes('{Phone}'));
  assert.match(phoneGet.formula, /\+447700900123/);
  assert.match(phoneGet.formula, /\{Funnel Source\}='Meta'/);
  assert.match(phoneGet.formula, /<=120/);
  assert.match(phoneGet.formula, /RECORD_ID\(\)!='recNEW'/);
  const confirmed = calls.find((call) => call.method === 'PATCH' && call.recordId === 'recPHONE');
  assert.equal(confirmed.body.fields['Confirmed Phone'], '+447700900123');
  assert.equal(confirmed.body.fields['LP Confirmed'], true);
  assert.equal(confirmed.body.fields['LP Consent'], `2026-01-01T00:00:00.000Z | guide-wtp/access | ${CONSENT}`);
  for (const key of ['Full Name', 'Funnel Source', 'Campaign Name', 'Lead Status', 'Phone']) {
    assert.equal(confirmed.body.fields[key], undefined, key);
  }
  const note = calls.find((call) => call.method === 'PATCH' && call.recordId === 'recNEW');
  assert.deepEqual(note.body.fields, { Notes: 'Merged into recPHONE' });
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);

  const band = await post({
    action: 'band', route: 'access', guide: 'wtp', band: '100-250',
    recordId: phone.body.recordId, sig: phone.body.sig
  });
  assert.equal(band.body.ok, true);
  const bandPatch = calls.find((call) => call.body && call.body.fields && call.body.fields['Self-Declared Band']);
  assert.equal(bandPatch.recordId, 'recPHONE');
  assert.equal(bandPatch.body.fields['Self-Declared Band'], '£100,000 to £250,000');
});

test('a phone miss does not match by name and keeps the new access record', async () => {
  const calls = installAirtable({
    nameRecords: [{ id: 'recNAME', fields: { 'Full Name': 'jane DOE', 'Funnel Source': 'Meta' } }],
    recordFields: { recNEW: { 'Full Name': 'jane DOE', 'LP Consent': 'stored consent' } }
  });
  const start = await post(startBody({ first: 'jane', last: 'DOE' }));
  const phone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '+447700900123',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(phone.body.recordId, 'recNEW');
  assert.equal(calls.some((call) => call.formula && call.formula.includes('Full Name')), false);
  const confirmed = calls.find((call) => call.method === 'PATCH');
  assert.equal(confirmed.recordId, 'recNEW');
  assert.equal(confirmed.body.fields['Confirmed Phone'], '+447700900123');
});

test('the combined band is accepted and the old splits are not', async () => {
  installAirtable();
  const start = await post(startBody({ route: 'ad', email: 'band@example.com' }));
  const ok = await post({
    action: 'band', route: 'ad', guide: 'wtp', band: '250-500',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(ok.body.ok, true);
  const bad = await post({
    action: 'band', route: 'ad', guide: 'wtp', band: '250-350',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error, 'band');
});

test('an email match is not merged again by phone, and a missing notes field does not block the lead', async () => {
  const calls = installAirtable({
    emailRecords: [{ id: 'recEMAIL', fields: { 'Full Name': 'Jane Doe', 'Campaign Name': 'Original' } }],
    phoneRecords: [{ id: 'recPHONE', fields: { Phone: '+447700900123' } }]
  });
  const start = await post(startBody());
  assert.equal(start.body.sig, lead.sign('recEMAIL'));
  const phone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07700900123',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(phone.body.recordId, 'recEMAIL');
  assert.equal(phone.body.sig, lead.sign('recEMAIL'));
  assert.equal(calls.some((call) => call.formula && (call.formula.includes('{Phone}') || call.formula.includes('Full Name'))), false);
  const patch = calls.find((call) => call.method === 'PATCH' && call.body.fields['Confirmed Phone']);
  assert.equal(patch.recordId, 'recEMAIL');
  assert.equal(patch.body.fields['Confirmed Phone'], '+447700900123');

  lead.resetNoteFieldCache();
  const mergeCalls = installAirtable({
    phoneRecords: [{ id: 'recPHONE', fields: {} }],
    recordFields: { recNEW: { 'Full Name': 'Jane Doe', 'LP Consent': 'stored consent' } },
    noteStatus: 422
  });
  const created = await post(startBody({ email: 'other@example.com' }));
  const moved = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07700900123',
    recordId: created.body.recordId, sig: created.body.sig
  });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.body.ok, true);
  assert.equal(moved.body.recordId, 'recPHONE');
  const noteAttempts = mergeCalls.filter((call) => call.method === 'PATCH' && call.recordId === 'recNEW');
  assert.equal(noteAttempts.length, lead.NOTE_FIELDS.length);
  for (const attempt of noteAttempts) {
    assert.equal(attempt.body.fields['Lead Status'], undefined);
    assert.equal(Object.keys(attempt.body.fields).length, 1);
  }
  assert.equal(mergeCalls.some((call) => call.method === 'DELETE'), false);
});

test('invalid numbers and bad sessions do not write', async () => {
  for (const raw of ['123', '07111111111', '07777777777', '02079460958', '']) {
    const res = await post({
      action: 'phone', route: 'ad', guide: 'wtp', phone: raw,
      recordId: 'recX', sig: lead.sign('recX')
    });
    assert.equal(res.body.ok, false, raw);
    assert.equal(res.body.error, 'invalid');
  }
  const res = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07700900123',
    recordId: 'recX', sig: 'not-a-signature'
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'session');
});

test('the trust line keeps only Secure and the phone step carries the matched session', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<div class="trust"><span>🔒 Secure<\/span><\/div>/);
  assert.equal(html.includes('No spam'), false);
  assert.equal(html.includes('ICO registered'), false);
  assert.ok(html.includes(CONSENT));
  assert.match(html, /if\(r\.recordId && r\.sig\)\{ state\.recordId=r\.recordId; state\.sig=r\.sig; \}/);
});
