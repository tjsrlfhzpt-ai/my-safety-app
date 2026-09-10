// 협력업체 실제 연결 검증 (2026-09-02, 마스터 프롬프트 45-4·13절)
// 가장 중요한 두 가지: (1) 기존 텍스트 데이터가 절대 사라지지 않는가
//                      (2) 엉뚱한 업체에 잘못 연결되지 않는가 (부당한 불이익 방지)
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
  console.log('=== 0. 준비: 협력업체 등록 ===');
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '도급테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'ct.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'ct.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  const ct = await api('POST', '/contractor', { companyName: '(주)한국기계설비', repName: '박대표', workType: '설비정비' }, token);
  assert(ct.status === 201, '협력업체 등록');

  console.log('\n=== 1. 목록에서 고른 경우 (contractorId 직접 지정) ===');
  const nm1 = await api('POST', '/nearmiss', {
    title: '연결테스트1', content: '내용', contractorId: ct.data.id, relatedContractor: '(주)한국기계설비',
  }, token);
  const row1 = (await api('GET', '/nearmiss', null, token)).data.find((r) => r.id === nm1.data.id);
  assert(row1.contractor_id === ct.data.id, '지정한 업체에 정확히 연결됨');
  assert(row1.related_contractor === '(주)한국기계설비', '사람이 적은 원본 텍스트도 그대로 보존됨');

  console.log('\n=== 2. 🔑 이름만 적어도 자동 연결된다 (표기가 조금 달라도) ===');
  const variants = [
    ['한국기계설비', '(주) 없이 적은 경우'],
    ['(주)한국기계설비', '정확히 같게 적은 경우'],
    ['주식회사 한국기계설비', '"주식회사"로 적은 경우'],
    ['한국기계설비(주)', '(주)를 뒤에 붙인 경우'],
    ['한국기계 설비', '중간에 공백이 들어간 경우'],
  ];
  for (const [name, desc] of variants) {
    const r = await api('POST', '/nearmiss', { title: `v-${name}`, content: 'x', relatedContractor: name }, token);
    const row = (await api('GET', '/nearmiss', null, token)).data.find((x) => x.id === r.data.id);
    assert(row.contractor_id === ct.data.id, `${desc}: "${name}" → 같은 업체로 연결됨`);
    assert(row.related_contractor === name, `  원본 표기 "${name}"는 그대로 보존됨`);
  }

  console.log('\n=== 3. 🔒 모르는 업체는 억지로 연결하지 않는다 (오연결 방지) ===');
  const unknown = await api('POST', '/nearmiss', { title: '미등록업체', content: 'x', relatedContractor: '전혀다른업체' }, token);
  const uRow = (await api('GET', '/nearmiss', null, token)).data.find((r) => r.id === unknown.data.id);
  assert(uRow.contractor_id === null, '등록되지 않은 업체명은 연결하지 않음(추측으로 엮지 않음)');
  assert(uRow.related_contractor === '전혀다른업체', '그래도 사람이 적은 내용은 그대로 남음(데이터 유실 없음)');

  console.log('\n=== 4. 다른 모듈에도 똑같이 적용되는가 ===');
  const risk = await api('POST', '/risks', { hazard: '위험', relatedContractor: '한국기계설비(주)' }, token);
  const riskRow = (await api('GET', '/risks', null, token)).data.find((r) => r.id === risk.data.id);
  assert(riskRow.contractor_id === ct.data.id, '위험성평가도 자동 연결됨');

  const ptw = await api('POST', '/ptw', { title: '작업', location: '현장', time: '09-18', relatedContractor: '한국기계설비(주)' }, token);
  const ptwRow = (await api('GET', '/ptw', null, token)).data.find((r) => r.id === ptw.data.id);
  assert(ptwRow.contractor_id === ct.data.id, 'PTW도 자동 연결됨');

  const eq = await api('POST', '/equipment', { name: '설비', category: '프레스', relatedContractor: '한국기계설비(주)' }, token);
  const eqRow = (await api('GET', '/equipment', null, token)).data.find((r) => r.id === eq.data.id);
  assert(eqRow.contractor_id === ct.data.id, '기계기구도 자동 연결됨');

  console.log('\n=== 5. 🔒 이름이 같은 업체가 둘이면 연결하지 않는다 (애매하면 안 엮음) ===');
  const dup = await api('POST', '/contractor', { companyName: '한국기계설비', repName: '김대표', workType: '다른업무' }, token);
  assert(dup.status === 201, '같은 이름의 업체를 하나 더 등록(실제로 있을 수 있는 상황)');
  const ambiguous = await api('POST', '/nearmiss', { title: '애매한경우', content: 'x', relatedContractor: '한국기계설비' }, token);
  const aRow = (await api('GET', '/nearmiss', null, token)).data.find((r) => r.id === ambiguous.data.id);
  assert(aRow.contractor_id === null, '후보가 둘 이상이면 연결하지 않음(엉뚱한 업체에 사고가 집계되면 부당한 불이익)');
  assert(aRow.related_contractor === '한국기계설비', '원본은 그대로 보존되어 사람이 나중에 정리할 수 있음');

  console.log('\n=== 6. 없는 업체 id를 직접 넣으면 명확히 거부 ===');
  const badId = await api('POST', '/nearmiss', { title: 'x', content: 'x', contractorId: 'CT-NOT-EXIST' }, token);
  assert(badId.status === 400, '존재하지 않는 업체 id는 400으로 거부');
  assert(badId.data.error.includes('협력업체'), '무엇이 문제인지 알려줌');

  console.log('\n=== 7. 수정하면 연결도 다시 계산된다 ===');
  await api('POST', '/contractor', { companyName: '대한안전', repName: '이대표' }, token);
  const ct2 = (await api('GET', '/contractor', null, token)).data.find((c) => c.company_name === '대한안전');
  const changed = await api('PATCH', `/nearmiss/${nm1.data.id}`, { relatedContractor: '대한안전' }, token);
  assert(changed.status === 200, '협력업체 변경');
  const afterRow = (await api('GET', '/nearmiss', null, token)).data.find((r) => r.id === nm1.data.id);
  assert(afterRow.contractor_id === ct2.id, '연결이 새 업체로 갱신됨(옛 업체에 남아있지 않음)');

  console.log('\n=== 8. 🔒 다른 회사 업체에는 연결되지 않는다 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'ct.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'ct.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bNm = await api('POST', '/nearmiss', { title: 'B사기록', content: 'x', relatedContractor: '(주)한국기계설비' }, bLogin.data.token);
  const bRow = (await api('GET', '/nearmiss', null, bLogin.data.token)).data.find((r) => r.id === bNm.data.id);
  assert(bRow.contractor_id === null, 'B사에서 같은 이름을 적어도 A사 업체에는 연결되지 않음(조직 격리)');
  const bCross = await api('POST', '/nearmiss', { title: 'x', content: 'x', contractorId: ct.data.id }, bLogin.data.token);
  assert(bCross.status === 400, 'B사가 A사 업체 id를 알아내 직접 지정해도 거부됨');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
