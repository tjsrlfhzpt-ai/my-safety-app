// 2026-09-02(마스터 프롬프트 45-4절): 협력업체 자동 연결.
//
// 현장에서는 협력업체를 목록에서 고르기도 하고, 급할 때 이름만 적기도 합니다.
// 이름만 적었을 때 그냥 텍스트로 두면 "(주)한국기계"와 "한국기계"가 서로 다른 업체가 되어
// 집계가 어긋납니다. 그래서 이름으로도 등록된 업체를 찾아 자동으로 연결해 줍니다.
//
// 다만 "비슷하니까 아마 이 업체겠지" 식의 추측은 하지 않습니다. 엉뚱한 업체에 사고가
// 집계되면 그 업체가 부당한 불이익을 받기 때문입니다. 그래서 아주 보수적으로,
// 회사 형태 표기((주)·주식회사 등)와 공백만 무시하고 나머지가 정확히 같을 때만 연결하며,
// 후보가 둘 이상이면 연결하지 않고 텍스트로만 남깁니다.

// 비교용으로 이름을 다듬습니다: 공백·괄호·회사형태 표기를 걷어냅니다.
function normalizeCompanyName(name) {
  return String(name || '')
    .replace(/\(주\)|\（주\）|주식회사|㈜|\(유\)|유한회사|\(합\)/g, '')
    .replace(/[\s\-_.]/g, '')
    .toLowerCase();
}

// 사업장 범위 안에서 이름이 일치하는 협력업체를 찾습니다.
// 찾으면 id를, 못 찾거나 애매하면 null을 돌려줍니다(연결하지 않음 = 안전한 쪽).
function findContractorIdByName(db, siteIds, name) {
  if (!name || !siteIds || !siteIds.length) return null;
  const target = normalizeCompanyName(name);
  if (!target) return null;

  const sitePh = siteIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, company_name FROM contractors WHERE site_id IN (${sitePh}) AND deleted = 0`
  ).all(...siteIds);

  const matches = rows.filter((r) => normalizeCompanyName(r.company_name) === target);
  // 같은 이름의 업체가 둘 이상이면 어느 쪽인지 알 수 없으므로 연결하지 않습니다.
  return matches.length === 1 ? matches[0].id : null;
}

// 요청 본문에서 협력업체 연결값을 결정합니다.
//  - contractorId를 직접 보냈으면(목록에서 고른 경우) 그 업체가 실제로 접근 가능한지 확인합니다.
//  - 이름만 보냈으면 위 규칙으로 찾아봅니다.
// 반환: { contractorId, error } — error가 있으면 호출한 쪽이 400으로 응답합니다.
function resolveContractorLink(db, siteIds, body) {
  const explicit = body && body.contractorId;
  if (explicit) {
    const sitePh = siteIds.map(() => '?').join(',');
    const found = siteIds.length
      ? db.prepare(`SELECT id FROM contractors WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(explicit, ...siteIds)
      : null;
    if (!found) {
      return { contractorId: null, error: '지정한 협력업체를 찾을 수 없습니다. 협력업체 목록에서 먼저 등록한 뒤 선택해 주세요.' };
    }
    return { contractorId: explicit, error: null };
  }
  return { contractorId: findContractorIdByName(db, siteIds, body && body.relatedContractor), error: null };
}

module.exports = { normalizeCompanyName, findContractorIdByName, resolveContractorLink };
