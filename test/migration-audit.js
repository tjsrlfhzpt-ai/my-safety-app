// 배포 마이그레이션 검증 (2026-09-05)
//
// 왜 이 테스트가 필요한가:
// schema.sql은 "새 DB를 처음 만들 때"만 실행됩니다. 이미 운영 중인 서버의 DB에는
// 적용되지 않으므로, 새로 추가한 테이블·컬럼은 db.js의 마이그레이션이 처리해야 합니다.
//
// 실제로 이 시나리오를 돌려보다가 서버가 아예 기동하지 못하는 문제를 발견했습니다
// (아직 없는 테이블에 컬럼을 추가하려다 "no such table: equipment"로 죽음).
// 새 기능을 추가할 때마다 같은 실수가 반복될 수 있으므로 테스트로 남깁니다.
//
// 실행 방법: 서버를 띄우지 말고 이 스크립트만 실행하세요(스크립트가 직접 띄웁니다).
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data.sqlite');
const BASE = 'http://localhost:4000';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 이번 세션에 추가된 테이블들을 들어낸 "구버전" 스키마를 만듭니다.
const NEW_TABLES = [
  'equipment', 'processes', 'loto_energy_sources', 'loto_permits',
  'work_env_measurements', 'ergonomic_surveys', 'ergonomic_symptoms',
  'stress_assessments', 'stress_counselings', 'risk_assessment_versions', 'system_errors',
  'inspection_templates', 'inspection_template_items', 'inspections', 'inspection_results',
  'safety_budgets', 'safety_budget_items', 'contractor_evaluations',
  'compliance_reviews', 'compliance_review_results',
];

function buildOldSchema() {
  let s = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf-8');
  for (const t of NEW_TABLES) {
    s = s.replace(new RegExp(`CREATE TABLE ${t} \\([\\s\\S]*?\\);\\n`), '');
  }
  // 나중에 추가된 컬럼들도 제거해 진짜 예전 상태를 흉내냅니다.
  s = s.replace(/^\s*contractor_id\s+TEXT REFERENCES contractors\(id\),.*\n/gm, '');
  s = s.replace(/^\s*must_change_password.*\n/gm, '');
  s = s.replace(/^\s*process_id\s+TEXT REFERENCES processes\(id\),.*\n/gm, '');
  s = s.replace(/^\s*attendees\s+TEXT,.*\n/gm, '');
  return s;
}

(async () => {
  console.log('=== 0. 구버전 DB + 기존 운영 데이터 준비 ===');
  try { execSync('pkill -9 -f "node server.js"'); } catch (e) { /* 떠 있지 않으면 무시 */ }
  await wait(600);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { if (fs.existsSync(f)) fs.unlinkSync(f); }

  const db = new Database(DB);
  db.exec(buildOldSchema());
  db.exec(`INSERT INTO organizations (id, name) VALUES ('ORG-OLD', '기존제조(주)')`);
  db.exec(`INSERT INTO sites (id, org_id, name) VALUES ('SITE-OLD', 'ORG-OLD', '1공장')`);
  db.exec(`INSERT INTO near_misses (id, site_id, title, content, related_contractor)
           VALUES ('NM-OLD', 'SITE-OLD', '기존 아차사고', '절대 사라지면 안 되는 내용', '(주)기존업체')`);
  db.exec(`INSERT INTO risk_assessments (id, site_id, hazard, likelihood, severity, risk_score)
           VALUES ('RISK-OLD', 'SITE-OLD', '기존 위험요인', 4, 4, 16)`);
  db.close();
  assert(true, '이번 세션 이전 상태의 DB에 실제 운영 데이터를 넣어둠');

  console.log('\n=== 1. 🔑 새 버전 서버가 기존 DB 위에서 정상 기동하는가 ===');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, JWT_SECRET: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  await wait(3500);

  let health = null;
  try { health = await (await fetch(`${BASE}/health`)).json(); } catch (e) { /* 기동 실패 */ }
  assert(health && health.ok === true, '기존 DB 위에서 서버가 정상 기동함');
  assert(!/no such table/i.test(log), '"no such table" 오류 없음 (테이블 생성이 컬럼 추가보다 먼저 실행됨)');
  if (!health) console.log('  [기동 로그]', log.slice(-500));

  console.log('\n=== 2. 🔑 기존 데이터가 그대로 살아있는가 (가장 중요) ===');
  const check = new Database(DB, { readonly: true });
  const nm = check.prepare('SELECT * FROM near_misses WHERE id = ?').get('NM-OLD');
  assert(!!nm, '기존 아차사고 기록이 사라지지 않음');
  assert(nm && nm.content === '절대 사라지면 안 되는 내용', '내용이 그대로 보존됨');
  assert(nm && nm.related_contractor === '(주)기존업체', '협력업체 원본 텍스트가 보존됨(FK 전환으로 지워지지 않음)');
  const risk = check.prepare('SELECT * FROM risk_assessments WHERE id = ?').get('RISK-OLD');
  assert(risk && risk.risk_score === 16, '기존 위험성평가와 점수도 그대로');

  console.log('\n=== 3. 신규 테이블이 모두 생성됐는가 ===');
  const created = check.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${NEW_TABLES.map(() => '?').join(',')})`
  ).all(...NEW_TABLES).map((r) => r.name);
  assert(created.length === NEW_TABLES.length,
    `신규 테이블 ${NEW_TABLES.length}개가 모두 생성됨 (실제 ${created.length}개)`);
  const missing = NEW_TABLES.filter((t) => !created.includes(t));
  if (missing.length) console.log('  누락:', missing.join(', '));

  console.log('\n=== 4. 신규 컬럼이 기존 테이블에 추가됐는가 ===');
  const nmCols = check.prepare('PRAGMA table_info(near_misses)').all().map((c) => c.name);
  assert(nmCols.includes('contractor_id'), 'near_misses에 contractor_id 추가됨');
  const userCols = check.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert(userCols.includes('must_change_password'), 'users에 must_change_password 추가됨');
  const eqCols = check.prepare('PRAGMA table_info(equipment)').all().map((c) => c.name);
  assert(eqCols.includes('process_id'), 'equipment에 process_id 추가됨(테이블 생성 직후 컬럼 추가가 순서대로 동작)');
  check.close();

  console.log('\n=== 5. 마이그레이션 후 실제로 쓸 수 있는가 ===');
  const eqRes = await fetch(`${BASE}/health`);
  assert(eqRes.ok, '서버가 계속 정상 응답함');

  server.kill('SIGKILL');
  await wait(300);

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
