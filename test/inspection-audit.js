// 안전점검 검증 (2026-09-05, 무사퇴근 "안전점검" 대응)
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
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '안전점검테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'in.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'in.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  console.log('\n=== 1. 점검표 만들기 (한 번 만들어 재사용) ===');
  const tpl = await api('POST', '/inspection/templates', {
    name: '월간 순회점검표', kind: '순회점검', description: '전 공정 월 1회 실시',
  }, token);
  assert(tpl.status === 201 && tpl.data.id.startsWith('INSPT-'), `점검표 생성 (${tpl.data.id})`);

  const addItems = await api('POST', `/inspection/templates/${tpl.data.id}/items`, {
    items: [
      { content: '통로에 적치물이 없는가', legalBasis: '산업안전보건기준규칙 제3조' },
      { content: '소화기 위치 표시 및 점검표 부착 상태', legalBasis: '' },
      { content: '고소작업 구간 안전난간 설치 상태' },
      { content: '전기 배전반 잠금 상태' },
    ],
  }, token);
  assert(addItems.status === 201 && addItems.data.added === 4, `점검 문항 4개 추가 (실제 ${addItems.data.added})`);

  const items = await api('GET', `/inspection/templates/${tpl.data.id}/items`, null, token);
  assert(items.data.length === 4, '문항 목록 조회됨');
  assert(items.data[0].content === '통로에 적치물이 없는가', '첫 문항이 순서대로 저장됨');
  assert(items.data[0].legal_basis.includes('제3조'), '근거 법령도 함께 보관됨');

  console.log('\n=== 2. 🔑 점검표를 지정하면 문항이 자동으로 펼쳐지는가 ===');
  const insp1 = await api('POST', '/inspection', {
    templateId: tpl.data.id, inspectDate: '2026-09-05', kind: '순회점검',
    location: 'A동 가공라인', inspector: '김안전',
  }, token);
  assert(insp1.status === 201 && insp1.data.id.startsWith('INSP-'), `점검 실시 기록 생성 (${insp1.data.id})`);
  assert(insp1.data.totalCount === 4, '문항을 다시 적지 않아도 4개가 자동으로 펼쳐짐');
  const r1 = await api('GET', `/inspection/${insp1.data.id}/results`, null, token);
  assert(r1.data.results.length === 4, '항목별 결과표가 생성됨');
  assert(r1.data.results[0].item_content === '통로에 적치물이 없는가', '문항 내용이 결과표에 복사됨');

  console.log('\n=== 3. 🔑 부적합이 나오면 개선조치로 이어지는가 ===');
  const insp2 = await api('POST', '/inspection', {
    templateId: tpl.data.id, inspectDate: '2026-09-06', location: 'B동 조립라인', inspector: '이안전',
    results: [
      { itemContent: '통로에 적치물이 없는가', result: '부적합', finding: '비상통로에 자재 적치' },
      { itemContent: '소화기 위치 표시 및 점검표 부착 상태', result: '적합' },
      { itemContent: '고소작업 구간 안전난간 설치 상태', result: '부적합', finding: '2층 개구부 난간 미설치' },
      { itemContent: '전기 배전반 잠금 상태', result: '해당없음' },
    ],
  }, token);
  assert(insp2.data.ngCount === 2, `부적합 2건이 정확히 집계됨 (실제 ${insp2.data.ngCount})`);
  assert(insp2.data.status === '개선필요', '부적합이 있으면 "개선필요" 상태(점검완료로 끝낼 수 없음)');
  assert(!!insp2.data.autoCapaId, `개선조치가 자동 생성됨 (${insp2.data.autoCapaId})`);

  const capa = (await api('GET', '/capa', null, token)).data.find((c) => c.id === insp2.data.autoCapaId);
  assert(!!capa, 'CAPA 목록에서 조회됨');
  assert(capa.source_type === 'inspection' && capa.source_id === insp2.data.id, '이 점검과 정확히 연결됨');
  assert(capa.title.includes('2건'), '부적합 건수가 제목에 담김');
  assert(capa.description.includes('비상통로에 자재 적치') && capa.description.includes('2층 개구부 난간 미설치'),
    '어떤 항목이 왜 부적합인지 CAPA에 그대로 담김(담당자가 바로 조치 가능)');

  console.log('\n=== 4. 부적합이 없으면 CAPA를 만들지 않는다 ===');
  const clean = await api('POST', '/inspection', {
    templateId: tpl.data.id, location: 'C동', inspector: '박안전',
    results: [{ itemContent: '통로에 적치물이 없는가', result: '적합' }],
  }, token);
  assert(clean.data.status === '점검완료', '전부 적합이면 "점검완료"');
  assert(!clean.data.autoCapaId, '불필요한 개선조치를 만들지 않음');

  console.log('\n=== 5. 🔑 자주 부적합이 나오는 항목을 찾아주는가 ===');
  await api('POST', '/inspection', {
    templateId: tpl.data.id, location: 'D동', inspector: '최안전',
    results: [
      { itemContent: '통로에 적치물이 없는가', result: '부적합', finding: '또 적치됨' },
      { itemContent: '소화기 위치 표시 및 점검표 부착 상태', result: '적합' },
    ],
  }, token);
  const freq = await api('GET', '/inspection/stats/frequent-ng', null, token);
  const top = freq.data[0];
  assert(!!top && top.문항 === '통로에 적치물이 없는가', '가장 자주 부적합인 항목이 맨 위에 나옴');
  assert(top.부적합횟수 === 2, `반복 횟수가 정확함 (실제 ${top ? top.부적합횟수 : '없음'})`);
  assert(!freq.data.some((f) => f.문항.includes('배전반')), '1회뿐인 항목은 반복으로 잡지 않음(거짓 경보 방지)');

  console.log('\n=== 6. 점검표 문항이 나중에 바뀌어도 과거 기록은 그대로인가 ===');
  const firstItemId = items.data[0].id;
  await api('DELETE', `/inspection/templates/${tpl.data.id}/items/${firstItemId}`, null, token);
  const afterDel = await api('GET', `/inspection/templates/${tpl.data.id}/items`, null, token);
  assert(afterDel.data.length === 3, '점검표에서 문항이 삭제됨');
  const oldRecord = await api('GET', `/inspection/${insp2.data.id}/results`, null, token);
  assert(oldRecord.data.results.some((r) => r.item_content === '통로에 적치물이 없는가'),
    '과거 점검 기록에는 그때 점검한 문항이 그대로 남아있음(스냅샷 보존)');

  console.log('\n=== 7. 없는 점검표를 지정하면 명확히 거부 ===');
  const badTpl = await api('POST', '/inspection', { templateId: 'INSPT-NOT-EXIST', location: 'X' }, token);
  assert(badTpl.status === 400, '존재하지 않는 점검표는 400으로 거부');
  assert(badTpl.data.error.includes('점검표'), '무엇이 문제인지 알려줌');
  const noItems = await api('POST', '/inspection', { location: '문항 없음' }, token);
  assert(noItems.status === 400, '점검표도 문항도 없으면 등록 불가');

  console.log('\n=== 8. 공정·협력업체 연결 ===');
  const proc = await api('POST', '/processes', { name: '가공공정', kind: 'process' }, token);
  const ct = await api('POST', '/contractor', { companyName: '(주)대한안전', repName: '김대표' }, token);
  const linked = await api('POST', '/inspection', {
    templateId: tpl.data.id, processId: proc.data.id, relatedContractor: '대한안전',
    results: [{ itemContent: '연결테스트', result: '적합' }],
  }, token);
  const linkRow = (await api('GET', '/inspection', null, token)).data.find((r) => r.id === linked.data.id);
  assert(linkRow.process_id === proc.data.id, '공정 마스터데이터에 연결됨');
  assert(linkRow.contractor_id === ct.data.id, '협력업체도 자동 연결됨(표기가 달라도)');

  console.log('\n=== 9. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'in.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'in.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  assert((await api('GET', '/inspection', null, bLogin.data.token)).data.length === 0, 'B사에서는 A사 점검 기록이 안 보임');
  const bCross = await api('POST', '/inspection', { templateId: tpl.data.id, location: 'x' }, bLogin.data.token);
  assert(bCross.status === 400, 'B사가 A사 점검표 id를 알아내도 쓸 수 없음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
