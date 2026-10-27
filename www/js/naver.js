// 네이버 검색광고 API / 오픈API(블로그 검색, 데이터랩) 클라이언트
import { AD_BASE, OPEN_BASE } from "./config.js";
import { http, NetError } from "./platform.js";

export const MAX_RETRY = 4;

export class ApiError extends Error {
  constructor(message, { status = null, kind = "error", body = "" } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // auth | permission | quota | bad_request | network | server | error
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Throttle {
  constructor(sec) { this.ms = Math.max(0, Number(sec) * 1000); this.last = 0; }
  async wait() {
    const gap = Date.now() - this.last;
    if (gap < this.ms) await sleep(this.ms - gap);
    this.last = Date.now();
  }
}

async function requestWithRetry(service, throttle, makeReq) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    await throttle.wait();
    let res;
    try {
      res = await http(await makeReq());
    } catch (e) {
      if (!(e instanceof NetError)) throw e;
      lastErr = new ApiError(`${service} 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.`, { kind: "network", body: e.message });
      await sleep(Math.min(8000, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const quota = res.status === 429;
      lastErr = new ApiError(quota
        ? `${service} 호출 한도를 초과했습니다 (429). 잠시 후 다시 시도하거나 일일 한도를 확인하세요.`
        : `${service} 서버 오류 (${res.status})`, { status: res.status, kind: quota ? "quota" : "server", body: res.text.slice(0, 500) });
      await sleep(Math.min(10000, 1500 * 2 ** attempt));
      continue;
    }
    return res;
  }
  throw lastErr;
}

// ------------------------------------------------------------------ 키워드 정리·매칭
/** 눈에 안 보이는 문자(폭 0 공백, BOM, 제어문자)를 지우고 한글을 완성형(NFC)으로 맞춘다. */
export function cleanText(s) {
  return String(s ?? "").normalize("NFC").replace(/[\p{Cf}\p{Cc}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
}
/** 검색광고 API는 공백이 들어간 키워드를 받지 않으므로 공백을 모두 지운다. */
export const normalizeKeyword = (kw) => cleanText(kw).replace(/\s+/g, "");
export const matchKey = (kw) => normalizeKeyword(kw).toUpperCase();

export function parseCount(v) {
  if (v === null || v === undefined) return [null, false];
  if (typeof v === "number") return [Math.trunc(v), false];
  const s = String(v).trim();
  if (s.startsWith("<")) return [null, true];
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? [Math.trunc(n), false] : [null, false];
}
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function itemTotal(it) {
  const [pc, pl] = parseCount(it.monthlyPcQcCnt);
  const [mo, ml] = parseCount(it.monthlyMobileQcCnt);
  return (pc ?? (pl ? 5 : 0)) + (mo ?? (ml ? 5 : 0));
}
export const findMatches = (items, kw) => { const k = matchKey(kw); return items.filter((it) => matchKey(it.relKeyword || "") === k); };
export const pickBest = (c) => (c && c.length ? c.reduce((a, b) => (itemTotal(b) > itemTotal(a) ? b : a)) : null);
/** 검색수는 둘 다 10 미만인데 경쟁도가 높음·중간이면 앞뒤가 맞지 않는 값으로 본다. */
export const isSuspicious = (r) => !!(r.pc_lt10 && r.mobile_lt10 && (r.comp === "높음" || r.comp === "중간"));

export function compactRaw(it) {
  const o = {};
  for (const k of ["relKeyword", "monthlyPcQcCnt", "monthlyMobileQcCnt", "compIdx", "plAvgDepth"]) o[k] = it[k] ?? null;
  return JSON.stringify(o);
}

export function toRow(it, source, seed = null) {
  const [pc, pl] = parseCount(it.monthlyPcQcCnt);
  const [mo, ml] = parseCount(it.monthlyMobileQcCnt);
  let depth = it.plAvgDepth;
  depth = depth === null || depth === undefined || !Number.isFinite(Number(depth)) ? null : Math.trunc(Number(depth));
  return {
    keyword: it.relKeyword || "", source, seed,
    pc, pc_lt10: pl ? 1 : 0, mobile: mo, mobile_lt10: ml ? 1 : 0,
    total: (pc ?? (pl ? 5 : 0)) + (mo ?? (ml ? 5 : 0)),
    pc_clk: num(it.monthlyAvePcClkCnt), mobile_clk: num(it.monthlyAveMobileClkCnt),
    pc_ctr: num(it.monthlyAvePcCtr), mobile_ctr: num(it.monthlyAveMobileCtr),
    ad_depth: depth, comp: it.compIdx || null,
    blog_total: null, blog_month: null, blog_month_estimated: 0, saturation: null, error: null,
    api_keyword: it.relKeyword || "", note: null, raw: compactRaw(it),
  };
}

export function errorRow(kw, msg) {
  return {
    keyword: kw, source: "seed", seed: null, pc: null, pc_lt10: 0, mobile: null, mobile_lt10: 0, total: null,
    pc_clk: null, mobile_clk: null, pc_ctr: null, mobile_ctr: null, ad_depth: null, comp: null,
    blog_total: null, blog_month: null, blog_month_estimated: 0, saturation: null, error: msg,
    api_keyword: null, note: null, raw: null,
  };
}

// ------------------------------------------------------------------ 검색광고 API
const enc = new TextEncoder();
async function hmacBase64(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  let s = "";
  sig.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}

export class SearchAdClient {
  static PATH = "/keywordstool";
  constructor(cfg) {
    const k = (cfg.ad_api_key || "").trim(), s = (cfg.ad_secret || "").trim(), c = String(cfg.ad_customer_id || "").trim();
    if (!(k && s && c)) throw new ApiError("검색광고 API 키가 아직 없습니다. [설정]에서 입력하세요.", { kind: "auth" });
    this.key = k; this.secret = s; this.customer = c;
    this.throttle = new Throttle(cfg.ad_delay ?? 0.35);
  }
  async headers() {
    const ts = String(Date.now());
    return {
      "X-Timestamp": ts, "X-API-KEY": this.key, "X-Customer": this.customer,
      "X-Signature": await hmacBase64(this.secret, `${ts}.GET.${SearchAdClient.PATH}`),
      "Content-Type": "application/json; charset=UTF-8",
    };
  }
  async raw(hints) {
    hints = hints.map(normalizeKeyword).filter(Boolean);
    if (!hints.length) return { res: null, hints };
    if (hints.length > 5) throw new Error("hintKeywords 는 한 번에 5개까지입니다.");
    const res = await requestWithRetry("검색광고 API", this.throttle, async () => ({
      method: "GET", url: AD_BASE + SearchAdClient.PATH,
      params: { hintKeywords: hints.join(","), showDetail: "1" }, headers: await this.headers(),
    }));
    return { res, hints };
  }
  async keywordstool(hints) {
    const { res } = await this.raw(hints);
    if (!res) return [];
    const body = res.text.slice(0, 500);
    if (res.status === 401 || res.status === 403)
      throw new ApiError("검색광고 API 인증에 실패했습니다. 액세스라이선스·비밀키·CUSTOMER_ID를 확인하세요.", { status: res.status, kind: "auth", body });
    if (res.status === 400)
      throw new ApiError("검색광고 API가 요청을 거부했습니다 (사용할 수 없는 문자가 있을 수 있음).", { status: 400, kind: "bad_request", body });
    if (res.status !== 200) throw new ApiError(`검색광고 API 오류 (${res.status})`, { status: res.status, body });
    if (!res.data || typeof res.data !== "object") throw new ApiError("검색광고 API 응답을 해석하지 못했습니다.", { status: res.status, body });
    return res.data.keywordList || [];
  }
  /** 진단: 보낸 값과 받은 원본을 그대로 돌려준다. */
  async diagnose(keyword) {
    const { res, hints } = await this.raw([keyword]);
    if (!res) throw new ApiError("키워드를 입력하세요.", { kind: "bad_request" });
    const items = (res.data && typeof res.data === "object" && res.data.keywordList) || [];
    const matches = findMatches(items, keyword);
    return {
      input: keyword,
      input_codepoints: [...String(keyword)].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")),
      sent_hint: hints.join(","), request_url: res.url, status: res.status, raw_text: res.text.slice(0, 8000),
      item_count: items.length, first_items: items.slice(0, 8), matches,
      first_is_match: items.length > 0 && matchKey(items[0].relKeyword || "") === matchKey(keyword),
      chosen: pickBest(matches),
    };
  }
}

// ------------------------------------------------------------------ 오픈API
export class OpenApiClient {
  constructor(cfg) {
    const id = (cfg.dev_client_id || "").trim(), sec = (cfg.dev_client_secret || "").trim();
    if (!(id && sec)) throw new ApiError("블로그·트렌드용 개발자센터 키가 없습니다. [설정]에서 입력하세요.", { kind: "auth" });
    this.h = { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": sec };
    this.throttle = new Throttle(cfg.blog_delay ?? 0.12);
  }
  check(res, service) {
    const body = res.text.slice(0, 500);
    if (res.status === 401) throw new ApiError(`${service} 인증 실패: Client ID/Secret을 확인하세요.`, { status: 401, kind: "auth", body });
    if (res.status === 403) throw new ApiError(`${service} 사용 권한이 없습니다. 개발자센터 애플리케이션의 '사용 API'에 추가했는지 확인하세요.`, { status: 403, kind: "permission", body });
    if (res.status === 400) throw new ApiError(`${service} 요청 형식 오류`, { status: 400, kind: "bad_request", body });
    if (res.status !== 200) throw new ApiError(`${service} 오류 (${res.status})`, { status: res.status, body });
    if (!res.data || typeof res.data !== "object") throw new ApiError(`${service} 응답을 해석하지 못했습니다.`, { status: res.status, body });
    return res.data;
  }
  async blogSearch(query, display = 100, sort = "date") {
    const res = await requestWithRetry("블로그 검색 API", this.throttle, () => ({
      method: "GET", url: OPEN_BASE + "/v1/search/blog.json",
      params: { query, display: String(display), start: "1", sort }, headers: this.h,
    }));
    return this.check(res, "블로그 검색 API");
  }
  async datalab(body) {
    const res = await requestWithRetry("데이터랩 API", this.throttle, () => ({
      method: "POST", url: OPEN_BASE + "/v1/datalab/search",
      headers: { ...this.h, "Content-Type": "application/json" }, data: body,
    }));
    return this.check(res, "데이터랩 API");
  }
}

// ------------------------------------------------------------------ 날짜·블로그 통계
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
export const dayStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/** 블로그 검색(최신순 100건)으로 총 문서수와 최근 30일 발행량(추정)을 계산. [total, month, estimated] */
export function blogStats(data, today = todayStr()) {
  const total = Number(data.total || 0);
  const items = data.items || [];
  const days = items.map((it) => String(it.postdate || "")).filter((p) => /^\d{8}$/.test(p))
    .map((p) => dayNum(`${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`));
  if (!days.length) return [total, 0, 0];
  const t = dayNum(today), cutoff = t - 30;
  const recent = days.filter((d) => d > cutoff).length;
  const oldest = Math.min(...days);
  if (oldest > cutoff && items.length < total) {
    const span = Math.max(1, t - oldest + 1);
    return [total, Math.min(total, Math.round((days.length * 30) / span)), 1];
  }
  return [total, recent, 0];
}

export function saturationGrade(s) {
  if (s === null || s === undefined) return null;
  if (s < 10) return [1, "매우 낮음"];
  if (s < 30) return [2, "낮음"];
  if (s < 100) return [3, "보통"];
  if (s < 300) return [4, "높음"];
  return [5, "매우 높음"];
}
