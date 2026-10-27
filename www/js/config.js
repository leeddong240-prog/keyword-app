// 앱 버전과 배포 설정. build-info.js 는 GitHub 자동 빌드 때 새로 만들어진다.
import { BUILD } from "./build-info.js";

export const APP_NAME = "키워드 검색량";
export const APP_VERSION = BUILD.versionName || "1.0.0";
export const VERSION_CODE = Number(BUILD.versionCode || 1);
// 새 버전 확인용 주소 (예: https://github.com/아이디/저장소/releases/latest/download/version.json). 비우면 확인 안 함
export const UPDATE_URL = BUILD.updateUrl || "";

// 네이버 API 주소. 개발 중 브라우저 시험에서는 ?mock=주소 로 가짜 서버를 쓸 수 있다.
const mock = new URLSearchParams(location.search).get("mock");
const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const AD_BASE = !native && mock ? mock : "https://api.searchad.naver.com";
export const OPEN_BASE = !native && mock ? mock : "https://openapi.naver.com";

export const DEFAULTS = {
  ad_api_key: "", ad_secret: "", ad_customer_id: "",
  dev_client_id: "", dev_client_secret: "",
  ad_delay: 0.35, blog_delay: 0.12,
  quick_related: 10, quick_blog: true,
};
