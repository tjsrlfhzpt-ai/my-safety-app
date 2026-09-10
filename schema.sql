-- ============================================================
-- 안전 미어캣 Pro — 서버 데이터 모델 (1단계 코어)
-- SQLite로 로컬 검증. datetime('now')/TEXT 타입 위주로 작성해
-- PostgreSQL로 옮길 때도 큰 변경 없이 이식되도록 함.
--
-- id 규칙: v5.7의 IdGenerator가 이미 "{PREFIX}-{연도}-{6자리}" 형식
-- (예: RISK-2026-000001)의 사람이 읽을 수 있는 ID를 쓰고 있으므로,
-- 안전관리 도메인 테이블은 이 규칙을 서버에서도 그대로 이어받는다.
-- (id_counters 테이블이 기존 State.idCounters 역할을 대신함)
-- 신규로 생기는 조직/사업장/사용자/권한 관련 테이블은 기존 앱에
-- 대응 개념이 없었으므로 ORG-/SITE-/USER- 접두어를 새로 부여한다.
-- ============================================================

CREATE TABLE id_counters (
  counter_key   TEXT PRIMARY KEY,   -- 예: 'RISK-2026', 'CAPA-2026'
  value         INTEGER NOT NULL DEFAULT 0
);

-- 1. 조직 계층 (지시서 5번: 회사-사업장-부서-팀) --------------------
CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  biz_reg_no    TEXT,
  join_code     TEXT,                             -- 근로자 가입용 6자리 코드 (2026-09-10)
  plan_tier     TEXT NOT NULL DEFAULT 'free',   -- free/basic/professional/enterprise (52번)
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

