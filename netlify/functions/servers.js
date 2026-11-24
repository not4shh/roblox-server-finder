// Netlify function: talks to Roblox on behalf of the browser (browsers can't call Roblox directly).
// Tries roblox.com first, falls back to roproxy.com if Roblox blocks or rate-limits.

const cache = new Map(); // short cache so rapid refreshes don't hit Roblox rate limits
const CACHE_MS = 8000;

async function tryUrls(urls) {
  let lastErr = new Error("Roblox did not respond");
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 429) { lastErr = new Error("rate_limited"); continue; }
      if (!r.ok) { lastErr = new Error("http_" + r.status); continue; }
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const reply = (code, body) => ({
  statusCode: code,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

async function postJson(urls, body) {
  let lastErr = new Error("Roblox did not respond");
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 429) { lastErr = new Error("rate_limited"); continue; }
      if (!r.ok) { lastErr = new Error("http_" + r.status); continue; }
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Turns anonymous player tokens (from the server list) into avatar headshot images.
async function getAvatars(tokens) {
  const list = tokens.slice(0, 80).map((t) => ({
    requestId: t, token: t, targetId: 0, type: "AvatarHeadShot",
    size: "48x48", format: "png", isCircular: true,
  }));
  const json = await postJson(
    ["https://thumbnails.roblox.com/v1/batch", "https://thumbnails.roproxy.com/v1/batch"],
    list
  );
  const out = {};
  for (const d of json.data || []) {
    if (d.imageUrl && d.state === "Completed") out[d.requestId] = d.imageUrl;
  }
  return { avatars: out };
}

async function getServers(placeId) {
  const hit = cache.get(placeId);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;

  let cursor = "";
  const out = [];
  for (let page = 0; page < 3; page++) {
    const q = `/v1/games/${placeId}/servers/Public?sortOrder=Asc&excludeFullGames=true&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const json = await tryUrls([
      `https://games.roblox.com${q}`,
      `https://games.roproxy.com${q}`,
    ]);
    for (const s of json.data || []) {
      out.push({
        id: s.id,
        playing: s.playing,
        maxPlayers: s.maxPlayers,
        ping: typeof s.ping === "number" ? s.ping : null,
        fps: typeof s.fps === "number" ? Math.round(s.fps) : null,
        playerTokens: Array.isArray(s.playerTokens) ? s.playerTokens.slice(0, 4) : [],
      });
    }
    cursor = json.nextPageCursor;
    if (!cursor || out.length >= 150) break;
  }
  const data = { servers: out, fetchedAt: Date.now() };
  cache.set(placeId, { t: Date.now(), data });
  return data;
}

async function getInfo(placeId) {
  const uni = await tryUrls([
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
    `https://apis.roproxy.com/universes/v1/places/${placeId}/universe`,
  ]);
  const universeId = uni.universeId;
  if (!universeId) throw new Error("game_not_found");
  const g = await tryUrls([
    `https://games.roblox.com/v1/games?universeIds=${universeId}`,
    `https://games.roproxy.com/v1/games?universeIds=${universeId}`,
  ]);
  const game = (g.data || [])[0] || {};
  return { placeId, name: game.name || "Roblox game", playing: game.playing ?? null };
}

async function searchGames(q) {
  const sid = "00000000-0000-4000-8000-" + String(Date.now()).padStart(12, "0").slice(-12);
  const path = `/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&sessionId=${sid}&pageType=all`;
  const json = await tryUrls([
    `https://apis.roblox.com${path}`,
    `https://apis.roproxy.com${path}`,
  ]);
  const results = [];
  for (const group of json.searchResults || []) {
    for (const c of group.contents || []) {
      if (c.rootPlaceId && c.name) {
        results.push({ placeId: String(c.rootPlaceId), name: c.name, playing: c.playerCount ?? null });
      }
    }
  }
  return { results: results.slice(0, 8) };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const action = p.action || "servers";
  try {
    if (action === "search") {
      const q = (p.q || "").trim();
      if (q.length < 2) return reply(400, { error: "bad_query" });
      return reply(200, await searchGames(q));
    }
    if (action === "avatars") {
      let tokens = [];
      try { tokens = JSON.parse(event.body || "{}").tokens || []; } catch (e) {}
      tokens = tokens.filter((t) => typeof t === "string" && t.length < 300);
      if (!tokens.length) return reply(200, { avatars: {} });
      return reply(200, await getAvatars(tokens));
    }
    const placeId = String(p.placeId || "");
    if (!/^\d{3,15}$/.test(placeId)) return reply(400, { error: "bad_place_id" });
    if (action === "info") return reply(200, await getInfo(placeId));
    return reply(200, await getServers(placeId));
  } catch (e) {
    const msg = e && e.message ? e.message : "failed";
    return reply(msg === "rate_limited" ? 429 : 502, { error: msg });
  }
};
