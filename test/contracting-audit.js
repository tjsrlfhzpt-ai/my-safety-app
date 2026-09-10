// 도급 안전보건관리 검증 (2026-09-05, 마스터 프롬프트 45-9절)
const BASE = 'http://localhost:4000';
const { bootstrapTestOrg } = require('./_helpers');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}
async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  console.log('=== 0. 준비 ===');
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '도급관리테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'dg.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'dg.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);
  const ct = await api('POST', '/contractor', { companyName: '(주)한빛건설', repName: '김대표' }, token);

  console.log('\n=== 1. 안전보건관리비 계상 등록 ===');
  const budget = await api('POST', '/contracting/budgets', {
    fiscalYear: '2026', projectName: 'A동 증축공사',
    contractAmount: '1,200,000,000', plannedAmount: '24,000,000',
  }, token);
  assert(budget.status === 201 && budget.data.id.startsWith('BDG-'), `계상 등록 (${budget.data.id})`);
  const bRow = (await api('GET', '/contracting/budgets', null, token)).data.find((b) => b.id === budget.data.id);
  assert(bRow.planned_amount === '24,000,000', '입력한 표기 그대로 보관됨(임의로 숫자 변환하지 않음)');
  assert(bRow.status === '집행중', '초기 상태가 설정됨');

  console.log('\n=== 2. 집행 내역 등록 ===');
  const spends = [
    { category: '안전시설비', content: '개구부 안전난간 설치', amount: '5,000,000', vendor: '안전산업', evidenceNo: 'TX-001' },
    { category: '보호구', content: '안전모·안전대 구매', amount: '3,200,000', vendor: '보호구몰', evidenceNo: 'TX-002', relatedContractor: '한빛건설' },
    { category: '교육비', content: '수급업체 특별안전교육', amount: '1,800,000', vendor: '안전교육원', evidenceNo: 'TX-003' },
  ];
  for (const sp of spends) {
    const r = await api('POST', '/contracting/budget-items', { budgetId: budget.data.id, ...sp }, token);
    assert(r.status === 201, `집행 등록: ${sp.content}`);
  }

  console.log('\n=== 3. 🔑 계상액 대비 집행률이 정확한가 ===');
  const sum = await api('GET', `/contracting/budgets/${budget.data.id}/summary`, null, token);
  assert(sum.status === 200, '집행 현황 조회 성공');
  assert(sum.data.itemCount === 3, `집행 건수 3건 (실제 ${sum.data.itemCount})`);
  assert(sum.data.spentSum === 10000000, `집행 합계 10,000,000원 (실제 ${sum.data.spentSum})`);
  assert(sum.data.plannedAmount === 24000000, '계상액이 숫자로 읽힘');
  assert(sum.data.executionRate === 41.7, `집행률 41.7% (실제 ${sum.data.executionRate})`);
  assert(sum.data.byCategory['안전시설비'] === 5000000, '항목별 집계도 정확함');
  assert(sum.data.byCategory['보호구'] === 3200000, '보호구 항목 집계');

  console.log('\n=== 4. 🔑 읽지 못한 금액을 조용히 넘기지 않는가 (감독 대상 자료이므로) ===');
  await api('POST', '/contracting/budget-items', {
    budgetId: budget.data.id, category: '진단비', content: '안전진단 위탁', amount: '삼백만원',
  }, token);
  const sum2 = await api('GET', `/contracting/budgets/${budget.data.id}/summary`, null, token);
  assert(sum2.data.unreadableAmountCount === 1, `숫자로 읽지 못한 항목 1건을 집어냄 (실제 ${sum2.data.unreadableAmountCount})`);
  assert(sum2.data.spentSum === 10000000, '읽지 못한 금액을 추측해서 더하지 않음(합계 그대로)');
  assert(sum2.data.note.includes('1건'), '몇 건이 빠졌는지 알려줌');
  assert(sum2.data.note.includes('확인'), '사용자에게 확인을 요청함');
  assert(sum2.data.itemCount === 4, '건수 자체는 4건으로 정확히 셈(누락 아님)');

  console.log('\n=== 5. 집행률이 없을 때 억지로 만들지 않는가 ===');
  const noPlan = await api('POST', '/contracting/budgets', { fiscalYear: '2027' }, token);
  const sum3 = await api('GET', `/contracting/budgets/${noPlan.data.id}/summary`, null, token);
  assert(sum3.data.executionRate === null, '계상액이 없으면 집행률을 null로 둠(0%로 오해시키지 않음)');

  console.log('\n=== 6. 수급업체 평가 이력이 쌓이는가 ===');
  const ev1 = await api('POST', '/contracting/evaluations', {
    relatedContractor: '한빛건설', evalDate: '2026-06-30', period: '2026년 상반기',
    evaluator: '김안전', grade: 'B', weakness: '고소작업 안전대 미착용 3회 적발',
    improvement: '작업 전 착용 점검 강화', followupDate: '2026-09-30',
  }, token);
  assert(ev1.status === 201 && ev1.data.id.startsWith('CTEV-'), `평가 등록 (${ev1.data.id})`);
  const evRow = (await api('GET', '/contracting/evaluations', null, token)).data.find((e) => e.id === ev1.data.id);
  assert(evRow.contractor_id === ct.data.id, '협력업체에 자동 연결됨(표기가 "(주)" 없이 달라도)');
  assert(evRow.weakness.includes('안전대 미착용'), '평가 근거가 기록됨');

  const ev2 = await api('POST', '/contracting/evaluations', {
    relatedContractor: '(주)한빛건설', evalDate: '2026-12-31', period: '2026년 하반기',
    grade: 'A', strength: '지적사항 전부 개선 완료',
  }, token);
  const all = (await api('GET', '/contracting/evaluations', null, token)).data.filter((e) => e.contractor_id === ct.data.id);
  assert(all.length === 2, `같은 업체의 평가가 이력으로 2건 쌓임 (실제 ${all.length}건)`);
  assert(all.some((e) => e.grade === 'B') && all.some((e) => e.grade === 'A'),
    '과거 평가(B)가 최신 평가(A)로 덮어써지지 않음 — 재계약 판단 근거가 남음');

  console.log('\n=== 7. 필수값 검증 ===');
  assert((await api('POST', '/contracting/budgets', {}, token)).status === 400, '대상 연도 없이는 계상 등록 불가');
  assert((await api('POST', '/contracting/budget-items', { amount: '100' }, token)).status === 400, '집행 내용 없이는 등록 불가');
  assert((await api('POST', '/contracting/evaluations', { grade: 'A' }, token)).status === 400, '평가 대상 업체 없이는 등록 불가');

  console.log('\n=== 8. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'dg.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'dg.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  assert((await api('GET', '/contracting/budgets', null, bLogin.data.token)).data.length === 0, 'B사에서 A사 관리비가 안 보임');
  assert((await api('GET', '/contracting/evaluations', null, bLogin.data.token)).data.length === 0, 'B사에서 A사 평가가 안 보임');
  assert((await api('GET', `/contracting/budgets/${budget.data.id}/summary`, null, bLogin.data.token)).status === 404,
    'B사가 A사 계상 id를 알아내도 집행내역을 볼 수 없음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
