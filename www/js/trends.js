// 데이터랩 검색어 트렌드 + 월간 검색수로 절대 검색량 추정
import {
  ApiError, OpenApiClient, SearchAdClient, dayNum, dayStr, findMatches, matchKey,
  normalizeKeyword, parseCount, pickBest, todayStr,
} from "./naver.js";

const MIN_DAY = dayNum("2016-01-01");

function bucketKey(n, unit) {
  const s = dayStr(n);
  if (unit === "month") return s.slice(0, 7);
  if (unit === "week") { const wd = (new Date(n * 86400000).getUTCDay() + 6) % 7; return dayStr(n - wd); }
  return s;
}
function bucketComplete(key, unit, start, end) {
  if (unit === "date") return true;
  let ws, we;
  if (unit === "week") { ws = dayNum(key); we = ws + 6; } else {
    ws = dayNum(key + "-01");
    const y = +key.slice(0, 4), m = +key.slice(5, 7);
    we = Math.round(Date.UTC(y, m, 1) / 86400000) - 1;
  }
  return ws >= start && we <= end;
}

async function volumes(cfg, keywords, device) {
  const client = new SearchAdClient(cfg);
  const uniq = [];
  for (const k of keywords) if (normalizeKeyword(k) && !uniq.some((u) => matchKey(u) === matchKey(k))) uniq.push(k);
  const found = new Map();
  for (let i = 0; i < uniq.length; i += 5) {
    const batch = uniq.slice(i, i + 5);
    let items = [];
    try { items = await client.keywordstool(batch); } catch (e) {
      if (!(e instanceof ApiError) || e.kind !== "bad_request") throw e;
      for (const kw of batch) {
        try { items.push(...(await client.keywordstool([kw]))); } catch (e2) {
          if (!(e2 instanceof ApiError) || e2.kind !== "bad_request") throw e2;
        }
      }
    }
    for (const k of batch) {
      const it = pickBest(findMatches(items, k));
      if (!it || found.has(matchKey(k))) continue;
      const [pc, pl] = parseCount(it.monthlyPcQcCnt), [mo, ml] = parseCount(it.monthlyMobileQcCnt);
      found.set(matchKey(k), { pc: pc ?? (pl ? 5 : 0), mo: mo ?? (ml ? 5 : 0) });
    }
  }
  const out = {};
  for (const k of uniq) {
    const v = found.get(matchKey(k));
    out[k] = !v ? null : device === "pc" ? v.pc : device === "mo" ? v.mo : v.pc + v.mo;
  }
  return out;
}

export async function runTrend(cfg, req) {
  const groups = [];
  for (const g of req.groups || []) {
    const kws = (g.keywords || []).map((k) => String(k).replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!kws.length) continue;
    groups.push({ groupName: (g.name || kws[0]).trim().slice(0, 50), keywords: kws.slice(0, 20) });
  }
  if (!groups.length) throw new Error("트렌드를 볼 키워드를 1개 이상 입력하세요.");
  if (groups.length > 5) throw new Error("트렌드는 한 번에 5개까지 비교할 수 있습니다.");

  const yesterday = dayNum(todayStr()) - 1;
  let end = req.end ? Math.min(dayNum(req.end), yesterday) : yesterday;
  let start = Math.max(req.start ? dayNum(req.start) : end - 364, MIN_DAY);
  if (start > end) throw new Error("시작일이 종료일보다 늦습니다.");
  const unit = ["date", "week", "month"].includes(req.unit) ? req.unit : "month";
  const device = ["pc", "mo"].includes(req.device) ? req.device : "";
  const gender = ["m", "f"].includes(req.gender) ? req.gender : "";
  const ages = (req.ages || []).filter((a) => /^(1[01]?|[2-9])$/.test(String(a))).map(String);

  const body = { startDate: dayStr(start), endDate: dayStr(end), timeUnit: "date", keywordGroups: groups };
  if (device) body.device = device;
  if (gender) body.gender = gender;
  if (ages.length) body.ages = ages;

  const data = await new OpenApiClient(cfg).datalab(body);
  const labels = [], idx = new Map();
  for (let d = start; d <= end; d++) {
    const k = bucketKey(d, unit);
    if (!idx.has(k)) { idx.set(k, labels.length); labels.push(k); }
  }
  const series = (data.results || []).map((res) => {
    const daily = new Map();
    for (const p of res.data || []) if (p.period) daily.set(dayNum(p.period), Number(p.ratio || 0));
    const raw = new Array(labels.length).fill(0);
    for (let d = start; d <= end; d++) raw[idx.get(bucketKey(d, unit))] += daily.get(d) || 0;
    let last30 = 0;
    for (let i = 0; i < 30; i++) last30 += daily.get(end - i) || 0;
    return { name: res.title || "", keywords: res.keywords || [], raw, last30 };
  });
  const peak = Math.max(0, ...series.flatMap((s) => s.raw));
  series.forEach((s) => { s.ratio = s.raw.map((v) => (peak ? Math.round((v / peak) * 10000) / 100 : 0)); });

  let estimate = !!req.estimate, note = "";
  if (estimate && (gender || ages.length)) { estimate = false; note = "성별·연령 조건을 쓰면 검색량으로 환산할 수 없어 상대지수만 보여줍니다."; }
  if (estimate) {
    const vols = await volumes(cfg, series.flatMap((s) => s.keywords), device);
    for (const s of series) {
      const known = s.keywords.map((k) => vols[k]).filter((v) => v !== null && v !== undefined);
      s.volume = known.length ? known.reduce((a, b) => a + b, 0) : null;
      s.estimate = s.volume !== null && s.last30 > 0 ? s.raw.map((v) => Math.round((v * s.volume) / s.last30)) : null;
    }
    if (end - start < 29) note = "기간이 30일보다 짧아 추정치가 부정확할 수 있습니다.";
  }
  series.forEach((s) => { delete s.raw; delete s.last30; });
  return {
    labels, complete: labels.map((k) => bucketComplete(k, unit, start, end)), series, unit,
    start: dayStr(start), end: dayStr(end), estimate, note,
  };
}
