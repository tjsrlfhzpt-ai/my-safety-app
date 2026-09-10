// 출시전 점검보고서(2-1, 2-2절) 재현·재검증용 스크립트 (배포 대상 아님, 리뷰/회귀테스트 전용)
//
// 사용법:
//   1) safety-meerkat-server 폴더에 이 파일을 test/security-audit.js로 넣는다
//      (better-sqlite3를 require하므로 서버의 node_modules 안에서 실행해야 함)
//   2) 별도 터미널에서 서버를 로컬 테스트용으로 기동: JWT_SECRET=dev node server.js
//   3) node test/security-audit.js
//
// 가설 A: /auth/register가 인증 없이 열려있고 roleCode를 그대로 신뢰 -> 권한상승 가능한가?
//         (수정 후 재실행 시 4번 단계가 403/401 등으로 막혀야 정상)
// 가설 B: 서버-제공/클라이언트-제공 id 중복확인이 site_id로 스코핑되지 않아
//         서로 다른 site가 같은 id를 보내면 두번째 site의 데이터가 조용히 유실되는가?
//         (수정 후 재실행 시 B현장 목록에 데이터가 실제로 존재해야 정상)
//
// ⚠️ 이 스크립트는 서버에 실제로 테스트 계정/데이터를 만듭니다. 운영 서버가 아니라
//    로컬 테스트용 서버(빈 data.sqlite)에 대해서만 실행하세요.

const BASE = 'http://localhost:4000';
const Database = require('better-sqlite3');
const path = require('path');
const { bootstrapTestOrg } = require('./_helpers');

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  const json = Buffer.from(payload, 'base64').toString('utf-8');
  return JSON.parse(json);
}

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, data };
}

