/* 키워드 검색량 — 모바일 앱 화면 */
/* global Chart */
import { APP_NAME, APP_VERSION, UPDATE_URL, VERSION_CODE } from "./config.js";
import * as db from "./db.js";
import { readKeywordsFile, resultsWorkbookBase64, safeName, trendWorkbookBase64 } from "./excel.js";
import { KeywordJob, dedupe, runningJob } from "./jobs.js";
import { ApiError, OpenApiClient, SearchAdClient, saturationGrade, todayStr } from "./naver.js";
import { copyText, http, isNative, onBackButton, openExternal, shareFile } from "./platform.js";
import { runTrend } from "./trends.js";

// ------------------------------------------------------------------ 공통
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "—"
  : Number(n).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }));
const cssv = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SECRET = ["ad_api_key", "ad_secret", "dev_client_secret"];
const mask = (v) => (!v ? "" : v.length <= 8 ? "•".repeat(v.length) : v.slice(0, 4) + "••••••" + v.slice(-3));

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function notice(el, msg, kind = "") {
  el.className = "notice" + (kind ? " " + kind : "");
  el.textContent = msg || ""; el.hidden = !msg;
}
const errMsg = (e) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

let cfg = {};
const hasAdKeys = () => !!(cfg.ad_api_key && cfg.ad_secret && cfg.ad_customer_id);
const hasDevKeys = () => !!(cfg.dev_client_id && cfg.dev_client_secret);

document.addEventListener("click", (e) => {
  const ext = e.target.closest("[data-ext]");
  if (ext) { e.preventDefault(); openExternal(ext.dataset.ext); }
  const go = e.target.closest("[data-goto]");
  if (go) showView(go.dataset.goto);
});

// ------------------------------------------------------------------ 첫 실행
async function testAd(c) {
  const items = await new SearchAdClient({ ...c, ad_delay: 0.1 }).keywordstool(["네이버"]);
  return `연결 성공 — 연관 키워드 ${items.length}개 수신`;
}
async function testOpen(c) {
  const oc = new OpenApiClient({ ...c, blog_delay: 0.05 });
  const out = [];
  let ok = true;
  try { const d = await oc.blogSearch("네이버", 1, "sim"); out.push(`블로그 검색 성공 (문서 ${fmt(d.total)}건)`); } catch (e) { ok = false; out.push(e.message); }
  try {
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const s = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    await oc.datalab({ startDate: s, endDate: y, timeUnit: "date", keywordGroups: [{ groupName: "네이버", keywords: ["네이버"] }] });
    out.push("데이터랩 성공");
  } catch (e) { ok = false; out.push(e.message); }
  return { ok, message: out.join(" / ") };
}
const formVals = (form) => Object.fromEntries([...form.elements].filter((x) => x.name).map((x) => [x.name, x.value.trim()]));

function startOnboarding() {
  $("#onboard").hidden = false; $("#shell").hidden = true;
  $("#obStep1").hidden = false; $("#obStep2").hidden = true;
}
$("#obAdForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = formVals(e.target), m = $("#obAdMsg"), btn = e.submitter || $("#obAdForm .btn.primary");
  m.className = "msg"; m.textContent = "확인 중…"; btn.disabled = true;
  try {
    m.textContent = await testAd({ ...cfg, ...v });
    m.className = "msg ok";
    cfg = await db.saveConfig(v);
    $("#obStep1").hidden = true; $("#obStep2").hidden = false; window.scrollTo(0, 0);
  } catch (err) { m.className = "msg bad"; m.textContent = errMsg(err); }
  finally { btn.disabled = false; }
});
$("#obDevForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = formVals(e.target), m = $("#obDevMsg");
  if (!v.dev_client_id || !v.dev_client_secret) { m.className = "msg bad"; m.textContent = "두 칸을 모두 넣거나 [건너뛰고 시작]을 누르세요."; return; }
  m.className = "msg"; m.textContent = "확인 중…";
  try {
    const r = await testOpen({ ...cfg, ...v });
    m.className = "msg " + (r.ok ? "ok" : "bad"); m.textContent = r.message;
    if (!r.ok) return;
    cfg = await db.saveConfig(v);
    finishOnboarding();
  } catch (err) { m.className = "msg bad"; m.textContent = errMsg(err); }
});
$("#obSkip").addEventListener("click", finishOnboarding);
function finishOnboarding() {
  $("#onboard").hidden = true; $("#shell").hidden = false;
  $("#qBlog").checked = hasDevKeys();
  showView("search"); toast("준비 완료! 키워드를 검색해 보세요.");
}

