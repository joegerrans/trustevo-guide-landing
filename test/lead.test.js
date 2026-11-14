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

async function post(body, headers) {
  const res = mockRes();
  await lead({ method: 'POST', body, headers: headers || {} }, res);
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
    if (String(url).includes('graph.facebook.com')) {
      return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
    }
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

test('phone matching does not use a name formula', () => {
  const before = Date.now();
  const formula = lead.nameFormula("  Jane   O'Brien ");
  const after = Date.now();
  assert.match(formula, /\{Funnel Source\}='Meta'/);
  assert.match(formula, /\{Meta Leadgen ID\}!=''/);
  assert.match(formula, /LOWER\(TRIM\(\{Full Name\}\)\)='jane o\\'brien'/);
  const parsed = /IS_AFTER\(\{Date Captured\}, DATETIME_PARSE\('([^']+)'\)\)/.exec(formula);
  assert.ok(parsed, formula);
  const cutoff = Date.parse(parsed[1]);
  assert.ok(cutoff >= before - 10 * 60 * 1000 && cutoff <= after - 10 * 60 * 1000, parsed[1]);
  assert.deepEqual(
    lead.typedEmailFields('consent', 'jane@gmail.com', 'jane@googlemail.com'),
    { 'LP Consent': 'consent' }
  );
  assert.deepEqual(
    lead.typedEmailFields('consent', 'other@example.com', 'jane@example.com'),
    { 'LP Consent': 'consent | typed email: other@example.com', 'LP Email': 'other@example.com' }
  );
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
  assert.deepEqual(Object.keys(patch.body.fields), ['LP Consent', 'LP Email']);
  assert.equal(patch.body.fields['LP Email'], "o'brien@example.com");
  assert.match(patch.body.fields['LP Consent'], /guide-wtp\/access \| /);
  assert.match(patch.body.fields['LP Consent'], new RegExp(CONSENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(patch.body.fields['LP Consent'], /\| typed email: o'brien@example.com$/);
  assert.equal(calls.some((call) => call.method === 'POST' || call.method === 'DELETE'), false);
});

test('access start with no email match creates the record immediately', async () => {
  const calls = installAirtable();
  const res = await post(startBody({ first: ' Jane ', last: ' Doe ', track: { campaign: 'Form Ad', adset: 'Broad' } }));
  assert.equal(res.body.recordId, 'recNEW');
  assert.equal(res.body.sig, lead.signNew('recNEW'));
  assert.equal(calls.filter((call) => call.method === 'GET').length, 2);
  assert.equal(calls[0].formula.includes('{Phone}'), false);
  assert.equal(calls[0].formula.includes('Full Name'), false);
  assert.match(calls[1].formula, /LOWER\(TRIM\(\{Full Name\}\)\)='jane doe'/);
  assert.match(calls[1].formula, /\{Meta Leadgen ID\}!=''/);
  const created = calls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created['Full Name'], 'Jane Doe');
  assert.equal(created.Email, 'jane@example.com');
  assert.equal(created['Lead Status'], 'New');
  assert.equal(created['Funnel Source'], 'Meta');
  assert.equal(created['Campaign Name'], 'Form Ad');
  assert.equal(created['Ad Set'], 'Broad');
  assert.match(created['LP Consent'], /guide-wtp\/access/);
});

test('access email match treats gmail and googlemail as the same address', async () => {
  const googlemail = installAirtable({
    emailRecords: [{ id: 'recMETA', fields: { Email: 'rachelb3630@googlemail.com', 'Campaign Name': 'Instant form', 'Ad Set': 'Original ad set' } }]
  });
  const fromGmail = await post(startBody({
    email: '  RachelB3630@Gmail.com ',
    track: { campaign: 'WTP LP access test v1', adset: 'WTP LP access test v1 adset' }
  }));
  assert.equal(fromGmail.body.recordId, 'recMETA');
  assert.match(googlemail[0].formula, /LOWER\(TRIM\(\{Email\}\)\)='rachelb3630@gmail\.com'/);
  assert.match(googlemail[0].formula, /LOWER\(TRIM\(\{Email\}\)\)='rachelb3630@googlemail\.com'/);
  assert.match(googlemail[0].formula, /^OR\(/);
  const gmailPatch = googlemail.find((call) => call.method === 'PATCH');
  assert.deepEqual(Object.keys(gmailPatch.body.fields), ['LP Consent']);
  assert.equal(googlemail.some((call) => call.method === 'POST'), false);

  const gmail = installAirtable({
    emailRecords: [{ id: 'recGMAIL', fields: { Email: 'rachelb3630@gmail.com', 'Campaign Name': 'Keep' } }]
  });
  const fromGooglemail = await post(startBody({ email: 'rachelb3630@googlemail.com' }));
  assert.equal(fromGooglemail.body.recordId, 'recGMAIL');
  assert.match(gmail[0].formula, /rachelb3630@gmail\.com/);
  assert.match(gmail[0].formula, /rachelb3630@googlemail\.com/);
  assert.equal(gmail.some((call) => call.method === 'POST'), false);

  const otherLocal = lead.emailFormula('rachelb3631@gmail.com');
  assert.equal(otherLocal.includes('rachelb3630@gmail.com'), false);
  const outlook = lead.emailFormula('rachelb3630@outlook.com');
  assert.equal(outlook, "LOWER(TRIM({Email}))='rachelb3630@outlook.com'");
  assert.equal(outlook.includes('gmail.com'), false);
  const dotted = lead.emailFormula('rachel.b+tag@gmail.com');
  assert.match(dotted, /rachel\.b\+tag@gmail\.com/);
  assert.match(dotted, /rachel\.b\+tag@googlemail\.com/);
  assert.equal(dotted.includes("'rachelb@gmail.com'"), false);
  assert.equal(dotted.includes("'rachel.b@gmail.com'"), false);
  assert.equal(lead.emailFormula('jane@example.com'), "LOWER(TRIM({Email}))='jane@example.com'");

  const adDup = installAirtable({
    emailRecords: [{ id: 'recOLD', fields: { Email: 'rachelb3630@googlemail.com' } }]
  });
  await post(startBody({ route: 'ad', email: 'rachelb3630@gmail.com', track: { platform: 'facebook' } }));
  assert.match(adDup[0].formula, /rachelb3630@googlemail\.com/);
  assert.equal(adDup.find((call) => call.method === 'POST').body.fields.Duplicate, true);
  assert.equal(adDup.some((call) => call.method === 'PATCH'), false);
});

test('unmatched access records drop only the fixed test campaign labels', async () => {
  const calls = installAirtable();
  await post(startBody({
    guide: 'wtp',
    track: { campaign: 'WTP LP access test v1', adset: 'WTP LP access test v1 adset', ad: 'WTP form v1' }
  }));
  const created = calls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created['Campaign Name'], 'WTP Confirmed Route');
  assert.equal(created['Ad Set'], 'WTP Confirmed Route');
  assert.equal(created['Campaign Name'].includes('WTP'), true);
  assert.equal(created['Campaign Name'].includes('45% Club'), false);
  assert.equal(created.Email, 'jane@example.com');

  const club = installAirtable();
  await post(startBody({
    guide: '45c',
    email: 'club@example.com',
    track: { campaign: '45C LP access test v1', adset: '45C LP access test v1 adset' }
  }));
  const clubCreated = club.find((call) => call.method === 'POST').body.fields;
  assert.equal(clubCreated['Campaign Name'], '45% Club Confirmed Route');
  assert.equal(clubCreated['Ad Set'], '45% Club Confirmed Route');
  assert.equal(clubCreated['Campaign Name'].includes('45% Club'), true);

  const named = installAirtable();
  await post(startBody({
    email: 'named@example.com',
    track: { campaign: '45% Club LP access test v1', adset: '45% Club LP access test v1 adset' }
  }));
  const namedCreated = named.find((call) => call.method === 'POST').body.fields;
  assert.equal(namedCreated['Campaign Name'], '45% Club Confirmed Route');
  assert.equal(namedCreated['Ad Set'], '45% Club Confirmed Route');

  const other = installAirtable();
  await post(startBody({
    email: 'other@example.com',
    track: { campaign: 'Form Ad', adset: 'Broad' }
  }));
  const otherCreated = other.find((call) => call.method === 'POST').body.fields;
  assert.equal(otherCreated['Campaign Name'], 'Form Ad');
  assert.equal(otherCreated['Ad Set'], 'Broad');

  const ad = installAirtable();
  await post(startBody({
    route: 'ad',
    email: 'ad@example.com',
    track: { campaign: 'WTP LP access test v1', adset: 'WTP LP access test v1 adset', platform: 'facebook' }
  }));
  const adCreated = ad.find((call) => call.method === 'POST').body.fields;
  assert.equal(adCreated['Campaign Name'], 'WTP Direct | WTP LP access test v1');
  assert.equal(adCreated['Ad Set'], 'WTP LP access test v1 adset');

  const matched = installAirtable({
    emailRecords: [{ id: 'recMETA', fields: { Email: 'jane@example.com', 'Campaign Name': 'Instant form', 'Ad Set': 'Original' } }]
  });
  const match = await post(startBody({
    track: { campaign: 'WTP LP access test v1', adset: 'WTP LP access test v1 adset' }
  }));
  assert.equal(match.body.recordId, 'recMETA');
  assert.deepEqual(Object.keys(matched.find((call) => call.method === 'PATCH').body.fields), ['LP Consent']);
  assert.equal(matched.some((call) => call.method === 'POST'), false);
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
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
  assert.match(calls[0].formula, /\{Email\}/);
  assert.equal(res.body.sig, lead.sign('recNEW'));
  const created = calls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created.Duplicate, undefined);
  assert.equal(created['Funnel Source'], 'Meta');
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
    assert.equal(patch.body.fields.Duplicate, undefined);
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
  assert.deepEqual(kinds, ['email', 'name', 'phone']);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.recordId, 'recNEW');
  assert.equal(patch.body.fields['Confirmed Phone'], '+447700900123');
  assert.equal(patch.body.fields['LP Confirmed'], true);
  assert.match(patch.body.fields['LP Confirmed At'], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
});

test('the Meta phone window uses a JS cutoff and Phone Clean', () => {
  const before = Date.now();
  const formula = lead.phoneFormula('+447759885561', 'recMy6r8rwBBdVHJN');
  const after = Date.now();
  assert.equal(formula.includes('DATETIME_DIFF(NOW()'), false);
  assert.match(formula, /\{Funnel Source\}='Meta'/);
  assert.match(formula, /RECORD_ID\(\)!='recMy6r8rwBBdVHJN'/);
  assert.match(formula, /\{Phone Clean\}='\+447759885561'/);
  const parsed = /IS_AFTER\(\{Date Captured\}, DATETIME_PARSE\('([^']+)'\)\)/.exec(formula);
  assert.ok(parsed, formula);
  const cutoff = Date.parse(parsed[1]);
  assert.ok(cutoff >= before - 120 * 60 * 1000 && cutoff <= after - 120 * 60 * 1000, parsed[1]);
});

test('a matched Meta phone is confirmed on that record, not the new access record', async () => {
  const calls = installAirtable({
    phoneRecords: [{ id: 'recx87tiOyU4QGHdx', fields: { Phone: '+447759885561', 'Funnel Source': 'Meta' } }],
    recordFields: {
      recNEW: { 'LP Consent': `2026-11-12T12:38:20.592Z | guide-wtp/access | ${CONSENT}` }
    },
    noteStatus: 200
  });
  const start = await post(startBody({ email: 'anthonybetts246@outlook.com' }));
  const phone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07759885561',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(phone.body.ok, true);
  assert.equal(phone.body.recordId, 'recx87tiOyU4QGHdx');
  const confirmed = calls.find((call) => call.method === 'PATCH' && call.recordId === 'recx87tiOyU4QGHdx');
  assert.equal(confirmed.body.fields['Confirmed Phone'], '+447759885561');
  assert.equal(confirmed.body.fields['LP Confirmed'], true);
  assert.match(confirmed.body.fields['LP Confirmed At'], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(confirmed.body.fields['LP Consent'], `2026-11-12T12:38:20.592Z | guide-wtp/access | ${CONSENT}`);
  const selfWrites = calls.filter((call) => call.method === 'PATCH' && call.recordId === 'recNEW');
  assert.equal(selfWrites.some((call) => call.body.fields['LP Confirmed'] === true), false);

  const miss = installAirtable({
    recordFields: { recNEW: { 'LP Consent': 'stored consent' } }
  });
  const missStart = await post(startBody({ email: 'nobody@outlook.com' }));
  const missPhone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '07759885561',
    recordId: missStart.body.recordId, sig: missStart.body.sig
  });
  assert.equal(missPhone.body.recordId, 'recNEW');
  const self = miss.find((call) => call.method === 'PATCH' && call.recordId === 'recNEW');
  assert.equal(self.body.fields['LP Confirmed'], true);
  assert.equal(self.body.fields['Confirmed Phone'], '+447759885561');
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
  const nameGets = calls.filter((call) => call.formula && call.formula.includes('{Full Name}'));
  assert.equal(nameGets.length, 1);
  assert.match(nameGets[0].formula, /LOWER\(TRIM\(\{Full Name\}\)\)='jane doe'/);
  const phoneGet = calls.find((call) => call.formula && call.formula.includes('{Phone}'));
  assert.match(phoneGet.formula, /\+447700900123/);
  assert.match(phoneGet.formula, /\{Funnel Source\}='Meta'/);
  assert.match(phoneGet.formula, /IS_AFTER\(\{Date Captured\}, DATETIME_PARSE\(/);
  assert.match(phoneGet.formula, /RECORD_ID\(\)!='recNEW'/);
  const confirmed = calls.find((call) => call.method === 'PATCH' && call.recordId === 'recPHONE');
  assert.equal(confirmed.body.fields['Confirmed Phone'], '+447700900123');
  assert.equal(confirmed.body.fields['LP Confirmed'], true);
  assert.equal(confirmed.body.fields['LP Consent'], `2026-01-01T00:00:00.000Z | guide-wtp/access | ${CONSENT}`);
  for (const key of ['Full Name', 'Funnel Source', 'Campaign Name', 'Lead Status', 'Phone']) {
    assert.equal(confirmed.body.fields[key], undefined, key);
  }
  const dup = calls.find((call) => call.method === 'PATCH' && call.recordId === 'recNEW' && call.body.fields.Duplicate);
  assert.deepEqual(dup.body.fields, { Duplicate: true });
  const note = calls.find((call) => call.method === 'PATCH' && call.recordId === 'recNEW' && call.body.fields.Notes);
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

test('an access start with no email match links an exact-name Meta lead', async () => {
  const calls = installAirtable({
    nameRecords: [{ id: 'recNAME', fields: { 'Full Name': 'jane DOE', 'Funnel Source': 'Meta' } }],
    recordFields: { recNEW: { 'Full Name': 'jane DOE', 'LP Consent': 'stored consent' } }
  });
  const start = await post(startBody({ first: 'jane', last: 'DOE' }));
  assert.equal(start.body.recordId, 'recNAME');
  assert.equal(start.body.sig, lead.sign('recNAME'));
  assert.equal(calls.some((call) => call.method === 'POST'), false);
  const nameGets = calls.filter((call) => call.formula && call.formula.includes('{Full Name}'));
  assert.equal(nameGets.length, 1);
  assert.match(nameGets[0].formula, /LOWER\(TRIM\(\{Full Name\}\)\)='jane doe'/);
  const linked = calls.find((call) => call.method === 'PATCH');
  assert.equal(linked.recordId, 'recNAME');
  assert.equal(linked.body.fields['LP Email'], 'jane@example.com');
  assert.match(linked.body.fields['LP Consent'], /typed email: jane@example.com$/);
  const phone = await post({
    action: 'phone', route: 'access', guide: 'wtp', phone: '+447700900123',
    recordId: start.body.recordId, sig: start.body.sig
  });
  assert.equal(phone.body.recordId, 'recNAME');
  const confirmed = calls.find((call) => call.method === 'PATCH' && call.body.fields['Confirmed Phone']);
  assert.equal(confirmed.recordId, 'recNAME');
  assert.equal(confirmed.body.fields['Confirmed Phone'], '+447700900123');
  assert.equal(calls.filter((call) => call.formula && call.formula.includes('{Full Name}')).length, 1);
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
  const step1Writes = mergeCalls.filter((call) => call.method === 'PATCH' && call.recordId === 'recNEW');
  assert.deepEqual(step1Writes[0].body.fields, { Duplicate: true });
  const noteAttempts = step1Writes.slice(1);
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

test('ad route ticks Duplicate on the new record only', async () => {
  const emailCalls = installAirtable({
    emailRecords: [{ id: 'recOLD', fields: { Email: 'jane@example.com' } }]
  });
  const emailStart = await post(startBody({ route: 'ad' }));
  assert.equal(emailStart.body.ok, true);
  assert.equal(emailStart.body.recordId, 'recNEW');
  const created = emailCalls.find((call) => call.method === 'POST').body.fields;
  assert.equal(created.Duplicate, true);
  assert.equal(emailCalls.some((call) => call.method === 'PATCH'), false);
  assert.equal(emailCalls.some((call) => call.recordId === 'recOLD' && call.method !== 'GET'), false);

  const noneCalls = installAirtable();
  const noneStart = await post(startBody({ route: 'ad', email: 'new@example.com' }));
  assert.equal(noneCalls.find((call) => call.method === 'POST').body.fields.Duplicate, undefined);
  const nonePhone = await post({
    action: 'phone', route: 'ad', guide: 'wtp', phone: '07700900123',
    recordId: noneStart.body.recordId, sig: noneStart.body.sig
  });
  assert.equal(nonePhone.body.ok, true);
  const nonePatch = noneCalls.find((call) => call.method === 'PATCH');
  assert.equal(nonePatch.recordId, 'recNEW');
  assert.equal(nonePatch.body.fields.Phone, '+447700900123');
  assert.equal(nonePatch.body.fields.Duplicate, undefined);

  const phoneCalls = installAirtable({
    phoneRecords: [{ id: 'recOLDPHONE', fields: { Phone: '+447700900123' } }]
  });
  const phoneStart = await post(startBody({ route: 'ad', email: 'fresh@example.com' }));
  assert.equal(phoneCalls.find((call) => call.method === 'POST').body.fields.Duplicate, undefined);
  const phone = await post({
    action: 'phone', route: 'ad', guide: 'wtp', phone: '07700 900123',
    recordId: phoneStart.body.recordId, sig: phoneStart.body.sig
  });
  assert.equal(phone.body.recordId, 'recNEW');
  const phoneLookup = phoneCalls.find((call) => call.formula && call.formula.includes('{Phone}'));
  assert.match(phoneLookup.formula, /RECORD_ID\(\)!='recNEW'/);
  assert.match(phoneLookup.formula, /\+447700900123/);
  assert.equal(phoneLookup.formula.includes('Funnel Source'), false);
  const phonePatch = phoneCalls.find((call) => call.method === 'PATCH');
  assert.equal(phonePatch.recordId, 'recNEW');
  assert.equal(phonePatch.body.fields.Duplicate, true);
  assert.equal(phonePatch.body.fields.Phone, '+447700900123');
  assert.equal(phoneCalls.some((call) => call.recordId === 'recOLDPHONE' && call.method !== 'GET'), false);
});

test('a failed ad-route duplicate lookup still saves the lead', async () => {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = parseCall(url, init);
    calls.push(call);
    if (call.method === 'GET') throw new Error('airtable down');
    return { ok: true, status: 200, json: async () => ({ id: 'recNEW', fields: call.body.fields }) };
  };
  const res = await post(startBody({ route: 'ad', email: 'down@example.com' }));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.recordId, 'recNEW');
  assert.equal(calls.find((call) => call.method === 'POST').body.fields.Duplicate, undefined);
});

function capiCalls(calls) {
  return calls.filter((call) => call.url.includes('graph.facebook.com'));
}

async function saveBand(track, headers) {
  process.env.META_PIXEL_ID = 'pixel-test';
  process.env.META_CAPI_TOKEN = 'capi-test';
  const calls = installAirtable();
  const start = await post(startBody({
    route: 'ad',
    email: `band-${Math.random().toString(16).slice(2)}@example.com`,
    track
  }), headers);
  assert.equal(start.body.ok, true);
  const phone = await post({
    action: 'phone', route: 'ad', guide: 'wtp', phone: '07700911123',
    recordId: start.body.recordId, sig: start.body.sig, track
  }, headers);
  assert.equal(phone.body.ok, true);
  const band = await post({
    action: 'band', route: 'ad', guide: 'wtp', band: 'u100', eventId: 'evt-test',
    recordId: phone.body.recordId, sig: phone.body.sig, track,
    fbc: headers && headers.fbc
  }, headers);
  assert.equal(band.body.ok, true);
  return { calls, created: calls.find((call) => call.method === 'POST').body.fields };
}

test('ad route maps funnel source and campaign, and sends Meta events only for Meta traffic', async () => {
  assert.equal(lead.funnelSource({ platform: 'linkedin' }), 'LinkedIn');
  assert.equal(lead.funnelSource({ platform: 'LINKEDIN', fbc: 'fb.1.1.cookie' }), 'LinkedIn');
  assert.equal(lead.funnelSource({ platform: 'facebook' }), 'Meta');
  assert.equal(lead.funnelSource({ platform: 'IG' }), 'Meta');
  assert.equal(lead.funnelSource({ platform: 'google', fbclid: 'click' }), 'Meta');
  assert.equal(lead.funnelSource({ platform: 'email' }), 'Website');
  assert.equal(lead.funnelSource({ platform: 'tiktok' }), 'Other');
  assert.equal(lead.funnelSource({}), 'Other');
  assert.equal(lead.adCampaign('wtp', { platform: 'linkedin', medium: 'post' }), 'LinkedIn post');
  assert.equal(lead.adCampaign('wtp', { platform: 'linkedin', medium: 'dm' }), 'LinkedIn DM');
  assert.equal(lead.adCampaign('45c', { platform: 'linkedin', medium: 'post', campaign: 'Launch' }), '45C Direct | Launch');
  assert.equal(lead.adCampaign('wtp', {}), 'WTP Direct');
  assert.equal(lead.metaTraffic({ platform: 'linkedin' }, ''), false);
  assert.equal(lead.metaTraffic({ platform: 'google' }, 'fb.1.1.cookie'), true);
  assert.equal(lead.metaTraffic({ isMeta: true }, ''), false);

  try {
    const linkedin = await saveBand({ platform: 'linkedin', medium: 'post' });
    assert.equal(linkedin.created['Funnel Source'], 'LinkedIn');
    assert.equal(linkedin.created['Campaign Name'], 'LinkedIn post');
    assert.equal(linkedin.created.Platform, 'linkedin');
    assert.equal(capiCalls(linkedin.calls).length, 0);
    assert.equal(linkedin.calls.some((call) => call.method === 'POST'), true);

    const aliases = [
      ['facebook', 'Meta'],
      ['Instagram', 'Meta'],
      ['fb', 'Meta'],
      ['IG', 'Meta'],
      ['google', 'Google'],
      ['Email', 'Website'],
      ['tiktok', 'Other'],
      ['', 'Other']
    ];
    for (const [platform, source] of aliases) {
      const saved = await saveBand({ platform, medium: platform ? 'post' : '' });
      assert.equal(saved.created['Funnel Source'], source, platform || '(missing)');
      const sent = capiCalls(saved.calls);
      if (source === 'Meta') {
        assert.equal(sent.length, 1, platform);
        assert.equal(sent[0].body.data[0].event_name, 'Lead');
      } else {
        assert.equal(sent.length, 0, platform || '(missing)');
      }
    }

    const click = await saveBand({ fbclid: 'IwAR123' });
    assert.equal(click.created['Funnel Source'], 'Meta');
    assert.equal(click.created['Campaign Name'], 'WTP Direct');
    assert.equal(capiCalls(click.calls)[0].body.data[0].event_name, 'Lead');

    const cookieOnly = await saveBand(
      { platform: 'google', medium: 'cpc' },
      { cookie: '_fbc=fb.1.1700000000.AbC' }
    );
    assert.equal(cookieOnly.created['Funnel Source'], 'Google');
    assert.equal(cookieOnly.created['Campaign Name'], 'Google CPC');
    assert.equal(capiCalls(cookieOnly.calls)[0].body.data[0].event_name, 'Lead');
    assert.equal(capiCalls(cookieOnly.calls)[0].body.data[0].user_data.fbc, 'fb.1.1700000000.AbC');

    const explicit = await saveBand({ platform: 'linkedin', medium: 'dm', campaign: 'Spring Sale' });
    assert.equal(explicit.created['Funnel Source'], 'LinkedIn');
    assert.equal(explicit.created['Campaign Name'], 'WTP Direct | Spring Sale');
    assert.equal(capiCalls(explicit.calls).length, 0);

    const lied = await saveBand({ platform: 'linkedin', medium: 'post', isMeta: true });
    assert.equal(lied.created['Funnel Source'], 'LinkedIn');
    assert.equal(capiCalls(lied.calls).length, 0);

    process.env.META_PIXEL_ID = 'pixel-test';
    process.env.META_CAPI_TOKEN = 'capi-test';
    const accessCalls = installAirtable();
    const accessStart = await post(startBody({ track: { platform: 'facebook', campaign: 'Form Ad' } }));
    const accessBand = await post({
      action: 'band', route: 'access', guide: 'wtp', band: '100-250', eventId: 'evt-access',
      recordId: accessStart.body.recordId, sig: accessStart.body.sig,
      track: { platform: 'facebook', campaign: 'Form Ad' }
    });
    assert.equal(accessBand.body.ok, true);
    assert.equal(accessCalls.find((call) => call.method === 'POST').body.fields['Funnel Source'], 'Meta');
    assert.equal(accessCalls.find((call) => call.method === 'POST').body.fields['Campaign Name'], 'Form Ad');
    assert.equal(capiCalls(accessCalls)[0].body.data[0].event_name, 'ConfirmedLead');

    const quietAccess = installAirtable();
    const quietStart = await post(startBody({ email: 'quiet@example.com' }));
    await post({
      action: 'band', route: 'access', guide: 'wtp', band: 'u100', eventId: 'evt-quiet',
      recordId: quietStart.body.recordId, sig: quietStart.body.sig, track: {}
    });
    assert.equal(quietAccess.find((call) => call.method === 'POST').body.fields['Funnel Source'], 'Meta');
    assert.equal(capiCalls(quietAccess).length, 0);
  } finally {
    delete process.env.META_PIXEL_ID;
    delete process.env.META_CAPI_TOKEN;
  }
});

test('the browser fires the pixel event only for Meta traffic', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /medium: qs\.get\('utm_medium'\)/);
  assert.equal(html.includes('isMeta:'), false);
  const fn = html.slice(html.indexOf('function isMetaOrigin()'), html.indexOf('function applyRoute()'));
  const gate = new Function('track', 'cookie', `${fn}; return isMetaOrigin();`);
  const noCookie = () => '';
  assert.equal(gate({ platform: 'linkedin', fbclid: '' }, noCookie), false);
  assert.equal(gate({ platform: 'facebook', fbclid: '' }, noCookie), true);
  assert.equal(gate({ platform: 'ig', fbclid: '' }, noCookie), true);
  assert.equal(gate({ platform: 'google', fbclid: 'click' }, noCookie), true);
  assert.equal(gate({ platform: 'email', fbclid: '' }, () => 'fb.1.1.cookie'), true);
  assert.equal(gate({ platform: '', fbclid: '' }, noCookie), false);
  assert.match(html, /function px\(name,params,eid\)\{\s*if\(!isMetaOrigin\(\)\) return;/);
  assert.match(html, /function maybePixel\(\)\{ if\(isMetaOrigin\(\)\) loadPixel\(\); \}/);
  assert.equal(html.includes("if(ck==='yes') loadPixel()"), false);
});

test('the trust line keeps only Secure and the phone step carries the matched session', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<div class="trust"><span>🔒 Secure<\/span><\/div>/);
  assert.equal(html.includes('No spam'), false);
  assert.equal(html.includes('ICO registered'), false);
  assert.ok(html.includes(CONSENT));
  assert.match(html, /if\(r\.recordId && r\.sig\)\{ state\.recordId=r\.recordId; state\.sig=r\.sig; \}/);
});
