// 운영 모니터링(오류 로그) 검증 (2026-08-30, 출시단계 업그레이드) - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
const Database = require('better-sqlite3');
const path = require('path');

const SECRET = process.env.BACKUP_SECRET;
if (!SECRET) { console.error('BACKUP_SECRET 환경변수가 필요합니다.'); process.exit(1); }

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}

(async () => {
  console.log('=== 0. DB에 직접 오류 2건을 심어서(전역 핸들러가 남길 법한 형태) 준비 ===');
  const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
  db.prepare('INSERT INTO system_errors (message, stack, path, method, status_code) VALUES (?, ?, ?, ?, ?)')
    .run('테스트 오류 1 - 잘못된 참조', 'Error: 테스트\\n    at test.js:1:1', '/risks/RISK-999', 'PATCH', 500);
  db.prepare('INSERT INTO system_errors (message, stack, path, method, status_code) VALUES (?, ?, ?, ?, ?)')
    .run('테스트 오류 2 - unhandledRejection', 'Error: 테스트2', 'unhandledRejection', 'PROCESS', null);
  db.close();

  console.log('\n=== 1. 비밀키 없이 요청하면 403 (백업과 동일한 보호) ===');
  const noKeyRes = await fetch(`${BASE}/admin/errors`);
  assert(noKeyRes.status === 403, '비밀키 없이 요청하면 403');

  console.log('\n=== 2. 올바른 키로 요청하면 최근 오류 목록이 실제로 조회됨 ===');
  const goodRes = await fetch(`${BASE}/admin/errors`, { headers: { 'X-Backup-Key': SECRET } });
  const errors = await goodRes.json();
  assert(goodRes.status === 200, '올바른 키로 200');
  assert(Array.isArray(errors) && errors.length === 2, '방금 심어둔 오류 2건이 정확히 조회됨');
  assert(errors[0].message === '테스트 오류 2 - unhandledRejection', '최신순(내림차순)으로 정렬되어 나옴');
  assert(errors.some((e) => e.path === 'unhandledRejection' && e.method === 'PROCESS'), '프로세스 레벨 오류(unhandledRejection)도 같은 테이블/API로 조회됨');

  console.log('\n=== 3. limit 파라미터가 실제로 동작함 ===');
  const limitedRes = await fetch(`${BASE}/admin/errors?limit=1`, { headers: { 'X-Backup-Key': SECRET } });
  const limited = await limitedRes.json();
  assert(limited.length === 1, 'limit=1 지정 시 1건만 반환됨');

  console.log('\n=== 4. 삭제(DELETE)도 같은 비밀키로만 가능하고, 실제로 지워짐 ===');
  const delNoKey = await fetch(`${BASE}/admin/errors`, { method: 'DELETE' });
  assert(delNoKey.status === 403, '비밀키 없이 삭제 시도하면 403');
  const delGood = await fetch(`${BASE}/admin/errors`, { method: 'DELETE', headers: { 'X-Backup-Key': SECRET } });
  assert(delGood.status === 200, '올바른 키로 삭제 성공');
  const afterDelete = await (await fetch(`${BASE}/admin/errors`, { headers: { 'X-Backup-Key': SECRET } })).json();
  assert(afterDelete.length === 0, '삭제 후 조회하면 실제로 비어있음');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
