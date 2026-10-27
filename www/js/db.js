// 휴대폰 안 저장소 (IndexedDB): 설정, 조회 기록
import { DEFAULTS } from "./config.js";
import { matchKey } from "./naver.js";

const DB_NAME = "keyword-volume";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv", { keyPath: "k" });
      db.createObjectStore("runs", { keyPath: "id", autoIncrement: true });
      const r = db.createObjectStore("results", { keyPath: "id", autoIncrement: true });
      r.createIndex("run_id", "run_id");
      r.createIndex("kwkey", "kwkey");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function nowStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ------------------------------------------------------------------ 설정
export async function loadConfig() {
  const row = await tx(["kv"], "readonly", (t) => wrap(t.objectStore("kv").get("config")));
  return { ...DEFAULTS, ...((row && row.v) || {}) };
}
export async function saveConfig(updates) {
  const cfg = { ...(await loadConfig()), ...updates };
  await tx(["kv"], "readwrite", (t) => wrap(t.objectStore("kv").put({ k: "config", v: cfg })));
  return cfg;
}
export async function getKV(k, dflt = null) {
  const row = await tx(["kv"], "readonly", (t) => wrap(t.objectStore("kv").get(k)));
  return row ? row.v : dflt;
}
export const setKV = (k, v) => tx(["kv"], "readwrite", (t) => wrap(t.objectStore("kv").put({ k, v })));

// ------------------------------------------------------------------ 기록
export const createRun = (title, seedCount, options) =>
  tx(["runs"], "readwrite", (t) => wrap(t.objectStore("runs").add({
    created_at: nowStr(), title, seed_count: seedCount, result_count: 0, options, status: "running", message: "",
  })));

export async function insertResults(runId, rows) {
  if (!rows.length) return;
  await tx(["results"], "readwrite", (t) => {
    const s = t.objectStore("results");
    rows.forEach((r) => { const o = { ...r, run_id: runId, kwkey: matchKey(r.keyword) }; delete o.id; s.add(o); });
  });
}

export async function finishRun(runId, status, message = "") {
  await tx(["runs", "results"], "readwrite", async (t) => {
    const cnt = await wrap(t.objectStore("results").index("run_id").count(runId));
    const runs = t.objectStore("runs");
    const run = await wrap(runs.get(runId));
    if (run) { run.status = status; run.message = message; run.result_count = cnt; runs.put(run); }
  });
}

export async function listRuns() {
  const all = await tx(["runs"], "readonly", (t) => wrap(t.objectStore("runs").getAll()));
  return all.sort((a, b) => b.id - a.id);
}
export const getRun = (id) => tx(["runs"], "readonly", (t) => wrap(t.objectStore("runs").get(id)));

export async function getResults(runId) {
  const rows = await tx(["results"], "readonly", (t) => wrap(t.objectStore("results").index("run_id").getAll(runId)));
  return rows.sort((a, b) => (a.source === b.source ? a.id - b.id : a.source === "seed" ? -1 : 1));
}

export async function deleteRun(runId) {
  await tx(["runs", "results"], "readwrite", async (t) => {
    const ids = await wrap(t.objectStore("results").index("run_id").getAllKeys(runId));
    ids.forEach((id) => t.objectStore("results").delete(id));
    t.objectStore("runs").delete(runId);
  });
}

export async function keywordHistory(keyword) {
  const key = matchKey(keyword);
  return tx(["runs", "results"], "readonly", async (t) => {
    const rows = await wrap(t.objectStore("results").index("kwkey").getAll(key));
    const out = [];
    for (const r of rows) {
      if (r.error) continue;
      const run = await wrap(t.objectStore("runs").get(r.run_id));
      if (run) out.push({ ...r, created_at: run.created_at });
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  });
}

export async function recoverInterrupted() {
  const runs = await listRuns();
  for (const r of runs.filter((x) => x.status === "running")) await finishRun(r.id, "cancelled", "앱이 닫혀서 중단됨");
}

// ------------------------------------------------------------------ 백업·복원
export async function exportBackup({ includeKeys = false } = {}) {
  const runs = await listRuns();
  const results = await tx(["results"], "readonly", (t) => wrap(t.objectStore("results").getAll()));
  const out = { app: "keyword-volume", format: 1, exported_at: nowStr(), runs, results };
  if (includeKeys) out.config = await loadConfig();
  return out;
}

export async function importBackup(data) {
  if (!data || data.app !== "keyword-volume" || !Array.isArray(data.runs)) throw new Error("이 앱의 백업 파일이 아닙니다.");
  const existing = new Set((await listRuns()).map((r) => `${r.created_at}|${r.title}|${r.seed_count}`));
  let added = 0;
  for (const run of data.runs.slice().sort((a, b) => a.id - b.id)) {
    const sig = `${run.created_at}|${run.title}|${run.seed_count}`;
    if (existing.has(sig)) continue;
    const { id: oldId, ...rest } = run;
    const newId = await tx(["runs"], "readwrite", (t) => wrap(t.objectStore("runs").add(rest)));
    const rows = (data.results || []).filter((r) => r.run_id === oldId);
    await insertResults(newId, rows);
    added++;
  }
  if (data.config) await saveConfig(data.config);
  return { added, skipped: data.runs.length - added, config: !!data.config };
}
