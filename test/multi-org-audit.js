// 멀티테넌트(여러 조직) 데이터 격리 검증 - 리뷰/회귀테스트 전용
// 2026-08-28: "여러 고객사를 위한 SaaS로 간다"는 결정에 따라, 지금까지 단 한 번도
// 직접 검증하지 않았던 "서로 다른 조직 간 데이터가 실제로 격리되는가"를 철저히 확인한다.
const BASE = 'http://localhost:4000';

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
  console.log('=== 0. 조직 생성 API 자체 검증 ===');
  const noName = await api('POST', '/organizations', {});
  assert(noName.status === 400, '조직명 없이는 생성할 수 없다');

  const orgA = await api('POST', '/organizations', { name: 'A건설(주)', bizRegNo: '000-00-00000', siteName: 'A본사현장' });
  assert(orgA.status === 201 && !!orgA.data.orgId && !!orgA.data.siteId, '조직 A 생성 성공 (초기 사업장까지 한 번에)');

  const orgB = await api('POST', '/organizations', { name: 'B건설(주)', bizRegNo: '000-00-00000', siteName: 'B본사현장' });
  assert(orgB.status === 201 && !!orgB.data.orgId, '조직 B 생성 성공');
  assert(orgA.data.orgId !== orgB.data.orgId, '두 조직의 id가 서로 다름');

  console.log('\n=== 1. 각 조직 부트스트랩 관리자 준비 ===');
  await api('POST', '/auth/register', { orgId: orgA.data.orgId, siteId: orgA.data.siteId, loginId: 'a.admin', password: 'Test1234!', name: 'A관리자' });
  const loginA = await api('POST', '/auth/login', { loginId: 'a.admin', password: 'Test1234!' });
  const tokenA = loginA.data.token;
  await consent(tokenA);
  assert(loginA.status === 200, 'A조직 관리자 로그인 성공');

  await api('POST', '/auth/register', { orgId: orgB.data.orgId, siteId: orgB.data.siteId, loginId: 'b.admin', password: 'Test1234!', name: 'B관리자' });
  const loginB = await api('POST', '/auth/login', { loginId: 'b.admin', password: 'Test1234!' });
  const tokenB = loginB.data.token;
  await consent(tokenB);
  assert(loginB.status === 200, 'B조직 관리자 로그인 성공');

  console.log('\n=== 2. 사업장 목록 격리 ===');
  const sitesA = await api('GET', '/sites', null, tokenA);
  assert(sitesA.data.length === 1 && sitesA.data[0].id === orgA.data.siteId, 'A조직 관리자는 A조직 사업장(1개)만 본다');
  const sitesB = await api('GET', '/sites', null, tokenB);
  assert(sitesB.data.length === 1 && sitesB.data[0].id === orgB.data.siteId, 'B조직 관리자는 B조직 사업장(1개)만 본다');

  console.log('\n=== 3. 사용자 목록 격리 ===');
  const usersA = await api('GET', '/users', null, tokenA);
  assert(usersA.data.length === 1 && usersA.data[0].loginId === 'a.admin', 'A조직 관리자는 A조직 사용자만 본다 (B관리자가 안 보임)');
  const usersB = await api('GET', '/users', null, tokenB);
  assert(usersB.data.length === 1 && usersB.data[0].loginId === 'b.admin', 'B조직 관리자는 B조직 사용자만 본다 (A관리자가 안 보임)');

  console.log('\n=== 4. 사용자 관리 API 조직 경계 (직접 침범 시도) ===');
  const usersAllA = await api('GET', '/users', null, tokenA);
  const bAdminIdFromA = usersAllA.data.find((u) => u.loginId === 'b.admin');
  assert(!bAdminIdFromA, 'A조직 목록에는 B관리자의 id 자체가 노출되지 않음');
  // B관리자의 실제 id를 알아내서(B 본인 토큰으로) A가 그 id로 직접 조작을 시도
  const bAdminId = usersB.data[0].id;
  const crossOrgRoleChange = await api('PATCH', `/users/${bAdminId}/role`, { roleCode: 'worker' }, tokenA);
  assert(crossOrgRoleChange.status === 404, 'A조직 관리자가 B조직 사용자 id를 알아내 직접 역할변경을 시도해도 404(대상 없음)로 막힘');
  const crossOrgStatusChange = await api('PATCH', `/users/${bAdminId}/status`, { accountStatus: 'disabled' }, tokenA);
  assert(crossOrgStatusChange.status === 404, 'A조직 관리자가 B조직 사용자를 직접 비활성화 시도해도 404로 막힘');

  console.log('\n=== 5. 안전관리 데이터 격리 (위험성평가·아차사고) ===');
  const workerA = await api('POST', '/auth/register', { orgId: orgA.data.orgId, siteId: orgA.data.siteId, loginId: 'a.worker', password: 'Test1234!', name: 'A근로자' });
  const loginWorkerA = await api('POST', '/auth/login', { loginId: 'a.worker', password: 'Test1234!' });
  await consent(loginWorkerA.data.token);
  await api('POST', '/risks', { hazard: 'A조직 기밀 위험요인 - B가 보면 안 됨' }, loginWorkerA.data.token);

  const workerB = await api('POST', '/auth/register', { orgId: orgB.data.orgId, siteId: orgB.data.siteId, loginId: 'b.worker', password: 'Test1234!', name: 'B근로자' });
  const loginWorkerB = await api('POST', '/auth/login', { loginId: 'b.worker', password: 'Test1234!' });
  await consent(loginWorkerB.data.token);
  await api('POST', '/risks', { hazard: 'B조직 기밀 위험요인 - A가 보면 안 됨' }, loginWorkerB.data.token);

  const risksA = await api('GET', '/risks', null, tokenA); // A조직 관리자(조직전역)
  assert(risksA.data.length === 1 && risksA.data[0].hazard.includes('A조직'), 'A조직 관리자(조직전역 권한)는 A조직 위험성평가만 본다 - B조직 내용 안 보임');
  const risksB = await api('GET', '/risks', null, tokenB);
  assert(risksB.data.length === 1 && risksB.data[0].hazard.includes('B조직'), 'B조직 관리자도 마찬가지로 B조직 것만 본다');

  console.log('\n=== 6. 같은 형식의 id가 서로 다른 조직에서 각각 독립적으로 생성됨 (2-2절 수정이 조직 경계에서도 유효한지) ===');
  const nmA = await api('POST', '/nearmiss', { id: 'NM-2026-999900', content: 'A조직 아차사고' }, loginWorkerA.data.token);
  const nmB = await api('POST', '/nearmiss', { id: 'NM-2026-999900', content: 'B조직 아차사고' }, loginWorkerB.data.token);
  assert(nmA.status === 201 && nmA.data.id === 'NM-2026-999900', 'A조직이 먼저 그 id를 정상적으로 씀');
  assert(nmB.status === 201 && nmB.data.idReassigned === true, 'B조직은 같은 id가 이미 다른 조직에 있어 자동으로 재채번됨(데이터 유실 없이)');
  const nmListB = await api('GET', '/nearmiss', null, tokenB);
  assert(nmListB.data.some((r) => r.content === 'B조직 아차사고'), 'B조직의 아차사고 내용이 실제로 저장·조회됨(유실 안 됨)');

  console.log('\n=== 7. 첨부파일 조직 경계 ===');
  const riskAId = risksA.data[0].id;
  const form = new FormData();
  form.append('entityType', 'risk_assessment');
  form.append('entityId', riskAId);
  form.append('file', new Blob([Buffer.from('A조직 기밀 파일')]), 'secret.pdf');
  const uploadA = await fetch(BASE + '/attachments', { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form });
  assert(uploadA.status === 201, 'A조직 관리자가 자기 조직 위험성평가에 첨부파일 업로드');
  const uploadAData = await uploadA.json();

  const downloadFromB = await fetch(`${BASE}/attachments/${uploadAData.id}/download`, { headers: { Authorization: `Bearer ${tokenB}` } });
  assert(downloadFromB.status === 404, 'B조직 관리자는 A조직의 첨부파일을 다운로드할 수 없다(404)');

  console.log('\n=== 8. 법정 체크리스트(85개) 조직 경계 ===');
  const complianceA = await api('GET', '/compliance', null, tokenA);
  const complianceB = await api('GET', '/compliance', null, tokenB);
  assert(complianceA.data.length === 85 && complianceB.data.length === 85, '두 조직 모두 85개 항목이 독립적으로 존재함(서로 공유 안 됨)');
  const item1A = complianceA.data.find((it) => it.item_no === 1);
  await api('PATCH', `/compliance/${item1A.id}`, { checked: true, note: 'A조직 메모' }, tokenA);
  const complianceBAfter = await api('GET', '/compliance', null, tokenB);
  const item1B = complianceBAfter.data.find((it) => it.item_no === 1);
  assert(item1B.checked === 0 || item1B.checked === false, 'A조직에서 체크해도 B조직의 같은 항목(1번)은 영향받지 않음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
