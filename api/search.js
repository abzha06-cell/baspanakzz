// Vercel серверлік функциясы: Алматыдағы пәтерлерді Gemini + Google Search арқылы іздейді.
// 1-қадам: ЖИ Google арқылы іздеп, тізімді қарапайым мәтінмен жазады.
// 2-қадам: екінші сұрау сол мәтінді сайтқа керек JSON пішініне айналдырады.
// Кілт: Vercel → Settings → Environments → Production → Environment Variables → GEMINI_API_KEY

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const LITE = "gemini-flash-lite-latest";

const DISTRICTS = { any: "любой район", alatau: "Алатауский район", almaly: "Алмалинский район", auezov: "Ауэзовский район", bostandyk: "Бостандыкский район", zhetysu: "Жетысуский район", medeu: "Медеуский район", nauryzbay: "Наурызбайский район", turksib: "Турксибский район" };
const TYPES = { any: "любой: новостройки и вторичное жильё", building: "строящиеся ЖК (новостройки на этапе строительства)", ready: "сданные новостройки", secondary: "вторичный рынок" };
const ROOMS = { any: "любое количество комнат", "1": "1-комнатная", "2": "2-комнатная", "3": "3-комнатная", "4": "4 и более комнат" };

function searchPrompt(c) {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. Search the web for apartments currently for sale in Almaty, Kazakhstan.
Buyer's criteria: price up to ${c.maxPrice} KZT (${Math.round(c.maxPrice / 1e6)} млн тенге); ${ROOMS[c.rooms]}; ${TYPES[c.type]}; ${DISTRICTS[c.district]}.${c.program === "nauryz" ? " The buyer uses the «Наурыз» mortgage of Otbasy Bank (only new buildings from developers), so residential complexes from Baspana Market are preferred." : ""}
Useful sources: krisha.kz, kn.kz, Baspana Market, developer websites.

List 4 to 6 concrete options (residential complexes or specific listings). For each, write on separate lines: name, district, address, status (under construction / completed / secondary market), completion date, rooms, area in m², total price in tenge, price per m², finishing (rough / clean), source website, and one sentence on why it fits.
Take district and prices only from the sources; do not guess. If nothing fits the budget exactly, still list the cheapest suitable options you found and say they are above budget. Never answer with an empty list.`;
}

const FORMAT_PROMPT = `Convert the apartment list below into a JSON array. Output only JSON.
Each item: {"name": string, "district": string, "address": string, "status": "салынып жатыр" | "тапсырылған" | "екінші нарық", "completion": string, "rooms": number or null, "area_m2": number or null, "price_total_kzt": number or null, "price_per_m2_kzt": number or null, "finish": "қара әрлеу" | "таза әрлеу" | "белгісіз", "source": string, "note": string}
Rules: prices are plain numbers in tenge (35 млн = 35000000). Translate district, address words, completion and note into Kazakh; keep names of residential complexes unchanged. Use null when unknown. Do not add options that are not in the list.

LIST:
`;

async function callGemini(key, model, prompt, opts) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
  if (opts.search) body.tools = [{ google_search: {} }];
  if (opts.json) body.generationConfig.responseMimeType = "application/json";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("").trim();
  const err = (data.error && data.error.message) || ("HTTP " + r.status);
  return { ok: r.ok && !!text, status: r.status, cand, text, err };
}

function parseItems(text) {
  let t = String(text || "").replace(/```json|```/g, "").trim();
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const arr = Object.values(v).find(Array.isArray); if (arr) return arr; }
  } catch (e) {}
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) { try { const v = JSON.parse(t.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch (e) {} }
  return [];
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ code: "method" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ code: "no_key" });

  const c = req.body || {};
  const maxPrice = Math.round(Number(c.maxPrice));
  if (!(maxPrice >= 1e6 && maxPrice <= 5e9)) return res.status(400).json({ code: "bad_price" });
  const crit = {
    maxPrice,
    rooms: ROOMS[c.rooms] ? c.rooms : "any",
    type: TYPES[c.type] ? c.type : "any",
    district: DISTRICTS[c.district] ? c.district : "any",
    program: String(c.program || "")
  };

  try {
    // 1-қадам: іздеу
    const attempts = [[MODEL, true], [LITE, true], [MODEL, false], [LITE, false]];
    let s1 = null, grounded = false, lastErr = "", lastStatus = 0;
    for (const [model, search] of attempts) {
      s1 = await callGemini(key, model, searchPrompt(crit), { search });
      if (s1.ok) { grounded = search; break; }
      lastErr = s1.err; lastStatus = s1.status;
      console.error("step1", model, search, s1.status, s1.err);
    }
    if (!s1.ok) {
      return res.status(lastStatus === 429 ? 429 : 502).json({ code: lastStatus === 429 ? "rate_limited" : "upstream_error", detail: String(lastErr).slice(0, 300) });
    }

    // 2-қадам: мәтінді JSON-ға айналдыру
    let items = [];
    for (const model of [LITE, MODEL]) {
      const s2 = await callGemini(key, model, FORMAT_PROMPT + s1.text, { json: true });
      if (s2.ok) { items = parseItems(s2.text); if (items.length) break; }
      else console.error("step2", model, s2.status, s2.err);
    }
    items = items.filter(it => it && typeof it === "object").slice(0, 6);

    // Әр пәтерге ЖИ шынымен оқыған беттің сілтемесін табамыз
    const gm = (s1.cand && s1.cand.groundingMetadata) || {};
    const chunks = gm.groundingChunks || [];
    const supports = gm.groundingSupports || [];
    for (const it of items) {
      const name = String(it.name || "").toLowerCase().trim();
      const idx = [];
      for (const s of supports) {
        const t = String((s.segment && s.segment.text) || "").toLowerCase();
        if (name && t.includes(name)) idx.push(...(s.groundingChunkIndices || []));
      }
      const webs = idx.map(i => chunks[i] && chunks[i].web).filter(w => w && w.uri);
      const pref = webs.find(w => /krisha|kn\.kz|otbasy|baspana/i.test(w.title || "")) || webs[0];
      if (pref) { it.link = pref.uri; it.link_title = pref.title || it.source || "дереккөз"; }
    }
    const seen = new Set();
    const sources = chunks.map(ch => ch.web).filter(w => w && w.uri && !seen.has(w.title) && seen.add(w.title)).slice(0, 8);

    return res.status(200).json({ items, sources, grounded, raw: items.length ? undefined : s1.text.slice(0, 1500) });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ code: "upstream_error" });
  }
};
