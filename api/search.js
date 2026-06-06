// Vercel Serverless Function
// This function keeps your API key SECRET (it is never exposed to the browser).
// The API key is read from Vercel's Environment Variables: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  // Allow POST requests only
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured. Set ANTHROPIC_API_KEY in Vercel.' });
  }

  const { category } = req.body || {};
  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: 'Category is required' });
  }

  const safeCategory = category.slice(0, 120).replace(/[\n\r]/g, ' ');

  const prompt = `You are a wholesale sourcing research expert. Search the web and find 8-10 authentic, legitimate US-based wholesale distributors and wholesalers for this category: "${safeCategory}".

For each one you MUST:
1. Confirm it is a real, established US company with a working website.
2. Check whether it offers wholesale / trade / reseller accounts.
3. Find the direct URL to their wholesale account registration or wholesale inquiry page if it exists.

Respond with ONLY valid JSON — no markdown, no code fences, no commentary. Use this exact structure:
{
  "category": "${safeCategory}",
  "distributors": [
    {
      "name": "Company Name",
      "type": "Distributor",
      "website": "https://www.example.com",
      "wholesale_page": "https://www.example.com/wholesale",
      "description": "Two short sentences: what they sell and who they serve.",
      "min_order": "Minimum order, or 'Varies', or 'No minimum'",
      "ships_international": true,
      "requires_resale_cert": true,
      "notable": "One key fact."
    }
  ]
}

Rules:
- "type" must be one of: "Distributor", "Wholesaler", "Dropshipper".
- "wholesale_page" should be null if you cannot find a specific wholesale page.
- Only include genuinely US-based, reputable companies that actually sell wholesale/bulk to retailers or resellers and have real working websites.
- Do NOT include Amazon, eBay, Alibaba, AliExpress, Walmart, or general marketplaces. Focus on direct distributors and wholesalers.
- ships_international and requires_resale_cert must be booleans (true/false).`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
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

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'unknown') });
  }
}