// ------------------------------------------------------------------ 화면 전환
const TITLES = { search: "조회", trend: "트렌드", history: "기록", settings: "설정" };
let currentView = "search";
function showView(name) {
  currentView = name;
  $$(".tab").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === "v-" + name));
  $("#viewTitle").textContent = TITLES[name];
  if (name !== "search") exitSelect();
  if (name === "history") loadRuns();
  if (name === "settings") fillSettings();
  if (name === "search") loadRecent();
  const kb = $("#keyBanner");
  if (name === "trend" && !hasDevKeys()) { $("#keyBannerText").textContent = "트렌드는 개발자센터 키가 있어야 볼 수 있습니다."; kb.hidden = false; }
  else kb.hidden = true;
  updateJobChip();
  window.scrollTo(0, 0);
}
$$(".tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

// ------------------------------------------------------------------ 조회 작업
let job = null;
function updateJobChip() {
  const j = runningJob();
  $("#jobChip").hidden = !(j && currentView !== "search");
  if (j) $("#jobChipText").textContent = j.total ? `${j.done}/${j.total}` : "";
}
$("#jobChip").addEventListener("click", () => showView("search"));

function renderJob(j) {
  const running = j.status === "running";
  $("#progress").hidden = !running;
  $("#qBtn").disabled = running; $("#bulkStart").disabled = running;
  $("#progPhase").textContent = j.phase;
  $("#progText").textContent = `${fmt(j.done)} / ${fmt(j.total)} · ${Math.round((Date.now() - j.started) / 1000)}초`;
  $("#progBar").style.width = j.total ? `${((j.done / j.total) * 100).toFixed(1)}%` : "0";
  updateJobChip();
}

async function startJob(keywords, options) {
  if (!hasAdKeys()) { toast("먼저 [설정]에서 검색광고 API 키를 넣어주세요."); showView("settings"); return; }
  notice($("#notice"), "");
  try {
    job = new KeywordJob(keywords, options, cfg, renderJob);
    await job.start();
  } catch (e) { notice($("#notice"), errMsg(e), "error"); return; }
  renderJob(job);
  $("#resultArea").hidden = true; $("#home").hidden = true;
  const j = await job.promise;
  renderJob(j);
  const msg = [j.status === "done" && options.quick ? "" : j.message, ...j.warnings].filter(Boolean).join("\n");
  notice($("#notice"), msg, j.status === "error" ? "error" : j.warnings.length ? "" : "ok");
  if (j.runId) await openRun(j.runId);
  loadRecent();
}

$("#quickForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) { $("#q").focus(); return; }
  $("#q").blur();
  const rel = Number($("#qRel").value);
  startJob([q], { quick: true, expand: rel > 0, related_limit: rel, related_min: 0, blog: $("#qBlog").checked, title: q });
});
$("#cancelBtn").addEventListener("click", () => { const j = runningJob(); if (j) j.cancel(); });

// 일괄 입력
const kwInput = $("#kwInput");
const parseKeywords = () => dedupe(kwInput.value.split(/\n|,/));
function refreshEstimate() {
  const n = parseKeywords().length;
  $("#kwCount").textContent = `${fmt(n)}개`;
  if (!n) { $("#callEstimate").textContent = ""; return; }
  const expand = $("#bExpand").checked, blog = $("#bBlog").checked, lim = Number($("#bRelLimit").value || 0);
  const adCalls = expand ? n : Math.ceil(n / 5);
  const kwTotal = expand ? (lim > 0 ? n + n * lim : null) : n;
  const sec = adCalls * (Number(cfg.ad_delay) || 0.35) + (blog && kwTotal ? kwTotal * ((Number(cfg.blog_delay) || 0.12) + 0.2) : 0);
  $("#callEstimate").textContent = `검색광고 API ${fmt(adCalls)}회` + (blog ? (kwTotal ? `, 블로그 검색 최대 ${fmt(kwTotal)}회` : ", 블로그 검색 키워드 수만큼") : "")
    + ` · 예상 ${sec < 60 ? Math.max(1, Math.round(sec)) + "초" : Math.round(sec / 60) + "분"}`;
}
["input", "change"].forEach((ev) => [kwInput, $("#bExpand"), $("#bBlog"), $("#bRelLimit")].forEach((el) => el.addEventListener(ev, refreshEstimate)));
$("#bulkToggle").addEventListener("click", () => {
  const b = $("#bulk"); b.hidden = !b.hidden;
  $("#bulkToggle").setAttribute("aria-expanded", String(!b.hidden));
  $("#bulkToggle").textContent = b.hidden ? "여러 개 한 번에" : "접기";
  if (!b.hidden) { $("#bBlog").checked = hasDevKeys(); refreshEstimate(); }
});
$("#clearKw").addEventListener("click", () => { kwInput.value = ""; refreshEstimate(); });
$("#fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const kws = await readKeywordsFile(f);
    if (!kws.length) { toast("파일에서 키워드를 찾지 못했습니다."); return; }
    kwInput.value = (kwInput.value.trim() ? kwInput.value.trim() + "\n" : "") + kws.join("\n");
    refreshEstimate(); toast(`${fmt(kws.length)}개 키워드를 불러왔습니다.`);
  } catch (err) { toast(errMsg(err)); }
});
$("#bulkStart").addEventListener("click", () => {
  const kws = parseKeywords();
  if (!kws.length) { toast("키워드를 한 개 이상 입력하세요."); return; }
  $("#bulk").hidden = true; $("#bulkToggle").textContent = "여러 개 한 번에"; $("#bulkToggle").setAttribute("aria-expanded", "false");
  startJob(kws, {
    expand: $("#bExpand").checked, related_limit: Number($("#bRelLimit").value || 0),
    related_min: Number($("#bRelMin").value || 0), blog: $("#bBlog").checked, title: $("#bTitle").value.trim(),
  });
});

// ------------------------------------------------------------------ 결과
const PAGE = 100;
const COMP = { "낮음": 1, "중간": 2, "높음": 3 };
let run = null, rows = [], heroRow = null, listRows = [], viewRows = [], shown = PAGE;
let sort = "total:-1";
const filters = { text: "", source: "", comp: "", min: null, max: null, sat: null, hideErr: false };
const selected = new Set(), opened = new Set();
let selectMode = false;

