// 비밀번호 분실 복구 검증 (2026-09-02)
// 관리자가 임시 비밀번호를 발급 → 사용자가 로그인 → 반드시 새 비밀번호로 변경
const BASE = 'http://localhost:4000';
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
const consent = (t) => api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, t);

(async () => {
  console.log('=== 0. 조직/관리자/근로자 준비 ===');
  const orgA = await api('POST', '/organizations', { name: 'A사', siteName: 'A현장' });
  await api('POST', '/auth/register', { orgId: orgA.data.orgId, siteId: orgA.data.siteId, loginId: 'pw.admin', password: 'Test1234!', name: '관리자' });
  const admin = await api('POST', '/auth/login', { loginId: 'pw.admin', password: 'Test1234!' });
  const adminToken = admin.data.token;
  await consent(adminToken);

  await api('POST', '/auth/register', { orgId: orgA.data.orgId, siteId: orgA.data.siteId, loginId: 'pw.worker', password: 'Original123!', name: '근로자' });
  const users = await api('GET', '/users', null, adminToken);
  const worker = users.data.find((u) => u.loginId === 'pw.worker');
  assert(!!worker, '근로자 계정 준비 완료');

  console.log('\n=== 1. 권한 없는 사람은 남의 비밀번호를 초기화할 수 없다 ===');
  const wLogin = await api('POST', '/auth/login', { loginId: 'pw.worker', password: 'Original123!' });
  await consent(wLogin.data.token);
  const denied = await api('POST', `/users/${worker.id}/reset-password`, {}, wLogin.data.token);
  assert(denied.status === 403, '일반 근로자(user.manage 없음)는 초기화 API에 접근할 수 없음');

  console.log('\n=== 2. 다른 회사 사용자는 초기화할 수 없다 (조직 경계) ===');
  const orgB = await api('POST', '/organizations', { name: 'B사', siteName: 'B현장' });
  await api('POST', '/auth/register', { orgId: orgB.data.orgId, siteId: orgB.data.siteId, loginId: 'b.admin', password: 'Test1234!', name: 'B관리자' });
  const bAdmin = await api('POST', '/auth/login', { loginId: 'b.admin', password: 'Test1234!' });
  await consent(bAdmin.data.token);
  const crossOrg = await api('POST', `/users/${worker.id}/reset-password`, {}, bAdmin.data.token);
  assert(crossOrg.status === 404, 'B사 관리자가 A사 근로자의 id를 알아내도 초기화할 수 없음');

  console.log('\n=== 3. 관리자가 임시 비밀번호를 발급한다 ===');
  const reset = await api('POST', `/users/${worker.id}/reset-password`, {}, adminToken);
  assert(reset.status === 200 && !!reset.data.temporaryPassword, '임시 비밀번호가 발급됨');
  const temp = reset.data.temporaryPassword;
  assert(temp.length >= 12, `임시 비밀번호가 충분히 길다 (${temp.length}자)`);
  assert(!/[0O1lI]/.test(temp), '혼동되는 문자(0/O/1/l/I)가 없어 전화로 불러주기 쉬움');
  assert(!!reset.data.notice, '한 번만 표시된다는 안내가 함께 옴');

  console.log('\n=== 4. 기존 비밀번호는 즉시 무효가 된다 ===');
  const oldTry = await api('POST', '/auth/login', { loginId: 'pw.worker', password: 'Original123!' });
  assert(oldTry.status === 401, '초기화 이후 예전 비밀번호로는 로그인할 수 없음');

  console.log('\n=== 5. 임시 비밀번호로 로그인하면 변경을 요구한다 ===');
  const tempLogin = await api('POST', '/auth/login', { loginId: 'pw.worker', password: temp });
  assert(tempLogin.status === 200, '임시 비밀번호로 로그인 성공');
  assert(tempLogin.data.user.mustChangePassword === true, '로그인 응답이 "비밀번호를 바꿔야 함"을 알려줌');
  const tempToken = tempLogin.data.token;

  console.log('\n=== 6. 비밀번호 변경 규칙 ===');
  const tooShort = await api('POST', '/auth/change-password', { currentPassword: temp, newPassword: 'short' }, tempToken);
  assert(tooShort.status === 400, '8자 미만은 거부됨');
  const wrongCurrent = await api('POST', '/auth/change-password', { currentPassword: 'wrong-one', newPassword: 'BrandNew123!' }, tempToken);
  assert(wrongCurrent.status === 400, '현재 비밀번호가 틀리면 거부됨(자리 비운 사이 남이 못 바꾸게)');
  const sameAgain = await api('POST', '/auth/change-password', { currentPassword: temp, newPassword: temp }, tempToken);
  assert(sameAgain.status === 400, '이전과 같은 비밀번호로는 바꿀 수 없음');

  console.log('\n=== 7. 실제로 변경하면 플래그가 풀린다 ===');
  const changed = await api('POST', '/auth/change-password', { currentPassword: temp, newPassword: 'BrandNew123!' }, tempToken);
  assert(changed.status === 200, '새 비밀번호로 변경 성공');
  const newLogin = await api('POST', '/auth/login', { loginId: 'pw.worker', password: 'BrandNew123!' });
  assert(newLogin.status === 200, '새 비밀번호로 로그인됨');
  assert(newLogin.data.user.mustChangePassword === false, '변경 완료 후에는 더 이상 변경을 요구하지 않음');
  const tempAgain = await api('POST', '/auth/login', { loginId: 'pw.worker', password: temp });
  assert(tempAgain.status === 401, '임시 비밀번호는 더 이상 쓸 수 없음');

  console.log('\n=== 8. 잠긴 계정도 함께 풀린다 (실제 문의 상황) ===');
  for (let i = 0; i < 6; i++) await api('POST', '/auth/login', { loginId: 'pw.worker', password: 'wrong' });
  const locked = await api('POST', '/auth/login', { loginId: 'pw.worker', password: 'BrandNew123!' });
  assert(locked.status !== 200, '연속 실패로 계정이 잠김');
  const reset2 = await api('POST', `/users/${worker.id}/reset-password`, {}, adminToken);
  const afterUnlock = await api('POST', '/auth/login', { loginId: 'pw.worker', password: reset2.data.temporaryPassword });
  assert(afterUnlock.status === 200, '초기화하면 잠금도 함께 풀려 바로 로그인됨(대부분 잠긴 채로 문의가 오므로)');

  console.log('\n=== 9. 임시 비밀번호가 감사로그에 남지 않는지 (평문 노출 방지) ===');
  const Database = require('better-sqlite3');
  const path = require('path');
  const db = new Database(path.join(__dirname, '..', 'data.sqlite'), { readonly: true });
  const logs = db.prepare("SELECT after_json FROM audit_logs WHERE entity_type = 'user'").all();
  db.close();
  const leaked = logs.some((l) => l.after_json && (l.after_json.includes(temp) || l.after_json.includes(reset2.data.temporaryPassword)));
  assert(!leaked, '임시 비밀번호 평문이 감사로그에 남지 않음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
