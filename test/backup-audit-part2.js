// 백업 시스템 검증 2부 (BACKUP_SECRET 설정된 환경 전용) - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { bootstrapTestOrg } = require('./_helpers');

const SECRET = process.env.BACKUP_SECRET;
if (!SECRET) { console.error('BACKUP_SECRET 환경변수가 필요합니다.'); process.exit(1); }

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
  console.log('=== 0. 백업으로 확인할 실제 데이터 심어두기 ===');
  const { orgId, siteId } = await bootstrapTestOrg(BASE, '백업테스트조직2');
  await apiRaw('POST', '/auth/register', { orgId, siteId, loginId: 'backup.test2', password: 'Test1234!', name: '백업테스트2' });
  const login = await apiRaw('POST', '/auth/login', { loginId: 'backup.test2', password: 'Test1234!' });
  await apiRaw('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, login.data.token);
  const markerContent = `백업무결성마커-${Date.now()}`;
  const nmRes = await apiRaw('POST', '/nearmiss', { content: markerContent }, login.data.token);
  assert(nmRes.status === 201, '검증용 마커 데이터 등록 성공');

  console.log('\n=== 1. 틀린 키로 요청하면 403 ===');
  const wrongKeyRes = await fetch(`${BASE}/admin/backup`, { headers: { 'X-Backup-Key': 'this-is-definitely-wrong' } });
  assert(wrongKeyRes.status === 403, '틀린 백업 키로 요청하면 403 (조직 계정 권한과 무관하게 차단)');

  console.log('\n=== 2. 일반 회사 관리자 로그인 토큰으로는 백업을 받을 수 없음 (완전히 분리된 인증) ===');
  const withNormalToken = await fetch(`${BASE}/admin/backup`, { headers: { Authorization: `Bearer ${login.data.token}` } });
  assert(withNormalToken.status === 403, '일반 로그인 토큰(Authorization 헤더)만으로는 백업에 접근할 수 없음 - 반드시 별도 X-Backup-Key 필요');

  console.log('\n=== 3. 올바른 키로 요청하면 실제 SQLite 파일이 다운로드됨 ===');
  const goodRes = await fetch(`${BASE}/admin/backup`, { headers: { 'X-Backup-Key': SECRET } });
  assert(goodRes.status === 200, '올바른 키로 요청하면 200');
  assert(goodRes.headers.get('content-disposition') && goodRes.headers.get('content-disposition').includes('safety-meerkat-backup'), 'Content-Disposition에 알아보기 쉬운 백업 파일명이 지정됨');

  const buf = Buffer.from(await goodRes.arrayBuffer());
  const tmpPath = path.join(__dirname, '__downloaded_backup_test.sqlite');
  fs.writeFileSync(tmpPath, buf);

  console.log('\n=== 4. 다운로드된 파일이 실제로 유효한 SQLite이고, 방금 넣은 데이터가 그대로 들어있는지 ===');
  try {
    const backupDb = new Database(tmpPath, { readonly: true });
    const row = backupDb.prepare('SELECT content FROM near_misses WHERE content = ?').get(markerContent);
    assert(!!row, '다운로드된 백업 파일 안에 방금 등록한 실제 데이터가 그대로 들어있음 (단순 빈 파일이 아님)');
    backupDb.close();
  } catch (e) {
    assert(false, `다운로드된 파일이 유효한 SQLite여야 함 (오류: ${e.message})`);
  } finally {
    fs.unlinkSync(tmpPath);
  }

  console.log('\n=== 5. 백업 디렉터리에 실제로 스냅샷 파일이 쌓이고 있는지 ===');
  const { BACKUP_DIR } = require('../src/backup');
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('backup-'));
  assert(files.length >= 1, '백업 디렉터리에 실제 스냅샷 파일이 최소 1개 이상 존재함');

  console.log('\n==================================================');
  console.log(`결과(2차): ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