async function openRun(id) {
  run = await db.getRun(id);
  if (!run) { toast("기록을 찾을 수 없습니다."); return; }
  rows = await db.getResults(id);
  selected.clear(); opened.clear(); shown = PAGE; exitSelect();
  Object.assign(filters, { text: "", source: "", comp: "", min: null, max: null, sat: null, hideErr: false });
  const quick = run.options && run.options.quick;
  if (quick) {
    heroRow = rows.find((r) => r.source === "seed") || null;
    listRows = rows.filter((r) => r !== heroRow);
    sort = "total:-1";
    $("#listTitle").textContent = listRows.length ? "연관 키워드" : "";
  } else {
    heroRow = null; listRows = rows; sort = "order:1";
    $("#listTitle").textContent = run.title || "결과";
  }
  $("#sortSel").value = sort;
  renderHero(quick);
  $("#resultArea").hidden = false; $("#home").hidden = true;
  applyFilters();
  if (currentView !== "search") showView("search");
}

function splitBar(r) {
  const pc = r.pc_lt10 ? 5 : r.pc || 0, mo = r.mobile_lt10 ? 5 : r.mobile || 0;
  const t = pc + mo;
  return `<div class="split" aria-hidden="true"><i style="width:${t ? ((pc / t) * 100).toFixed(1) : 0}%"></i></div>`;
}
const cnt = (v, lt) => (lt ? "&lt;10" : fmt(v));
function totalLabel(r) {
  if (r.total === null || r.total === undefined) return "—";
  if (r.pc_lt10 && r.mobile_lt10) return "&lt;20";
  return (r.pc_lt10 || r.mobile_lt10 ? "≈" : "") + fmt(r.total);
}
function chips(r) {
  const out = [];
  if (r.comp) out.push(`<span class="chip c-${esc(r.comp)}">경쟁 ${esc(r.comp)}</span>`);
  const g = saturationGrade(r.saturation);
  if (g) out.push(`<span class="chip g${g[0]}"><i></i>포화 ${fmt(r.saturation, 1)}% · ${g[1]}</span>`);
  if (r.total && r.mobile !== null && r.mobile !== undefined) out.push(`<span class="chip">모바일 ${fmt((r.mobile / r.total) * 100)}%</span>`);
  return `<div class="chips-row">${out.join("")}</div>`;
}
function detail(r) {
  const items = [
    ["PC 검색수", cnt(r.pc, r.pc_lt10)], ["모바일 검색수", cnt(r.mobile, r.mobile_lt10)],
    ["월 클릭 PC/모바일", r.pc_clk === null && r.mobile_clk === null ? "—" : `${fmt(r.pc_clk, 1)} / ${fmt(r.mobile_clk, 1)}`],
    ["클릭률 PC/모바일", r.pc_ctr === null && r.mobile_ctr === null ? "—" : `${fmt(r.pc_ctr, 2)} / ${fmt(r.mobile_ctr, 2)}%`],
    ["월평균 광고수", fmt(r.ad_depth)],
  ];
  if (r.blog_total !== null && r.blog_total !== undefined) {
    items.push(["블로그 문서", fmt(r.blog_total)], ["블로그 월 발행량", (r.blog_month_estimated ? "≈" : "") + fmt(r.blog_month)]);
  }
  if (r.api_keyword) items.push(["API 응답 키워드", esc(r.api_keyword)]);
  return `<dl class="detail">${items.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>`;
}
function noteHtml(r) {
  if (r.error) return `<span class="note err">${esc(r.error)}</span>`;
  return r.note ? `<span class="note">${esc(r.note)}</span>` : "";
}

function renderHero(quick) {
  const h = $("#hero");
  if (quick && heroRow) {
    const r = heroRow;
    h.innerHTML = `<article class="hero">
      <div class="h-top"><span class="h-name">${esc(r.keyword)}</span><span class="hint">${esc(run.created_at.slice(5, 16))}</span></div>
      <div class="h-num">${r.error ? "—" : totalLabel(r)}</div>
      <div class="h-label">월간 검색수 · 최근 30일</div>
      ${r.error ? "" : splitBar(r) + `<div class="split-legend"><span>PC <b>${cnt(r.pc, r.pc_lt10)}</b></span><span>모바일 <b>${cnt(r.mobile, r.mobile_lt10)}</b></span></div>` + chips(r)}
      ${noteHtml(r)}
      ${r.error ? "" : detail(r)}
      <div class="h-actions"><button class="btn small" data-hero="trend">트렌드 보기</button><button class="btn small ghost" data-hero="copy">복사</button></div>
    </article>`;
  } else {
    const seeds = rows.filter((r) => r.source === "seed").length, errs = rows.filter((r) => r.error).length;
    h.innerHTML = `<article class="hero summary">
      <div class="h-top"><span class="h-name">${esc(run.title)}</span></div>
      <div class="h-num">${fmt(rows.length)}개</div>
      <div class="h-label">${esc(run.created_at)} · 입력 ${fmt(seeds)} · 연관 ${fmt(rows.length - seeds)}${errs ? ` · 오류 ${fmt(errs)}` : ""}</div>
    </article>`;
  }
}
$("#hero").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-hero]");
  if (!b || !heroRow) return;
  if (b.dataset.hero === "trend") { setGroups([[heroRow.keyword]]); showView("trend"); doTrend(); }
  if (b.dataset.hero === "copy") {
    const r = heroRow;
    await copyText(`${r.keyword}\t월간 ${r.total ?? "-"}\tPC ${r.pc_lt10 ? "<10" : r.pc ?? "-"}\t모바일 ${r.mobile_lt10 ? "<10" : r.mobile ?? "-"}\t경쟁 ${r.comp ?? "-"}` + (r.saturation !== null ? `\t포화 ${r.saturation}%` : ""));
    toast("복사했습니다.");
  }
});

