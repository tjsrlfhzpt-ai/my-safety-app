// 사업장 지정 등록(resolveTargetSiteId) 검증 (2026-09-02)
// 마스터 프롬프트 15·16·17·37절: 본사 관리자가 여러 현장에 데이터를 등록할 수 있어야 하되,
// 클라이언트가 보낸 siteId를 그대로 믿지 않고 서버가 권한을 검증해야 한다.
const BASE = 'http://localhost:4000';
let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}
async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const consent = (t) => api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, t);

(async () => {
  console.log('=== 0. 조직 A(현장 2개) + 조직 B(별개 회사) 준비 ===');
  const orgA = await api('POST', '/organizations', { name: 'A제조(주)', siteName: 'A1공장' });
  await api('POST', '/auth/register', { orgId: orgA.data.orgId, siteId: orgA.data.siteId, loginId: 'hq.admin', password: 'Test1234!', name: '본사관리자' });
  const loginA = await api('POST', '/auth/login', { loginId: 'hq.admin', password: 'Test1234!' });
  const tokenA = loginA.data.token;
  await consent(tokenA);
  const site2 = await api('POST', '/sites', { name: 'A2공장' }, tokenA);
  assert(site2.status === 201, 'A조직에 두 번째 사업장(A2공장) 생성');

  const orgB = await api('POST', '/organizations', { name: 'B건설(주)', siteName: 'B현장' });
  await api('POST', '/auth/register', { orgId: orgB.data.orgId, siteId: orgB.data.siteId, loginId: 'b.admin', password: 'Test1234!', name: 'B관리자' });
  const loginB = await api('POST', '/auth/login', { loginId: 'b.admin', password: 'Test1234!' });
  await consent(loginB.data.token);

  console.log('\n=== 1. 사업장을 지정해서 등록 (핵심 신규 기능) ===');
  const r1 = await api('POST', '/nearmiss', { content: 'A2공장 아차사고', siteId: site2.data.id }, tokenA);
  assert(r1.status === 201, '본사 관리자가 A2공장을 지정해서 등록 성공 (예전엔 자기 소속 사업장에만 가능했음)');
  const list = await api('GET', '/nearmiss', null, tokenA);
  const created = list.data.find((x) => x.id === r1.data.id);
  assert(created && created.site_id === site2.data.id, '실제로 지정한 사업장(A2공장)에 저장됨');

  console.log('\n=== 2. siteId 생략 시 기존 동작 유지 (회귀 방지) ===');
  const r2 = await api('POST', '/nearmiss', { content: '소속 사업장 등록' }, tokenA);
  const list2 = await api('GET', '/nearmiss', null, tokenA);
  const created2 = list2.data.find((x) => x.id === r2.data.id);
  assert(r2.status === 201 && created2.site_id === orgA.data.siteId, 'siteId를 안 보내면 예전처럼 본인 소속 사업장에 등록됨');

  console.log('\n=== 3. 🔒 권한 밖 사업장 지정은 차단되는가 (다른 회사 사업장 침범 시도) ===');
  const evil = await api('POST', '/nearmiss', { content: '타사 침범 시도', siteId: orgB.data.siteId }, tokenA);
  assert(evil.status === 403, 'A조직 관리자가 B회사 사업장을 지정하면 403으로 차단됨 (클라이언트 값을 그대로 믿지 않음)');
  const bList = await api('GET', '/nearmiss', null, loginB.data.token);
  assert(!bList.data.some((x) => x.content === '타사 침범 시도'), 'B회사 데이터에 실제로 아무것도 안 들어감');

  console.log('\n=== 4. 존재하지 않는 사업장 지정도 차단 ===');
  const ghost = await api('POST', '/nearmiss', { content: '유령사업장', siteId: 'SITE-NOT-EXIST' }, tokenA);
  assert(ghost.status === 403, '존재하지 않는 사업장 id를 보내도 403');

  console.log('\n=== 5. 위험성평가·PTW·CAPA에도 동일하게 적용되는가 ===');
  const risk = await api('POST', '/risks', { hazard: 'A2공장 프레스 끼임', likelihood: 5, severity: 5, siteId: site2.data.id }, tokenA);
  assert(risk.status === 201, '위험성평가도 사업장 지정 등록 가능');
  const riskList = await api('GET', '/risks', null, tokenA);
  const rr = riskList.data.find((x) => x.id === risk.data.id);
  assert(rr && rr.site_id === site2.data.id, '위험성평가가 지정 사업장에 저장됨');
  const capaList = await api('GET', '/capa', null, tokenA);
  const autoCapa = capaList.data.find((c) => c.source_id === risk.data.id);
  assert(autoCapa && autoCapa.site_id === site2.data.id, '고위험 자동생성 CAPA도 같은 사업장으로 들어감(엉뚱한 사업장에 안 생김)');

  const ptw = await api('POST', '/ptw', { title: 'A2 밀폐공간', location: '탱크실', time: '09-18', siteId: site2.data.id }, tokenA);
  assert(ptw.status === 201, 'PTW도 사업장 지정 등록 가능');
  const ptwList = await api('GET', '/ptw', null, tokenA);
  assert(ptwList.data.find((x) => x.id === ptw.data.id).site_id === site2.data.id, 'PTW가 지정 사업장에 저장됨');

  const capa = await api('POST', '/capa', { title: '수동 CAPA', siteId: site2.data.id }, tokenA);
  assert(capa.status === 201, 'CAPA 수동생성도 사업장 지정 가능');

  const ptwEvil = await api('POST', '/ptw', { title: '침범', location: 'x', time: 'y', siteId: orgB.data.siteId }, tokenA);
  assert(ptwEvil.status === 403, 'PTW도 권한 밖 사업장이면 403으로 차단');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
