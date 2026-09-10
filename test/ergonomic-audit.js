// 근골격계 유해요인 조사 검증 (2026-09-02, 마스터 프롬프트 6·21·44·45-2절)
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '근골격계테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'er.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'er.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 작업 단위 조사 등록 (위험도 보통) ===');
  const ok = await api('POST', '/ergonomic/surveys', {
    taskName: '완제품 포장 작업', location: 'C동 포장라인', burdenType: '반복작업',
    surveyDate: '2026-09-01', roundNo: '2026년 정기조사', workerCount: 8,
    method: 'RULA', riskLevel: '보통', finding: '손목 반복 굴곡',
    nextSurveyDate: '2029-09-01',
  }, token);
  assert(ok.status === 201 && ok.data.id.startsWith('ERG-'), `조사 등록 (${ok.data.id})`);
  const okRow = (await api('GET', '/ergonomic/surveys', null, token)).data.find((r) => r.id === ok.data.id);
  assert(okRow.status === '조사완료', '위험도가 높지 않으면 "조사완료"');
  assert(okRow.method === 'RULA', '어떤 기법으로 평가했는지 기록됨(시스템이 점수를 계산하지 않음)');
  assert(okRow.risk_level === '보통', '평가 결과가 입력한 그대로 저장됨');

  console.log('\n=== 2. 🔑 위험도 높음이면 그냥 넘어갈 수 없다 ===');
  const high = await api('POST', '/ergonomic/surveys', {
    taskName: '자재 상차 작업', location: 'A동 출하장', burdenType: '중량물 취급',
    method: 'REBA', riskLevel: '높음', finding: '25kg 이상 중량물을 허리 굽혀 반복 인력운반',
    workerCount: 5,
  }, token);
  const highRow = (await api('GET', '/ergonomic/surveys', null, token)).data.find((r) => r.id === high.data.id);
  assert(highRow.status === '개선필요', '위험도 높음이면 자동으로 "개선필요" 상태');

  console.log('\n=== 3. 🔑 개선조치(CAPA)가 자동으로 열리는가 ===');
  assert(!!high.data.autoCapaId, `개선조치 자동 생성 (${high.data.autoCapaId})`);
  const capa = (await api('GET', '/capa', null, token)).data.find((c) => c.id === high.data.autoCapaId);
  assert(!!capa, 'CAPA 목록에서 실제로 조회됨');
  assert(capa.source_type === 'ergonomic' && capa.source_id === high.data.id, '이 조사와 정확히 연결됨');
  assert(capa.title.includes('자재 상차 작업'), '어떤 작업인지 제목에 담김');
  assert(capa.description.includes('중량물 취급'), '무엇이 문제인지 담겨 담당자가 바로 판단 가능');

  console.log('\n=== 4. 위험도가 높지 않으면 CAPA를 만들지 않는다 ===');
  const capasForOk = (await api('GET', '/capa', null, token)).data.filter((c) => c.source_id === ok.data.id);
  assert(capasForOk.length === 0, '보통 위험도에는 개선조치가 생기지 않음(불필요한 업무 방지)');

  console.log('\n=== 5. 강제로 "조사완료"를 보내도 고위험이면 막힌다 ===');
  const forced = await api('POST', '/ergonomic/surveys', {
    taskName: '강제완료 시도', riskLevel: '높음', status: '조사완료',
  }, token);
  const forcedRow = (await api('GET', '/ergonomic/surveys', null, token)).data.find((r) => r.id === forced.data.id);
  assert(forcedRow.status === '개선필요', '개선 대책 없이 완료 처리할 수 없음');

  const withFix = await api('POST', '/ergonomic/surveys', {
    taskName: '개선완료 작업', riskLevel: '높음',
    improvement: '리프트 테이블 설치로 허리 굽힘 제거', status: '개선완료',
  }, token);
  const fixRow = (await api('GET', '/ergonomic/surveys', null, token)).data.find((r) => r.id === withFix.data.id);
  assert(fixRow.status === '개선완료', '개선 대책을 적으면 개선완료로 등록 가능');

  console.log('\n=== 6. 증상 호소자 관리 (개인 건강정보) ===');
  const sym = await api('POST', '/ergonomic/symptoms', {
    workerName: '김근로', surveyId: high.data.id, reportDate: '2026-09-02',
    bodyPart: '허리', symptomLevel: '중등도', workRelated: '업무관련성 있음',
    actionTaken: '작업전환 및 물리치료 연계', followupDate: '2026-10-01',
  }, token);
  assert(sym.status === 201 && sym.data.id.startsWith('ERGS-'), `증상 접수 (${sym.data.id})`);
  const symRow = (await api('GET', '/ergonomic/symptoms', null, token)).data.find((r) => r.id === sym.data.id);
  assert(symRow.worker_name === '김근로' && symRow.body_part === '허리', '증상 내용이 정확히 저장됨');
  assert(symRow.survey_id === high.data.id, '어떤 작업 조사와 연결된 증상인지 추적 가능');
  assert(symRow.status === '접수', '초기 상태는 "접수"');

  console.log('\n=== 7. 조사와 증상은 별도로 조회된다 (증상자 명단이 작업 화면에 딸려나오지 않음) ===');
  const surveys = await api('GET', '/ergonomic/surveys', null, token);
  assert(!JSON.stringify(surveys.data).includes('김근로'), '작업 조사 목록에 증상자 이름이 섞여 나오지 않음(불필요한 노출 방지)');

  console.log('\n=== 8. 필수값 검증 ===');
  const noTask = await api('POST', '/ergonomic/surveys', { riskLevel: '보통' }, token);
  assert(noTask.status === 400, '조사 대상 작업 없이는 등록 불가');
  const noName = await api('POST', '/ergonomic/symptoms', { bodyPart: '어깨' }, token);
  assert(noName.status === 400, '대상자 성명 없이는 증상 등록 불가');

  console.log('\n=== 9. 공정·협력업체 연결 ===');
  const proc = await api('POST', '/processes', { name: '포장공정', kind: 'process' }, token);
  const ct = await api('POST', '/contractor', { companyName: '(주)한빛물류', repName: '이대표' }, token);
  const linked = await api('POST', '/ergonomic/surveys', {
    taskName: '연결테스트', processId: proc.data.id, relatedContractor: '한빛물류',
  }, token);
  const linkRow = (await api('GET', '/ergonomic/surveys', null, token)).data.find((r) => r.id === linked.data.id);
  assert(linkRow.process_id === proc.data.id, '공정 마스터데이터에 연결됨');
  assert(linkRow.contractor_id === ct.data.id, '협력업체도 자동 연결됨');

  console.log('\n=== 10. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'er.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'er.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bSurveys = await api('GET', '/ergonomic/surveys', null, bLogin.data.token);
  const bSymptoms = await api('GET', '/ergonomic/symptoms', null, bLogin.data.token);
  assert(bSurveys.data.length === 0, 'B사에서는 A사 조사가 보이지 않음');
  assert(bSymptoms.data.length === 0, 'B사에서는 A사 증상자 정보가 보이지 않음(민감정보 격리)');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