function sortVal(r, key) {
  switch (key) {
    case "keyword": return r.keyword;
    case "comp": return COMP[r.comp] ?? null;
    case "order": return r.id;
    default: return r[key];
  }
}
function applyFilters() {
  const t = filters.text.replace(/\s/g, "").toUpperCase();
  viewRows = listRows.filter((r) => {
    if (t && !r.keyword.replace(/\s/g, "").toUpperCase().includes(t)) return false;
    if (filters.source && r.source !== filters.source) return false;
    if (filters.comp && r.comp !== filters.comp) return false;
    if (filters.hideErr && r.error) return false;
    if (filters.min !== null && !(r.total >= filters.min)) return false;
    if (filters.max !== null && !(r.total <= filters.max)) return false;
    if (filters.sat !== null && !(r.saturation !== null && r.saturation !== undefined && r.saturation <= filters.sat)) return false;
    return true;
  });
  const [k, d] = sort.split(":"), dir = Number(d);
  viewRows.sort((a, b) => {
    const x = sortVal(a, k), y = sortVal(b, k);
    const xn = x === null || x === undefined, yn = y === null || y === undefined;
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
    return (typeof x === "string" ? x.localeCompare(y, "ko") : x - y) * dir;
  });
  const active = ["text", "source", "comp"].filter((f) => filters[f]).length + ["min", "max", "sat"].filter((f) => filters[f] !== null).length + (filters.hideErr ? 1 : 0);
  $("#filterCount").textContent = active ? ` ${active}` : "";
  $("#listMeta").textContent = listRows.length ? `${fmt(viewRows.length)} / ${fmt(listRows.length)}개` : "";
  $("#listHead").hidden = !listRows.length;
  renderCards();
}
function renderCards() {
  const html = viewRows.slice(0, shown).map((r) => {
    const cls = ["kcard", r.error ? "err" : "", (r.note || "").startsWith("확인 필요") ? "warn" : "",
      selected.has(r.id) ? "sel" : "", opened.has(r.id) ? "open" : ""].filter(Boolean).join(" ");
    const sub = r.source === "related" && r.seed && !(run.options && run.options.quick) ? `<small>${esc(r.seed)}에서</small>` : "";
    return `<article class="${cls}" data-id="${r.id}" tabindex="0">
      <div class="k-main"><span class="k-name">${esc(r.keyword)}${sub}</span><span class="k-total">${r.error ? "—" : totalLabel(r)}</span></div>
      ${r.error ? "" : splitBar(r) + chips(r)}${noteHtml(r)}${r.error ? "" : detail(r)}
    </article>`;
  }).join("");
  $("#cards").innerHTML = html || (listRows.length ? `<p class="empty">조건에 맞는 키워드가 없습니다. 필터를 줄여보세요.</p>` : "");
  $("#moreBtn").hidden = viewRows.length <= shown;
  $("#moreBtn").textContent = `더 보기 (${fmt(viewRows.length - shown)}개 남음)`;
}
$("#moreBtn").addEventListener("click", () => { shown += PAGE; renderCards(); });
$("#sortSel").addEventListener("change", (e) => { sort = e.target.value; shown = PAGE; applyFilters(); });

// 카드: 탭 = 펼치기 / 선택, 길게 누르기 = 선택 모드
let pressTimer = null, pressed = null, longPressed = false;
const cardsEl = $("#cards");
cardsEl.addEventListener("pointerdown", (e) => {
  const c = e.target.closest(".kcard"); if (!c) return;
  pressed = c; longPressed = false;
  pressTimer = setTimeout(() => { longPressed = true; enterSelect(); toggleSelect(+c.dataset.id, c); if (navigator.vibrate) navigator.vibrate(15); }, 480);
});
["pointerup", "pointercancel", "pointerleave"].forEach((ev) => cardsEl.addEventListener(ev, () => clearTimeout(pressTimer)));
cardsEl.addEventListener("pointermove", (e) => { if (Math.abs(e.movementY) > 3 || Math.abs(e.movementX) > 3) clearTimeout(pressTimer); });
cardsEl.addEventListener("contextmenu", (e) => { if (e.target.closest(".kcard")) e.preventDefault(); });
cardsEl.addEventListener("click", (e) => {
  const c = e.target.closest(".kcard"); if (!c) return;
  if (longPressed) { longPressed = false; return; }
  const id = +c.dataset.id;
  if (selectMode) { toggleSelect(id, c); return; }
  opened.has(id) ? opened.delete(id) : opened.add(id);
  c.classList.toggle("open");
});
cardsEl.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("kcard")) { e.preventDefault(); e.target.click(); } });

function enterSelect() { selectMode = true; cardsEl.classList.add("select-mode"); $("#selBar").hidden = false; updateSel(); }
function exitSelect() { selectMode = false; selected.clear(); cardsEl.classList.remove("select-mode"); $("#selBar").hidden = true; $$(".kcard.sel").forEach((c) => c.classList.remove("sel")); }
function toggleSelect(id, el) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  if (el) el.classList.toggle("sel", selected.has(id));
  updateSel();
}
function updateSel() {
  $("#selCount").textContent = `${selected.size}개 선택` + (selected.size > 5 ? " (트렌드는 앞 5개)" : "");
  $("#selTrend").disabled = !selected.size; $("#selCopy").disabled = !selected.size;
}
$("#selectMode").addEventListener("click", () => (selectMode ? exitSelect() : enterSelect()));
$("#selCancel").addEventListener("click", exitSelect);
const selRows = () => rows.filter((r) => selected.has(r.id));
$("#selTrend").addEventListener("click", () => {
  const kws = selRows().slice(0, 5).map((r) => [r.keyword]);
  exitSelect(); setGroups(kws); showView("trend"); doTrend();
});
$("#selCopy").addEventListener("click", async () => {
  const lines = selRows().map((r) => [r.keyword, r.pc_lt10 ? "<10" : r.pc ?? "", r.mobile_lt10 ? "<10" : r.mobile ?? "", r.total ?? "", r.comp ?? "", r.saturation ?? ""].join("\t"));
  await copyText(["키워드\tPC\t모바일\t합계\t경쟁\t포화지수", ...lines].join("\n"));
  toast(`${lines.length}개를 복사했습니다. 엑셀·메모에 붙여넣을 수 있습니다.`);
  exitSelect();
});

