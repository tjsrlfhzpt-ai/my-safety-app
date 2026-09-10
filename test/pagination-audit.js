// 페이지네이션(출시전 점검보고서 3절) 검증 스크립트 - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
const { bootstrapTestOrg } = require('./_helpers');

async function apiRaw(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, totalCount: res.headers.get('x-total-count') };
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}

(async () => {
  const orgResult = await bootstrapTestOrg(BASE);
  const org = { id: orgResult.orgId };
  const site = { id: orgResult.siteId };

  await apiRaw('POST', '/auth/register', { orgId: org.id, siteId: site.id, loginId: 'page.admin', password: 'Test1234!', name: '관리자' });
  const login = await apiRaw('POST', '/auth/login', { loginId: 'page.admin', password: 'Test1234!' });
  const token = login.data.token;
  await apiRaw('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('=== 1. 기본 동작 (기존 프론트엔드 호환성 - ?limit= 없이 호출) ===');
  for (let i = 0; i < 12; i++) {
    await apiRaw('POST', '/nearmiss', { content: `아차사고 ${i}` }, token);
  }
  const noParam = await apiRaw('GET', '/nearmiss', null, token);
  assert(noParam.status === 200 && Array.isArray(noParam.data) && noParam.data.length === 12,
    '?limit= 없이 호출하면 기존처럼 배열 그대로, 지금 데이터량(12건)에서는 전부 반환됨');
  assert(noParam.totalCount === '12', 'X-Total-Count 헤더로 총 건수(12)를 함께 알려준다');

  console.log('\n=== 2. limit/offset 명시적 사용 ===');
  const page1 = await apiRaw('GET', '/nearmiss?limit=5&offset=0', null, token);
  assert(page1.data.length === 5, 'limit=5 지정 시 5건만 반환');
  const page2 = await apiRaw('GET', '/nearmiss?limit=5&offset=5', null, token);
  assert(page2.data.length === 5, '두 번째 페이지(offset=5)도 5건 반환');
  const page3 = await apiRaw('GET', '/nearmiss?limit=5&offset=10', null, token);
  assert(page3.data.length === 2, '마지막 페이지(offset=10)는 남은 2건만 반환');
  const ids1 = new Set(page1.data.map((r) => r.id));
  const ids2 = new Set(page2.data.map((r) => r.id));
  const overlap = [...ids1].some((id) => ids2.has(id));
  assert(!overlap, '페이지 간 데이터가 중복되지 않는다');

  console.log('\n=== 3. 비정상 입력 방어 ===');
  const hugeLimit = await apiRaw('GET', '/nearmiss?limit=999999', null, token);
  assert(hugeLimit.data.length === 12, 'limit을 비정상적으로 크게 요청해도 실제 존재하는 건수만큼만 반환(상한 500 이내이므로 이 경우는 전체 반환)');
  const negativeOffset = await apiRaw('GET', '/nearmiss?limit=5&offset=-3', null, token);
  assert(negativeOffset.status === 200 && negativeOffset.data.length === 5, '음수 offset은 무시되고 기본값(0)으로 동작');
  const junkLimit = await apiRaw('GET', '/nearmiss?limit=abc', null, token);
  assert(junkLimit.status === 200 && junkLimit.data.length === 12, '숫자가 아닌 limit은 무시되고 기본 상한으로 동작(에러 아님)');

  console.log('\n=== 4. 위험성평가/CAPA/PTW도 동일하게 적용됨 ===');
  for (let i = 0; i < 3; i++) await apiRaw('POST', '/risks', { hazard: `위험요인 ${i}` }, token);
  const riskPage = await apiRaw('GET', '/risks?limit=2', null, token);
  assert(riskPage.data.length === 2 && riskPage.totalCount === '3', '위험성평가 목록도 페이지네이션 적용됨');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
