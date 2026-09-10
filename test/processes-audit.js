// 공정/공종 마스터데이터 검증 (2026-09-02, 마스터 프롬프트 45-1·45-5·45-6절)
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '공정마스터테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'pr.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'pr.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 제조업 공정 등록 (계층 구조) ===');
  const line = await api('POST', '/processes', {
    name: 'A동 가공라인', kind: 'process', code: 'P-A01',
    manager: '김공정', hazardSummary: '끼임, 소음', sortOrder: 1,
  }, token);
  assert(line.status === 201 && line.data.id.startsWith('PRC-'), `상위 공정 등록 (${line.data.id})`);

  const press = await api('POST', '/processes', {
    name: '프레스 공정', kind: 'process', parentId: line.data.id,
    manager: '이반장', hazardSummary: '금형교체 중 끼임', sortOrder: 1,
  }, token);
  assert(press.status === 201, '하위 공정 등록');

  const list = await api('GET', '/processes', null, token);
  const savedPress = list.data.find((p) => p.id === press.data.id);
  assert(savedPress.parent_id === line.data.id, '하위 공정이 상위 공정에 연결됨');
  assert(savedPress.hazard_summary === '금형교체 중 끼임', '공정별 대표 위험요인이 저장됨');

  console.log('\n=== 2. 건설업 공종도 같은 구조로 (업종 종속 없음) ===');
  const frame = await api('POST', '/processes', { name: '골조공사', kind: 'work_type', sortOrder: 1 }, token);
  const rebar = await api('POST', '/processes', { name: '철근작업', kind: 'work_type', parentId: frame.data.id }, token);
  assert(frame.status === 201 && rebar.status === 201, '건설 공종도 같은 표에 등록됨');
  const list2 = await api('GET', '/processes', null, token);
  assert(list2.data.filter((p) => p.kind === 'work_type').length === 2, 'kind로 제조 공정과 건설 공종이 구분됨');
  assert(list2.data.filter((p) => p.kind === 'process').length === 2, '제조 공정도 별도로 구분됨');

  console.log('\n=== 3. 필수값 검증 ===');
  const noName = await api('POST', '/processes', { kind: 'process' }, token);
  assert(noName.status === 400, '공정명 없이는 등록 불가');

  console.log('\n=== 4. 설비를 공정에 연결 ===');
  const eq = await api('POST', '/equipment', {
    name: '3호기 프레스', category: '프레스', processId: press.data.id,
    nextInspectionDate: '2027-01-01',
  }, token);
  assert(eq.status === 201, '설비 등록 시 공정을 지정할 수 있음');
  const eqRow = (await api('GET', '/equipment', null, token)).data.find((e) => e.id === eq.data.id);
  assert(eqRow.process_id === press.data.id, '설비가 실제로 해당 공정에 연결됨(자유입력 텍스트가 아님)');

  console.log('\n=== 5. 🔒 계층 삭제 안전장치 (고아 데이터 방지) ===');
  const delParent = await api('DELETE', `/processes/${line.data.id}`, null, token);
  assert(delParent.status === 409, '하위 공정이 있으면 상위 공정을 삭제할 수 없음(409)');
  assert(delParent.data.blockedBy && delParent.data.blockedBy.children === 1, `무엇이 막고 있는지 알려줌 (하위공정 ${delParent.data.blockedBy.children}건)`);
  assert(delParent.data.error.includes('하위 공정'), '사용자가 이해할 수 있는 안내 메시지');

  const delWithEquip = await api('DELETE', `/processes/${press.data.id}`, null, token);
  assert(delWithEquip.status === 409, '연결된 기계기구가 있으면 공정을 삭제할 수 없음');
  assert(delWithEquip.data.blockedBy.equipment === 1, `연결된 설비 건수를 알려줌 (${delWithEquip.data.blockedBy.equipment}건)`);

  console.log('\n=== 6. 걸리는 게 없으면 정상 삭제된다 ===');
  const alone = await api('POST', '/processes', { name: '단독 공정', kind: 'process' }, token);
  const delAlone = await api('DELETE', `/processes/${alone.data.id}`, null, token);
  assert(delAlone.status === 200, '하위·연결이 없는 공정은 정상 삭제됨');
  const afterDel = await api('GET', '/processes', null, token);
  assert(!afterDel.data.some((p) => p.id === alone.data.id), '삭제 후 목록에서 사라짐');
  assert(afterDel.data.some((p) => p.id === line.data.id), '삭제가 막혔던 공정은 그대로 살아있음(데이터 보존)');

  console.log('\n=== 7. 정리 후에는 삭제 가능해진다 ===');
  await api('DELETE', `/equipment/${eq.data.id}`, null, token);   // 설비 먼저 정리
  const delPressNow = await api('DELETE', `/processes/${press.data.id}`, null, token);
  assert(delPressNow.status === 200, '연결된 설비를 정리하면 공정을 삭제할 수 있음');
  const delParentNow = await api('DELETE', `/processes/${line.data.id}`, null, token);
  assert(delParentNow.status === 200, '하위 공정을 정리하면 상위 공정도 삭제할 수 있음');

  console.log('\n=== 8. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'pr.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'pr.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bList = await api('GET', '/processes', null, bLogin.data.token);
  assert(bList.data.length === 0, 'B사에서는 A사 공정이 전혀 보이지 않음');
  const bDel = await api('DELETE', `/processes/${frame.data.id}`, null, bLogin.data.token);
  assert(bDel.status === 404, 'B사가 A사 공정 id를 알아내도 삭제할 수 없음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