$("#shareXlsx").addEventListener("click", async () => {
  if (!run) return;
  const filtered = viewRows.length !== listRows.length;
  const out = (heroRow ? [heroRow] : []).concat(filtered ? viewRows : listRows);
  try {
    await shareFile(`${safeName(run.title)}_${run.created_at.slice(0, 10)}.xlsx`, {
      base64: resultsWorkbookBase64(run, out), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", title: "엑셀 공유·저장",
    });
    if (filtered) toast("필터에 맞는 결과만 담았습니다.");
  } catch (e) { if (!/cancel/i.test(errMsg(e))) toast("공유하지 못했습니다: " + errMsg(e)); }
});

// 필터 시트
function openSheet(id) { $("#backdrop").hidden = false; $(id).hidden = false; }
function closeSheets() { $("#backdrop").hidden = true; $$(".sheet").forEach((s) => { s.hidden = true; }); }
$("#backdrop").addEventListener("click", closeSheets);
$("#filterBtn").addEventListener("click", () => {
  $("#fText").value = filters.text; $("#fSource").value = filters.source; $("#fComp").value = filters.comp;
  $("#fMin").value = filters.min ?? ""; $("#fMax").value = filters.max ?? ""; $("#fSat").value = filters.sat ?? ""; $("#fHideErr").checked = filters.hideErr;
  openSheet("#filterSheet");
});
const numOrNull = (v) => (v === "" ? null : Number(v));
$("#fApply").addEventListener("click", () => {
  Object.assign(filters, {
    text: $("#fText").value.trim(), source: $("#fSource").value, comp: $("#fComp").value,
    min: numOrNull($("#fMin").value), max: numOrNull($("#fMax").value), sat: numOrNull($("#fSat").value), hideErr: $("#fHideErr").checked,
  });
  shown = PAGE; closeSheets(); applyFilters();
});
$("#fReset").addEventListener("click", () => {
  Object.assign(filters, { text: "", source: "", comp: "", min: null, max: null, sat: null, hideErr: false });
  shown = PAGE; closeSheets(); applyFilters();
});

// 최근 조회 (홈)
async function loadRecent() {
  if (!$("#resultArea").hidden || runningJob()) return;
  const runs = (await db.listRuns()).slice(0, 10);
  $("#recentWrap").hidden = !runs.length;
  $("#recentList").innerHTML = runs.map((r) => `<button data-run="${r.id}">${esc(r.title)}</button>`).join("");
}
$("#recentList").addEventListener("click", (e) => { const b = e.target.closest("[data-run]"); if (b) openRun(+b.dataset.run); });

// ------------------------------------------------------------------ 트렌드
const SERIES = ["--c1", "--c2", "--c3", "--c4", "--c5"];
const AGES = ["0–12", "13–18", "19–24", "25–29", "30–34", "35–39", "40–44", "45–49", "50–54", "55–59", "60+"];
$("#tAges").innerHTML = AGES.map((a, i) => `<label><input type="checkbox" value="${i + 1}">${a}</label>`).join("");
function setGroups(list = []) {
  $("#groups").innerHTML = SERIES.map((c, i) => `<div class="group"><span class="dot" style="background:var(${c})"></span>
    <input type="text" class="gkws" placeholder="${i === 0 ? "키워드 (예: 캠핑의자, 캠핑 체어)" : "비교할 키워드"}" value="${esc((list[i] || []).join(", "))}" aria-label="비교 ${i + 1}"></div>`).join("");
}
setGroups();
let tDays = 365, tUnit = "month", tView = "estimate", trendData = null, trendChart = null;
$("#tPreset").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#tPreset button").forEach((x) => x.classList.toggle("on", x === b));
  tDays = Number(b.dataset.days); $("#tStart").value = ""; $("#tEnd").value = "";
  if (tDays <= 30) setUnit("date"); else if (tDays <= 90) setUnit("week"); else setUnit("month");
});
function setUnit(u) { tUnit = u; $$("#tUnit button").forEach((x) => x.classList.toggle("on", x.dataset.v === u)); }
$("#tUnit").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setUnit(b.dataset.v); });
$("#tView").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.disabled) { tView = b.dataset.v; drawTrend(); } });

