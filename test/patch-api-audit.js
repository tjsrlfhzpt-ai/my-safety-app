// PATCH API(출시전 점검보고서 3절 "12개 모듈 PATCH API 부재") 검증 스크립트 - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
const Database = require('better-sqlite3');
const path = require('path');
const { bootstrapTestOrg } = require('./_helpers');

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, data };
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}

async function consent(token) {
  return api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);
}

(async () => {
  const orgResult = await bootstrapTestOrg(BASE);
  const org = { id: orgResult.orgId };
  const site = { id: orgResult.siteId };

  // 조직 최초 가입자 = company_admin 부트스트랩 (update 권한 보유)
  await api('POST', '/auth/register', { orgId: org.id, siteId: site.id, loginId: 'patch.admin', password: 'Test1234!', name: '관리자' });
  const adminLogin = await api('POST', '/auth/login', { loginId: 'patch.admin', password: 'Test1234!' });
  const adminToken = adminLogin.data.token;
  await consent(adminToken);

  // 일반 worker (update 권한 없음 - 기존 delete_any와 동일한 등급으로 부여했으므로)
  await api('POST', '/auth/register', { orgId: org.id, siteId: site.id, loginId: 'patch.worker', password: 'Test1234!', name: '근로자' });
  const workerLogin = await api('POST', '/auth/login', { loginId: 'patch.worker', password: 'Test1234!' });
  const workerToken = workerLogin.data.token;
  await consent(workerToken);

  // 다른 사업장 worker (사업장 경계 확인용)
  const rw = new Database(path.join(__dirname, '..', 'data.sqlite'));
  const siteBId = 'SITE-2026-PATCHTEST';
  rw.prepare('INSERT INTO sites (id, org_id, name) VALUES (?, ?, ?)').run(siteBId, org.id, '패치테스트 제2현장');
  rw.close();
  await api('POST', '/auth/register', { orgId: org.id, siteId: siteBId, loginId: 'patch.workerb', password: 'Test1234!', name: 'B현장근로자' });
  const workerBLogin = await api('POST', '/auth/login', { loginId: 'patch.workerb', password: 'Test1234!' });
  const workerBToken = workerBLogin.data.token;
  await consent(workerBToken);

  console.log('=== 1. 단순모듈(nearmiss) PATCH ===');
  const create1 = await api('POST', '/nearmiss', { content: '원본 내용 - 오타있음' }, adminToken);
  const patch1 = await api('PATCH', `/nearmiss/${create1.data.id}`, { content: '수정된 내용 - 오타 고침' }, adminToken);
  assert(patch1.status === 200, 'update 권한이 있으면 PATCH 성공');

  const list1 = await api('GET', '/nearmiss', null, adminToken);
  const found1 = list1.data.find((r) => r.id === create1.data.id);
  assert(found1 && found1.content === '수정된 내용 - 오타 고침', 'GET 목록에 수정된 내용이 실제로 반영됨');
  assert(found1 && found1.updated_by && found1.updated_at, 'updated_by/updated_at이 기록됨 (지침 10 - 변경이력)');

  const patchDenied = await api('PATCH', `/nearmiss/${create1.data.id}`, { content: '근로자가 시도' }, workerToken);
  assert(patchDenied.status === 403, 'worker(update 권한 없음)는 PATCH 시도 시 403');

  const patchEmpty = await api('PATCH', `/nearmiss/${create1.data.id}`, { content: '' }, adminToken);
  assert(patchEmpty.status === 400, '필수 필드(content)를 빈 값으로 바꾸려 하면 400');

  const patchNoField = await api('PATCH', `/nearmiss/${create1.data.id}`, {}, adminToken);
  assert(patchNoField.status === 400, '수정할 필드가 아예 없으면 400');

  console.log('\n=== 2. 사업장 경계 확인 (A현장에만 소속된 update권한 보유자 기준) ===');
  // adminToken은 조직 최초가입자=company_admin이라 조직전역 권한이 있어 B현장도 정상적으로
  // 볼 수 있어야 한다(의도된 동작 - 2-4/2-6절). 사업장 경계 자체를 확인하려면 "A현장에만
  // 소속된" update 권한 보유자가 필요하므로, patch.worker를 safety_manager로 승격시켜 쓴다.
  await api('PATCH', `/users/${(await api('GET', '/users', null, adminToken)).data.find((u) => u.loginId === 'patch.worker').id}/role`,
    { roleCode: 'safety_manager' }, adminToken);
  const reloginWorker = await api('POST', '/auth/login', { loginId: 'patch.worker', password: 'Test1234!' });
  const siteScopedMgrToken = reloginWorker.data.token;

  const create2 = await api('POST', '/nearmiss', { content: 'B현장 내용' }, workerBToken);
  const crossPatch = await api('PATCH', `/nearmiss/${create2.data.id}`, { content: 'A현장 관리자가 침범 시도' }, siteScopedMgrToken);
  assert(crossPatch.status === 404, 'A현장에만 소속된 관리자는 B현장 데이터를 PATCH할 수 없다 (404 - 존재 자체를 노출하지 않음)');

  const ownSitePatch = await api('PATCH', `/nearmiss/${create1.data.id}`, { content: 'A현장 관리자가 자기 현장 항목 수정' }, siteScopedMgrToken);
  assert(ownSitePatch.status === 200, '반면 같은(A) 현장 데이터는 정상적으로 PATCH할 수 있다');

  console.log('\n=== 3. 위험성평가 PATCH ===');
  const risk1 = await api('POST', '/risks', { hazard: '원본 위험요인', likelihood: 2, severity: 2 }, adminToken);
  assert(risk1.data.riskScore === 4 && risk1.data.autoCapaId === null, '낮은 점수(2x2=4)로 등록 시 CAPA 자동생성 안 됨');

  const patchHazardOnly = await api('PATCH', `/risks/${risk1.data.id}`, { hazard: '수정된 위험요인' }, adminToken);
  assert(patchHazardOnly.status === 200 && patchHazardOnly.data.riskScore === 4, 'hazard만 수정하면 점수는 그대로 유지됨');

  console.log('\n=== 4. 수정으로 점수가 새로 임계값을 넘으면 CAPA 자동생성 ===');
  const patchScoreUp = await api('PATCH', `/risks/${risk1.data.id}`, { likelihood: 5, severity: 5 }, adminToken);
  assert(patchScoreUp.status === 200 && patchScoreUp.data.riskScore === 25, '수정 후 점수가 재계산됨(5x5=25)');
  assert(!!patchScoreUp.data.autoCapaId, '새로 임계값(15점)을 넘었으므로 CAPA가 자동생성됨');

  const capaList = await api('GET', '/capa', null, adminToken);
  const linkedCapas = capaList.data.filter((c) => c.source_id === risk1.data.id);
  assert(linkedCapas.length === 1, '같은 위험성평가에 대해 CAPA가 정확히 1건만 생성됨(중복생성 아님)');

  console.log('\n=== 5. 이미 CAPA가 있는 상태에서 재수정해도 중복생성 안 됨 ===');
  const patchAgain = await api('PATCH', `/risks/${risk1.data.id}`, { hazard: '한번 더 수정' }, adminToken);
  assert(patchAgain.data.autoCapaId === null, '이미 CAPA가 있으면 재수정 시 autoCapaId는 null(추가생성 안 함)');
  const capaListAfter = await api('GET', '/capa', null, adminToken);
  const linkedCapasAfter = capaListAfter.data.filter((c) => c.source_id === risk1.data.id);
  assert(linkedCapasAfter.length === 1, '재수정 후에도 여전히 CAPA는 1건뿐');

  console.log('\n=== 6. 소프트삭제된 항목은 PATCH 대상에서 제외 ===');
  const create3 = await api('POST', '/nearmiss', { content: '삭제될 항목' }, adminToken);
  await api('DELETE', `/nearmiss/${create3.data.id}`, null, adminToken);
  const patchDeleted = await api('PATCH', `/nearmiss/${create3.data.id}`, { content: '삭제된 걸 수정 시도' }, adminToken);
  assert(patchDeleted.status === 404, '삭제된 항목은 PATCH할 수 없다(404)');

  console.log('\n=== 7. 사고(incident) 신고 시 CAPA 자동생성 (출시전 점검보고서 3절) ===');
  const accident1 = await api('POST', '/accident', { description: '지게차 후진 중 협착 사고' }, adminToken);
  assert(accident1.status === 201 && !!accident1.data.autoCapaId, '사고 신고 즉시(고위험 여부 무관) CAPA가 자동생성된다');
  const capaForAccident = await api('GET', '/capa', null, adminToken);
  assert(capaForAccident.data.some((c) => c.id === accident1.data.autoCapaId && c.source_type === 'incident' && c.source_id === accident1.data.id),
    '생성된 CAPA의 source_type=incident, source_id가 정확히 연결됨');

  console.log('\n=== 8. CAPA 수동 생성 API (출시전 점검보고서 3절 - 예전엔 자동생성 외 방법이 없었음) ===');
  const manualNoTitle = await api('POST', '/capa', { sourceType: 'report' }, adminToken);
  assert(manualNoTitle.status === 400, '제목 없이는 생성할 수 없다');

  const manualBadSource = await api('POST', '/capa', { title: '정기점검 발견사항', sourceType: 'not_a_real_type' }, adminToken);
  assert(manualBadSource.status === 400, '허용되지 않은 sourceType은 거부된다');

  const manualReport = await api('POST', '/capa', { title: '정기점검 중 발견한 노후 배선', description: '2동 지하 배전반' }, adminToken);
  assert(manualReport.status === 201, 'sourceType 생략 시 report(근거기록 없음)로 기본 처리되어 생성된다');

  const nm = await api('POST', '/nearmiss', { content: '연결 테스트용 아차사고' }, adminToken);
  const manualLinkedWrongSite = await api('POST', '/capa', { title: '침범시도', sourceType: 'near_miss', sourceId: 'NM-2026-NOTEXIST' }, adminToken);
  assert(manualLinkedWrongSite.status === 400, '존재하지 않는 sourceId를 연결하려 하면 거부된다');

  const manualLinked = await api('POST', '/capa', { title: '아차사고 후속조치', sourceType: 'near_miss', sourceId: nm.data.id }, adminToken);
  assert(manualLinked.status === 201, '실제 존재하는 아차사고를 근거로 CAPA를 수동 생성할 수 있다');
  const capaList2 = await api('GET', '/capa', null, adminToken);
  assert(capaList2.data.some((c) => c.id === manualLinked.data.id && c.source_type === 'near_miss' && c.source_id === nm.data.id),
    '수동 생성된 CAPA도 목록에서 올바른 source로 조회된다');

  const manualDenied = await api('POST', '/capa', { title: '권한없는 시도' }, workerBToken);
  assert(manualDenied.status === 403, 'worker(capa.update 없음)는 수동 CAPA 생성 API에 접근할 수 없다');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