(async () => {
  console.log('========================================');
  console.log('[가설 A] 공개 /auth/register + 임의 roleCode 권한상승 검증');
  console.log('========================================');

  // 1) 정상적인 방법으로 "가장 낮은 권한" worker 계정을 하나 만든다.
  //    이때 orgId는 이미 알고 있다고 가정 (신규 입사자 온보딩 시 회사가 나눠줘야 하는 값이므로
  //    실제로는 이 값 자체가 이미 "비밀"로 취급되기 어렵다 - 아래 3)에서 이것 없이도
  //    뚫리는 것을 보여준다)
  const orgResult = await bootstrapTestOrg(BASE);
  const org = { id: orgResult.orgId };
  const site = { id: orgResult.siteId };
  console.log('실제 orgId (테스트 편의상 조회):', org.id);

  const reg1 = await api('POST', '/auth/register', {
    orgId: org.id, siteId: site.id, loginId: 'audit.worker1', password: 'pw12345!', name: '감사용근로자',
    roleCode: 'worker',
  });
  console.log('1) 최하위 worker 계정 자가등록 ->', reg1.status);

  const login1 = await api('POST', '/auth/login', { loginId: 'audit.worker1', password: 'pw12345!' });
  console.log('2) worker 로그인 ->', login1.status);
  const workerToken = login1.data.token;
  // 2026-08-28(2-3절): 로그인 직후 동의하지 않으면 서버가 데이터 작업을 막는다 - 이 검증
  // 스크립트는 그 자체가 아니라 다른 두 취약점을 확인하는 것이 목적이므로 여기서 처리해둔다.
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, workerToken);

  // 2) 이 worker는 orgId를 "몰라야 정상"이지만, JWT payload를 스스로 디코딩하면 바로 얻어낼 수 있다.
  const decoded = decodeJwtPayload(workerToken);
  console.log('3) worker 자신의 JWT를 base64 디코딩해서 얻어낸 orgId:', decoded.orgId, '(JWT는 서명만 될 뿐 암호화되지 않음)');

  // 3) 그 orgId로, 인증 토큰 없이(!) roleCode=super_admin으로 새 계정을 자가등록한다.
  const escalate = await api('POST', '/auth/register', {
    orgId: decoded.orgId, siteId: decoded.siteId,
    loginId: 'audit.selfmademe.superadmin', password: 'pw12345!', name: '셀프임명관리자',
    roleCode: 'super_admin',
  });
  console.log('4) 인증 토큰 없이 roleCode=super_admin 으로 자가등록 시도 ->', escalate.status, escalate.data);

  const loginAdmin = await api('POST', '/auth/login', { loginId: 'audit.selfmademe.superadmin', password: 'pw12345!' });
  console.log('5) 방금 만든 계정으로 로그인 ->', loginAdmin.status, 'roles=', loginAdmin.data.user && loginAdmin.data.user.roles);
  const fakeAdminToken = loginAdmin.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, fakeAdminToken);

  // 4) 실제로 super_admin 전용 동작(capa.approve)이 통과하는지 증명한다.
  const risk = await api('POST', '/risks', { hazard: '감사용 위험요인' }, workerToken);
  const capaProbe = await api('PATCH', `/capa/${risk.data.autoCapaId || 'CAPA-NONE'}/status`, { status: '조치중' }, fakeAdminToken);
  console.log('6) 셀프임명 관리자가 CAPA 상태를 실제로 변경 ->', capaProbe.status, capaProbe.data);

  console.log('\n=> 결론: 인증되지 않은 사용자가 조직ID만 알면(혹은 최하위 계정으로 로그인해 JWT를 디코딩하면)');
  console.log('   인증 없이 POST 한 번으로 최고권한 계정을 스스로 만들 수 있는가?');
  const gotSuperAdmin = !!(loginAdmin.data.user && loginAdmin.data.user.roles && loginAdmin.data.user.roles.includes('super_admin'));
  console.log('   실제 확인됨 =', gotSuperAdmin, gotSuperAdmin ? '(취약함 - 수정 필요)' : '(막혀있음 - 정상)');

  console.log('\n========================================');
  console.log('[가설 B] site 간 id 충돌 시 두번째 site 데이터 유실 검증');
  console.log('========================================');

  // Site B를 API가 아니라 DB에 직접 추가 (현재 이 기능을 만들 API 자체가 없음 - 그 자체가 발견사항)
  const rw = new Database(path.join(__dirname, '..', 'data.sqlite'));
  const siteBId = 'SITE-2026-TESTB01';
  rw.prepare('INSERT INTO sites (id, org_id, name) VALUES (?, ?, ?)').run(siteBId, org.id, '테스트용 제2현장');
  rw.close();

  const regA = await api('POST', '/auth/register', { orgId: org.id, siteId: site.id, loginId: 'audit.sitea.worker', password: 'pw12345!', name: 'A현장근로자', roleCode: 'worker' });
  const regB = await api('POST', '/auth/register', { orgId: org.id, siteId: siteBId, loginId: 'audit.siteb.worker', password: 'pw12345!', name: 'B현장근로자', roleCode: 'worker' });
  const loginA = await api('POST', '/auth/login', { loginId: 'audit.sitea.worker', password: 'pw12345!' });
  const loginB = await api('POST', '/auth/login', { loginId: 'audit.siteb.worker', password: 'pw12345!' });
  const tokenA = loginA.data.token;
  const tokenB = loginB.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenA);
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenB);
  console.log('1) 서로 다른 site(A, B) worker 두 명 등록/로그인 완료');

  // 두 site의 "기기"가 각자 오프라인 상태에서 독립적으로 같은 로컬 카운터로 채번했다고 가정 ->
  // 둘 다 우연히 "NM-2026-000001"을 만들어 서버로 동기화 시도.
  const clientGeneratedId = 'NM-2026-000001';
  const postA = await api('POST', '/nearmiss', { id: clientGeneratedId, content: 'A현장: 지게차 근처 통행 아차사고' }, tokenA);
  console.log('2) A현장이 클라이언트 id로 아차사고 등록 ->', postA.status, postA.data);

  const postB = await api('POST', '/nearmiss', { id: clientGeneratedId, content: 'B현장: 고소작업대 전도 위험 아차사고' }, tokenB);
  console.log('3) B현장이 "우연히 같은" 클라이언트 id로 등록 시도 ->', postB.status, postB.data);

  const listB = await api('GET', '/nearmiss', null, tokenB);
  const found = (listB.data || []).some(r => r.content && r.content.includes('고소작업대'));
  console.log('4) B현장 목록 조회 결과 건수:', (listB.data || []).length, '-> B가 방금 등록한 내용이 실제로 존재하는가?', found);

  console.log(`\n=> 결론: B현장의 POST는 status ${postB.status} (id: ${postB.data && postB.data.id}, idReassigned: ${postB.data && postB.data.idReassigned}, alreadyExisted: ${postB.data && postB.data.alreadyExisted}) 를 반환했고`);
  console.log('   B현장 목록에는 그 데이터가', found ? '존재함 (정상 - 데이터 유실 없음)' : '존재하지 않음 (취약함 - 데이터 유실 재현됨)');

  // risk.js는 한 술 더 떠서 "이미 존재함" 응답에 다른 site의 실제 데이터(risk_score)를 그대로 실어보낸다 - 교차 테넌트 정보 유출 여부 확인
  console.log('\n[부가 검증] risk.js의 alreadyExisted 응답이 다른 site의 실제 데이터를 유출하는지');
  const riskId = 'RISK-2026-999999';
  const riskA = await api('POST', '/risks', { id: riskId, hazard: 'A현장 기밀 위험요인', likelihood: 5, severity: 5 }, tokenA);
  console.log('1) A현장이 위험성평가 등록 (5x5=25점) ->', riskA.status, riskA.data);
  const riskB = await api('POST', '/risks', { id: riskId, hazard: 'B현장이 보낸 전혀 다른 내용' }, tokenB);
  console.log('2) B현장이 동일 id로 등록 시도 -> 응답에 A현장의 riskScore가 노출되는가?', riskB.status, riskB.data);
  const leaked = riskB.data && riskB.data.riskScore === 25 && riskB.data.alreadyExisted;
  console.log('=> 결론: A현장의 실제 점수(25점)가 B현장에게 노출됐는가? =', !!leaked, leaked ? '(취약함 - 수정 필요)' : '(노출 없음 - 정상)');
})().catch(e => { console.error('스크립트 오류:', e); process.exit(1); });
