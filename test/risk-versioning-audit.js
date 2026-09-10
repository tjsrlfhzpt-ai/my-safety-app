// 위험성평가 버전관리 검증 (2026-09-02, 마스터 프롬프트 20절)
// 예전에는 수정하면 이전 내용이 그냥 덮어써져 사라졌습니다. 이제 수정 직전 상태가
// 스냅샷으로 남아 "언제 무엇을 어떻게 바꿨는지"를 되짚을 수 있어야 합니다.
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
  console.log('=== 0. 준비 ===');
  const org = await api('POST', '/organizations', { name: '버전테스트', siteName: '공장' });
  await api('POST', '/auth/register', { orgId: org.data.orgId, siteId: org.data.siteId, loginId: 'ver.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'ver.admin', password: 'Test1234!' });
  const token = login.data.token;
  await consent(token);

  const created = await api('POST', '/risks', { hazard: '프레스 금형교체 중 끼임', likelihood: 3, severity: 3, dueDate: '2026-10-01' }, token);
  assert(created.status === 201, '위험성평가 최초 등록');
  const rid = created.data.id;

  console.log('\n=== 1. 아직 수정 전이면 이력이 비어있다 ===');
  const v0 = await api('GET', `/risks/${rid}/versions`, null, token);
  assert(v0.status === 200 && v0.data.versions.length === 0, '수정 이력 0건');
  assert(v0.data.current && v0.data.current.hazard === '프레스 금형교체 중 끼임', '현재 상태는 함께 조회됨');

  console.log('\n=== 2. 수정하면 이전 상태가 보존된다 (핵심) ===');
  await api('PATCH', `/risks/${rid}`, { hazard: '프레스 금형교체 중 끼임(방호장치 추가 후 재평가)', likelihood: 2, severity: 3 }, token);
  const v1 = await api('GET', `/risks/${rid}/versions`, null, token);
  assert(v1.data.versions.length === 1, '수정 1회 후 이력 1건 생성');
  assert(v1.data.versions[0].snapshot.hazard === '프레스 금형교체 중 끼임', '이력에 수정 "직전"의 내용이 보존됨(덮어써지지 않음)');
  assert(v1.data.versions[0].snapshot.likelihood === 3, '수정 전 가능성 값(3)이 그대로 남아있음');
  assert(v1.data.current.likelihood === 2, '현재 레코드는 최신 값(2)으로 갱신됨');
  assert(v1.data.current.risk_score === 6, `점수도 재계산됨 (2×3=6, 실제 ${v1.data.current.risk_score})`);

  console.log('\n=== 3. 무엇이 바뀌었는지 기록되는가 ===');
  const changed = v1.data.versions[0].changedFields;
  assert(changed.includes('hazard') && changed.includes('likelihood'), `바뀐 필드가 기록됨: ${changed.join(', ')}`);
  assert(!!v1.data.versions[0].changedBy, '누가 바꿨는지 기록됨');
  assert(!!v1.data.versions[0].changedAt, '언제 바꿨는지 기록됨');

  console.log('\n=== 4. 여러 번 수정하면 버전이 쌓인다 (v1 → v2 → v3) ===');
  await api('PATCH', `/risks/${rid}`, { reductionMeasures: '방호장치 설치 완료' }, token);
  await api('PATCH', `/risks/${rid}`, { likelihood: 1 }, token);
  const v3 = await api('GET', `/risks/${rid}/versions`, null, token);
  assert(v3.data.versions.length === 3, `수정 3회 후 이력 3건 (실제 ${v3.data.versions.length})`);
  assert(v3.data.versions[0].versionNo === 3, '최신 버전이 맨 위에 옴(내림차순)');
  assert(v3.data.versions[2].versionNo === 1, '가장 오래된 버전이 맨 아래');

  // 최초 등록 당시 내용까지 되짚을 수 있는지
  const oldest = v3.data.versions[2].snapshot;
  assert(oldest.hazard === '프레스 금형교체 중 끼임' && oldest.likelihood === 3,
    '가장 오래된 이력에서 최초 등록 당시 내용을 그대로 확인할 수 있음');

  console.log('\n=== 5. 다른 회사의 이력은 볼 수 없다 (조직 경계) ===');
  const orgB = await api('POST', '/organizations', { name: 'B사', siteName: 'B현장' });
  await api('POST', '/auth/register', { orgId: orgB.data.orgId, siteId: orgB.data.siteId, loginId: 'b.ver', password: 'Test1234!', name: 'B관리자' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'b.ver', password: 'Test1234!' });
  await consent(bLogin.data.token);
  const cross = await api('GET', `/risks/${rid}/versions`, null, bLogin.data.token);
  assert(cross.status === 404, '다른 회사 관리자는 남의 위험성평가 이력을 볼 수 없음(404)');

  console.log('\n=== 6. 기존 조회/통계가 그대로 동작하는가 (회귀) ===');
  const list = await api('GET', '/risks', null, token);
  assert(Array.isArray(list.data) && list.data.length === 1,
    '목록에는 여전히 1건만 나옴(과거 버전이 목록을 오염시키지 않음)');
  assert(list.data[0].likelihood === 1, '목록의 값은 항상 최신 상태');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
