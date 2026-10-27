// 엑셀·CSV 불러오기와 내보내기 (SheetJS)
/* global XLSX */
import { saturationGrade } from "./naver.js";

const HEADER_WORDS = new Set(["키워드", "keyword", "keywords", "검색어", "단어", "kw"]);

function pickColumn(rows) {
  for (const r of rows.slice(0, 5)) for (let i = 0; i < r.length; i++) {
    if (r[i] !== null && r[i] !== undefined && HEADER_WORDS.has(String(r[i]).trim().toLowerCase())) return i;
  }
  return 0;
}
function clean(rows) {
  const col = pickColumn(rows), out = [];
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    const s = String(v).replace(/\s+/g, " ").trim();
    if (s && !HEADER_WORDS.has(s.toLowerCase())) out.push(s);
  }
  return out;
}
function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, ""); } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

export async function readKeywordsFile(file) {
  const name = (file.name || "").toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".xls")) throw new Error("예전 엑셀 형식(.xls)은 읽을 수 없습니다. .xlsx로 저장한 뒤 올려주세요.");
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
    return clean(rows);
  }
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);
  if (name.endsWith(".csv")) return clean(lines.filter((l) => l.trim()).map(parseCsvLine));
  return clean(lines.flatMap((l) => l.split(",")).map((x) => [x]));
}

export const COLUMNS = [
  ["keyword", "키워드", 22], ["source", "구분", 7], ["seed", "출처 키워드", 16],
  ["pc", "PC 검색수", 11], ["mobile", "모바일 검색수", 12], ["total", "합계 검색수", 12],
  ["mobile_share", "모바일 비중(%)", 12], ["pc_clk", "PC 월평균 클릭", 12], ["mobile_clk", "모바일 월평균 클릭", 14],
  ["pc_ctr", "PC 클릭률(%)", 11], ["mobile_ctr", "모바일 클릭률(%)", 13], ["comp", "경쟁 정도", 9],
  ["ad_depth", "월평균 노출 광고수", 14], ["blog_total", "블로그 총 문서수", 14], ["blog_month", "블로그 월 발행량", 14],
  ["saturation", "포화지수(%)", 11], ["grade", "포화 등급", 9], ["error", "비고", 36], ["api_keyword", "API 응답 키워드", 16],
];

function cell(r, key) {
  switch (key) {
    case "source": return r.source === "seed" ? "입력" : "연관";
    case "pc": case "mobile": return r[key + "_lt10"] ? "< 10" : r[key];
    case "mobile_share": return r.total && r.mobile !== null ? Math.round((r.mobile / r.total) * 1000) / 10 : null;
    case "grade": { const g = saturationGrade(r.saturation); return g ? g[1] : ""; }
    case "error": return [r.error, r.note].filter(Boolean).join(" / ") || null;
    default: return r[key] ?? null;
  }
}

export function safeName(s) { return String(s || "keywords").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40); }

export function resultsWorkbookBase64(run, rows) {
  const aoa = [COLUMNS.map((c) => c[1]), ...rows.map((r) => COLUMNS.map((c) => cell(r, c[0])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = COLUMNS.map((c) => ({ wch: c[2] }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(1, rows.length), c: COLUMNS.length - 1 } }) };
  const intKeys = new Set(["pc", "mobile", "total", "blog_total", "blog_month", "ad_depth"]);
  const decKeys = new Set(["pc_clk", "mobile_clk", "pc_ctr", "mobile_ctr", "mobile_share", "saturation"]);
  rows.forEach((r, ri) => COLUMNS.forEach(([k], ci) => {
    const a = ws[XLSX.utils.encode_cell({ r: ri + 1, c: ci })];
    if (!a || a.t !== "n") return;
    if (intKeys.has(k)) a.z = k === "blog_month" && r.blog_month_estimated ? '"≈"#,##0' : "#,##0";
    else if (decKeys.has(k)) a.z = "#,##0.0";
  }));
  const info = XLSX.utils.aoa_to_sheet([
    ["조회 이름", run.title], ["조회 시각", run.created_at], ["입력 키워드 수", run.seed_count], ["결과 키워드 수", rows.length], [],
    ["검색수", "네이버 검색광고 키워드도구 기준 최근 30일 검색수. '< 10'은 10회 미만."],
    ["블로그 월 발행량", "블로그 최신순 100건으로 센 최근 30일 발행량. ≈ 는 기간 비율로 환산한 추정치."],
    ["포화지수", "블로그 월 발행량 ÷ 월간 검색수 × 100. 낮을수록 검색 수요 대비 글이 적음."],
    ["포화 등급", "10% 미만 매우 낮음 / 30% 미만 낮음 / 100% 미만 보통 / 300% 미만 높음 / 그 이상 매우 높음"],
  ]);
  info["!cols"] = [{ wch: 16 }, { wch: 90 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "조회 결과");
  XLSX.utils.book_append_sheet(wb, info, "정보");
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

export function trendWorkbookBase64(t) {
  const head = ["구간", "온전한 구간", ...t.series.flatMap((s) => [`${s.name} 상대지수`, `${s.name} 추정 검색수`])];
  const rows = t.labels.map((k, j) => [k, t.complete[j] ? "Y" : "N", ...t.series.flatMap((s) => [s.ratio[j], s.estimate ? s.estimate[j] : null])]);
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws["!cols"] = head.map((_, i) => ({ wch: i < 2 ? 12 : 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "트렌드");
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}
