// 백업 시스템 검증 (2026-08-30, 출시단계 업그레이드) - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { bootstrapTestOrg } = require('./_helpers');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}

async function apiRaw(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  console.log('=== 0. 백업으로 확인할 실제 데이터 하나 심어두기 ===');
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '백업테스트조직');
  await apiRaw('POST', '/auth/register', { orgId, siteId, loginId: 'backup.test', password: 'Test1234!', name: '백업테스트' });
  const login = await apiRaw('POST', '/auth/login', { loginId: 'backup.test', password: 'Test1234!' });
  await apiRaw('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, login.data.token);
  const markerContent = `백업무결성마커-${Date.now()}`;
  await apiRaw('POST', '/nearmiss', { content: markerContent }, login.data.token);

  console.log('\n=== 1. BACKUP_SECRET 없이 요청 시 404 (기능 자체가 존재하지 않는 것처럼 숨김) ===');
  const noKeyRes = await fetch(`${BASE}/admin/backup`);
  assert(noKeyRes.status === 404, 'BACKUP_SECRET 미설정 시 404');

  console.log('\n==================================================');
  console.log(`결과(1차): ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
