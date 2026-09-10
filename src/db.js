const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (isNew) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
  db.exec(schema);
  console.log('[db] schema.sql 적용 완료:', DB_PATH);
}

// 2026-08-28: 개인정보 동의(2-3절) 컬럼 추가. schema.sql은 "새 DB를 처음 만들 때만" 적용되므로
// (위 isNew 분기), 이미 존재하는 DB에는 반영되지 않는다. 기존 데이터는 절대 건드리지 않고
// 누락된 컬럼만 안전한 기본값(NULL)으로 추가하는 방식 - README가 지켜온 마이그레이션 원칙과
// 동일하다. 컬럼이 이미 있으면 조용히 건너뛴다(재기동해도 안전 = idempotent).
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[db] 마이그레이션: ${table}.${column} 컬럼 추가`);
  }
}
// ============================================================================
// ⚠️ 실행 순서가 중요합니다 (2026-09-02 배포 시뮬레이션에서 발견한 문제)
// ----------------------------------------------------------------------------
// schema.sql은 "새 DB를 처음 만들 때"만 실행됩니다. 이미 운영 중인 서버의 DB에는
// 적용되지 않으므로, 새로 추가한 테이블·컬럼은 여기서 다시 한 번 만들어 줍니다.
//
// 이때 반드시 "테이블 생성 → 컬럼 추가" 순서를 지켜야 합니다. 반대로 하면 아직
// 존재하지 않는 테이블에 컬럼을 붙이려다 서버가 아예 기동하지 못합니다.
// 실제로 기존 DB에 새 버전을 올리는 시뮬레이션에서 이 문제로 서버가 죽는 것을
// 확인했고(no such table: equipment), 그래서 순서를 이렇게 고정했습니다.
// ============================================================================

// ── (1) 신규 테이블 먼저 생성 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS compliance_reviews (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    review_period TEXT NOT NULL, review_date TEXT, reviewer TEXT, scope TEXT,
    total_count INTEGER, ok_count INTEGER, ng_count INTEGER, compliance_rate TEXT,
    finding TEXT, improvement TEXT, next_review_date TEXT,
    status TEXT DEFAULT '점검완료', memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS compliance_review_results (
    id TEXT PRIMARY KEY, review_id TEXT NOT NULL, item_no TEXT,
    item_title TEXT NOT NULL, tag TEXT, result TEXT, note TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS safety_budgets (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    fiscal_year TEXT, project_name TEXT, contract_amount TEXT, planned_amount TEXT,
    memo TEXT, status TEXT DEFAULT '집행중',
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS safety_budget_items (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    budget_id TEXT, spend_date TEXT, category TEXT, content TEXT NOT NULL,
    amount TEXT, vendor TEXT, evidence_no TEXT,
    related_contractor TEXT, contractor_id TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS contractor_evaluations (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    contractor_id TEXT, related_contractor TEXT, eval_date TEXT, period TEXT,
    evaluator TEXT, grade TEXT, strength TEXT, weakness TEXT, improvement TEXT,
    followup_date TEXT, status TEXT DEFAULT '평가완료', memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS inspection_templates (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    name TEXT NOT NULL, kind TEXT, description TEXT, status TEXT DEFAULT '사용중', memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS inspection_template_items (
    id TEXT PRIMARY KEY, template_id TEXT NOT NULL, seq INTEGER DEFAULT 0,
    content TEXT NOT NULL, legal_basis TEXT, memo TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS inspections (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    template_id TEXT, process_id TEXT, inspect_date TEXT, kind TEXT, location TEXT,
    inspector TEXT, accompanied TEXT, total_count INTEGER, ng_count INTEGER,
    summary TEXT, status TEXT DEFAULT '점검완료',
    related_contractor TEXT, contractor_id TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS inspection_results (
    id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL, item_id TEXT, seq INTEGER DEFAULT 0,
    item_content TEXT NOT NULL, result TEXT, finding TEXT, action TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stress_assessments (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    process_id TEXT, assess_date TEXT, round_no TEXT, target_group TEXT NOT NULL,
    target_count INTEGER, respond_count INTEGER, method TEXT, high_risk_count INTEGER,
    main_factor TEXT, finding TEXT, improvement TEXT, next_assess_date TEXT, agency TEXT,
    status TEXT DEFAULT '평가완료', memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS stress_counselings (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    assessment_id TEXT, subject_code TEXT NOT NULL, is_anonymous INTEGER DEFAULT 1,
    counsel_date TEXT, counselor TEXT, action_taken TEXT, followup_date TEXT,
    status TEXT DEFAULT '상담완료', memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS ergonomic_surveys (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    process_id TEXT, survey_date TEXT, round_no TEXT, task_name TEXT NOT NULL,
    location TEXT, burden_type TEXT, worker_count INTEGER, method TEXT,
    risk_level TEXT, finding TEXT, improvement TEXT, next_survey_date TEXT,
    status TEXT DEFAULT '조사완료', related_contractor TEXT, contractor_id TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS ergonomic_symptoms (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    survey_id TEXT, worker_name TEXT NOT NULL, report_date TEXT, body_part TEXT,
    symptom_level TEXT, work_related TEXT, action_taken TEXT, followup_date TEXT,
    status TEXT DEFAULT '접수', memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS work_env_measurements (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    process_id TEXT, measure_date TEXT, round_no TEXT, location TEXT NOT NULL,
    factor_type TEXT, factor_name TEXT NOT NULL, result_value TEXT, unit TEXT,
    exposure_limit TEXT, exceeded INTEGER DEFAULT 0, worker_count INTEGER,
    agency TEXT, improvement TEXT, next_measure_date TEXT,
    status TEXT DEFAULT '측정완료', related_contractor TEXT, contractor_id TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS loto_energy_sources (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL, equipment_id TEXT NOT NULL,
    energy_type TEXT NOT NULL, source_name TEXT NOT NULL, location TEXT,
    isolation_method TEXT, release_method TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS loto_permits (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    equipment_id TEXT, work_desc TEXT NOT NULL, work_date TEXT,
    worker TEXT, supervisor TEXT, lock_tag_no TEXT, isolated_sources TEXT,
    residual_checked INTEGER DEFAULT 0, residual_checker TEXT,
    status TEXT DEFAULT '신청', isolated_at TEXT, restored_at TEXT,
    related_contractor TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE, site_id TEXT NOT NULL,
    parent_id TEXT, kind TEXT NOT NULL DEFAULT 'process', code TEXT,
    name TEXT NOT NULL, description TEXT, manager TEXT, hazard_summary TEXT,
    status TEXT DEFAULT '운영중', sort_order INTEGER DEFAULT 0, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS equipment (
    id TEXT PRIMARY KEY, legacy_id TEXT UNIQUE,
    site_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT, asset_no TEXT,
    maker TEXT, model_no TEXT, location TEXT, install_date TEXT,
    inspection_required INTEGER DEFAULT 1, inspection_cycle TEXT,
    last_inspection_date TEXT, next_inspection_date TEXT, inspection_result TEXT,
    inspection_agency TEXT, cert_no TEXT, operator TEXT,
    status TEXT DEFAULT '사용중', related_contractor TEXT, memo TEXT,
    created_by TEXT, updated_at TEXT, updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS risk_assessment_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id TEXT NOT NULL,
    version_no INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    changed_fields TEXT,
    changed_by TEXT,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS system_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT, stack TEXT, path TEXT, method TEXT, status_code INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── (2) 그 다음에 컬럼 추가 ──────────────────────────────────────────────────
addColumnIfMissing('users', 'consent_privacy_at', 'consent_privacy_at TEXT');
addColumnIfMissing('users', 'consent_terms_at', 'consent_terms_at TEXT');
addColumnIfMissing('users', 'consent_sensitive_at', 'consent_sensitive_at TEXT');
addColumnIfMissing('users', 'consent_policy_version', 'consent_policy_version TEXT');

// 2026-08-28 후속조치(출시전 점검보고서 3절 "12개 모듈 PATCH API 부재"): 수정 기능을 추가하며
// "누가 언제 고쳤는지"도 함께 남긴다(지침 10 - 변경이력). 이 12개 테이블은 원래 created_by/
// created_at만 있고 updated_*가 아예 없었다.
const UPDATABLE_TABLES = [
  'risk_assessments', 'incidents', 'near_misses', 'tbm_records', 'voice_reports',
  'legal_meetings', 'msds_items', 'health_records', 'training_records', 'ppe_records',
  'legal_appointments', 'contractors', 'equipment', 'processes',
  'loto_energy_sources', 'loto_permits', 'work_env_measurements',
  'ergonomic_surveys', 'ergonomic_symptoms',
  'stress_assessments', 'stress_counselings', 'inspection_templates', 'inspections',
  'safety_budgets', 'safety_budget_items', 'contractor_evaluations', 'compliance_reviews',
];
for (const t of UPDATABLE_TABLES) {
  addColumnIfMissing(t, 'updated_at', 'updated_at TEXT');
  addColumnIfMissing(t, 'updated_by', 'updated_by TEXT');
}

// 2026-08-30(전자서명 서버 연동): TBM 참석자 명단을 저장할 컬럼. 서명 이미지 자체는
// attachments 테이블에 별도로 올라간다(entityType='tbm') - 무거운 이미지를 이 컬럼에
// 직접 넣지 않아야 목록조회가 계속 가볍게 유지된다.
addColumnIfMissing('tbm_records', 'attendees', 'attendees TEXT');
addColumnIfMissing('training_records', 'attendees', 'attendees TEXT');

// 2026-09-02: 첨부파일 소프트 삭제 전환(기존 DB에도 안전하게 반영)
addColumnIfMissing('attachments', 'deleted', 'deleted INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('attachments', 'deleted_at', 'deleted_at TEXT');
addColumnIfMissing('attachments', 'deleted_by', 'deleted_by TEXT');

// 2026-09-02(비밀번호 복구): 관리자가 임시 비밀번호를 발급하면 이 값이 1이 되고, 사용자가
// 스스로 새 비밀번호로 바꾸면 0으로 돌아간다. 임시 비밀번호를 계속 쓰는 것을 막기 위함이다.
addColumnIfMissing('users', 'must_change_password', 'must_change_password INTEGER NOT NULL DEFAULT 0');

// 2026-09-02: 설비를 공정에 연결(기존 DB에도 반영)
addColumnIfMissing('equipment', 'process_id', 'process_id TEXT');

// ============================================================================
// 2026-09-02(마스터 프롬프트 45-4·13절): 협력업체를 텍스트가 아닌 실제 연결로 바꾸기
// ----------------------------------------------------------------------------
// 지금까지 9개 모듈이 협력업체를 related_contractor라는 "자유입력 텍스트"로만 갖고
// 있었습니다. 그래서 "(주)한국기계", "한국기계", "한국기계(주)"가 전부 다른 업체로
// 취급되어, "이 업체에서 사고가 몇 건 났는지" 집계가 어긋났습니다. 도급 관리(45-4절)의
// 발목을 잡는 지점입니다.
//
// ⚠️ 여기서 가장 중요한 원칙은 "기존 데이터를 잃지 않는 것"입니다(13절).
// 그래서 텍스트 컬럼을 지우고 FK로 바꾸는 방식은 쓰지 않았습니다. 이미 운영 중인
// 데이터에 오타나 폐업 업체명이 들어있을 수 있는데, 그걸 정리하려다 원본을 날리면
// 되돌릴 수 없기 때문입니다.
//
// 대신 이렇게 합니다:
//   - related_contractor(텍스트)는 그대로 둡니다 — 사람이 적은 원본은 언제나 보존됩니다.
//   - contractor_id(FK)를 새로 추가합니다 — 목록에서 고르면 여기 채워집니다.
//   - 화면은 FK가 있으면 그걸 쓰고, 없으면 기존 텍스트를 그대로 보여줍니다.
// 이러면 예전 데이터도 계속 보이고, 새 데이터부터 정확한 집계가 가능해집니다.
// ============================================================================
const CONTRACTOR_LINKED_TABLES = [
  'risk_assessments', 'incidents', 'near_misses', 'tbm_records',
  'legal_meetings', 'training_records', 'permits', 'loto_permits', 'equipment', 'work_env_measurements', 'ergonomic_surveys', 'inspections', 'safety_budget_items', 'contractor_evaluations',
];
for (const t of CONTRACTOR_LINKED_TABLES) {
  addColumnIfMissing(t, 'contractor_id', 'contractor_id TEXT');
}

// 2026-08-30(운영 모니터링): schema.sql은 신규 설치 때만 실행되므로, 이미 떠 있는 서버의
// 기존 DB에도 이 테이블이 생기도록 별도로 한 번 더 만든다(이미 있으면 아무 일도 안 함).

// ============================================================================
// 2026-09-10: 회원가입(가입코드) 도입
// ----------------------------------------------------------------------------
// 근로자가 자기 회사에 합류하려면 회사를 특정할 방법이 필요한데, 내부 ID
// (ORG-2026-xxxxxxxx)를 외우게 할 수는 없다. 회사마다 짧은 가입코드를 두고
// 관리자가 근로자에게 알려주는 방식으로 한다.
//
// 코드 형식: 영문 대문자+숫자 6자. 사람이 받아적고 입력하는 값이라 혼동하기 쉬운
// 문자(0/O, 1/I/L)는 애초에 후보에서 제외한다.
// ============================================================================
addColumnIfMissing('organizations', 'join_code', 'join_code TEXT');

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeJoinCode() {
  let s = '';
  for (let i = 0; i < 6; i += 1) {
    s += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return s;
}
// 이미 존재하는 조직에는 코드가 없으므로 한 번 채워준다(신규 설치 시엔 대상이 0건).
// UNIQUE 인덱스를 걸기 "전에" 채워야 중복으로 인덱스 생성이 실패하지 않는다.
const orgsWithoutCode = db.prepare('SELECT id FROM organizations WHERE join_code IS NULL').all();
if (orgsWithoutCode.length > 0) {
  const used = new Set(
    db.prepare('SELECT join_code FROM organizations WHERE join_code IS NOT NULL').all().map((r) => r.join_code)
  );
  const upd = db.prepare('UPDATE organizations SET join_code = ? WHERE id = ?');
  for (const org of orgsWithoutCode) {
    let code = makeJoinCode();
    while (used.has(code)) code = makeJoinCode();
    used.add(code);
    upd.run(code, org.id);
  }
  console.log(`[db] 마이그레이션: 기존 조직 ${orgsWithoutCode.length}건에 가입코드 부여`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_join_code ON organizations(join_code)');

module.exports = db;
module.exports.DB_PATH = DB_PATH;
module.exports.makeJoinCode = makeJoinCode;
