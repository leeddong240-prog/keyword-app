// 네이티브(안드로이드) / 브라우저 공통 기능: HTTP, 파일 공유, 외부 링크, 뒤로가기
const Cap = window.Capacitor;
export const isNative = !!(Cap && typeof Cap.isNativePlatform === "function" && Cap.isNativePlatform());
const plugins = () => (Cap && Cap.Plugins) || {};

export class NetError extends Error {}

/**
 * HTTP 요청. 앱에서는 네이티브 HTTP(브라우저 CORS 제한 없음)를, 브라우저에서는 fetch 를 쓴다.
 * params 는 인코딩하지 않은 원래 값으로 넘긴다 (인코딩은 한 번만).
 * 반환: { status, data(파싱된 JSON 또는 문자열), text(원문), url(보낸 주소 추정) }
 */
export async function http({ method = "GET", url, params = {}, headers = {}, data, timeout = 20000 }) {
  const qs = new URLSearchParams(params).toString();
  const shownUrl = qs ? `${url}?${qs}` : url;
  if (isNative) {
    let res;
    try {
      res = await plugins().CapacitorHttp.request({
        method, url, params, headers, data,
        connectTimeout: timeout, readTimeout: timeout, responseType: "text",
      });
    } catch (e) {
      throw new NetError(String((e && e.message) || e));
    }
    let body = res.data, text;
    if (typeof body === "string") {
      text = body;
      try { body = JSON.parse(body); } catch { /* 문자열 그대로 */ }
    } else {
      text = JSON.stringify(body);
    }
    return { status: res.status, data: body, text, url: shownUrl };
  }
  let res;
  try {
    res = await fetch(shownUrl, {
      method, headers: data !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
  } catch (e) {
    throw new NetError(String((e && e.message) || e));
  }
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 문자열 */ }
  return { status: res.status, data: body, text, url: shownUrl };
}

function base64FromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 파일을 만들어 공유 시트(카톡, 드라이브, 내 파일 저장 등)로 내보낸다. */
export async function shareFile(filename, { base64, text, mime = "application/octet-stream", title = "파일 공유" }) {
  if (base64 === undefined) base64 = base64FromBytes(new TextEncoder().encode(text));
  if (isNative) {
    const { Filesystem, Share } = plugins();
    const w = await Filesystem.writeFile({ path: filename, data: base64, directory: "CACHE" });
    await Share.share({ title, files: [w.uri], dialogTitle: title });
    return;
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export async function shareText(text, title = "공유") {
  if (isNative && plugins().Share) {
    try { await plugins().Share.share({ title, text, dialogTitle: title }); return true; } catch { return false; }
  }
  return false;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 아래 방식 */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** 외부 사이트는 휴대폰 기본 브라우저로 연다. */
export async function openExternal(url) {
  if (isNative && plugins().Browser) {
    try { await plugins().Browser.open({ url }); return; } catch { /* 아래 방식 */ }
  }
  window.open(url, "_blank", "noopener");
}

/** 안드로이드 뒤로가기 버튼. handler 가 true 를 돌려주면 처리 완료, 아니면 앱을 백그라운드로 보낸다. */
export function onBackButton(handler) {
  if (!isNative || !plugins().App) return;
  plugins().App.addListener("backButton", () => {
    if (!handler()) plugins().App.minimizeApp();
  });
}

export function onResume(handler) {
  if (!isNative || !plugins().App) return;
  plugins().App.addListener("resume", handler);
}
