// 키워드 일괄 조회 작업
import * as db from "./db.js";
import {
  ApiError, OpenApiClient, SearchAdClient, blogStats, cleanText, errorRow, findMatches,
  isSuspicious, matchKey, normalizeKeyword, pickBest, toRow, todayStr,
} from "./naver.js";

export const saturationOf = (month, total) => (month === null || month === undefined || !total ? null : Math.round((month / total) * 1000) / 10);

export function dedupe(keywords) {
  const seen = new Set(), out = [];
  for (const raw of keywords) {
    const k = cleanText(raw).replace(/\s+/g, " ").trim();
    if (!k || !normalizeKeyword(k)) continue;
    const key = matchKey(k);
    if (seen.has(key)) continue;
    seen.add(key); out.push(k);
  }
  return out;
}

let current = null;
export const runningJob = () => (current && current.status === "running" ? current : null);

export class KeywordJob {
  constructor(keywords, options, cfg, onUpdate) {
    this.keywords = dedupe(keywords);
    this.options = options; this.cfg = cfg; this.onUpdate = onUpdate || (() => {});
    this.status = "running"; this.phase = "검색량 조회";
    this.done = 0; this.total = 0; this.message = ""; this.warnings = []; this.log = [];
    this.runId = null; this.started = Date.now(); this.cancelled = false;
  }
  emit() { try { this.onUpdate(this); } catch { /* 화면 오류는 무시 */ } }
  addLog(m) {
    const t = new Date().toTimeString().slice(0, 8);
    this.log.push(`[${t}] ${m}`); if (this.log.length > 60) this.log.shift();
  }
  cancel() { this.cancelled = true; this.phase = "중지하는 중…"; this.emit(); }

  async start() {
    if (runningJob()) throw new Error("이미 조회가 진행 중입니다. 끝나거나 중지한 뒤 다시 시도하세요.");
    if (!this.keywords.length) throw new Error("조회할 키워드가 없습니다.");
    // 키 확인을 먼저 해서, 키가 없으면 기록을 만들지 않는다
    this.ad = new SearchAdClient(this.cfg);
    const expand = !!this.options.expand;
    const title = this.options.title || this.keywords[0] + (this.keywords.length > 1 ? ` 외 ${this.keywords.length - 1}개` : "");
    this.runId = await db.createRun(title, this.keywords.length, this.options);
    this.batch = expand ? 1 : 5;
    this.total = Math.ceil(this.keywords.length / this.batch);
    current = this;
    this.promise = this.run();
    return this;
  }

  async run() {
    let rows = [];
    try {
      rows = await this.phaseVolume();
      if (!this.cancelled && this.options.blog && rows.length) await this.phaseBlog(rows);
      await db.insertResults(this.runId, rows);
      if (this.cancelled) {
        this.status = "cancelled";
        this.message = "조회를 중지했습니다. 그때까지의 결과는 저장했습니다.";
      } else {
        this.status = "done";
        const ok = rows.filter((r) => !r.error).length;
        this.message = `완료: ${rows.length}개 키워드 (정상 ${ok}개)`;
      }
      await db.finishRun(this.runId, this.status, [this.message, ...this.warnings].join("\n"));
    } catch (e) {
      try { await db.insertResults(this.runId, rows); } catch { /* 저장 실패는 아래 메시지로 */ }
      this.status = "error";
      const msg = e instanceof ApiError ? e.message : `알 수 없는 오류: ${e && e.message ? e.message : e}`;
      this.message = msg + (rows.length ? " 그때까지의 결과는 저장했습니다." : "");
      this.addLog("중단: " + msg + (e && e.body ? ` / 응답: ${e.body}` : ""));
      await db.finishRun(this.runId, "error", this.message);
    }
    this.emit();
    return this;
  }

