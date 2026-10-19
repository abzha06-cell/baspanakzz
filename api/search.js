// Vercel серверлік функциясы: Gemini + Google Search арқылы Алматыдағы пәтерлерді іздейді.
// Кілт: Vercel → Settings → Environment Variables → GEMINI_API_KEY

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const LITE = "gemini-flash-lite-latest"; // тегін лимиті көбірек, қосалқы модель

const DISTRICTS = { any: "любой район", alatau: "Алатауский район", almaly: "Алмалинский район", auezov: "Ауэзовский район", bostandyk: "Бостандыкский район", zhetysu: "Жетысуский район", medeu: "Медеуский район", nauryzbay: "Наурызбайский район", turksib: "Турксибский район" };
const TYPES = { any: "любой: новостройки и вторичное жильё", building: "строящиеся ЖК (новостройки на этапе строительства)", ready: "сданные новостройки", secondary: "вторичный рынок" };
const ROOMS = { any: "любое количество комнат", "1": "1-комнатная", "2": "2-комнатная", "3": "3-комнатная", "4": "4 и более комнат" };

function buildPrompt(c) {
  const today = new Date().toISOString().slice(0, 10);
  return `Use Google Search to find apartments for sale in Almaty, Kazakhstan that are advertised now (today is ${today}).
Criteria: price up to ${c.maxPrice} KZT; ${ROOMS[c.rooms]}; type: ${TYPES[c.type]}; district: ${DISTRICTS[c.district]}.${c.program === "nauryz" ? " The buyer uses the «Наурыз» mortgage of Otbasy Bank, which works only for new buildings from developers, so prefer residential complexes listed on Baspana Market." : ""}
Good sources: krisha.kz, kn.kz, Baspana Market (Otbasy Bank), developer websites.
Give up to 6 different options. Use only prices you actually saw in the search results; never invent prices. Prices in KZT as plain numbers (35 млн = 35000000).
Reply with ONLY a JSON array and nothing else. Each item:
{"name":"...","district":"...","address":"...","status":"салынып жатыр"|"тапсырылған"|"екінші нарық","completion":"...","rooms":number|null,"area_m2":number|null,"price_total_kzt":number|null,"price_per_m2_kzt":number|null,"finish":"қара әрлеу"|"таза әрлеу"|"белгісіз","source":"site name","note":"one short sentence in Kazakh: why it fits"}
Write text values in Kazakh, but keep the names of residential complexes as they are. If nothing fits exactly, return the closest options and say so in note.`;
}

async function callGemini(key, prompt, withSearch, model) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } };
  if (withSearch) body.tools = [{ google_search: {} }];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

function parseItems(text) {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  try { const arr = JSON.parse(text.slice(a, b + 1)); return Array.isArray(arr) ? arr.slice(0, 6) : []; } catch (e) { return []; }
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
    // 1) Негізгі модель + Google іздеу, 2) жеңіл модель + Google іздеу,
    // 3) негізгі модель іздеусіз, 4) жеңіл модель іздеусіз
    const attempts = [[MODEL, true], [LITE, true], [MODEL, false], [LITE, false]];
    let r = null, grounded = false, lastErr = "";
    for (const [model, withSearch] of attempts) {
      r = await callGemini(key, buildPrompt(crit), withSearch, model);
      if (r.ok) { grounded = withSearch; break; }
      lastErr = (r.data && r.data.error && r.data.error.message) || ("HTTP " + r.status);
      console.error(model, withSearch, r.status, lastErr);
    }
    if (!r.ok) {
      return res.status(r.status === 429 ? 429 : 502).json({ code: r.status === 429 ? "rate_limited" : "upstream_error", detail: lastErr.slice(0, 300) });
    }

    const cand = r.data.candidates && r.data.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    const items = parseItems(text);
    const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const seen = new Set();
    const sources = chunks.map(ch => ch.web).filter(w => w && w.uri && !seen.has(w.title) && seen.add(w.title)).slice(0, 8);
    return res.status(200).json({ items, sources, grounded });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ code: "upstream_error" });
  }
};
