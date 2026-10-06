import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Bright Data for Bridex agents.
 *
 * - A web-access provider for the core: web_fetch and browser_navigate come
 *   here on a bot wall (Web Unlocker / Browser API), web_proxy hands scripts a
 *   local address in front of a residential zone.
 * - Its own tools for steering it: balance, zones, scrape, search.
 *
 * Zones (Bright Data's products) are created on first use; an existing zone of
 * the right kind is reused. The account's daily spend is checked before each
 * paid call against daily_budget_usd.
 */

const API = "https://api.brightdata.com";
const UA = "bridex-plugin-brightdata";
const resolveRef = (ref) => String(ref ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");

/** Bright Data's product → how a zone of it is created (docs: Account Management API → Add a zone). */
const PRODUCTS = {
  unlocker: { zoneType: "unblocker", plan: { type: "unblocker" }, name: "bridex_unlocker", match: (z) => z.type === "unblocker" },
  serp: { zoneType: "serp", plan: { type: "unblocker", serp: true }, name: "bridex_serp", match: (z) => z.type === "serp" },
  browser: { zoneType: "browser", plan: { type: "browser_api" }, name: "bridex_browser", match: (z) => z.type === "browser_api" || z.type === "browser" },
  residential: { zoneType: "resident", plan: { type: "resident" }, name: "bridex_residential", match: (z) => z.type === "resident" || z.type === "residential" },
  datacenter: { zoneType: "static", plan: { type: "static", pool_ip_type: "dc", ips_type: "shared" }, name: "bridex_datacenter", match: (z) => z.type === "static" || z.type === "dc" },
};

/** Query parameters that only track a share/click — dropping them often gets past a wall that keys on them. */
const TRACKING = /^(utm_|share_|url_from|ref|rep|ret|cdn_|fbclid|gclid|yclid|mc_|_ga|spm|scm|ici|src_)/i;

function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

const WALL = /risk\/challenge|captcha|geetest|verify you are (a )?human|checking your browser|Just a moment\.\.\.|Access Denied/i;

export default async function activate(ctx) {
  const cfg = { api_key: "${BRIGHTDATA_API_KEY}", daily_budget_usd: 5, ...(ctx.config ?? {}) };
  const key = () => {
    const k = resolveRef(cfg.api_key);
    if (!k) throw new Error("BRIGHTDATA_API_KEY is not set — add the Bright Data key under Settings → Integrations");
    return k;
  };

  async function api(pathname, init = {}, timeoutMs = 60_000) {
    const res = await fetch(`${API}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${key()}`, "User-Agent": UA, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text();
      const brd = res.headers.get("x-brd-error") || res.headers.get("x-luminati-error") || "";
      if (res.status === 401) throw new Error(`Bright Data rejected the key (401): ${body.slice(0, 160)}`);
      if (res.status === 402 || /insufficient|balance|payment/i.test(body))
        ctx.billing?.outOfFunds?.({ provider: "Bright Data", what: "web access (brightdata plugin)", detail: body.slice(0, 400) });
      const err = new Error(`Bright Data HTTP ${res.status}${brd ? ` (${brd})` : ""}: ${body.slice(0, 300)}`);
      err.status = res.status;
      err.brd = brd;
      throw err;
    }
    // a 200 can still be a failure: Bright Data puts it in a header
    const brdOk = res.headers.get("x-brd-error");
    if (brdOk) {
      const err = new Error(`Bright Data: ${brdOk}${res.headers.get("x-brd-error-code") ? ` (${res.headers.get("x-brd-error-code")})` : ""}`);
      err.status = Number(res.headers.get("x-brd-status-code")) || 502;
      err.brd = brdOk;
      throw err;
    }
    return res;
  }
  const json = async (pathname, init, t) => (await api(pathname, init, t)).json();

  // -- account ---------------------------------------------------------------

  let customer = null;
  const customerId = async () => (customer ??= (await json("/status")).customer);

  async function zones() {
    return json("/zone/get_active_zones");
  }

  /** The zone for a product: an existing one of its kind, else a new bridex_* zone. */
  async function ensureZone(product, name) {
    const p = PRODUCTS[product];
    if (!p) throw new Error(`unknown product "${product}" — one of ${Object.keys(PRODUCTS).join(", ")}`);
    const all = await zones();
    const want = name ?? p.name;
    const found = all.find((z) => z.name === want) ?? (name ? null : all.find(p.match));
    if (found) return found.name;
    try {
      await json("/zone", { method: "POST", body: JSON.stringify({ zone: { name: want, type: p.zoneType }, plan: p.plan }) });
    } catch (err) {
      if (product === "residential" && /kyc|verif/i.test(err.message))
        throw new Error(`Bright Data asks for a KYC check before a residential zone — the account owner completes it in the Bright Data dashboard (${err.message})`);
      throw err;
    }
    ctx.log.info(`created zone ${want} (${product})`);
    return want;
  }

  async function zonePassword(zone) {
    const r = await json(`/zone/passwords?zone=${encodeURIComponent(zone)}`);
    const pw = r.passwords?.[0];
    if (!pw) throw new Error(`no password for zone ${zone}`);
    return pw;
  }

  /** Spend today and this month, per zone and in total (USD). */
  async function spend() {
    const out = { today: 0, month: 0, zones: [] };
    for (const z of await zones()) {
      try {
        const c = await json(`/zone/cost?zone=${encodeURIComponent(z.name)}`);
        const row = Object.values(c)[0] ?? {};
        const today = Number(row.back_d0?.cost ?? 0);
        const month = Number(row.back_m0?.cost ?? 0);
        out.today += today;
        out.month += month;
        out.zones.push({ name: z.name, type: z.type, today, month });
      } catch {
        out.zones.push({ name: z.name, type: z.type, today: null, month: null });
      }
    }
    return out;
  }

  let spendCache = { at: 0, today: 0 };
  async function guardBudget() {
    const cap = Number(cfg.daily_budget_usd);
    if (!(cap > 0)) return;
    if (Date.now() - spendCache.at > 120_000) spendCache = { at: Date.now(), today: (await spend()).today };
    if (spendCache.today >= cap)
      throw new Error(
        `the Bright Data daily budget is used up ($${spendCache.today.toFixed(2)} of $${cap}) — paid web access is paused until tomorrow. Tell the person; they can raise daily_budget_usd in the Bright Data plugin settings`,
      );
  }

  const usage = (call, model, units, unit) =>
    ctx.usage?.record?.({ workspace: call.workspace, agent: call.agent, taskId: call.taskId ?? null, kind: "brightdata", model, costUsd: 0, units, unit });

  // -- web unlocker ------------------------------------------------------------

  async function unlock(url, { country, format = "markdown", zone } = {}) {
    const z = zone ?? (await ensureZone("unlocker"));
    const body = { zone: z, url, format: "raw", ...(format === "markdown" ? { data_format: "markdown" } : format === "screenshot" ? { data_format: "screenshot" } : {}), ...(country ? { country } : {}) };
    const res = await api("/request", { method: "POST", body: JSON.stringify(body) }, 150_000);
    if (format === "screenshot") return { buf: Buffer.from(await res.arrayBuffer()) };
    return { text: await res.text() };
  }

  /** One page, with the fallbacks that work on picky sites: a clean URL, a European exit. */
  async function unblock(url, opts, call) {
    await guardBudget();
    const format = opts.format ?? "markdown";
    const tries = [];
    const add = (label, u, country) => {
      if (!tries.some((t) => t.u === u && t.country === country)) tries.push({ label, u, country });
    };
    if (opts.recipe) add(`remembered recipe${opts.recipe.country ? ` (${opts.recipe.country})` : ""}${opts.recipe.clean ? ", clean URL" : ""}`, opts.recipe.clean ? cleanUrl(url) : url, opts.recipe.country);
    add(`as given${opts.country ? `, exit ${opts.country}` : ""}`, url, opts.country);
    if (opts.auto !== false) {
      const clean = cleanUrl(url);
      add(`clean URL${opts.country ? `, exit ${opts.country}` : ""}`, clean, opts.country);
      if (!opts.country) {
        add("clean URL, exit de", clean, "de");
        add("clean URL, exit us", clean, "us");
      }
    }
    const attempts = [];
    for (const t of tries.slice(0, opts.auto === false ? 1 : 4)) {
      try {
        const { text } = await unlock(t.u, { country: t.country, format });
        usage(call, "web_unlocker", 1, "requests");
        if (!text || text.length < 300 || WALL.test(text.slice(0, 3000))) {
          attempts.push({ how: t.label, ok: false, detail: "still a bot check" });
          continue;
        }
        attempts.push({ how: t.label, ok: true });
        return { ok: true, content: text, format, attempts, recipe: { ...(t.country ? { country: t.country } : {}), ...(t.u !== url ? { clean: true } : {}) } };
      } catch (err) {
        attempts.push({ how: t.label, ok: false, detail: (err.brd || err.message).slice(0, 160) });
        if (err.status === 401 || /budget/.test(err.message)) break;
      }
    }
    return { ok: false, content: "", format, attempts, error: attempts.at(-1)?.detail };
  }

  // -- the core's provider -----------------------------------------------------

  ctx.registerAccessProvider({
    label: "Bright Data",
    unblock,
    async remoteBrowser(opts, call) {
      await guardBudget();
      const zone = await ensureZone("browser");
      const [cust, pw] = await Promise.all([customerId(), zonePassword(zone)]);
      usage(call, "browser_api", 1, "sessions");
      return { cdpUrl: `wss://brd-customer-${cust}-zone-${zone}${opts.country ? `-country-${opts.country}` : ""}:${pw}@brd.superproxy.io:9222` };
    },
    async proxy(opts, call) {
      await guardBudget();
      const zone = await ensureZone("residential");
      const [cust, pw] = await Promise.all([customerId(), zonePassword(zone)]);
      usage(call, "residential", 1, "proxy grants");
      return { url: `http://brd-customer-${cust}-zone-${zone}${opts.country ? `-country-${opts.country}` : ""}:${encodeURIComponent(pw)}@brd.superproxy.io:33335` };
    },
  });

  // -- tools ---------------------------------------------------------------------

  const z = ctx.z;
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  ctx.registerTool({
    name: "brightdata_balance",
    description: "The Bright Data account: balance, what was spent today and this month (per zone), and the daily budget left. Free.",
    schema: {},
    async handler() {
      const [bal, sp] = await Promise.all([json("/customer/balance"), spend()]);
      const cap = Number(cfg.daily_budget_usd);
      const lines = [
        `Balance: $${Number(bal.balance ?? 0).toFixed(2)}${bal.pending_costs ? ` (pending $${Number(bal.pending_costs).toFixed(2)})` : ""}`,
        `Spent today: $${sp.today.toFixed(4)}${cap > 0 ? ` of the $${cap} daily budget` : ""} · this month: $${sp.month.toFixed(4)}`,
        "Zones:",
        ...sp.zones.map((x) => `- ${x.name} (${x.type}) — today $${x.today ?? "?"}, month $${x.month ?? "?"}`),
      ];
      return text(lines.join("\n"));
    },
  });

  ctx.registerTool({
    name: "brightdata_zones",
    description:
      "List the Bright Data zones (products) on the account, or create one: unlocker (pages behind bot walls), serp (search engines), browser (interactive remote browser), residential / datacenter (proxies). Creating a zone is free — use is paid. Residential zones need a KYC check by the account owner.",
    schema: {
      action: z.enum(["list", "create"]).default("list"),
      product: z.enum(["unlocker", "serp", "browser", "residential", "datacenter"]).optional(),
      name: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/).optional().describe("zone name (lowercase); default bridex_<product>"),
    },
    async handler(args) {
      if (args.action === "create") {
        if (!args.product) return text("error: give the product to create");
        const name = await ensureZone(args.product, args.name);
        return text(`zone ${name} (${args.product}) is ready`);
      }
      const all = await zones();
      return text(all.length ? all.map((x) => `- ${x.name}: ${x.type}`).join("\n") : "no zones yet — they are created on first use");
    },
  });

  ctx.registerTool({
    name: "brightdata_scrape",
    description:
      "Open one page through Bright Data's Web Unlocker — it solves captchas and anti-bot checks. Markdown (default), raw html, or a screenshot (saved to the task's artifacts). `auto` (default true) also tries a clean URL and a European/US exit when the first try is still walled, and reports each attempt. Paid per successful request.",
    schema: {
      url: z.string().url(),
      country: z.string().length(2).optional().describe("exit country, ISO code"),
      format: z.enum(["markdown", "html", "screenshot"]).optional(),
      auto: z.boolean().optional(),
      zone: z.string().optional().describe("a specific unlocker zone"),
    },
    async handler(args, call) {
      const country = args.country?.toLowerCase();
      if (args.format === "screenshot") {
        await guardBudget();
        const { buf } = await unlock(args.url, { country, format: "screenshot", zone: args.zone });
        usage(call, "web_unlocker", 1, "requests");
        const rel = path.posix.join(call.taskId ?? "brightdata", `screenshot-${crypto.randomBytes(3).toString("hex")}.png`);
        const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        ctx.artifacts.annotate(call.workspace, rel, { agent: call.agent, taskId: call.taskId, description: `Screenshot of ${args.url} (Bright Data)`, action: "generated" });
        return text(`artifacts/${rel}`);
      }
      const r = await unblock(args.url, { country, format: args.format ?? "markdown", auto: args.auto !== false }, call);
      const tried = r.attempts.map((a, i) => `${i + 1}. ${a.how} — ${a.ok ? "ok" : `failed${a.detail ? `: ${a.detail}` : ""}`}`).join("\n");
      if (!r.ok) return text(`Not opened. Attempts:\n${tried}\nNext: another country, browser_navigate with via: "remote" (interactive), or another source.`);
      return text(`Attempts:\n${tried}\n\n${r.content.slice(0, 40_000)}`);
    },
  });

  ctx.registerTool({
    name: "brightdata_search",
    description: "Search Google (parsed results), Bing or Yandex through Bright Data's SERP API — from any country, with news/images/shopping verticals. Paid per request.",
    schema: {
      query: z.string().min(1),
      engine: z.enum(["google", "bing", "yandex"]).optional(),
      country: z.string().length(2).optional(),
      language: z.string().min(2).max(5).optional(),
      type: z.enum(["web", "news", "images", "shopping"]).optional(),
      page: z.number().int().min(0).max(10).optional(),
    },
    async handler(args, call) {
      await guardBudget();
      const engine = args.engine ?? "google";
      const base = { google: "https://www.google.com/search", bing: "https://www.bing.com/search", yandex: "https://www.yandex.com/search" }[engine];
      const q = new URLSearchParams({ q: args.query });
      if (engine === "google") q.set("brd_json", "1");
      const country = args.country?.toLowerCase();
      if (country) q.set(engine === "google" ? "gl" : "cc", country);
      if (args.language) q.set(engine === "google" ? "hl" : "setLang", args.language);
      if (args.page) q.set(engine === "google" ? "start" : "first", String(args.page * 10 + (engine === "google" ? 0 : 1)));
      if (args.type && args.type !== "web") {
        const [k, v] = { news: ["tbm", "nws"], images: ["tbm", "isch"], shopping: ["udm", "28"] }[args.type];
        q.set(k, v);
      }
      const zone = await ensureZone("serp");
      const body = { zone, url: `${base}?${q}`, format: "raw", ...(engine === "google" ? {} : { data_format: "markdown" }) };
      const res = await api("/request", { method: "POST", body: JSON.stringify(body) }, 90_000);
      usage(call, "serp", 1, "requests");
      const raw = await res.text();
      if (engine !== "google") return text(raw.slice(0, 30_000));
      try {
        const d = JSON.parse(raw);
        const items = [...(d.organic ?? []), ...(d.news ?? []), ...(d.shopping ?? []), ...(d.images ?? [])].slice(0, 20);
        const lines = items.map((it, i) => `${i + 1}. ${it.title ?? ""}${it.price ? ` — ${it.price}` : ""}\n   ${it.link ?? it.url ?? ""}${it.description ? `\n   ${String(it.description).slice(0, 220)}` : ""}`);
        return text(lines.length ? lines.join("\n") : raw.slice(0, 20_000));
      } catch {
        return text(raw.slice(0, 30_000));
      }
    },
  });

  // dashboard balance tile
  if (typeof ctx.registerStat === "function") {
    let cache = { at: 0, tiles: [] };
    ctx.registerStat(async () => {
      if (!resolveRef(cfg.api_key)) return [];
      if (Date.now() - cache.at < 300_000) return cache.tiles;
      const bal = await json("/customer/balance", undefined, 4000);
      const b = Number(bal.balance ?? 0);
      cache = { at: Date.now(), tiles: [{ label: "Bright Data", value: `$${b.toFixed(2)}`, sub: "balance", balance: null, low: b < 2 }] };
      return cache.tiles;
    });
  }

  if (!resolveRef(cfg.api_key)) ctx.needsConfig("Add the Bright Data API key (Settings → Integrations, BRIGHTDATA_API_KEY).");
  else ctx.log.info("brightdata ready");
}
