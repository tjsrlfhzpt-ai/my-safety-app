// 신규 관리자 API(sites.js, users.js) 검증 스크립트 - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
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

(async () => {
  console.log('=== 0. 부트스트랩 관리자 생성 (조직 최초 가입 -> company_admin 자동 부여) ===');
  const orgResult = await bootstrapTestOrg(BASE);
  const org = { id: orgResult.orgId };

  const boot = await api('POST', '/auth/register', {
    orgId: org.id, loginId: 'admin.boot', password: 'Test1234!', name: '부트관리자',
  });
  assert(boot.status === 201 && boot.data.roleCode === 'company_admin' && boot.data.bootstrap === true,
    '조직 최초 가입자는 company_admin으로 자동 부트스트랩된다');

  const bootLogin = await api('POST', '/auth/login', { loginId: 'admin.boot', password: 'Test1234!' });
  const bootToken = bootLogin.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bootToken);

  console.log('\n=== 1. 사업장(현장) 추가 API ===');
  const noAuth = await api('POST', '/sites', { name: '무단시도현장' });
  assert(noAuth.status === 401, '인증 없이 사업장 생성 시도 -> 401');

  const siteA = await api('POST', '/sites', { name: '본사 사업장' }, bootToken);
  assert(siteA.status === 201 && !!siteA.data.id, 'company_admin은 사업장을 생성할 수 있다');

  const siteB = await api('POST', '/sites', { name: '제2현장' }, bootToken);
  assert(siteB.status === 201 && siteB.data.id !== siteA.data.id, '두 번째 사업장도 정상 생성된다 (2-4절 핵심 - 예전엔 API 자체가 없었음)');

  const siteList = await api('GET', '/sites', null, bootToken);
  const hasA = siteList.data && siteList.data.some((s) => s.id === siteA.data.id);
  const hasB = siteList.data && siteList.data.some((s) => s.id === siteB.data.id);
  assert(siteList.status === 200 && hasA && hasB, 'GET /sites로 방금 만든 두 사업장이 실제로 조회된다');

  console.log('\n=== 2. 사업장별 worker 등록 (일반 가입은 site.settings 없어도 됨) ===');
  const workerA = await api('POST', '/auth/register', { orgId: org.id, siteId: siteA.data.id, loginId: 'worker.a', password: 'Test1234!', name: 'A현장근로자' });
  const workerB = await api('POST', '/auth/register', { orgId: org.id, siteId: siteB.data.id, loginId: 'worker.b', password: 'Test1234!', name: 'B현장근로자' });
  assert(workerA.status === 201 && workerA.data.roleCode === 'worker', 'A현장 근로자 등록 (worker로 시작)');
  assert(workerB.status === 201 && workerB.data.roleCode === 'worker', 'B현장 근로자 등록 (worker로 시작)');

  console.log('\n=== 3. company_admin의 조직전역 조회 (여러 사업장 데이터를 한번에) ===');
  const loginWorkerA = await api('POST', '/auth/login', { loginId: 'worker.a', password: 'Test1234!' });
  const tokenWorkerA = loginWorkerA.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenWorkerA);
  await api('POST', '/risks', { hazard: 'A현장 위험요인' }, tokenWorkerA);

  const loginWorkerB = await api('POST', '/auth/login', { loginId: 'worker.b', password: 'Test1234!' });
  const tokenWorkerB = loginWorkerB.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenWorkerB);
  await api('POST', '/risks', { hazard: 'B현장 위험요인' }, tokenWorkerB);

  const adminRiskView = await api('GET', '/risks', null, bootToken);
  const seesRiskA = adminRiskView.data && adminRiskView.data.some((r) => r.hazard === 'A현장 위험요인');
  const seesRiskB = adminRiskView.data && adminRiskView.data.some((r) => r.hazard === 'B현장 위험요인');
  assert(adminRiskView.status === 200 && seesRiskA && seesRiskB,
    'company_admin은 GET /risks에서 A/B 두 사업장 데이터를 모두 본다 (README가 "권한상 가능"이라 했던 것을 실제로 동작하게 함)');

  const workerARiskView = await api('GET', '/risks', null, tokenWorkerA);
  assert(workerARiskView.status === 200 && workerARiskView.data.length === 1,
    '반면 일반 worker는 여전히 자기 사업장(A) 데이터 1건만 본다 (사업장 격리 유지 확인)');

  console.log('\n=== 4. 사용자 관리 API ===');
  const usersNoManage = await api('GET', '/users', null, tokenWorkerA);
  assert(usersNoManage.status === 403, '일반 worker는 사용자 목록을 볼 수 없다 (user.manage 없음)');

  const usersList = await api('GET', '/users', null, bootToken);
  const seesA = usersList.data && usersList.data.some((u) => u.id === workerA.data.id);
  const seesB = usersList.data && usersList.data.some((u) => u.id === workerB.data.id);
  assert(usersList.status === 200 && seesA && seesB, 'company_admin은 방금 만든 사업장(A/B) 소속 사용자까지 모두 본다 (로그인 이후 생성된 사업장도 실시간 반영)');

  console.log('\n=== 5. 역할 변경 - 상위 역할은 org.settings 보유자만 ===');
  const selfRoleChange = await api('PATCH', `/users/${boot.data.id}/role`, { roleCode: 'worker' }, bootToken);
  assert(selfRoleChange.status === 400, '관리자는 스스로의 역할을 바꿀 수 없다 (본인 잠금 방지)');

  const promote = await api('PATCH', `/users/${workerA.data.id}/role`, { roleCode: 'safety_manager' }, bootToken);
  assert(promote.status === 200 && promote.data.roleCode === 'safety_manager', 'company_admin이 A현장 근로자를 안전관리자로 승격시킬 수 있다');

  // 이제 workerA는 safety_manager (user.manage 없음) - site_admin으로 스스로/타인을 승격 시도해야 함
  const reloginA = await api('POST', '/auth/login', { loginId: 'worker.a', password: 'Test1234!' });
  const tokenSafetyMgrA = reloginA.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenSafetyMgrA);
  const escalateAttempt = await api('PATCH', `/users/${workerB.data.id}/role`, { roleCode: 'company_admin' }, tokenSafetyMgrA);
  assert(escalateAttempt.status === 403, 'safety_manager(user.manage 없음)는 애초에 역할변경 API 자체에 접근 불가 (403)');

  console.log('\n=== 6. 계정 잠금 → 해제 (2-5절 핵심) ===');
  for (let i = 0; i < 5; i++) {
    await api('POST', '/auth/login', { loginId: 'worker.b', password: 'wrong-password' });
  }
  const lockedLogin = await api('POST', '/auth/login', { loginId: 'worker.b', password: 'Test1234!' });
  assert(lockedLogin.status === 423, '5회 실패 후에는 올바른 비밀번호로도 로그인이 423(Locked)으로 잠긴다 (기존 동작)');

  const beforeFix = 'DB를 직접 열어야만 풀 수 있었음(예전)';
  const unlock = await api('PATCH', `/users/${workerB.data.id}/status`, { accountStatus: 'active' }, bootToken);
  assert(unlock.status === 200, `관리자가 API로 잠금을 해제할 수 있다 (${beforeFix} → 이제는 API로 가능)`);

  const afterUnlockLogin = await api('POST', '/auth/login', { loginId: 'worker.b', password: 'Test1234!' });
  assert(afterUnlockLogin.status === 200, '잠금 해제 후 정상 비밀번호로 다시 로그인된다');
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, afterUnlockLogin.data.token);

  console.log('\n=== 7. 계정 비활성화 → 이미 발급된 토큰도 즉시 차단 ===');
  const tokenBeforeDisable = afterUnlockLogin.data.token;
  const stillWorks = await api('GET', '/risks', null, tokenBeforeDisable);
  assert(stillWorks.status === 200, '비활성화 전에는 기존 토큰이 정상 동작한다');

  await api('PATCH', `/users/${workerB.data.id}/status`, { accountStatus: 'disabled' }, bootToken);
  const afterDisable = await api('GET', '/risks', null, tokenBeforeDisable);
  assert(afterDisable.status === 403, '비활성화 즉시, 만료 전인 기존 토큰도 다음 요청부터 차단된다 (JWT 자체 폐기는 불가능하지만 사실상 동일 효과)');

  const selfDisable = await api('PATCH', `/users/${boot.data.id}/status`, { accountStatus: 'disabled' }, bootToken);
  assert(selfDisable.status === 400, '관리자는 스스로를 비활성화할 수 없다 (전원 잠금 방지)');

  console.log('\n=== 8. 개인정보 동의 게이트 (2-3절) ===');
  await api('POST', '/auth/register', { orgId: org.id, siteId: siteA.data.id, loginId: 'consent.test', password: 'Test1234!', name: '동의테스트' });
  const freshLogin = await api('POST', '/auth/login', { loginId: 'consent.test', password: 'Test1234!' });
  assert(freshLogin.data.user && freshLogin.data.user.needsConsent === true, '신규 계정은 로그인 응답에 needsConsent: true가 포함된다');

  const beforeConsent = await api('POST', '/risks', { hazard: '동의 전 시도' }, freshLogin.data.token);
  assert(beforeConsent.status === 403, '동의 전에는 서버가 실제 데이터작업을 막는다 (프론트만 믿지 않고 서버에서도 검증 - 지침 8번)');

  const consentIncomplete = await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: false }, freshLogin.data.token);
  assert(consentIncomplete.status === 400, '세 항목 중 하나라도 빠지면 동의 처리가 거부된다');

  const consentOk = await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, freshLogin.data.token);
  assert(consentOk.status === 200, '세 항목 모두 동의하면 정상 처리된다');

  const afterConsent = await api('POST', '/risks', { hazard: '동의 후 시도' }, freshLogin.data.token);
  assert(afterConsent.status === 201, '동의 후에는 정상적으로 데이터작업이 가능하다');

  console.log('\n=== 9. 회원탈퇴 (2-3절) ===');
  const withdrawWrongPw = await api('POST', '/auth/withdraw', { password: 'wrong' }, freshLogin.data.token);
  assert(withdrawWrongPw.status === 401, '잘못된 비밀번호로는 탈퇴할 수 없다');

  const withdrawOk = await api('POST', '/auth/withdraw', { password: 'Test1234!' }, freshLogin.data.token);
  assert(withdrawOk.status === 200, '올바른 비밀번호로 탈퇴 처리된다');

  const reLoginAfterWithdraw = await api('POST', '/auth/login', { loginId: 'consent.test', password: 'Test1234!' });
  assert(reLoginAfterWithdraw.status === 401, '탈퇴 후에는 같은 아이디/비밀번호로 로그인할 수 없다 (익명화됨)');

  const reRegisterSameId = await api('POST', '/auth/register', { orgId: org.id, siteId: siteA.data.id, loginId: 'consent.test', password: 'Test1234!', name: '재가입' });
  assert(reRegisterSameId.status === 201, '탈퇴 후 같은 아이디로 재가입할 수 있다 (완전 익명화 + 재사용 가능 확인)');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('스크립트 오류:', e); process.exit(1); });