  async queryBatch(batch) {
    try {
      return { all: await this.ad.keywordstool(batch), failed: {} };
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind !== "bad_request") throw e;
      const all = [], failed = {};
      for (const kw of batch) {
        try { all.push(...(await this.ad.keywordstool([kw]))); } catch (e2) {
          if (!(e2 instanceof ApiError) || e2.kind !== "bad_request") throw e2;
          failed[kw] = e2;
        }
      }
      return { all, failed };
    }
  }

  async recheck(kw, row) {
    this.addLog(`값 재확인: ${kw} (10 미만인데 경쟁도 ${row.comp})`);
    let items = [];
    try { items = await this.ad.keywordstool([kw]); } catch (e) {
      if (!(e instanceof ApiError) || e.kind !== "bad_request") throw e;
    }
    const best = pickBest(findMatches(items, kw));
    if (best) {
      const fresh = toRow(best, "seed"); fresh.keyword = kw;
      if ((fresh.total || 0) > (row.total || 0)) { fresh.note = "재조회로 보정 (처음 응답은 10 미만)"; return fresh; }
    }
    row.note = `확인 필요: 10 미만인데 경쟁도 ${row.comp} · 설정 > 검색량 진단`;
    return row;
  }

  async phaseVolume() {
    const expand = !!this.options.expand;
    const relLimit = Number(this.options.related_limit || 0);
    const relMin = Number(this.options.related_min || 0);
    const seeds = [], related = [];
    const seedKeys = new Set(this.keywords.map(matchKey));
    const relSeen = new Set();
    for (let i = 0; i < this.keywords.length; i += this.batch) {
      if (this.cancelled) break;
      const batch = this.keywords.slice(i, i + this.batch);
      this.addLog("검색량 조회: " + batch.join(", "));
      this.emit();
      const { all, failed } = await this.queryBatch(batch);
      const groups = new Map();
      for (const it of all) {
        const k = matchKey(it.relKeyword || "");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      for (const kw of batch) {
        if (failed[kw]) { seeds.push(errorRow(kw, "사용할 수 없는 키워드 (특수문자 등)")); continue; }
        const cands = groups.get(matchKey(kw)) || [];
        const it = pickBest(cands);
        if (!it) { seeds.push(errorRow(kw, "검색량 데이터 없음")); continue; }
        let row = toRow(it, "seed"); row.keyword = kw;
        if (cands.length > 1) row.note = `같은 키워드 후보 ${cands.length}개 중 큰 값 사용`;
        if (isSuspicious(row)) row = await this.recheck(kw, row);
        seeds.push(row);
      }
      if (expand) {
        const seed = batch[0];
        let cands = [];
        for (const [k, list] of groups) {
          if (seedKeys.has(k) || relSeen.has(k)) continue;
          const r = toRow(pickBest(list), "related", seed);
          if (r.total < relMin) continue;
          cands.push([k, r]);
        }
        cands.sort((a, b) => b[1].total - a[1].total);
        if (relLimit > 0) cands = cands.slice(0, relLimit);
        for (const [k, r] of cands) { relSeen.add(k); related.push(r); }
      }
      this.done++;
      this.emit();
    }
    if (expand) this.addLog(`연관 키워드 ${related.length}개 수집`);
    return seeds.concat(related);
  }

  async phaseBlog(rows) {
    let oc;
    try { oc = new OpenApiClient(this.cfg); } catch (e) {
      this.warnings.push("블로그 포화도 생략: " + e.message); this.addLog(this.warnings.at(-1)); return;
    }
    const targets = rows.filter((r) => !r.error);
    this.phase = "블로그 포화도 계산"; this.done = 0; this.total = targets.length; this.emit();
    const today = todayStr();
    for (const r of targets) {
      if (this.cancelled) break;
      try {
        const [total, month, est] = blogStats(await oc.blogSearch(r.keyword), today);
        r.blog_total = total; r.blog_month = month; r.blog_month_estimated = est;
        const unsure = (r.note || "").startsWith("확인 필요");
        r.saturation = unsure ? null : saturationOf(month, r.total);
      } catch (e) {
        if (e instanceof ApiError && ["auth", "permission", "quota"].includes(e.kind)) {
          this.warnings.push("블로그 포화도 일부/전체 생략: " + e.message); this.addLog(this.warnings.at(-1)); return;
        }
        this.addLog(`블로그 조회 실패(${r.keyword}): ${e.message}`);
      }
      this.done++;
      if (this.done % 5 === 0 || this.done === this.total) this.emit();
    }
  }
}
