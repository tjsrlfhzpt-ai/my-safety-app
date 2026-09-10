// 2026-08-28 후속조치(출시전 점검보고서 3절 "페이지네이션 없음"): 지금까지 모든 목록조회가
// LIMIT/OFFSET 없이 무조건 전체를 반환했다(원칙 14 위반). 다만 기존 프론트엔드가 "항상
// 전체 목록"을 기대하고 만들어져 있어서, ?limit=을 아예 지정하지 않아도 기존과 동일하게
// 동작하도록 넉넉한 기본 상한(DEFAULT_LIMIT)만 걸어둔다. 지금 데이터 규모에서는 이 상한에
// 걸릴 일이 없어 기존 동작을 깨지 않으면서, 데이터가 수천 건으로 늘어났을 때의 안전판
// 역할을 한다. 프론트엔드가 실제로 ?limit=&offset=을 보내도록 바뀌는 것은 별도 작업이다
// (지금은 "무제한 응답"이라는 구조적 위험만 없앤 것).
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function parsePagination(query) {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  if (query && query.limit !== undefined) {
    const n = parseInt(query.limit, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }
  if (query && query.offset !== undefined) {
    const n = parseInt(query.offset, 10);
    if (Number.isFinite(n) && n >= 0) offset = n;
  }
  return { limit, offset };
}

// site_id IN (...) AND deleted = 0 로 스코핑된 목록조회 + 총 건수를 함께 반환한다.
// 응답 바디 형태(배열)는 그대로 유지하고, 총 건수는 X-Total-Count 헤더로 별도 전달한다 -
// 그래야 이미 "배열이 온다"고 가정하고 만들어진 기존 프론트엔드 코드를 안 건드려도 된다.
function queryPaginatedList(db, table, siteIds, query) {
  if (!siteIds.length) return { rows: [], total: 0 };
  const { limit, offset } = parsePagination(query);
  const sitePh = siteIds.map(() => '?').join(',');
  const total = db.prepare(
    `SELECT COUNT(*) c FROM ${table} WHERE site_id IN (${sitePh}) AND deleted = 0`
  ).get(...siteIds).c;
  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE site_id IN (${sitePh}) AND deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...siteIds, limit, offset);
  return { rows, total };
}

module.exports = { parsePagination, queryPaginatedList, DEFAULT_LIMIT, MAX_LIMIT };
