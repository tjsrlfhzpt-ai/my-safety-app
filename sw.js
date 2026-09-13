/* ============================================================
   SAFE DUCKY — Service Worker
   ------------------------------------------------------------
   전략: 앱 셸(HTML/아이콘/핵심 CDN 스크립트)은 설치 시 미리 캐싱하고,
   이후 요청은 "캐시 우선 응답 + 백그라운드 갱신"(stale-while-revalidate)
   방식으로 처리합니다. 오프라인에서는 캐시로 폴백합니다.

   ⚠️ 파일을 수정한 뒤에는 반드시 CACHE_VERSION 문자열을 바꿔주세요.
   버전을 바꾸지 않으면 사용자 기기에 예전 버전이 계속 캐시된 채로
   남아 "업데이트했는데 옛날 화면이 보이는" 문제가 발생합니다.
   ============================================================ */
const CACHE_VERSION = 'safe-ducky-shell-v23.0.0';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  // 2026-09-12: 세더키 브랜드 일러스트(스플래시 화면·빈 데이터 화면) 오프라인 캐싱 추가
  './assets/safeducky/splash-hero.jpg',
  './assets/safeducky/empty-risk.jpg',
  './assets/safeducky/empty-edu.jpg',
  './assets/safeducky/empty-ppe.jpg',
  './assets/safeducky/empty-health.jpg',
  './assets/safeducky/empty-msds.jpg',
  './assets/safeducky/empty-permit.jpg',
  './assets/safeducky/empty-history.jpg',
  './assets/safeducky/empty-generic.jpg',
  './assets/safeducky/empty-accident.jpg',
  './assets/safeducky/empty-tbm.jpg',
  './assets/safeducky/empty-appoint.jpg',
  './assets/safeducky/empty-contractor.jpg',
  './assets/safeducky/empty-nearmiss.jpg',
  './assets/safeducky/empty-equipment.jpg',
  './assets/safeducky/empty-orgchart.jpg',
  './assets/safeducky/empty-emergency.jpg',
  // 2026-09-13: v5.31 안전모듈 메뉴 아이콘(사용자 제공 마스코트 아이콘 자료, 20개) 오프라인 캐싱 추가
  './assets/safeducky/menu-icons/menu-capa.png',
  './assets/safeducky/menu-icons/menu-risk.png',
  './assets/safeducky/menu-icons/menu-accident.png',
  './assets/safeducky/menu-icons/menu-msds.png',
  './assets/safeducky/menu-icons/menu-health.png',
  './assets/safeducky/menu-icons/menu-ptw.png',
  './assets/safeducky/menu-icons/menu-edu.png',
  './assets/safeducky/menu-icons/menu-tbm.png',
  './assets/safeducky/menu-icons/menu-appoint.png',
  './assets/safeducky/menu-icons/menu-legalmeet.png',
  './assets/safeducky/menu-icons/menu-ppe.png',
  './assets/safeducky/menu-icons/menu-contractor.png',
  './assets/safeducky/menu-icons/menu-nearmiss.png',
  './assets/safeducky/menu-icons/menu-voice.png',
  './assets/safeducky/menu-icons/menu-statutory.png',
  './assets/safeducky/menu-icons/menu-equipment.png',
  './assets/safeducky/menu-icons/menu-orgchart.png',
  './assets/safeducky/menu-icons/menu-emergency.png',
  './assets/safeducky/menu-icons/menu-ai.png',
  './assets/safeducky/menu-icons/menu-stats.png',
  'https://cdn.tailwindcss.com',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // 리소스 하나(특히 외부 CDN)가 실패해도 전체 설치가 죽지 않도록 개별 처리
      const results = await Promise.allSettled(
        CORE_ASSETS.map((url) => cache.add(new Request(url, { mode: url.startsWith('http') ? 'no-cors' : 'same-origin' })))
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.warn('[SW] 사전캐싱 실패(무시하고 계속):', CORE_ASSETS[i], r.reason);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached); // 오프라인이면 캐시로 폴백

      return cached || network;
    })
  );
});
