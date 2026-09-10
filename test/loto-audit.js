// LOTO(Lockout/Tagout) 검증 (2026-09-02, 마스터 프롬프트 45-3절)
// 이 모듈의 존재 이유는 "잔류에너지를 확인하지 않으면 작업에 들어갈 수 없게 막는 것"입니다.
// 그 안전장치가 실제로 서버에서 동작하는지를 중심으로 확인합니다.
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
  console.log('=== 0. 준비: 설비 등록 ===');
  const { orgId, siteId } = await bootstrapTestOrg(BASE, 'LOTO테스트');
  await api('POST', '/auth/register', { orgId, siteId, loginId: 'loto.admin', password: 'Test1234!', name: '관리자' });
  const login = await api('POST', '/auth/login', { loginId: 'loto.admin', password: 'Test1234!' });
  const token = login.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, token);

  const eq = await api('POST', '/equipment', { name: '3호기 유압프레스', category: '프레스' }, token);
  assert(eq.status === 201, '대상 설비 등록');

  console.log('\n=== 1. 설비의 에너지원 등록 (한 번 등록하면 계속 씀) ===');
  const src1 = await api('POST', '/loto/sources', {
    equipmentId: eq.data.id, energyType: '전기', sourceName: '주전원 차단기 MCC-3',
    location: 'B동 전기실 3번 패널', isolationMethod: '차단기 OFF 후 잠금장치 체결',
    releaseMethod: '테스터로 무전압 확인',
  }, token);
  assert(src1.status === 201, '전기 에너지원 등록');

  const src2 = await api('POST', '/loto/sources', {
    equipmentId: eq.data.id, energyType: '유압', sourceName: '유압펌프 밸브 V-12',
    isolationMethod: '밸브 잠금', releaseMethod: '압력계 0 확인 후 드레인 밸브 개방',
  }, token);
  assert(src2.status === 201, '유압 에너지원 등록(설비 하나에 에너지원 여러 개)');

  const sources = await api('GET', '/loto/sources', null, token);
  assert(sources.data.filter((s) => s.equipment_id === eq.data.id).length === 2, '해당 설비의 에너지원 2건이 조회됨');
  assert(sources.data.some((s) => s.release_method.includes('압력계')), '잔류에너지 해소 방법이 기록됨(현장에서 그대로 따라할 수 있게)');

  console.log('\n=== 2. 필수값 검증 ===');
  const noEq = await api('POST', '/loto/sources', { energyType: '전기', sourceName: 'X' }, token);
  assert(noEq.status === 400, '대상 설비 없이는 에너지원 등록 불가');

  console.log('\n=== 3. LOTO 작업 신청 ===');
  const permit = await api('POST', '/loto/permits', {
    equipmentId: eq.data.id, workDesc: '3호기 금형 교체', workDate: '2026-09-10',
    worker: '김정비', supervisor: '이반장', lockTagNo: 'LT-001',
    isolatedSources: JSON.stringify(['주전원 차단기 MCC-3', '유압펌프 밸브 V-12']),
  }, token);
  assert(permit.status === 201 && permit.data.id.startsWith('LOTO-'), `작업 신청 (${permit.data.id})`);
  const pList = await api('GET', '/loto/permits', null, token);
  const p0 = pList.data.find((x) => x.id === permit.data.id);
  assert(p0.status === '신청', '초기 상태는 "신청"');
  assert(p0.residual_checked === 0, '잔류에너지는 아직 미확인 상태');

  console.log('\n=== 4. 🔒 핵심 안전장치: 잔류에너지 확인 없이 작업 시작 불가 ===');
  const skipToWork = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '작업중' }, token);
  assert(skipToWork.status === 400, '신청 상태에서 곧바로 "작업중"으로 건너뛸 수 없음');

  const isolate = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '차단완료' }, token);
  assert(isolate.status === 200, '에너지원 차단·잠금 완료로 전이');
  const afterIsolate = (await api('GET', '/loto/permits', null, token)).data.find((x) => x.id === permit.data.id);
  assert(!!afterIsolate.isolated_at, '차단 시각이 자동 기록됨');

  // 여기가 가장 중요합니다 - 차단은 했지만 잔류에너지 확인을 안 한 상태
  const noResidual = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '작업중' }, token);
  assert(noResidual.status === 400, '🔒 차단만 하고 잔류에너지를 확인하지 않으면 작업에 들어갈 수 없음');
  assert(noResidual.data.error.includes('잔류에너지'), '왜 막혔는지 현장에서 알아들을 수 있게 설명함');

  console.log('\n=== 5. 잔류에너지 확인 후에야 작업 가능 ===');
  const check = await api('PATCH', `/loto/permits/${permit.data.id}/residual-check`, { checker: '박안전' }, token);
  assert(check.status === 200, '잔류에너지 확인 기록');
  const afterCheck = (await api('GET', '/loto/permits', null, token)).data.find((x) => x.id === permit.data.id);
  assert(afterCheck.residual_checked === 1 && afterCheck.residual_checker === '박안전',
    '누가 확인했는지 기록됨(사고 조사 시 핵심 근거)');

  const nowWork = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '작업중' }, token);
  assert(nowWork.status === 200, '확인이 끝나면 작업을 시작할 수 있음');

  console.log('\n=== 6. 잔류에너지 확인은 차단 후에만 가능 ===');
  const permit2 = await api('POST', '/loto/permits', { equipmentId: eq.data.id, workDesc: '순서 확인용' }, token);
  const earlyCheck = await api('PATCH', `/loto/permits/${permit2.data.id}/residual-check`, {}, token);
  assert(earlyCheck.status === 400, '차단하기 전에는 잔류에너지 확인을 기록할 수 없음(절차 역전 방지)');

  console.log('\n=== 7. 나머지 단계 전이 ===');
  const restore = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '복구완료' }, token);
  assert(restore.status === 200, '복구완료로 전이');
  const afterRestore = (await api('GET', '/loto/permits', null, token)).data.find((x) => x.id === permit.data.id);
  assert(!!afterRestore.restored_at, '복구 시각이 자동 기록됨');
  const close = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '종료' }, token);
  assert(close.status === 200, '종료로 전이');
  const backward = await api('PATCH', `/loto/permits/${permit.data.id}/status`, { status: '작업중' }, token);
  assert(backward.status === 400, '종료된 작업을 되돌릴 수 없음');

  console.log('\n=== 8. 조직 경계 ===');
  const orgB = await bootstrapTestOrg(BASE, 'B사');
  await api('POST', '/auth/register', { orgId: orgB.orgId, siteId: orgB.siteId, loginId: 'loto.b', password: 'Test1234!', name: 'B' });
  const bLogin = await api('POST', '/auth/login', { loginId: 'loto.b', password: 'Test1234!' });
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, bLogin.data.token);
  const bList = await api('GET', '/loto/permits', null, bLogin.data.token);
  assert(bList.data.length === 0, 'B사에서는 A사 LOTO 기록이 보이지 않음');
  const bStatus = await api('PATCH', `/loto/permits/${permit2.data.id}/status`, { status: '차단완료' }, bLogin.data.token);
  assert(bStatus.status === 404, 'B사가 A사 LOTO id를 알아내도 상태를 바꿀 수 없음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
