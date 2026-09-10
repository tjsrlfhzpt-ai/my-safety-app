const db = require('../src/db');
const { bootstrapTestOrg } = require('./_helpers');

const BASE = 'http://localhost:4000';

async function api(method, urlPath, body, token) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  const { orgId, siteId } = await bootstrapTestOrg(BASE);
  const org = { id: orgId };
  const site = { id: siteId };

  console.log('\n1) 안전관리자 계정 등록 (safety_manager)');
  console.log('  →', await api('POST', '/auth/register', {
    orgId: org.id, siteId: site.id, loginId: 'sunggi.lee', password: 'Test1234!', name: '이선기', roleCode: 'safety_manager',
  }));

  console.log('\n2) 근로자 계정 등록 (worker)');
  console.log('  →', await api('POST', '/auth/register', {
    orgId: org.id, siteId: site.id, loginId: 'worker.kim', password: 'Test1234!', name: '김근로', roleCode: 'worker',
  }));

  console.log('\n3) 안전관리자 로그인');
  const loginManager = await api('POST', '/auth/login', { loginId: 'sunggi.lee', password: 'Test1234!' });
  console.log('  →', loginManager.status, loginManager.data.user);
  const tokenManager = loginManager.data.token;

  // 2026-08-28(2-3절): 로그인 직후 정책 동의를 하지 않으면 hasPermission이 모든 데이터
  // API를 막는다(서버가 동의 여부를 다시 검증함). 실제 앱은 동의 게이트 화면에서 처리하지만
  // 이 테스트는 API를 직접 두드리므로 여기서 명시적으로 동의를 기록한다.
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenManager);

  console.log('\n4) 근로자 로그인');
  const loginWorker = await api('POST', '/auth/login', { loginId: 'worker.kim', password: 'Test1234!' });
  console.log('  →', loginWorker.status, loginWorker.data.user);
  const tokenWorker = loginWorker.data.token;
  await api('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, tokenWorker);

  console.log('\n5) 근로자가 고위험 위험성평가 등록 (가능성5 x 중대성4=20) → CAPA 자동 생성 확인');
  const risk = await api('POST', '/risks', {
    hazard: '캐디 카트 급경사 구간 전복 위험', likelihood: 5, severity: 4, existingMeasures: '없음',
  }, tokenWorker);
  console.log('  →', risk.status, risk.data);

  console.log('\n6) 근로자가 방금 등록한 위험성평가를 "완전 삭제" 시도 → 거부되어야 함 (risk.delete_any 없음)');
  console.log('  →', await api('DELETE', `/risks/${risk.data.id}`, null, tokenWorker));

  console.log('\n7) 안전관리자는 동일 항목 삭제 가능해야 함 (soft delete)');
  console.log('  →', await api('DELETE', `/risks/${risk.data.id}`, null, tokenManager));

  console.log('\n8) CAPA 상태를 "등록 → 완료요청"으로 단계 건너뛰기 시도 → 거부되어야 함');
  console.log('  →', await api('PATCH', `/capa/${risk.data.autoCapaId}/status`, { status: '완료요청' }, tokenManager));

  console.log('\n9) CAPA 상태를 정상 절차대로 "등록 → 조치중" 전환');
  console.log('  →', await api('PATCH', `/capa/${risk.data.autoCapaId}/status`, { status: '조치중' }, tokenManager));

  console.log('\n10) 감사로그 확인 (누가/언제/무엇을/어떻게)');
  const logs = db.prepare(`
    SELECT actor_name, action, entity_type, entity_id, created_at
    FROM audit_logs ORDER BY created_at
  `).all();
  console.table(logs);
})();
