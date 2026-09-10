// 반기점검(중대재해처벌법 대응) 검증 (2026-09-05)
// 핵심: "점검했다"는 기록이 아니라, 회차 간 비교로 개선 여부를 알 수 있는가
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '반기점검테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'rv.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'rv.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 🔑 법정 체크리스트를 그대로 떠서 회차를 만드는가 (다시 입력 안 해도 됨) ===');
  // 법정 체크리스트 화면을 한 번 열면 85개 항목이 사업장에 시딩됩니다.
  const cl = await api('GET', '/compliance', null, token);
  assert(Array.isArray(cl.data) && cl.data.length > 0, `법정 체크리스트 ${cl.data.length}개 항목이 준비됨`);

  // 상반기: 3개 항목만 이행으로 체크
  const someItems = cl.data.slice(0, 5);
  for (let i = 0; i < 3; i++) {
    await api('PATCH', `/compliance/${encodeURIComponent(someItems[i].id)}`, { checked: true }, token);
  }

  const h1 = await api('POST', '/compliance-review', {
    reviewPeriod: '2026년 상반기', reviewDate: '2026-06-30', reviewer: '대표이사',
    scope: '전 사업장', finding: '다수 항목 미이행',
  }, token);
  assert(h1.status === 201 && h1.data.id.startsWith('REV-'), `상반기 점검 기록 (${h1.data.id})`);
  assert(h1.data.totalCount === cl.data.length, `항목을 다시 입력하지 않아도 ${h1.data.totalCount}개가 그대로 담김`);
  assert(h1.data.okCount === 3, `이행 3건 (실제 ${h1.data.okCount})`);
  assert(h1.data.ngCount === cl.data.length - 3, '나머지는 미이행으로 집계');
  assert(h1.data.status === '개선필요', '미이행이 있으면 "개선필요"(점검완료로 끝낼 수 없음)');

  console.log('\n=== 2. 미이행이 있으면 개선조치가 열리는가 ===');
  assert(!!h1.data.autoCapaId, `개선조치 자동 생성 (${h1.data.autoCapaId})`);
  const capa = (await api('GET', '/capa', null, token)).data.find((c) => c.id === h1.data.autoCapaId);
  assert(capa && capa.source_type === 'review' && capa.source_id === h1.data.id, '이 점검 회차와 정확히 연결됨');
  assert(capa.title.includes('상반기'), '어느 회차인지 제목에 담김');
  assert(capa.description.includes('외 '), '미이행이 많으면 일부만 나열하고 나머지 건수를 알려줌(제목이 무한정 길어지지 않게)');

  console.log('\n=== 3. 하반기에 개선한 뒤 다시 점검 ===');
  // 2개를 추가로 이행 처리, 1개는 오히려 해제(악화 사례)
  await api('PATCH', `/compliance/${encodeURIComponent(someItems[3].id)}`, { checked: true }, token);
  await api('PATCH', `/compliance/${encodeURIComponent(someItems[4].id)}`, { checked: true }, token);
  await api('PATCH', `/compliance/${encodeURIComponent(someItems[0].id)}`, { checked: false }, token);

  const h2 = await api('POST', '/compliance-review', {
    reviewPeriod: '2026년 하반기', reviewDate: '2026-12-31', reviewer: '대표이사',
    improvement: '미이행 항목 순차 개선 계획 수립',
  }, token);
  assert(h2.status === 201, '하반기 점검 기록');
  assert(h2.data.okCount === 4, `이행 4건으로 증가 (실제 ${h2.data.okCount})`);
  assert(h2.data.status === '개선필요', '아직 미이행이 남아 "개선필요" 유지');

  console.log('\n=== 4. 🔑 회차 간 비교가 실제로 의미 있는 정보를 주는가 ===');
  const cmp = await api('GET', `/compliance-review/compare?from=${h1.data.id}&to=${h2.data.id}`, null, token);
  assert(cmp.status === 200, '비교 조회 성공');
  assert(cmp.data.from.period === '2026년 상반기' && cmp.data.to.period === '2026년 하반기', '두 회차가 올바르게 잡힘');
  assert(cmp.data.improved.length === 2, `개선된 항목 2건을 정확히 집어냄 (실제 ${cmp.data.improved.length})`);
  assert(cmp.data.worsened.length === 1, `악화된 항목 1건도 놓치지 않음 (실제 ${cmp.data.worsened.length})`);
  assert(cmp.data.stillNg.length > 0, `계속 미이행인 항목을 따로 알려줌 (${cmp.data.stillNg.length}건)`);
  assert(cmp.data.note.includes('반복 미이행'), '반복 미이행이 무엇을 뜻하는지 설명함(개선이 실제로 안 되고 있다는 신호)');
  assert(cmp.data.improved.length > 0 && !!cmp.data.improved[0].title, '개선된 항목의 내용도 함께 나옴(번호만으로는 알 수 없으므로)');

  console.log('\n=== 5. 이행률 계산 (해당없음을 미이행처럼 세지 않는가) ===');
  const custom = await api('POST', '/compliance-review', {
    reviewPeriod: '2027년 상반기',
    results: [
      { itemNo: 'A-1', itemTitle: '항목1', result: '이행' },
      { itemNo: 'A-2', itemTitle: '항목2', result: '이행' },
      { itemNo: 'A-3', itemTitle: '항목3', result: '미이행' },
      { itemNo: 'A-4', itemTitle: '항목4', result: '해당없음' },
    ],
    improvement: '개선 예정',
  }, token);
  assert(custom.data.totalCount === 4, '전체 4건');
  assert(custom.data.complianceRate === '66.7',
    `이행률 66.7% — 해당없음을 뺀 3건 기준 (실제 ${custom.data.complianceRate}%). 해당없음을 미이행처럼 세면 50%로 부당하게 낮아짐`);

  console.log('\n=== 6. 과거 회차는 그대로 보존되는가 (스냅샷) ===');
  const h1Results = await api('GET', `/compliance-review/${h1.data.id}/results`, null, token);
  assert(h1Results.data.results.length === cl.data.length, '상반기 회차의 항목별 결과가 그대로 남아있음');
  // 스냅샷은 원본 항목번호(item_no)로 저장되므로 그 값으로 찾습니다.
  const targetNo = someItems[0].item_no;
  const firstItemInH1 = h1Results.data.results.find((r) => String(r.item_no) === String(targetNo));
  assert(firstItemInH1 && firstItemInH1.result === '이행',
    '상반기에 이행이던 항목이, 나중에 해제됐어도 상반기 기록에는 "이행"으로 남아있음');
  assert(!!firstItemInH1.item_title, '항목 문구도 그 시점 그대로 보존됨(법령 개정 대비)');

  console.log('\n=== 7. 필수값·예외 처리 ===');
  assert((await api('POST', '/compliance-review', {}, token)).status === 400, '점검 기간 없이는 등록 불가');
  const badCmp = await api('GET', `/compliance-review/compare?from=${h1.data.id}`, null, token);
  assert(badCmp.status === 400, '비교할 회차를 하나만 주면 400');

  console.log('\n=== 8. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'rv.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'rv.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  assert((await api('GET', '/compliance-review', null, bLogin.data.token)).data.length === 0, 'B사에서 A사 점검이 안 보임');
  assert((await api('GET', `/compliance-review/${h1.data.id}/results`, null, bLogin.data.token)).status === 404,
    'B사가 A사 회차 id를 알아내도 결과를 볼 수 없음');
  assert((await api('GET', `/compliance-review/compare?from=${h1.data.id}&to=${h2.data.id}`, null, bLogin.data.token)).status === 404,
    'B사는 A사 회차를 비교할 수도 없음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