async function doTrend() {
  const groups = $$("#groups .gkws").map((i) => i.value.split(",").map((s) => s.trim()).filter(Boolean)).filter((g) => g.length).map((k) => ({ name: k[0], keywords: k }));
  if (!groups.length) { toast("키워드를 한 개 이상 입력하세요."); return; }
  if (!hasDevKeys()) { notice($("#trendNotice"), "트렌드는 개발자센터 키가 필요합니다. [설정]에서 넣어주세요.", "error"); return; }
  let start, end;
  if ($("#tStart").value && $("#tEnd").value) { start = $("#tStart").value; end = $("#tEnd").value; }
  else {
    const y = new Date(); y.setDate(y.getDate() - 1);
    end = todayLocal(y); const s = new Date(y); s.setDate(s.getDate() - (tDays - 1)); start = todayLocal(s);
  }
  const btn = $("#trendBtn"); btn.disabled = true; btn.textContent = "불러오는 중…";
  notice($("#trendNotice"), "");
  try {
    trendData = await runTrend(cfg, {
      groups, start, end, unit: tUnit, device: $("#tDevice").value, gender: $("#tGender").value,
      ages: $$("#tAges input:checked").map((i) => i.value), estimate: $("#tEstimate").checked && hasAdKeys(),
    });
    const canEst = trendData.estimate && trendData.series.some((s) => s.estimate);
    tView = canEst ? "estimate" : "ratio";
    $("#tView [data-v=estimate]").disabled = !canEst;
    const missing = trendData.estimate ? trendData.series.filter((s) => !s.estimate).map((s) => s.name) : [];
    notice($("#trendNotice"), [trendData.note, missing.length ? `검색수를 찾지 못해 환산하지 못한 키워드: ${missing.join(", ")}` : ""].filter(Boolean).join("\n"));
    $("#trendResult").hidden = false;
    drawTrend();
    $("#trendResult").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { notice($("#trendNotice"), errMsg(e), "error"); }
  finally { btn.disabled = false; btn.textContent = "트렌드 보기"; }
}
function todayLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
$("#trendBtn").addEventListener("click", doTrend);

function drawTrend() {
  const t = trendData; if (!t) return;
  const est = tView === "estimate";
  $$("#tView button").forEach((b) => b.classList.toggle("on", b.dataset.v === tView));
  $("#trendMeta").textContent = `${t.start} ~ ${t.end} · ${{ date: "일", week: "주", month: "월" }[t.unit]} 단위 · ${est ? "추정 검색수" : "최고 구간 = 100"}`;
  const lab = (k) => (t.unit === "month" ? k.slice(2).replace("-", ".") : k.slice(5).replace("-", "."));
  if (trendChart) trendChart.destroy();
  trendChart = new Chart($("#trendChart"), {
    type: "line",
    data: {
      labels: t.labels.map(lab),
      datasets: t.series.map((s, i) => ({
        label: s.name, data: est ? s.estimate || [] : s.ratio, borderColor: cssv(SERIES[i]), backgroundColor: cssv(SERIES[i]),
        borderWidth: 2, tension: 0.25, pointRadius: t.labels.length > 40 ? 0 : 2, pointHitRadius: 12,
        segment: { borderDash: (c) => (!t.complete[c.p0DataIndex] || !t.complete[c.p1DataIndex] ? [5, 4] : undefined) },
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: cssv("--ink"), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y, est ? 0 : 1)}${t.complete[c.dataIndex] ? "" : " (일부)"}` } },
      },
      scales: {
        x: { ticks: { color: cssv("--muted"), maxRotation: 0, autoSkipPadding: 10, font: { size: 11 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: cssv("--muted"), font: { size: 11 }, callback: (v) => (v >= 10000 ? fmt(v / 10000, 1) + "만" : fmt(v)) }, grid: { color: cssv("--line") } },
      },
    },
  });
  $("#trendTable thead").innerHTML = `<tr><th>구간</th>${t.series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>`;
  $("#trendTable tbody").innerHTML = t.labels.map((_, j) => j).reverse().map((j) => `<tr><td>${esc(t.labels[j])}${t.complete[j] ? "" : " (일부)"}</td>`
    + t.series.map((s) => `<td>${est ? (s.estimate ? fmt(s.estimate[j]) : "—") : fmt(s.ratio[j], 1)}</td>`).join("") + "</tr>").join("");
}
$("#trendShare").addEventListener("click", async () => {
  if (!trendData) return;
  try {
    await shareFile(`트렌드_${trendData.start}_${trendData.end}.xlsx`, { base64: trendWorkbookBase64(trendData), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", title: "트렌드 공유" });
  } catch (e) { if (!/cancel/i.test(errMsg(e))) toast("공유하지 못했습니다: " + errMsg(e)); }
});

// ------------------------------------------------------------------ 기록
const ST = { done: "완료", error: "오류", cancelled: "중지됨", running: "진행 중" };
async function loadRuns() {
  const list = await db.listRuns();
  $("#runsEmpty").hidden = list.length > 0;
  $("#runList").innerHTML = list.map((r) => {
    const o = r.options || {};
    const opts = [o.quick ? "빠른 조회" : "일괄", o.expand ? `연관 ${o.related_limit ? "≤" + o.related_limit : "전체"}` : "", o.blog ? "포화도" : ""].filter(Boolean).join(" · ");
    return `<article class="run" data-run="${r.id}">
      <div class="r-top"><span class="r-title">${esc(r.title)}</span><span class="st-${esc(r.status)}">${ST[r.status] || esc(r.status)}</span></div>
      <div class="r-meta">${esc(r.created_at)} · 결과 ${fmt(r.result_count)}개 · ${esc(opts)}</div>
      <div class="r-actions"><button class="btn small" data-open="${r.id}">열기</button><button class="btn small ghost" data-xlsx="${r.id}">엑셀 공유</button><button class="btn small ghost" data-del="${r.id}">삭제</button></div>
    </article>`;
  }).join("");
}
$("#runList").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]"), x = e.target.closest("[data-xlsx]"), d = e.target.closest("[data-del]");
  if (o) return openRun(+o.dataset.open);
  if (x) {
    const r = await db.getRun(+x.dataset.xlsx), res = await db.getResults(r.id);
    try { await shareFile(`${safeName(r.title)}_${r.created_at.slice(0, 10)}.xlsx`, { base64: resultsWorkbookBase64(r, res), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", title: "엑셀 공유·저장" }); }
    catch (err) { if (!/cancel/i.test(errMsg(err))) toast("공유하지 못했습니다: " + errMsg(err)); }
    return;
  }
  if (d) {
    const j = runningJob();
    if (j && j.runId === +d.dataset.del) { toast("진행 중인 조회는 삭제할 수 없습니다."); return; }
    if (!confirm("이 조회 기록을 삭제할까요? 되돌릴 수 없습니다.")) return;
    await db.deleteRun(+d.dataset.del);
    if (run && run.id === +d.dataset.del) { run = null; $("#resultArea").hidden = true; $("#home").hidden = false; }
    loadRuns(); toast("삭제했습니다.");
    return;
  }
  const card = e.target.closest(".run");
  if (card && !e.target.closest("button")) openRun(+card.dataset.run);
});
let histChart = null;
$("#histForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kw = $("#histKw").value.trim(); if (!kw) return;
  $("#histKw").blur();
  const list = await db.keywordHistory(kw);
  $("#histResult").hidden = !list.length; $("#histEmpty").hidden = !!list.length;
  $("#histEmpty").textContent = `‘${kw}’ 조회 기록이 없습니다.`;
  if (!list.length) return;
  $("#histTitle").textContent = `${kw} · ${list.length}번 조회`;
  $("#histTable thead").innerHTML = "<tr><th>조회 시각</th><th>PC</th><th>모바일</th><th>합계</th><th>포화</th></tr>";
  $("#histTable tbody").innerHTML = list.slice().reverse().map((r) => `<tr><td>${esc(r.created_at.slice(2, 16))}</td><td>${cnt(r.pc, r.pc_lt10)}</td><td>${cnt(r.mobile, r.mobile_lt10)}</td><td>${fmt(r.total)}</td><td>${r.saturation === null || r.saturation === undefined ? "—" : fmt(r.saturation, 1) + "%"}</td></tr>`).join("");
  if (histChart) histChart.destroy();
  histChart = new Chart($("#histChart"), {
    type: "line",
    data: { labels: list.map((r) => r.created_at.slice(5, 10)), datasets: [{ data: list.map((r) => r.total), borderColor: cssv("--c1"), backgroundColor: cssv("--c1"), tension: 0.2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: cssv("--muted") }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: cssv("--muted"), callback: (v) => fmt(v) }, grid: { color: cssv("--line") } } } },
  });
});

// ------------------------------------------------------------------ 설정
function fillSettings() {
  const f = $("#cfgForm");
  for (const k of ["ad_customer_id", "dev_client_id", "ad_delay", "blog_delay"]) f.elements[k].value = cfg[k] ?? "";
  for (const k of SECRET) { f.elements[k].value = ""; f.elements[k].placeholder = cfg[k] ? `저장됨 ${mask(cfg[k])} · 바꿀 때만 입력` : "입력하세요"; }
  $("#appInfo").textContent = `${APP_NAME} ${APP_VERSION} (${VERSION_CODE})${isNative ? "" : " · 브라우저 미리보기"}`;
}
async function saveSettings() {
  const f = $("#cfgForm"), up = {};
  for (const k of ["ad_customer_id", "dev_client_id"]) up[k] = f.elements[k].value.trim();
  for (const k of SECRET) { const v = f.elements[k].value.trim(); if (v) up[k] = v; }
  for (const [k, lo, hi] of [["ad_delay", 0.1, 5], ["blog_delay", 0.05, 5]]) {
    const v = Number(f.elements[k].value);
    if (Number.isFinite(v) && f.elements[k].value !== "") up[k] = Math.min(hi, Math.max(lo, v));
  }
  cfg = await db.saveConfig(up);
  fillSettings();
}
$("#cfgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await saveSettings(); $("#saveMsg").className = "msg center ok"; $("#saveMsg").textContent = "저장했습니다."; }
  catch (err) { $("#saveMsg").className = "msg center bad"; $("#saveMsg").textContent = errMsg(err); }
});
$("#testAd").addEventListener("click", async () => {
  const m = $("#testAdMsg"); m.className = "msg"; m.textContent = "확인 중…";
  try { await saveSettings(); m.textContent = await testAd(cfg); m.className = "msg ok"; } catch (err) { m.className = "msg bad"; m.textContent = errMsg(err); }
});
$("#testOpen").addEventListener("click", async () => {
  const m = $("#testOpenMsg"); m.className = "msg"; m.textContent = "확인 중…";
  try { await saveSettings(); const r = await testOpen(cfg); m.className = "msg " + (r.ok ? "ok" : "bad"); m.textContent = r.message; }
  catch (err) { m.className = "msg bad"; m.textContent = errMsg(err); }
});

let diagText = "";
$("#diagForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kw = $("#diagKw").value;
  if (!kw.trim()) { toast("진단할 키워드를 입력하세요."); return; }
  const btn = $("#diagBtn"); btn.disabled = true; btn.textContent = "조회 중…";
  $("#diagOut").hidden = false;
  try {
    const d = await new SearchAdClient({ ...cfg, ad_delay: 0.1 }).diagnose(kw);
    const c = d.chosen, v = (x) => (x === undefined || x === null ? "—" : String(x));
    const hidden = d.input_codepoints.filter((u) => /^U\+(200[B-F]|FEFF|00AD|2060|00A0|3000)$/.test(u));
    const rowsD = [
      ["입력 글자", `${esc(d.input)} <span class="hint">${d.input_codepoints.join(" ")}</span>` + (hidden.length ? ` <span class="bad">숨은 문자 ${hidden.join(", ")}</span>` : "")],
      ["보낸 키워드", esc(d.sent_hint)], ["요청 주소", esc(d.request_url)],
      ["응답 상태", d.status === 200 ? `<span class="good">200 정상</span>` : `<span class="bad">${d.status}</span>`],
      ["응답 항목", `${d.item_count}개` + (d.item_count ? (d.first_is_match ? " · 첫 항목 일치" : ` · <span class="bad">첫 항목 다름 (${esc(d.first_items[0] && d.first_items[0].relKeyword)})</span>`) : "")],
      ["일치 항목", d.matches.length ? `${d.matches.length}개` : `<span class="bad">없음</span>`],
      ["사용할 값", c ? `PC ${esc(v(c.monthlyPcQcCnt))} / 모바일 ${esc(v(c.monthlyMobileQcCnt))} / 경쟁 ${esc(v(c.compIdx))}` : "—"],
    ];
    $("#diagSum").innerHTML = rowsD.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
    $("#diagMatches").textContent = d.matches.length ? JSON.stringify(d.matches, null, 2) : "(일치 항목 없음)\n\n처음 항목:\n" + JSON.stringify(d.first_items, null, 2);
    $("#diagRaw").textContent = d.raw_text;
    diagText = [`[검색량 진단] ${d.input}`, `입력 글자: ${d.input_codepoints.join(" ")}`, `보낸 키워드: ${d.sent_hint}`, `요청 주소: ${d.request_url}`,
      `응답: ${d.status} / 항목 ${d.item_count}개 / 첫 항목 일치 ${d.first_is_match}`, `일치 항목: ${JSON.stringify(d.matches)}`, `처음 3개: ${JSON.stringify(d.first_items.slice(0, 3))}`].join("\n");
    $("#diagCopy").hidden = false;
  } catch (err) {
    $("#diagSum").innerHTML = `<dt>오류</dt><dd class="bad">${esc(errMsg(err))}</dd>` + (err.body ? `<dt>응답</dt><dd>${esc(err.body)}</dd>` : "");
    $("#diagMatches").textContent = ""; $("#diagRaw").textContent = ""; $("#diagCopy").hidden = true;
  } finally { btn.disabled = false; btn.textContent = "진단"; }
});
$("#diagCopy").addEventListener("click", async () => { await copyText(diagText); toast("진단 결과를 복사했습니다."); });

$("#backupBtn").addEventListener("click", async () => {
  try {
    const data = await db.exportBackup({ includeKeys: $("#bkKeys").checked });
    await shareFile(`키워드검색량_백업_${todayStr()}.json`, { text: JSON.stringify(data), mime: "application/json", title: "백업 파일 저장" });
  } catch (e) { if (!/cancel/i.test(errMsg(e))) toast("백업하지 못했습니다: " + errMsg(e)); }
});
$("#restoreInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const r = await db.importBackup(JSON.parse(await f.text()));
    if (r.config) cfg = await db.loadConfig();
    toast(`기록 ${r.added}개를 불러왔습니다${r.skipped ? ` (이미 있는 ${r.skipped}개 제외)` : ""}${r.config ? " · 키 포함" : ""}.`, 3500);
    fillSettings();
  } catch (err) { toast("불러오지 못했습니다: " + errMsg(err)); }
});

function showInfo(tplId) { $("#infoBody").innerHTML = $(tplId).innerHTML; openSheet("#infoSheet"); }
$("#guideBtn").addEventListener("click", () => showInfo("#guideTpl"));
$("#legendBtn").addEventListener("click", () => showInfo("#legendTpl"));
$("#infoClose").addEventListener("click", closeSheets);

// ------------------------------------------------------------------ 업데이트 확인
let updateInfo = null;
async function checkUpdate(manual = false) {
  if (!UPDATE_URL) { if (manual) toast("업데이트 확인 주소가 설정되지 않은 빌드입니다."); return; }
  try {
    const res = await http({ method: "GET", url: UPDATE_URL, timeout: 10000 });
    const v = res.data;
    if (res.status === 200 && v && Number(v.versionCode) > VERSION_CODE) {
      updateInfo = v;
      $("#updateText").textContent = `새 버전 ${v.versionName}이 있습니다.`;
      $("#updateBanner").hidden = false;
    } else if (manual) toast("최신 버전입니다.");
  } catch { if (manual) toast("업데이트를 확인하지 못했습니다."); }
}
$("#updateBtn").addEventListener("click", () => { if (updateInfo && updateInfo.url) openExternal(updateInfo.url); });
$("#updateCheck").addEventListener("click", () => checkUpdate(true));

// ------------------------------------------------------------------ 뒤로가기
onBackButton(() => {
  if ($$(".sheet").some((s) => !s.hidden)) { closeSheets(); return true; }
  if (!$("#onboard").hidden) { if (!$("#obStep2").hidden) { $("#obStep2").hidden = true; $("#obStep1").hidden = false; return true; } return false; }
  if (selectMode) { exitSelect(); return true; }
  if (currentView !== "search") { showView("search"); return true; }
  if (!$("#resultArea").hidden && !runningJob()) { $("#resultArea").hidden = true; $("#home").hidden = false; notice($("#notice"), ""); run = null; loadRecent(); return true; }
  return false;
});

// ------------------------------------------------------------------ 시작
(async () => {
  try { await db.recoverInterrupted(); } catch { /* 첫 실행 */ }
  cfg = await db.loadConfig();
  if (!hasAdKeys()) startOnboarding();
  else { $("#shell").hidden = false; $("#qBlog").checked = hasDevKeys(); showView("search"); }
  checkUpdate();
})();
