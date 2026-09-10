// 사업장 대시보드(서버 집계) 검증 (2026-09-05, 마스터 프롬프트 14·32·33절)
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
  console.log('=== 0. 준비: 사업장 2개에 서로 다른 데이터 ===');
  const { orgId, siteId: siteA } = await bootstrapTestOrg(BASE, '대시보드테스트');
  await api('POST', '/auth/register', { orgId, siteId: siteA, loginId: 'db.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'db.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);
  const site2 = await api('POST', '/sites', { name: '2공장' }, token);
  const siteB = site2.data.id;

  // A공장: 문제 많은 현장
  await api('POST', '/risks', { hazard: '고위험1', likelihood: 5, severity: 5, siteId: siteA }, token);
  await api('POST', '/risks', { hazard: '고위험2', likelihood: 4, severity: 4, siteId: siteA }, token);
  await api('POST', '/accident', { description: '사고발생', siteId: siteA }, token);
  await api('POST', '/nearmiss', { title: 'a', content: 'x', siteId: siteA }, token);
  await api('POST', '/equipment', { name: '노후프레스', category: '프레스', nextInspectionDate: '2020-01-01', siteId: siteA }, token);
  // B공장: 상대적으로 양호
  await api('POST', '/nearmiss', { title: 'b', content: 'y', siteId: siteB }, token);
  await api('POST', '/tbm', { topic: '작업내용', siteId: siteB }, token);

  console.log('\n=== 1. 사업장별로 끊어서 나오는가 (합계에 묻히지 않게) ===');
  const dash = await api('GET', '/dashboard', null, token);
  assert(dash.status === 200, '대시보드 조회 성공');
  assert(dash.data.sites.length === 2, `사업장 2개가 각각 나옴 (실제 ${dash.data.sites.length})`);
  const a = dash.data.sites.find((s) => s.siteId === siteA);
  const b = dash.data.sites.find((s) => s.siteId === siteB);
  assert(!!a && !!b, '두 사업장이 모두 조회됨');
  assert(a.siteName && b.siteName, '사업장 이름이 함께 나옴(id만으로는 알아볼 수 없으므로)');

  console.log('\n=== 2. 건수 집계가 정확한가 ===');
  assert(a.counts.risk === 2, `A공장 위험성평가 2건 (실제 ${a.counts.risk})`);
  assert(a.counts.accident === 1, `A공장 산업재해 1건 (실제 ${a.counts.accident})`);
  assert(a.counts.nearmiss === 1, `A공장 아차사고 1건 (실제 ${a.counts.nearmiss})`);
  assert(b.counts.nearmiss === 1 && b.counts.tbm === 1, 'B공장 건수도 정확함');
  assert(!b.counts.risk, 'B공장에 없는 모듈은 0으로 처리됨(A공장 것이 섞이지 않음)');

  console.log('\n=== 3. 🔑 "주의가 필요한 지표"가 제대로 잡히는가 ===');
  assert(a.alerts.미완료_고위험 === 2, `A공장 고위험 2건(5×5=25, 4×4=16 모두 15점 이상) (실제 ${a.alerts.미완료_고위험})`);
  assert(a.alerts.검사기한_초과설비 === 1, `A공장 검사기한 지난 설비 1건 (실제 ${a.alerts.검사기한_초과설비})`);
  assert(a.alerts.산업재해 === 1, 'A공장 산업재해 1건');
  assert(b.alerts.미완료_고위험 === 0 && b.alerts.산업재해 === 0, 'B공장은 주의 지표가 0(현장 비교가 가능함)');

  console.log('\n=== 4. 회사 전체 합계도 함께 나오는가 (경영진용) ===');
  assert(dash.data.totals.counts.nearmiss === 2, `전사 아차사고 합계 2건 (실제 ${dash.data.totals.counts.nearmiss})`);
  assert(dash.data.totals.alerts.미완료_고위험 === 2, '전사 고위험 합계도 정확함');
  assert(!!dash.data.moduleLabels && dash.data.moduleLabels.risk === '위험성평가', '모듈 이름표가 함께 와서 화면이 바로 그릴 수 있음');

  console.log('\n=== 5. 🔑 데이터가 늘어도 응답이 무거워지지 않는가 (성능) ===');
  // 대량 데이터를 넣고 응답 크기가 그대로인지 봅니다.
  // API로 300번 요청하면 서버의 분당 요청 제한(300건)에 걸립니다 — 그건 과도한 요청을
  // 막는 정상 동작이므로, 여기서는 DB에 직접 넣어 "집계 성능"만 따로 확인합니다.
  const before = JSON.stringify((await api('GET', '/dashboard', null, token)).data).length;
  const Database = require('better-sqlite3');
  const path = require('path');
  const seedDb = new Database(path.join(__dirname, '..', 'data.sqlite'));
  const t0 = Date.now();
  const ins = seedDb.prepare(`INSERT INTO near_misses (id, site_id, title, content, created_at)
                              VALUES (?, ?, ?, ?, datetime('now'))`);
  seedDb.transaction(() => {
    for (let i = 0; i < 3000; i++) ins.run(`NM-BULK-${i}`, siteA, `대량-${i}`, '성능테스트');
  })();
  seedDb.close();
  console.log(`   (3000건 삽입 완료 ${Date.now() - t0}ms)`);

  const t1 = Date.now();
  const after = await api('GET', '/dashboard', null, token);
  const elapsed = Date.now() - t1;
  const afterSize = JSON.stringify(after.data).length;

  assert(after.data.sites.find((s) => s.siteId === siteA).counts.nearmiss === 3001,
    `3001건이 정확히 집계됨 (실제 ${after.data.sites.find((s) => s.siteId === siteA).counts.nearmiss})`);
  assert(Math.abs(afterSize - before) < 200,
    `데이터가 3000건 늘어도 응답 크기는 그대로 (${before}B → ${afterSize}B) — 숫자만 내려오므로`);
  assert(elapsed < 500, `집계 응답이 빠름 (${elapsed}ms)`);

  // 비교: 예전 방식(전체 목록을 받아 세기)은 얼마나 무거운가
  const t2 = Date.now();
  const listRes = await fetch(`${BASE}/nearmiss`, { headers: { Authorization: `Bearer ${token}` } });
  const listBody = await listRes.text();
  const listElapsed = Date.now() - t2;
  console.log(`   [비교] 목록 전체 조회: ${listBody.length}B, ${listElapsed}ms`);
  assert(afterSize < listBody.length,
    `집계 응답(${afterSize}B)이 목록 하나(${listBody.length}B)보다도 작음 — 25개 모듈을 다 받던 예전 방식 대비 큰 차이`);

  console.log('\n=== 6. 🔒 다른 회사 데이터가 섞이지 않는가 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'db.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'db.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bDash = await api('GET', '/dashboard', null, bLogin.data.token);
  assert(bDash.data.sites.length === 1, 'B사는 자기 사업장 1개만 보임');
  assert(!bDash.data.sites.some((s) => s.siteId === siteA), 'A사 사업장이 전혀 보이지 않음');
  assert(!bDash.data.totals.counts.nearmiss, 'B사 합계에 A사 데이터가 섞이지 않음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
