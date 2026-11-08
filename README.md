# TrustEvo guide landing pages

One site with two routes for The Wealth Turning Point:

| URL | Who lands here | Step 1 heading |
|---|---|---|
| guide-wtp.trustevo.co.uk | People clicking an ad straight to the page | Where should we send your guide? |
| guide-wtp.trustevo.co.uk/access | People clicking "Open my guide" after the Meta form | Please confirm your details |

The steps are: name, email and consent, then mobile (with a Twilio check), then the band question, then the guide page.

## Going live

1. **GitHub.** Create a private repo (for example `trustevo-guide-landing`) and upload this folder.
2. **Vercel.** Add New Project, import the repo and leave the settings as they are. Then deploy.
3. **Environment variables** (Vercel, then Settings, then Environment Variables). Redeploy after adding them.

   | Name | What it is |
   |---|---|
   | AIRTABLE_TOKEN | An Airtable personal access token with data.records:read and data.records:write on the TrustEvo base |
   | TWILIO_SID / TWILIO_TOKEN | The same Twilio credentials as your n8n lookup |
   | META_PIXEL_ID | Your Pixel (dataset) ID |
   | META_CAPI_TOKEN | Conversions API token (Events Manager, then Settings) |
   | META_TEST_CODE | Optional. A Test Events code while you test. Delete it before going live |
   | SIGNING_SECRET | Any long random string |
   | N8N_WEBHOOK | Optional. Each step is also posted here so your n8n flows can send the guide email, add the lead to CloudTalk and so on |

   Also put the Pixel ID into `CFG.pixelId` near the bottom of `public/index.html`, so the browser pixel fires once someone accepts cookies.
4. **Domain.** In Vercel, go to Settings, then Domains, and add `guide-wtp.trustevo.co.uk`. Then add the CNAME record it shows you at your DNS provider.
5. **Airtable.** Add these fields to the Leads table. Until you do, the page still saves everything else.

   | Field | Type |
   |---|---|
   | LP Confirmed | Checkbox |
   | LP Confirmed At | Date with time |
   | Confirmed Phone | Single line text |
   | Self-Declared Band | Single select (the page creates the options) |
   | LP Consent | Long text (timestamp, page and the exact consent wording) |

   The ad route sets Funnel Source from the visit: Meta (Facebook, Instagram, fb, ig, or an fbclid), LinkedIn, Google, Website (email), or Other. It uses those existing options only.

## Meta setup

- **Ads straight to the page.** Set the website URL to `https://guide-wtp.trustevo.co.uk`. Under URL parameters, add:
  `utm_source={{site_source_name}}&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&ad_id={{ad.id}}`
  These fill in Campaign Name, Ad Set, Meta Ad ID and Platform in Airtable.
- **Meta form end screen.** Set the headline to "Thanks, your request is in" and the description to "One quick step left: confirm your details on the next page to open your guide." Make the button "Open my guide", linking to `https://guide-wtp.trustevo.co.uk/access` with the same URL parameters.

## What each route writes

| | Ad route | /access route |
|---|---|---|
| Step 1 | New lead: Full Name, Email, Lead Status New, Funnel Source from the visit, tracking fields, LP Consent. With no utm_campaign, Campaign Name is the source and medium, such as "LinkedIn post" | Finds the Meta form lead by email and adds LP Consent. If there's no match, it creates a new lead with Funnel Source "Meta" |
| Step 2 | Phone and Valid Number? | Confirmed Phone, LP Confirmed and LP Confirmed At. The original Phone is left alone |
| Step 3 | Self-Declared Band. A CAPI **Lead** event is sent only for Meta traffic (Facebook, Instagram, fb, ig, fbclid, or _fbc) | Self-Declared Band. A CAPI **ConfirmedLead** event uses the same Meta-traffic rule |

## Phone check

The number must be a UK mobile (07). Numbers with eight or more repeated digits are rejected. Twilio Lookup line status then runs, using the same rule as the Meta lead workflow: a number fails only if it is invalid or `inactive`. If Twilio itself errors, the number is allowed through, so a real person is never blocked.

## Values sent to Meta (per lead)

Meeting price × 0.70 contacted × 0.20 booked × 0.65 held:

| Band | Value |
|---|---|
| Under £100,000 | £1 |
| £100,000 to £250,000 | £36 |
| £250,000 to £500,000 | £50 |
| £500,000+ | £64 |

You can change these in `api/lead.js` (BANDS) and in `public/index.html` (BANDS).

## Test mode

Without AIRTABLE_TOKEN the site runs in test mode. A yellow bar shows and nothing is saved. In test mode, 07700 900xxx numbers fail the phone check, so you can see the error.
