// 유해·위험 기계기구 안전검사 관리 검증 (2026-09-02, 경쟁사 격차 해소)
// 무사퇴근 "기계/기구 관리", 스마플 "안전검사"에 대응하는 신규 모듈입니다.
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '기계기구테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'eq.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'eq.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 기계기구 등록 (프레스 - 법정 안전검사 대상) ===');
  const press = await api('POST', '/equipment', {
    name: '3호기 유압프레스', category: '프레스', assetNo: 'M-003',
    maker: '한국기계', modelNo: 'HP-200', location: 'A동 가공라인',
    installDate: '2020-03-15', inspectionRequired: 1, inspectionCycle: '2년',
    lastInspectionDate: '2024-03-10', nextInspectionDate: '2026-03-10',
    inspectionResult: '합격', inspectionAgency: '안전보건공단', certNo: 'C-2024-0311',
    operator: '김생산', status: '사용중',
  }, token);
  assert(press.status === 201 && press.data.id.startsWith('EQP-'), `등록 성공 및 전용 ID 부여 (${press.data.id})`);

  console.log('\n=== 2. 필수값 검증 ===');
  const noName = await api('POST', '/equipment', { category: '크레인' }, token);
  assert(noName.status === 400, '기계기구명 없이는 등록 불가');
  const noCategory = await api('POST', '/equipment', { name: '이름만' }, token);
  assert(noCategory.status === 400, '종류 없이는 등록 불가');

  console.log('\n=== 3. 저장된 값이 정확한가 (필드 매핑 확인) ===');
  const list = await api('GET', '/equipment', null, token);
  const saved = list.data.find((e) => e.id === press.data.id);
  assert(saved.name === '3호기 유압프레스', '기계기구명 저장됨');
  assert(saved.category === '프레스', '종류 저장됨');
  assert(saved.next_inspection_date === '2026-03-10', '다음 검사일 저장됨(기한 관리의 핵심)');
  assert(saved.inspection_agency === '안전보건공단' && saved.cert_no === 'C-2024-0311', '검사기관·합격증명서 번호 저장됨');
  assert(saved.asset_no === 'M-003' && saved.operator === '김생산', '관리번호·담당자 저장됨');
  assert(saved.status === '사용중', '상태 저장됨');

  console.log('\n=== 4. 검사 완료 후 갱신 (PATCH) ===');
  const upd = await api('PATCH', `/equipment/${press.data.id}`, {
    lastInspectionDate: '2026-03-05', nextInspectionDate: '2028-03-05',
    inspectionResult: '합격', certNo: 'C-2026-0912',
  }, token);
  assert(upd.status === 200, '검사 결과 갱신 성공');
  const after = (await api('GET', '/equipment', null, token)).data.find((e) => e.id === press.data.id);
  assert(after.next_inspection_date === '2028-03-05' && after.cert_no === 'C-2026-0912', '차기 검사일과 증명서 번호가 갱신됨');
  assert(!!after.updated_by, '누가 갱신했는지 기록됨');

  console.log('\n=== 5. 합격증명서 사진 첨부 (첨부파일 연동) ===');
  const form = new FormData();
  form.append('entityType', 'equipment');
  form.append('entityId', press.data.id);
  form.append('file', new Blob([Buffer.from('cert')]), '안전검사합격증.png');
  const up = await fetch(BASE + '/attachments', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert(up.status === 201, '합격증명서를 첨부파일로 올릴 수 있음');
  const atts = await api('GET', `/attachments?entityType=equipment&entityId=${press.data.id}`, null, token);
  assert(atts.data.length === 1 && atts.data[0].file_name === '안전검사합격증.png', '한글 파일명 그대로 첨부됨');

  console.log('\n=== 6. 사업장 지정 등록도 되는가 (본사 관리자 대리입력) ===');
  const site2 = await api('POST', '/sites', { name: '2공장' }, token);
  const crane = await api('POST', '/equipment', {
    name: '천장크레인 1호', category: '크레인', siteId: site2.data.id,
    nextInspectionDate: '2026-12-01',
  }, token);
  assert(crane.status === 201, '다른 사업장을 지정해 등록 가능');
  const craneRow = (await api('GET', '/equipment', null, token)).data.find((e) => e.id === crane.data.id);
  assert(craneRow.site_id === site2.data.id, '지정한 사업장(2공장)에 저장됨');

  console.log('\n=== 7. 조직 경계 (다른 회사 기계기구는 안 보임) ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'eq.b', password: 'Test1234!', name: 'B관리자' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'eq.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bList = await api('GET', '/equipment', null, bLogin.data.token);
  assert(bList.data.length === 0, 'B사에서는 A사 기계기구가 전혀 보이지 않음');

  console.log('\n=== 8. 소프트 삭제 (이력 보존) ===');
  await api('DELETE', `/equipment/${crane.data.id}`, null, token);
  const afterDel = await api('GET', '/equipment', null, token);
  assert(!afterDel.data.some((e) => e.id === crane.data.id), '삭제 후 목록에서 사라짐');
  assert(afterDel.data.some((e) => e.id === press.data.id), '다른 기계기구는 그대로 남아있음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
