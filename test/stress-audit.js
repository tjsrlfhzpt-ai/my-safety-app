// 직무스트레스 평가 검증 (2026-09-02, 마스터 프롬프트 6·21·44절)
// 핵심: 개인이 특정되거나 낙인이 찍히지 않도록 설계된 대로 동작하는가
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '직무스트레스테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'st.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'st.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 집단 단위 평가 등록 (고위험군 없음) ===');
  const ok = await api('POST', '/stress/assessments', {
    targetGroup: 'A동 가공팀', assessDate: '2026-09-01', roundNo: '2026년 정기평가',
    targetCount: 24, respondCount: 22, method: 'KOSS', highRiskCount: 0,
    mainFactor: '직무자율성', finding: '전반적으로 평균 수준',
    agency: '한국산업안전보건공단', nextAssessDate: '2028-09-01',
  }, token);
  assert(ok.status === 201 && ok.data.id.startsWith('STR-'), `평가 등록 (${ok.data.id})`);
  const okRow = (await api('GET', '/stress/assessments', null, token)).data.find((r) => r.id === ok.data.id);
  assert(okRow.status === '평가완료', '고위험군이 없으면 "평가완료"');
  assert(okRow.method === 'KOSS', '어떤 도구로 평가했는지 기록됨(시스템이 점수를 계산하지 않음)');
  assert(okRow.target_group === 'A동 가공팀', '집단 단위로 저장됨');
  assert(!ok.data.privacyWarning, '응답 인원이 충분하면 별도 경고 없음');

  console.log('\n=== 2. 🔒 응답 인원이 적으면 개인 특정 위험을 알려주는가 ===');
  const small = await api('POST', '/stress/assessments', {
    targetGroup: '품질검사팀', targetCount: 3, respondCount: 2, method: 'KOSS', highRiskCount: 0,
  }, token);
  assert(small.status === 201, '작은 집단도 등록은 가능(작은 사업장은 어쩔 수 없으므로 막지 않음)');
  assert(!!small.data.privacyWarning, '대신 개인이 특정될 수 있다는 경고를 함께 알려줌');
  assert(small.data.privacyWarning.includes('2명'), '몇 명인지 구체적으로 알려줌');
  assert(small.data.privacyWarning.includes('주의'), '결과 공유 시 주의하라는 안내 포함');

  console.log('\n=== 3. 🔑 고위험군이 있으면 그냥 넘어갈 수 없다 ===');
  const high = await api('POST', '/stress/assessments', {
    targetGroup: 'B동 조립팀', targetCount: 30, respondCount: 28, method: 'KOSS',
    highRiskCount: 6, mainFactor: '직무요구', finding: '작업량 과다에 따른 스트레스 수준 높음',
  }, token);
  const highRow = (await api('GET', '/stress/assessments', null, token)).data.find((r) => r.id === high.data.id);
  assert(highRow.status === '개선필요', '고위험군이 있으면 자동으로 "개선필요" 상태');
  assert(highRow.high_risk_count === 6, '고위험군은 인원수(집계)만 저장됨');

  console.log('\n=== 4. 🔒 CAPA에 개인을 특정할 정보가 들어가지 않는가 ===');
  assert(!!high.data.autoCapaId, `개선조치 자동 생성 (${high.data.autoCapaId})`);
  const capa = (await api('GET', '/capa', null, token)).data.find((c) => c.id === high.data.autoCapaId);
  assert(!!capa, 'CAPA 목록에서 조회됨');
  assert(capa.source_type === 'stress' && capa.source_id === high.data.id, '이 평가와 정확히 연결됨');
  assert(capa.title.includes('B동 조립팀'), '집단명은 제목에 담김(개선 대상을 알아야 하므로)');
  assert(!/\d+명|고위험자|명단/.test(capa.title + capa.description), 'CAPA 내용에 인원수·명단 등 개인 특정 가능 정보가 없음');
  assert(capa.description.includes('조직 차원'), '개인이 아니라 조직 차원의 개선을 안내함');

  console.log('\n=== 5. 강제로 "평가완료"를 보내도 고위험군이 있으면 막힌다 ===');
  const forced = await api('POST', '/stress/assessments', {
    targetGroup: '강제완료팀', highRiskCount: 3, status: '평가완료',
  }, token);
  const forcedRow = (await api('GET', '/stress/assessments', null, token)).data.find((r) => r.id === forced.data.id);
  assert(forcedRow.status === '개선필요', '개선 대책 없이 완료 처리할 수 없음');

  console.log('\n=== 6. 🔒 상담 기록은 익명이 기본인가 ===');
  const cns = await api('POST', '/stress/counselings', {
    subjectCode: 'B-07', assessmentId: high.data.id, counselDate: '2026-09-05',
    counselor: '보건관리자', actionTaken: '전문기관 연계 및 작업량 조정 건의',
  }, token);
  assert(cns.status === 201 && cns.data.id.startsWith('STRC-'), `상담 기록 (${cns.data.id})`);
  const cnsRow = (await api('GET', '/stress/counselings', null, token)).data.find((r) => r.id === cns.data.id);
  assert(cnsRow.is_anonymous === 1, '실명 여부를 명시하지 않으면 익명으로 처리됨(안전한 쪽이 기본값)');
  assert(cnsRow.subject_code === 'B-07', '이름 대신 코드로 관리 가능');
  assert(cnsRow.status === '상담완료', '초기 상태가 정상 설정됨');

  console.log('\n=== 7. 🔒 집단 평가 목록에 상담 대상자가 섞여 나오지 않는가 ===');
  const assessList = await api('GET', '/stress/assessments', null, token);
  assert(!JSON.stringify(assessList.data).includes('B-07'), '평가 목록에 상담 대상자 코드가 노출되지 않음');
  assert(!JSON.stringify(assessList.data).includes('전문기관 연계'), '평가 목록에 상담 내용이 섞여 나오지 않음');

  console.log('\n=== 8. 필수값 검증 ===');
  const noGroup = await api('POST', '/stress/assessments', { method: 'KOSS' }, token);
  assert(noGroup.status === 400, '평가 대상 집단 없이는 등록 불가');
  const noCode = await api('POST', '/stress/counselings', { counselor: '보건관리자' }, token);
  assert(noCode.status === 400, '대상자 코드 없이는 상담 기록 불가');

  console.log('\n=== 9. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'st.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'st.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bAssess = await api('GET', '/stress/assessments', null, bLogin.data.token);
  const bCns = await api('GET', '/stress/counselings', null, bLogin.data.token);
  assert(bAssess.data.length === 0, 'B사에서는 A사 평가가 보이지 않음');
  assert(bCns.data.length === 0, 'B사에서는 A사 상담 기록이 보이지 않음(민감정보 격리)');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
