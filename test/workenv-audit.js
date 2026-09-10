// 작업환경측정 검증 (2026-09-02, 마스터 프롬프트 6·21·29절)
// 핵심: 노출기준을 넘었을 때 "기록만 남고 끝나지 않는가"
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '작업환경테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'we.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'we.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 기준 이내 측정 (정상) ===');
  const ok = await api('POST', '/workenv', {
    location: 'A동 조립부스', factorName: '소음', factorType: '물리적인자',
    measureDate: '2026-09-01', roundNo: '2026년 상반기',
    resultValue: '78', unit: 'dB', exposureLimit: '90', exceeded: 0,
    workerCount: 12, agency: '한국산업보건환경연구원', nextMeasureDate: '2027-03-01',
  }, token);
  assert(ok.status === 201 && ok.data.id.startsWith('WENV-'), `측정 등록 (${ok.data.id})`);
  const okRow = (await api('GET', '/workenv', null, token)).data.find((r) => r.id === ok.data.id);
  assert(okRow.status === '측정완료', '기준 이내면 "측정완료" 상태');
  assert(okRow.factor_name === '소음' && okRow.result_value === '78', '측정값이 정확히 저장됨');
  assert(okRow.exposure_limit === '90', '노출기준은 측정기관 통보값을 그대로 보관(코드에 고정하지 않음)');

  console.log('\n=== 2. 🔑 기준 초과 시 그냥 넘어가지 않는가 ===');
  const over = await api('POST', '/workenv', {
    location: 'B동 도장부스', factorName: '톨루엔', factorType: '화학적인자',
    measureDate: '2026-09-01', resultValue: '65', unit: 'ppm', exposureLimit: '50',
    exceeded: 1, workerCount: 5, agency: '한국산업보건환경연구원',
  }, token);
  assert(over.status === 201, '기준 초과 측정 등록');
  const overRow = (await api('GET', '/workenv', null, token)).data.find((r) => r.id === over.data.id);
  assert(overRow.status === '개선필요', '기준을 넘으면 자동으로 "개선필요" 상태가 됨(측정완료로 끝낼 수 없음)');
  assert(overRow.exceeded === 1, '초과 표시가 저장됨');

  console.log('\n=== 3. 🔑 개선조치(CAPA)가 자동으로 열리는가 (마스터 프롬프트 21절) ===');
  assert(!!over.data.autoCapaId, `개선조치가 자동 생성됨 (${over.data.autoCapaId})`);
  const capaList = await api('GET', '/capa', null, token);
  const capa = capaList.data.find((c) => c.id === over.data.autoCapaId);
  assert(!!capa, 'CAPA 목록에서 실제로 조회됨');
  assert(capa.source_type === 'workenv' && capa.source_id === over.data.id, '이 측정 기록과 정확히 연결됨(추적 가능)');
  assert(capa.title.includes('톨루엔') && capa.title.includes('B동 도장부스'), '무엇이 어디서 초과됐는지 제목에 담김');
  assert(capa.description.includes('65') && capa.description.includes('50'), '측정값과 기준값이 함께 기록되어 담당자가 바로 판단 가능');

  console.log('\n=== 4. 기준 이내인 측정은 CAPA를 만들지 않는다 (불필요한 업무 방지) ===');
  const capaForOk = capaList.data.filter((c) => c.source_id === ok.data.id);
  assert(capaForOk.length === 0, '정상 측정에는 개선조치가 생기지 않음');

  console.log('\n=== 5. 사용자가 강제로 "측정완료"를 보내도 초과면 막히는가 ===');
  const forced = await api('POST', '/workenv', {
    location: 'C동', factorName: '분진', resultValue: '20', exposureLimit: '10',
    exceeded: 1, status: '측정완료',
  }, token);
  const forcedRow = (await api('GET', '/workenv', null, token)).data.find((r) => r.id === forced.data.id);
  assert(forcedRow.status === '개선필요', '개선 내용 없이 "측정완료"로 보내도 "개선필요"로 유지됨');

  console.log('\n=== 6. 개선 내용을 적으면 상태를 넘길 수 있다 ===');
  const withFix = await api('POST', '/workenv', {
    location: 'D동', factorName: '분진', resultValue: '20', exposureLimit: '10',
    exceeded: 1, improvement: '국소배기장치 증설 완료', status: '개선완료',
  }, token);
  const fixRow = (await api('GET', '/workenv', null, token)).data.find((r) => r.id === withFix.data.id);
  assert(fixRow.status === '개선완료', '개선 내용을 함께 적으면 개선완료로 등록 가능');
  assert(fixRow.improvement === '국소배기장치 증설 완료', '개선 내용이 기록됨');

  console.log('\n=== 7. 필수값 검증 ===');
  const noLoc = await api('POST', '/workenv', { factorName: '소음' }, token);
  assert(noLoc.status === 400, '측정 지점 없이는 등록 불가');
  const noFactor = await api('POST', '/workenv', { location: 'A동' }, token);
  assert(noFactor.status === 400, '유해인자명 없이는 등록 불가');

  console.log('\n=== 8. 공정·협력업체 연결 ===');
  const proc = await api('POST', '/processes', { name: '도장공정', kind: 'process' }, token);
  const ct = await api('POST', '/contractor', { companyName: '(주)대한도장', repName: '김대표' }, token);
  const linked = await api('POST', '/workenv', {
    location: 'E동', factorName: '유기용제', processId: proc.data.id, relatedContractor: '대한도장',
  }, token);
  const linkRow = (await api('GET', '/workenv', null, token)).data.find((r) => r.id === linked.data.id);
  assert(linkRow.process_id === proc.data.id, '공정 마스터데이터에 연결됨');
  assert(linkRow.contractor_id === ct.data.id, '협력업체도 자동 연결됨(표기가 달라도)');

  console.log('\n=== 9. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'we.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'we.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bList = await api('GET', '/workenv', null, bLogin.data.token);
  assert(bList.data.length === 0, 'B사에서는 A사 측정 기록이 보이지 않음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
