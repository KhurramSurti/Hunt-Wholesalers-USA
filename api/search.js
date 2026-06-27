// Vercel Serverless Function
// This function keeps your API key SECRET (it is never exposed to the browser).
// The API key is read from Vercel's Environment Variables: ANTHROPIC_API_KEY
//
// ─── ABUSE / BUDGET PROTECTION ───────────────────────────────────────────────
// These guards protect your Anthropic credit when the link is public.
// They are "best effort" (in-memory, reset on cold starts). For a hard cap,
// ALSO set a monthly spend limit in the Anthropic console — that is guaranteed.
// Optional tuning via Vercel Environment Variables:
//   MAX_PER_IP_HOUR   (default 10)  — searches allowed per visitor per hour
//   MAX_PER_DAY       (default 200) — total searches allowed per day (budget cap)
//   ACCESS_CODE       (optional)    — if set, requests must include this code
// ─────────────────────────────────────────────────────────────────────────────

const CACHE = new Map();          // key -> { at, data }
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const IP_HITS = new Map();        // ip  -> [timestamps]
let DAY = { date: new Date().toDateString(), count: 0 };

function num(envVal, def) { const n = parseInt(envVal, 10); return Number.isFinite(n) ? n : def; }
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

export default async function handler(req, res) {
  // Allow POST requests only
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accessCodeEnv = process.env.ACCESS_CODE;

  // ── Lightweight: tell the frontend whether an access code is required ──
  if (req.body && req.body.checkGate === true) {
    return res.status(200).json({ gated: !!accessCodeEnv });
  }

  // ── Lightweight: verify an access code WITHOUT calling the AI (no cost) ──
  if (req.body && req.body.verifyOnly === true) {
    if (!accessCodeEnv) return res.status(200).json({ ok: true, gated: false });
    const supplied = req.body.code || req.headers['x-access-code'];
    if (supplied === accessCodeEnv) return res.status(200).json({ ok: true });
    return res.status(401).json({ error: 'Incorrect access code.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured. Set ANTHROPIC_API_KEY in Vercel.' });
  }

  // Access code gate (for private/team use). Public demo: leave ACCESS_CODE unset.
  if (accessCodeEnv) {
    const supplied = (req.body && req.body.code) || req.headers['x-access-code'];
    if (supplied !== accessCodeEnv) {
      return res.status(401).json({ error: 'Access code required or incorrect.' });
    }
  }

  // ── Daily budget cap (protects your credit) ──
  const today = new Date().toDateString();
  if (DAY.date !== today) DAY = { date: today, count: 0 };
  const maxPerDay = num(process.env.MAX_PER_DAY, 200);
  if (DAY.count >= maxPerDay) {
    return res.status(429).json({ error: "Daily search limit reached. Please try again tomorrow." });
  }

  // ── Per-IP rate limit (protects against spam) ──
  const ip = clientIp(req);
  const maxPerIpHour = num(process.env.MAX_PER_IP_HOUR, 10);
  const nowTs = Date.now();
  const recent = (IP_HITS.get(ip) || []).filter(t => nowTs - t < 60 * 60 * 1000);
  if (recent.length >= maxPerIpHour) {
    return res.status(429).json({ error: "You've run several searches in a short time. Please wait a little and try again." });
  }

  const { category, country, region, exclude, dropship } = req.body || {};
  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: 'Category is required' });
  }

  const safeCategory = category.slice(0, 120).replace(/[\n\r]/g, ' ');

  // Country (default United States)
  const COUNTRIES = {
    'United States': { demonym: 'US-based', currency: 'USD ($)' },
    'United Kingdom': { demonym: 'UK-based', currency: 'GBP (£)' },
    'Germany': { demonym: 'Germany-based', currency: 'EUR (€)' },
    'Australia': { demonym: 'Australia-based', currency: 'AUD ($)' }
  };
  const safeCountry = (country && COUNTRIES[country]) ? country : 'United States';
  const c = COUNTRIES[safeCountry];

  // Region within country (state / Bundesland / etc.)
  const safeRegion = (region && typeof region === 'string' && !/^all/i.test(region))
    ? region.slice(0, 50).replace(/[\n\r]/g, ' ')
    : null;

  // Optional list of company names to exclude (for "Find 10 more")
  const excludeList = Array.isArray(exclude)
    ? exclude.filter(n => typeof n === 'string').slice(0, 60).map(n => n.slice(0, 80))
    : [];

  const wantDropship = dropship === true;

  // ── Cache lookup (only for fresh searches, not "Find 10 more") ──
  const cacheKey = JSON.stringify([safeCategory, safeCountry, safeRegion, wantDropship]);
  const isFreshSearch = excludeList.length === 0;
  if (isFreshSearch) {
    const hit = CACHE.get(cacheKey);
    if (hit && (Date.now() - hit.at) < CACHE_TTL) {
      // Served from cache — costs you nothing.
      return res.status(200).json(hit.data);
    }
  }

  const locationLine = safeRegion
    ? `Find suppliers that are HEADQUARTERED, WAREHOUSED, or primarily based in ${safeRegion}, ${safeCountry}. Prefer suppliers physically located in ${safeRegion}.`
    : `Find ${c.demonym} suppliers located anywhere in ${safeCountry}.`;

  const dropshipLine = wantDropship
    ? `\n\nCRITICAL FILTER: Only include suppliers that explicitly offer DROPSHIPPING or FBM (Fulfilment-by-Merchant) services — i.e. they let a reseller list their products, then the supplier picks, packs and ships orders directly to the reseller's customer (often blind / white-label). Exclude any supplier that does NOT offer dropshipping/FBM. For each, confirm the dropshipping program is real.`
    : `\n\nFor each supplier, also determine whether they offer a dropshipping / FBM (Fulfilment-by-Merchant) program where they ship orders on the reseller's behalf.`;

  const excludeLine = excludeList.length
    ? `\n\nIMPORTANT: Do NOT include any of these companies — they have already been shown. Find COMPLETELY DIFFERENT ones:\n${excludeList.map(n => '- ' + n).join('\n')}`
    : '';

  const prompt = `You are a wholesale sourcing research expert. Search the web and find 8-10 authentic, legitimate ${c.demonym} wholesale distributors, wholesalers and suppliers for this category: "${safeCategory}".

PRIORITISE RELIABILITY AND TRACK RECORD ABOVE ALL ELSE. Strongly prefer companies that are:
- Well-established and long-operating (ideally several years or decades in business).
- Reputable, with a verifiable real-world presence (physical address, registered business, working professional website).
- Known/trusted in their industry (positive reputation, trade-association membership, recognised brand, or established trade customer base).
Rank the results so the MOST established and reliable suppliers appear FIRST. Avoid brand-new, unverified, thin, or suspicious operations.

QUALITY OVER QUANTITY: Only include a supplier if you are confident it is a genuine, legitimate, established business with a real working website. If you cannot verify a company is real and reputable, DO NOT include it — it is better to return fewer high-quality, verified suppliers than to pad the list with weak, unverified, or doubtful ones. Never invent companies or details; every supplier must be real and findable on the web.

${locationLine}${dropshipLine}

For each one you MUST:
1. Confirm it is a real, established company in ${safeCountry} with a working website and verifiable track record.
2. Estimate how long it has been in business (founding year if findable).
3. Check whether it offers wholesale / trade / reseller accounts.
4. Find the direct URL to their wholesale account registration or wholesale inquiry page if it exists.
5. Determine whether they offer dropshipping / FBM fulfilment.${excludeLine}

Respond with ONLY valid JSON — no markdown, no code fences, no commentary. Use this exact structure:
{
  "category": "${safeCategory}",
  "country": "${safeCountry}",
  "region": "${safeRegion || 'All'}",
  "distributors": [
    {
      "name": "Company Name",
      "type": "Distributor",
      "region": "Region or state within ${safeCountry}",
      "website": "https://www.example.com",
      "wholesale_page": "https://www.example.com/wholesale",
      "description": "Two short sentences: what they sell and who they serve.",
      "established": "Founding year like '1998', or 'Est. 2005', or 'Long-established', or 'Unknown'",
      "min_order": "Minimum order in ${c.currency}, or 'Varies', or 'No minimum'",
      "ships_international": true,
      "requires_resale_cert": true,
      "offers_dropshipping": true,
      "dropship_note": "One short line on their dropshipping/FBM program, or '' if none.",
      "notable": "One short reason this supplier is reliable/established (e.g. '25+ years, supplies major retailers')."
    }
  ]
}

Rules:
- Order the array from MOST established/reliable to least.
- "type" must be one of: "Distributor", "Wholesaler", "Dropshipper", "Supplier".
- "region" is the company's home region/state within ${safeCountry}, or the country name if nationwide.
- "established" should reflect real evidence (founding year, "since" text on their site, or industry knowledge); use 'Unknown' only if genuinely not findable.
- "wholesale_page" should be null if you cannot find a specific wholesale page.
- Only include genuinely ${c.demonym}, reputable companies that actually sell wholesale/bulk to retailers or resellers and have real working websites.
- Do NOT include Amazon, eBay, Alibaba, AliExpress, Walmart, Etsy or general marketplaces. Focus on direct distributors, wholesalers and suppliers.
- ships_international, requires_resale_cert and offers_dropshipping must be booleans (true/false).
- Monetary amounts should be in ${c.currency}.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'Upstream API error: ' + t.slice(0, 200) });
    }

    const data = await r.json();

    const fullText = (data.content || [])
      .map(b => (b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');

    let parsed;
    try {
      const clean = fullText.replace(/```json/g, '').replace(/```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : clean);
    } catch (e) {
      return res.status(500).json({ error: 'Could not parse AI response. Please retry.' });
    }

    // Success → record usage against the rate-limit + budget counters
    recent.push(nowTs); IP_HITS.set(ip, recent);
    DAY.count += 1;

    // Cache fresh searches so identical repeats cost nothing
    if (isFreshSearch) {
      CACHE.set(cacheKey, { at: Date.now(), data: parsed });
      if (CACHE.size > 500) { const oldest = CACHE.keys().next().value; CACHE.delete(oldest); }
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'unknown') });
  }
}