CREATE TABLE sites (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  name          TEXT NOT NULL,
  address       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

CREATE TABLE departments (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  name          TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE teams (
  id              TEXT PRIMARY KEY,
  department_id   TEXT NOT NULL REFERENCES departments(id),
  name            TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0
);

-- 2. 사용자 / 역할 / 권한 (지시서 4·6번) ---------------------------
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  legacy_id           TEXT UNIQUE,   -- v5.7 단일 사용자 데이터에서 이관 시 참조용(현재는 단일 사용자라 대부분 NULL)
  org_id              TEXT NOT NULL REFERENCES organizations(id),
  site_id             TEXT REFERENCES sites(id),
  department_id       TEXT REFERENCES departments(id),
  team_id             TEXT REFERENCES teams(id),
  login_id            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  name                TEXT NOT NULL,
  employee_no         TEXT,
  position            TEXT,
  phone               TEXT,
  email               TEXT,
  user_type           TEXT NOT NULL DEFAULT 'employee',  -- employee/contractor
  account_status      TEXT NOT NULL DEFAULT 'active',    -- active/locked/dormant/disabled
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  last_login_at       TEXT,
  -- 2026-08-28: 개인정보 수집·이용/이용약관/민감정보(건강정보 등) 처리 동의 시각. NULL이면
  -- 미동의 상태 - 로그인 시 이 값들이 채워질 때까지 앱 사용 전 동의 화면을 먼저 띄운다.
  consent_privacy_at    TEXT,
  consent_terms_at      TEXT,
  consent_sensitive_at  TEXT,
  consent_policy_version TEXT,
  -- 2026-09-02: 관리자가 임시 비밀번호를 발급한 상태. 사용자가 직접 바꾸면 0으로 돌아간다.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  deleted_by          TEXT
);

CREATE TABLE roles (
  id    TEXT PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE permissions (
  id    TEXT PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE
);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id   TEXT NOT NULL REFERENCES users(id),
  role_id   TEXT NOT NULL REFERENCES roles(id),
  site_id   TEXT REFERENCES sites(id),   -- NULL = 조직 전체 범위
  PRIMARY KEY (user_id, role_id, site_id)
);

-- 3. 안전관리 핵심 모듈 (오늘 구현: 위험성평가, CAPA / 나머지는 6절 참고) ----
CREATE TABLE risk_assessments (
  id                  TEXT PRIMARY KEY,   -- RISK-2026-000001 형식
  legacy_id           TEXT UNIQUE,        -- v14 이전 구식 id('r1' 등)였던 경우만 채움
  site_id             TEXT NOT NULL REFERENCES sites(id),
  process_name        TEXT,
  task_name           TEXT,
  hazard              TEXT NOT NULL,
  existing_measures   TEXT,
  likelihood          INTEGER,
  severity            INTEGER,
  risk_score          INTEGER,
  reduction_measures  TEXT,
  post_likelihood     INTEGER,
  post_severity       INTEGER,
  post_risk_score     INTEGER,
  previous_assessment_id TEXT REFERENCES risk_assessments(id),  -- v16 재평가 연결과 동일 개념
  status              TEXT NOT NULL DEFAULT 'draft',
  assignee_id         TEXT REFERENCES users(id),
  due_date            TEXT,
  related_contractor  TEXT,           -- v5.14: 관련 협력업체(회사명 문자열, 로컬 앱과 동일한 방식 - 15절 참고),
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  created_by          TEXT REFERENCES users(id),  -- NULL 허용: 마이그레이션된 과거 기록은 작성자를 알 수 없는 게 정직한 상태
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by          TEXT REFERENCES users(id),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  deleted_by          TEXT
);

CREATE TABLE incidents (          -- 산업재해, prefix ACC
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  occurred_date   TEXT,
  occurred_time   TEXT,
  location        TEXT,
  victim_name     TEXT,
  injury_type     TEXT,
  body_part       TEXT,
  severity        TEXT,
  lost_days       INTEGER,
  description     TEXT NOT NULL,
  root_cause      TEXT,
  corrective_plan TEXT,           -- 프론트 correctiveAction과 매핑
  report_status   TEXT,           -- 산재보고 진행상태(별도) - status(사고 처리상태)와는 다른 축
  memo            TEXT,
  related_contractor TEXT,          -- v5.14: 관련 협력업체,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  status          TEXT NOT NULL DEFAULT 'investigating',
  created_by      TEXT REFERENCES users(id),  -- NULL 허용(사유는 risk_assessments와 동일, 5절 참고)
  updated_at  TEXT,
  updated_by  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

CREATE TABLE near_misses (        -- 아차사고, prefix NM
  id          TEXT PRIMARY KEY,
  legacy_id   TEXT UNIQUE,
  site_id     TEXT NOT NULL REFERENCES sites(id),
  title       TEXT,
  content     TEXT NOT NULL,
  occurred_date TEXT,
  location    TEXT,               -- v16에서 추가된 발생장소 필드와 동일 개념
  cause       TEXT,
  measure     TEXT,
  manager     TEXT,
  due_date    TEXT,
  memo        TEXT,
  related_contractor TEXT,        -- v5.14: 관련 협력업체,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  status      TEXT NOT NULL DEFAULT '접수',
  created_by  TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  deleted_by  TEXT
);

-- v5.11: TBM(작업 전 안전점검회의), prefix TBM
CREATE TABLE tbm_records (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  tbm_date      TEXT,
  tbm_time      TEXT,
  location      TEXT,
  topic         TEXT NOT NULL,
  hazard        TEXT,
  risk_level    TEXT,
  measure       TEXT,
  health_note   TEXT,
  notice        TEXT,
  supervisor    TEXT,
  related_contractor TEXT,      -- v5.14: 관련 협력업체,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  attendees     TEXT,           -- 2026-08-30: 참석자 명단 JSON [{name, signed}] - 서명 이미지 자체는
                                 -- attachments 테이블에 별도 업로드(엔티티타입 'tbm')하고, signed는
                                 -- 그 참석자의 서명이 완료됐는지만 표시. 이렇게 나누면 목록조회 시
                                 -- 무거운 이미지 데이터를 매번 안 불러와도 된다.
  created_by    TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- v5.11: 안전의 소리함(익명 제안/신고), prefix VOC
CREATE TABLE voice_reports (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  report_date     TEXT,
  report_time     TEXT,
  location        TEXT,
  category        TEXT,
  content         TEXT NOT NULL,
  reporter_type   TEXT,            -- 익명/실명
  reporter_name   TEXT,            -- 익명이면 비워둠(프론트에서도 이미 그렇게 처리)
  action_taken    TEXT,
  memo            TEXT,
  status          TEXT NOT NULL DEFAULT '접수',
  created_by      TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- v5.11: 법정회의·점검(산업안전보건위원회 등), prefix LM
CREATE TABLE legal_meetings (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  meeting_date  TEXT,
  meeting_time  TEXT,
  location      TEXT,
  kind          TEXT,
  attendees     TEXT,
  content       TEXT NOT NULL,
  finding       TEXT,
  measure       TEXT,
  next_date     TEXT,
  manager       TEXT,
  memo          TEXT,
  related_contractor TEXT,      -- v5.14: 관련 협력업체,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  status        TEXT NOT NULL DEFAULT '예정',
  created_by    TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- v5.12: MSDS(물질안전보건자료), prefix MSDS
CREATE TABLE msds_items (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  name          TEXT NOT NULL,
  cas_no        TEXT,
  maker         TEXT,
  hazard_grade  TEXT,
  location      TEXT,
  department    TEXT,
  memo          TEXT,
  created_by    TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- v5.12: 건강진단, prefix HLT
CREATE TABLE health_records (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  worker_name   TEXT NOT NULL,
  exam_type     TEXT,
  exam_date     TEXT,
  next_date     TEXT,
  result        TEXT,
  created_by    TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- v5.12: 안전교육 실시기록, prefix EDU
CREATE TABLE training_records (
  id                  TEXT PRIMARY KEY,
  legacy_id           TEXT UNIQUE,
  site_id             TEXT NOT NULL REFERENCES sites(id),
  name                TEXT NOT NULL,   -- 교육명
  training_date       TEXT,
  target_audience     TEXT,
  next_training_date  TEXT,
  material            TEXT,
  attendee_names      TEXT,            -- 콤마로 구분한 명단 원문 (프론트 parseNameList와 호환)
  absentee_names      TEXT,
  attendees           TEXT,            -- 2026-08-30: 서명 가능한 참석자 구조 [{name, signed}]
                                        -- (TBM과 동일 패턴). attendee_names는 계속 원문 텍스트
                                        -- 용도로 남겨두고, 서명 여부는 이 컬럼으로 관리한다.
  memo                TEXT,
  related_contractor  TEXT,          -- v5.14: 관련 협력업체,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  created_by          TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  deleted_by          TEXT
);

-- v5.12: 보호구(PPE) 지급기록, prefix PPE
CREATE TABLE ppe_records (
  id                  TEXT PRIMARY KEY,
  legacy_id           TEXT UNIQUE,
  site_id             TEXT NOT NULL REFERENCES sites(id),
  item_type           TEXT NOT NULL,
  recipient           TEXT,
  issue_date          TEXT,
  quantity            INTEGER,
  next_replace_date   TEXT,
  status              TEXT NOT NULL DEFAULT '지급완료',
  memo                TEXT,
  created_by          TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  deleted_by          TEXT
);

-- v5.13: 법정선임(관리책임자/안전관리자 등 법정 선임자 관리), prefix APT
CREATE TABLE legal_appointments (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  role            TEXT NOT NULL,     -- 직책(관리책임자/안전관리자/보건관리자 등)
  person_name     TEXT NOT NULL,
  appoint_date    TEXT,
  next_edu_date   TEXT,
  cert_number     TEXT,
  status          TEXT NOT NULL DEFAULT '유효',
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- v5.13: 협력업체 - 이벤트 기록이 아니라 마스터데이터(디렉토리) 성격. 다른 모듈에서
-- "관련 협력업체"로 참조하는 연동은 이번 범위에 포함하지 않음(15절 참고). prefix CT
CREATE TABLE contractors (
  id                  TEXT PRIMARY KEY,
  legacy_id           TEXT UNIQUE,
  site_id             TEXT NOT NULL REFERENCES sites(id),
  company_name        TEXT NOT NULL,
  rep_name            TEXT NOT NULL,
  phone               TEXT,
  work_type           TEXT,
  contract_start      TEXT,
  contract_end        TEXT,
  insurance_status    TEXT,
  safety_edu_date     TEXT,
  evaluation          TEXT,
  status              TEXT NOT NULL DEFAULT '계약중',
  memo                TEXT,
  created_by          TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  deleted_by          TEXT
);

-- v5.13: PTW(작업허가서) - CAPA와 동일하게 실제 승인 워크플로우가 있어 상태전이를
-- 서버가 강제한다(15절 참고). prefix PTW
CREATE TABLE permits (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  title           TEXT NOT NULL,
  location        TEXT NOT NULL,
  work_time       TEXT NOT NULL,
  work_date       TEXT,
  manager         TEXT,
  worker          TEXT,
  hazard          TEXT,
  measure         TEXT,
  approver        TEXT,
  memo            TEXT,
  related_contractor TEXT,        -- v5.14: 관련 협력업체,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결
  status          TEXT NOT NULL DEFAULT '등록',  -- 등록/위험확인중/승인대기/승인됨/작업중/종료/반려
  approved_at     TEXT,
  work_started_at TEXT,
  closed_at       TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT REFERENCES users(id),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- v5.15→정정: 처음엔 중대재해처벌법 12개 항목만으로 별도 테이블을 만들었으나, 실제로는
-- 모바일 앱에 이미 "산안법 & 중처법 85개 핵심 법규 DB"(tab-checklist)가 조항·과태료까지
-- 갖춰 존재하고 있었습니다(먼저 확인하지 못한 제 실수 - 19-3절 README 참고). 그 85개 항목을
-- 그대로 서버에 반영합니다. content(tag/title/desc/penalty)는 고정 시드값이고, 사업장별로
-- checked/note만 달라집니다.
CREATE TABLE legal_checklist_items (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  item_no       INTEGER NOT NULL,      -- 1~85, 로컬 앱과 동일한 번호 체계
  tag           TEXT NOT NULL,         -- 법령 조항 근거
  title         TEXT NOT NULL,
  description   TEXT,
  penalty       TEXT,                  -- 과태료/벌금/징역 등 위반 시 처벌 규정
  checked       INTEGER NOT NULL DEFAULT 0,
  note          TEXT,                  -- 이행 근거·증빙 메모
  checked_by    TEXT REFERENCES users(id),
  checked_at    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, item_no)
);

CREATE TABLE capa_actions (        -- CAPA, prefix CAPA
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  source_type     TEXT NOT NULL,   -- risk_assessment/incident/near_miss/legalmeet/voice/ptw/report
  source_id       TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT '등록',  -- 등록/조치중/완료요청/검증중/승인/반려/종결 (기존과 동일)
  assignee_id     TEXT REFERENCES users(id),
  verifier_id     TEXT REFERENCES users(id),
  due_date        TEXT,
  before_photo_key TEXT,
  after_photo_key  TEXT,
  reject_reason   TEXT,
  created_by      TEXT REFERENCES users(id),  -- NULL 허용(사유는 risk_assessments와 동일)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT REFERENCES users(id),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by     TEXT REFERENCES users(id),
  approved_at     TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0
);

-- 4. 감사로그 / 첨부파일 -------------------------------------------
CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_name    TEXT,             -- 당시 이름 스냅샷(계정 삭제돼도 기록은 남게)
  action        TEXT NOT NULL,    -- create/update/delete/restore/status_change/approve/reject/login/logout
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_json   TEXT,
  after_json    TEXT,
  ip_address    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2026-08-30(출시단계 업그레이드 - 운영 모니터링): 예상 못 한 서버 오류가 나도 지금까지는
-- 콘솔 로그에만 찍혀서, 실제로 확인하려면 Render 대시보드 로그를 직접 뒤져야 했다. 최근
-- 오류를 DB에 남겨 관리자가 API로 조회할 수 있게 한다. 요청 본문·헤더(비밀번호·토큰 등이
-- 들어있을 수 있음)는 절대 저장하지 않고, 오류 메시지·스택트레이스·경로·메서드만 남긴다.
-- 2026-09-05(중대재해처벌법 대응, 무사퇴근 "반기점검·안전보건수준평가"): 반기점검.
--
-- 중대재해처벌법은 경영책임자가 안전보건 확보 의무의 이행을 반기 1회 이상 점검하도록
-- 정하고 있습니다. "했다"는 사실뿐 아니라 "무엇을 어떻게 점검했고 무엇을 개선했는지"가
-- 남아야 실제로 의미가 있습니다.
--
-- 기존 법정 체크리스트(legal_checklist_items, 85개 법규 항목)를 다시 만들지 않았습니다.
-- 다만 그 표는 항목별 checked 값 하나만 갖고 있어 점검할 때마다 덮어써집니다. 즉
-- "지금 상태"는 알 수 있어도 "상반기엔 어땠는지"는 알 수 없습니다. 반기점검은 회차 간
-- 비교(무엇이 나아졌는가)가 핵심이므로, 항목은 그대로 참조하고 결과만 회차별로 쌓습니다.
CREATE TABLE compliance_reviews (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  review_period   TEXT NOT NULL,              -- 예: 2026년 상반기
  review_date     TEXT,
  reviewer        TEXT,                       -- 점검 주체(경영책임자·안전보건총괄 등)
  scope           TEXT,                       -- 점검 범위
  total_count     INTEGER,                    -- 점검 항목 수
  ok_count        INTEGER,                    -- 이행 항목 수
  ng_count        INTEGER,                    -- 미이행 항목 수
  compliance_rate TEXT,                       -- 이행률(%) - 표시용 문자열
  finding         TEXT,                       -- 주요 미이행 사항
  improvement     TEXT,                       -- 개선 계획
  next_review_date TEXT,
  status          TEXT DEFAULT '점검완료',     -- 점검완료/개선필요/개선완료
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 회차별 항목 결과 (그 시점의 스냅샷)
-- item_title을 여기 복사해 두는 이유: 법령이 개정되면 항목 문구가 바뀔 수 있는데,
-- 과거 점검 기록은 "그때 무엇을 점검했는지" 그대로 남아야 하기 때문입니다.
CREATE TABLE compliance_review_results (
  id            TEXT PRIMARY KEY,
  review_id     TEXT NOT NULL REFERENCES compliance_reviews(id),
  item_no       TEXT,                         -- 원본 법규 항목 번호
  item_title    TEXT NOT NULL,                -- 점검 당시 항목 문구(스냅샷)
  tag           TEXT,                         -- 분류(산안법/중처법 등)
  result        TEXT,                         -- 이행/미이행/해당없음
  note          TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0
);

-- 2026-09-05(마스터 프롬프트 45-9절, 무사퇴근 "도급관리 고급 기능"): 도급 안전보건관리.
--
-- 중대재해처벌법상 도급인은 수급업체의 안전보건 확보에도 의무를 집니다. 그런데 지금까지
-- 이 시스템의 협력업체 관리는 "업체 명단"에 머물러 있었습니다.
--
-- 무사퇴근이 내세우는 도급 고급기능 4가지 중 이미 있는 것은 빼고 없는 것만 만듭니다:
--   · 안전보건협의체  → 이미 법정회의점검(legal_meetings)의 kind로 관리 중 (중복 안 만듦)
--   · 도급 위험성평가 → 위험성평가에 협력업체 연결이 이미 되어 있음 (중복 안 만듦)
--   · 도급 안전보건교육 → 안전교육에 협력업체 연결이 이미 되어 있음 (중복 안 만듦)
--   · 안전보건관리비  → 없음. 아래에서 신설.
-- 여기에 더해 수급업체 안전보건 평가(정기 평가 이력)를 신설합니다. contractors.evaluation은
-- 값 한 칸뿐이라 "언제 몇 점이었고 왜 그랬는지"를 남길 수 없었기 때문입니다.

-- 산업안전보건관리비 집행 관리
-- 건설공사에서는 공사금액의 일정 비율을 안전보건관리비로 계상하고 그 사용내역을
-- 증빙과 함께 관리해야 합니다. 계상 비율·항목은 고시로 정해지고 개정되므로 코드에
-- 넣지 않고(마스터 프롬프트 83절), 사업장이 계상액과 집행내역을 입력하도록 했습니다.
CREATE TABLE safety_budgets (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  fiscal_year     TEXT,                       -- 대상 연도/공사기간
  project_name    TEXT,                       -- 공사명(건설업)
  contract_amount TEXT,                       -- 도급금액
  planned_amount  TEXT,                       -- 계상액
  memo            TEXT,
  status          TEXT DEFAULT '집행중',       -- 집행중/마감
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 집행 내역 (증빙과 함께)
CREATE TABLE safety_budget_items (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  budget_id       TEXT REFERENCES safety_budgets(id),
  spend_date      TEXT,
  category        TEXT,                       -- 항목(안전시설비/보호구/교육비/진단비 등)
  content         TEXT NOT NULL,              -- 집행 내용
  amount          TEXT,                       -- 집행 금액
  vendor          TEXT,                       -- 지출처
  evidence_no     TEXT,                       -- 증빙번호(세금계산서 등)
  related_contractor TEXT,
  contractor_id   TEXT REFERENCES contractors(id),
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 수급업체 안전보건 평가 (정기 평가 이력)
-- contractors.evaluation은 값 한 칸이라 최신 결과만 남고 이력이 사라집니다.
-- 평가는 "언제 무엇을 보고 어떤 판단을 했는지"가 근거로 남아야 재계약 판단에 쓸 수 있습니다.
CREATE TABLE contractor_evaluations (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  contractor_id   TEXT REFERENCES contractors(id),
  related_contractor TEXT,
  eval_date       TEXT,
  period          TEXT,                       -- 평가 대상기간
  evaluator       TEXT,
  grade           TEXT,                       -- 등급/점수(사업장 기준에 따름)
  strength        TEXT,                       -- 잘한 점
  weakness        TEXT,                       -- 미흡한 점
  improvement     TEXT,                       -- 요구 개선사항
  followup_date   TEXT,
  status          TEXT DEFAULT '평가완료',     -- 평가완료/개선요청/개선완료
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 2026-09-05(경쟁사 대조 - 무사퇴근 "안전점검", 스마플 "안전보건관리규정" 영역): 안전점검.
--
-- 순회점검·정기점검은 안전관리자가 매일 하는 업무입니다. 지금까지는 법정회의점검
-- (legal_meetings)의 kind에 "순회점검"을 넣어 쓰고 있었는데, 그 표는 회의 구조라
-- (참석자·안건·의결사항) 체크리스트 기반 점검을 담을 수 없었습니다. 지적사항이
-- 자유 텍스트 한 칸이라 "15개 항목 중 3개 부적합" 같은 관리가 불가능했습니다.
--
-- 기존 legal_checklist_items(법규 85항목)와는 다릅니다. 그건 법령 조문이 고정 시딩되는
-- 표이고, 사업장이 자기 점검표를 만들 수 없습니다. 그래서 중복이 아니라 별도 구조입니다.
--
-- 표를 넷으로 나눈 이유:
--   templates/template_items = "점검표"(한 번 만들어 매번 재사용)
--   inspections/results      = "실시 기록"(점검할 때마다 쌓임)
-- 이렇게 나눠야 같은 점검표로 반복 점검하면서 "이 항목이 자주 부적합하다"를 볼 수 있습니다.

-- 점검표(재사용 체크리스트)
CREATE TABLE inspection_templates (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  name          TEXT NOT NULL,              -- 예: 월간 순회점검표
  kind          TEXT,                       -- 순회점검/정기점검/수시점검/설비점검/작업장점검
  description   TEXT,
  status        TEXT DEFAULT '사용중',       -- 사용중/보관
  memo          TEXT,
  created_by    TEXT REFERENCES users(id),
  updated_at    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- 점검표의 문항
CREATE TABLE inspection_template_items (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL REFERENCES inspection_templates(id),
  seq           INTEGER DEFAULT 0,
  content       TEXT NOT NULL,              -- 점검 문항
  legal_basis   TEXT,                       -- 근거 법령(선택)
  memo          TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0
);

-- 실제 점검 실시 기록
CREATE TABLE inspections (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  template_id   TEXT REFERENCES inspection_templates(id),
  process_id    TEXT REFERENCES processes(id),
  inspect_date  TEXT,
  kind          TEXT,
  location      TEXT,
  inspector     TEXT,                       -- 점검자
  accompanied   TEXT,                       -- 입회자
  total_count   INTEGER,                    -- 점검 문항 수
  ng_count      INTEGER,                    -- 부적합 건수
  summary       TEXT,                       -- 총평
  status        TEXT DEFAULT '점검완료',     -- 점검완료/개선필요/개선완료
  related_contractor TEXT,
  contractor_id TEXT REFERENCES contractors(id),
  memo          TEXT,
  created_by    TEXT REFERENCES users(id),
  updated_at    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- 항목별 점검 결과
-- item_content를 여기에 다시 저장(스냅샷)하는 이유: 점검표 문항은 나중에 수정될 수 있는데,
-- 과거 점검 기록은 "그때 무엇을 점검했는지" 그대로 남아야 하기 때문입니다.
CREATE TABLE inspection_results (
  id            TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  item_id       TEXT,                       -- 원본 문항(참고용, 삭제돼도 기록은 남음)
  seq           INTEGER DEFAULT 0,
  item_content  TEXT NOT NULL,              -- 점검 당시 문항(스냅샷)
  result        TEXT,                       -- 적합/부적합/해당없음
  finding       TEXT,                       -- 부적합 내용
  action        TEXT,                       -- 조치 사항
  deleted       INTEGER NOT NULL DEFAULT 0
);

-- 2026-09-02(마스터 프롬프트 6절): 직무스트레스 평가.
--
-- ⚠️ 이 모듈은 앞선 모듈들과 성격이 다릅니다. 개인의 정신건강에 관한 정보라,
-- 잘못 다루면 낙인이 찍히거나 인사상 불이익으로 이어질 수 있습니다. 그래서 설계 원칙을
-- 다르게 잡았습니다.
--
--  (1) 기본 단위가 "집단"입니다. 부서·공정 단위로 평가 결과를 모아 보는 것이 원칙이고,
--      개인별 점수를 나열하는 화면은 만들지 않았습니다. 직무스트레스 평가의 목적은
--      "누가 스트레스를 받는지 찾아내는 것"이 아니라 "어떤 작업환경이 스트레스를
--      유발하는지 찾아 고치는 것"이기 때문입니다.
--
--  (2) 개인 상담 기록은 별도 표에 두고, 이름 대신 익명 코드를 쓸 수 있게 했습니다.
--      상담을 받았다는 사실 자체가 노출되면 근로자가 상담을 기피하게 됩니다.
--
--  (3) 점수 계산·판정은 시스템이 하지 않습니다. 한국인 직무스트레스 측정도구(KOSS) 등
--      기법마다 문항과 환산 방식이 다르고, 정신건강 판정을 자동화하는 것은 위험합니다
--      (마스터 프롬프트 44절). 평가기관이 통보한 결과를 입력받습니다.

-- 집단(부서·공정) 단위 평가 결과 — 이것이 기본 화면입니다
CREATE TABLE stress_assessments (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  process_id      TEXT REFERENCES processes(id),
  assess_date     TEXT,
  round_no        TEXT,                            -- 회차 (예: 2026년 정기평가)
  target_group    TEXT NOT NULL,                   -- 평가 대상 집단 (예: A동 가공팀)
  target_count    INTEGER,                         -- 대상 인원
  respond_count   INTEGER,                         -- 응답 인원
  method          TEXT,                            -- 평가 도구 (KOSS 등)
  high_risk_count INTEGER,                         -- 고위험군 인원수(집계값만, 명단 아님)
  main_factor     TEXT,                            -- 주요 스트레스 요인 (직무요구/직무자율 등)
  finding         TEXT,                            -- 평가 결과 요약
  improvement     TEXT,                            -- 개선 대책 (작업환경·조직 차원)
  next_assess_date TEXT,
  agency          TEXT,                            -- 평가기관
  status          TEXT DEFAULT '평가완료',          -- 평가완료/개선필요/개선완료
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 개인 상담 기록 — 이름 대신 익명 코드 사용 가능
CREATE TABLE stress_counselings (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  assessment_id   TEXT REFERENCES stress_assessments(id),
  subject_code    TEXT NOT NULL,                   -- 익명 코드(예: A-07) 또는 성명
  is_anonymous    INTEGER DEFAULT 1,               -- 기본은 익명. 실명은 본인 동의 시에만
  counsel_date    TEXT,
  counselor       TEXT,                            -- 상담자(보건관리자·전문기관 등)
  action_taken    TEXT,                            -- 조치 (전문기관 연계/작업조정 등)
  followup_date   TEXT,
  status          TEXT DEFAULT '상담완료',          -- 상담완료/추적관찰/종결
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 2026-09-02(마스터 프롬프트 6·45-2절): 근골격계 유해요인 조사.
--
-- 반복작업·중량물 취급·부적절한 자세가 많은 사업장은 근골격계 부담작업을 조사하고
-- 개선해야 합니다. 제조업에서 실제로 가장 흔한 직업병 영역인데도 지금까지 이 시스템에
-- 다룰 곳이 없었습니다.
--
-- 표를 둘로 나눈 이유:
--  (1) ergonomic_surveys  — "이 작업이 근골격계에 얼마나 부담을 주는가" (작업 단위 평가)
--  (2) ergonomic_symptoms — "누가 어디가 아픈가" (사람 단위 증상 호소)
-- 둘은 성격이 완전히 다릅니다. 작업 평가는 공정·설비와 연결되고, 증상은 개인 건강정보라
-- 취급이 더 조심스럽습니다. 합쳐두면 증상자 명단이 작업 평가 화면에 딸려 나와
-- 불필요하게 노출됩니다.
--
-- 평가 기법(OWAS·RULA·REBA 등)의 점수 계산식은 코드에 넣지 않았습니다. 기법마다 다르고
-- 잘못 계산하면 위험을 과소평가하게 되므로(마스터 프롬프트 44절), 어떤 기법으로 평가했고
-- 결과가 무엇이었는지를 입력받습니다.
CREATE TABLE ergonomic_surveys (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  process_id      TEXT REFERENCES processes(id),
  survey_date     TEXT,
  round_no        TEXT,                            -- 회차 (예: 2026년 정기조사)
  task_name       TEXT NOT NULL,                   -- 조사 대상 작업 (예: 자재 상차 작업)
  location        TEXT,
  burden_type     TEXT,                            -- 부담작업 유형 (반복작업/중량물/부적절자세 등)
  worker_count    INTEGER,                         -- 해당 작업 종사자 수
  method          TEXT,                            -- 평가 기법 (OWAS/RULA/REBA/체크리스트 등)
  risk_level      TEXT,                            -- 평가 결과 위험도 (높음/보통/낮음)
  finding         TEXT,                            -- 발견된 유해요인
  improvement     TEXT,                            -- 개선 대책
  next_survey_date TEXT,
  status          TEXT DEFAULT '조사완료',          -- 조사완료/개선필요/개선완료
  related_contractor TEXT,
  contractor_id   TEXT REFERENCES contractors(id),
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 증상 호소자 관리 (개인 건강정보 - 민감정보로 취급)
CREATE TABLE ergonomic_symptoms (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  survey_id       TEXT REFERENCES ergonomic_surveys(id),
  worker_name     TEXT NOT NULL,
  report_date     TEXT,
  body_part       TEXT,                            -- 부위 (목/어깨/허리/손목 등)
  symptom_level   TEXT,                            -- 정도 (경미/중등도/심각)
  work_related    TEXT,                            -- 업무 관련성 판단
  action_taken    TEXT,                            -- 조치 (작업전환/치료/휴식 등)
  followup_date   TEXT,
  status          TEXT DEFAULT '접수',              -- 접수/조치중/관찰중/종결
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 2026-09-02(마스터 프롬프트 6·29절, 스마플 보유 기능): 작업환경측정.
--
-- 산업안전보건법은 소음·분진·유기용제 등 유해인자를 취급하는 사업장에 대해 정기적으로
-- 작업환경을 측정하고, 노출기준을 넘으면 개선하도록 정하고 있습니다.
--
-- 건강진단(health_records)과 헷갈리기 쉬운데 대상이 다릅니다:
--   건강진단   = "사람"이 건강한가 (근로자별 검진)
--   작업환경측정 = "장소·공정"이 안전한가 (측정 지점별 유해인자 농도)
-- 그래서 별도 표로 둡니다. 한쪽에서 이상이 나오면 다른 쪽을 확인하는 관계입니다.
--
-- 노출기준(TWA/STEL)은 물질마다 다르고 고시 개정으로 바뀌므로 코드에 넣지 않고
-- (마스터 프롬프트 83절), 측정기관이 통보한 값을 그대로 입력받습니다. 시스템은
-- "기준 초과 여부"와 "다음 측정 시기"를 관리합니다.
CREATE TABLE work_env_measurements (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  process_id      TEXT REFERENCES processes(id),   -- 어느 공정인지(마스터데이터 연결)
  measure_date    TEXT,                            -- 측정일
  round_no        TEXT,                            -- 회차 (예: 2026년 상반기)
  location        TEXT NOT NULL,                   -- 측정 지점 (예: A동 도장부스)
  factor_type     TEXT,                            -- 유해인자 구분 (화학적/물리적/분진 등)
  factor_name     TEXT NOT NULL,                   -- 유해인자명 (예: 톨루엔, 소음)
  result_value    TEXT,                            -- 측정 결과값
  unit            TEXT,                            -- 단위 (ppm, mg/m³, dB 등)
  exposure_limit  TEXT,                            -- 노출기준 (측정기관 통보값)
  exceeded        INTEGER DEFAULT 0,               -- 기준 초과 여부
  worker_count    INTEGER,                         -- 해당 지점 근로자 수
  agency          TEXT,                            -- 측정기관
  improvement     TEXT,                            -- 개선 조치 내용
  next_measure_date TEXT,                          -- 다음 측정 예정일
  status          TEXT DEFAULT '측정완료',          -- 측정완료/개선필요/개선완료
  related_contractor TEXT,
  contractor_id   TEXT REFERENCES contractors(id),
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 2026-09-02(마스터 프롬프트 45-3절): LOTO(Lockout/Tagout) 관리.
--
-- 설비를 정비·청소하려면 전원만 끄는 것으로는 부족합니다. 잔류 전기·압축공기·유압·
-- 스팀 같은 에너지가 남아 있으면 갑자기 설비가 움직여 끼임 사고로 이어집니다. 그래서
-- "에너지원을 하나하나 차단하고 잠근 뒤, 잔류 에너지까지 확인하고 작업"하는 절차가
-- 필요하고, 이것이 LOTO입니다.
--
-- 표를 둘로 나눈 이유:
--  (1) loto_energy_sources — "이 설비에는 어떤 에너지원이 있는가"는 설비의 고정 속성입니다.
--      한 번 등록해두면 정비할 때마다 다시 적을 필요가 없습니다.
--  (2) loto_permits — "언제 누가 무엇을 잠갔다 풀었는가"는 매번 달라지는 작업 기록입니다.
--
-- 이렇게 나눠야 "이 설비의 에너지원 목록"과 "차단 이력"을 각각 관리할 수 있습니다.
-- 하나로 합치면 정비할 때마다 에너지원을 다시 입력해야 해서 현장에서 안 씁니다.

-- 설비별 에너지원 목록 (설비의 고정 속성)
CREATE TABLE loto_energy_sources (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  equipment_id  TEXT NOT NULL REFERENCES equipment(id),
  energy_type   TEXT NOT NULL,   -- 전기/유압/공압/스팀/화학물질/중력(위치에너지)/기계적 등
  source_name   TEXT NOT NULL,   -- 예: 주전원 차단기 MCC-3
  location      TEXT,            -- 차단장치 위치 (예: B동 전기실 3번 패널)
  isolation_method TEXT,         -- 차단 방법 (예: 차단기 OFF 후 잠금장치 체결)
  release_method   TEXT,         -- 잔류에너지 해소 방법 (예: 압력계 0 확인 후 드레인 밸브 개방)
  memo          TEXT,
  created_by    TEXT REFERENCES users(id),
  updated_at    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- LOTO 작업 기록 (매 정비마다 생기는 기록)
-- 상태는 마스터 프롬프트 45-3절의 흐름을 그대로 따릅니다:
--   신청 → 차단·잠금 → 잔류에너지 확인 → 작업중 → 복구 → 완료
CREATE TABLE loto_permits (
  id              TEXT PRIMARY KEY,
  legacy_id       TEXT UNIQUE,
  site_id         TEXT NOT NULL REFERENCES sites(id),
  equipment_id    TEXT REFERENCES equipment(id),
  work_desc       TEXT NOT NULL,   -- 작업 내용 (예: 3호기 금형 교체)
  work_date       TEXT,
  worker          TEXT,            -- 작업자
  supervisor      TEXT,            -- 감독자
  lock_tag_no     TEXT,            -- 잠금장치/태그 번호
  isolated_sources TEXT,           -- 실제로 차단한 에너지원 목록(JSON) - 작업 시점의 스냅샷
  residual_checked INTEGER DEFAULT 0,  -- 잔류에너지 확인 완료 여부
  residual_checker TEXT,           -- 잔류에너지를 확인한 사람
  status          TEXT DEFAULT '신청',  -- 신청/차단완료/작업중/복구완료/종료
  isolated_at     TEXT,            -- 차단·잠금 시각
  restored_at     TEXT,            -- 복구 시각
  related_contractor TEXT,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결(위 텍스트는 원본 보존)
  memo            TEXT,
  created_by      TEXT REFERENCES users(id),
  updated_at      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  deleted_by      TEXT
);

-- 2026-09-02(마스터 프롬프트 45-1·45-5·45-6절): 공정/공종 마스터데이터.
--
-- 지금까지 위험성평가·TBM 등에서 "공정명"은 전부 자유입력 텍스트였습니다. 그래서
-- 같은 공정을 두고 "가공라인", "가공 라인", "A동가공"처럼 제각각 적히고, 결과적으로
-- "이 공정에서 위험이 몇 건 났는지"를 집계할 방법이 없었습니다. 반복 위험요인 분석도
-- 낱말이 정확히 일치할 때만 잡히는 한계가 있었습니다.
--
-- 제조업의 "공정"과 건설업의 "공종"은 이름만 다를 뿐 구조가 같습니다(작업을 묶는 단위).
-- 그래서 하나의 표로 만들고 kind로 구분합니다 - 업종마다 별도 테이블을 만들면 나중에
-- 물류·플랜트 등으로 확장할 때마다 스키마를 늘려야 하기 때문입니다(마스터 프롬프트 46절:
-- 특정 업종에 종속되는 DB 구조를 만들지 말 것).
--
-- parent_id로 계층을 표현합니다. 제조업이면 "가공라인 > 프레스공정", 건설업이면
-- "골조공사 > 철근작업"처럼 2~3단계로 쓸 수 있고, 단순한 사업장은 1단계만 써도 됩니다.
CREATE TABLE processes (
  id            TEXT PRIMARY KEY,
  legacy_id     TEXT UNIQUE,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  parent_id     TEXT REFERENCES processes(id),   -- 상위 공정(없으면 최상위)
  kind          TEXT NOT NULL DEFAULT 'process', -- process(제조 공정) / work_type(건설 공종)
  code          TEXT,                            -- 사내 공정코드(선택)
  name          TEXT NOT NULL,
  description   TEXT,
  manager       TEXT,                            -- 공정 책임자
  hazard_summary TEXT,                           -- 이 공정의 대표적인 유해·위험요인
  status        TEXT DEFAULT '운영중',            -- 운영중/중단/폐지
  sort_order    INTEGER DEFAULT 0,               -- 공정 순서(원재료→가공→조립→출하)
  memo          TEXT,
  created_by    TEXT REFERENCES users(id),
  updated_at    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT
);

-- 2026-09-02(경쟁사 격차 해소 - 무사퇴근 "기계/기구 관리", 스마플 "안전검사"):
-- 산업안전보건법은 프레스·크레인·리프트·압력용기 등 유해·위험 기계기구에 대해
-- 주기적인 안전검사를 받도록 정하고 있습니다. 검사 시기를 놓치면 과태료 대상이 되는데,
-- 지금까지 이 시스템에는 기계기구를 등록하고 검사 이력을 관리할 곳이 아예 없었습니다.
--
-- 검사 주기는 기계 종류·설치연도·사용조건에 따라 달라지고 법령 개정으로 바뀌기도 하므로
-- (마스터 프롬프트 83절: 법규를 하드코딩하지 말 것), 주기를 코드에 고정하지 않고
-- 사업장이 직접 입력하도록 했습니다. 시스템은 "입력된 다음 검사일이 다가오는지"만 관리합니다.
CREATE TABLE equipment (
  id                  TEXT PRIMARY KEY,
  legacy_id           TEXT UNIQUE,
  site_id             TEXT NOT NULL REFERENCES sites(id),
  name                TEXT NOT NULL,   -- 기계기구명 (예: 3호기 유압프레스)
  category            TEXT,            -- 종류 (프레스/크레인/리프트/압력용기/곤돌라 등)
  asset_no            TEXT,            -- 관리번호·자산번호
  maker               TEXT,
  model_no            TEXT,
  location            TEXT,            -- 설치 위치
  process_id          TEXT REFERENCES processes(id),  -- 2026-09-02: 이 설비가 속한 공정
  install_date        TEXT,
  inspection_required INTEGER DEFAULT 1,  -- 법정 안전검사 대상 여부
  inspection_cycle    TEXT,            -- 검사 주기 (예: 6개월, 2년) - 자유입력
  last_inspection_date TEXT,
  next_inspection_date TEXT,           -- 이 값이 다가오면 알려줍니다
  inspection_result   TEXT,            -- 합격/불합격/조건부합격
  inspection_agency   TEXT,            -- 검사기관
  cert_no             TEXT,            -- 합격증명서 번호
  operator            TEXT,            -- 운전자·담당자
  status              TEXT DEFAULT '사용중',           -- 사용중/수리중/사용중지/폐기
  related_contractor  TEXT,
  contractor_id      TEXT REFERENCES contractors(id),  -- 2026-09-02: 목록에서 고른 경우 여기 연결(위 텍스트는 원본 보존)
  memo                TEXT,
  created_by          TEXT REFERENCES users(id),
  updated_at          TEXT,
  updated_by          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  deleted_by          TEXT
);

-- 2026-09-02(마스터 프롬프트 20절): 위험성평가 버전관리.
-- risk_assessments에 previous_assessment_id 컬럼이 있었지만 어디서도 쓰이지 않아,
-- 수정하면 이전 내용이 그냥 덮어써지고 사라졌다. 산업안전보건법상 위험성평가는
-- "언제 무엇을 어떻게 바꿨는지"가 중요한 기록이므로, 수정 직전 상태를 스냅샷으로
-- 남긴다. 원본 레코드는 항상 최신 상태를 유지하고(기존 조회/통계가 그대로 동작),
-- 과거 버전만 이 표에 쌓인다.
CREATE TABLE risk_assessment_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id  TEXT NOT NULL,
  version_no     INTEGER NOT NULL,
  snapshot_json  TEXT NOT NULL,   -- 수정 직전의 레코드 전체
  changed_fields TEXT,            -- 이번 수정에서 실제로 바뀐 필드 목록
  changed_by     TEXT REFERENCES users(id),
  changed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE system_errors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message       TEXT,
  stack         TEXT,
  path          TEXT,
  method        TEXT,
  status_code   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  file_key      TEXT NOT NULL,    -- 오브젝트 스토리지 키(로컬 프로토타입에서는 파일 경로)
  file_name     TEXT,
  mime_type     TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- 2026-09-02: 다른 13개 모듈과 동일하게 소프트 삭제로 전환. 예전에는 DB 레코드와 실제
  -- 파일을 즉시 지워서, 실수로 삭제하면 되돌릴 방법이 전혀 없었다(사고 현장사진·서명 등
  -- 법정 증빙이 포함되므로 위험). 이제 목록에서만 감추고 실물은 보존한다.
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  deleted_by    TEXT REFERENCES users(id)
);

CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_site ON users(site_id);
CREATE INDEX idx_risk_site ON risk_assessments(site_id);
CREATE INDEX idx_capa_site_status ON capa_actions(site_id, status);
CREATE INDEX idx_incident_site ON incidents(site_id);
CREATE INDEX idx_nearmiss_site ON near_misses(site_id);
CREATE INDEX idx_tbm_site ON tbm_records(site_id);
CREATE INDEX idx_voice_site ON voice_reports(site_id);
CREATE INDEX idx_legalmeet_site ON legal_meetings(site_id);
CREATE INDEX idx_msds_site ON msds_items(site_id);
CREATE INDEX idx_health_site ON health_records(site_id);
CREATE INDEX idx_training_site ON training_records(site_id);
CREATE INDEX idx_ppe_site ON ppe_records(site_id);
CREATE INDEX idx_appoint_site ON legal_appointments(site_id);
CREATE INDEX idx_contractor_site ON contractors(site_id);
CREATE INDEX idx_permit_site_status ON permits(site_id, status);
CREATE INDEX idx_legal_checklist_site ON legal_checklist_items(site_id);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- ============================================================
-- 아직 만들지 않은 목표 테이블 (지시서 32번 ERD 기준, 다음 단계):
-- worker_reports, documents, notifications, inspection_templates,
-- inspection_submissions, assets, ai_records
-- 13개 안전관리 모듈 중 협력업체를 제외한 12개가 이제 API로 연결됨.
-- 협력업체는 테이블은 있으나(마스터데이터 성격) 다른 모듈과의 연동은 미착수(15절).
-- ============================================================
