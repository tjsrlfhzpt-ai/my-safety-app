const db = require('./db');
const { generateId } = require('./ids');

// 지시서 6번 최소 역할 목록
const ROLES = [
  'super_admin', 'company_admin', 'site_admin', 'safety_manager', 'health_manager',
  'dept_manager', 'supervisor', 'worker', 'contractor_admin', 'contractor_worker',
  'viewer', 'auditor',
];

// 위험성평가/CAPA에 이어 v5.11~5.13에서 추가된 모듈들. 이 열한(단순모듈+CAPA 제외)은
// 모두 "생성/조회/삭제"만 있는 단순 구조라 권한도 동일한 3종 세트(create/read/delete_any)로 통일한다.
// 2026-09-02: equipment(유해·위험 기계기구 안전검사) 추가 - 다른 단순모듈과 동일 권한 등급.
const SIMPLE_MODULES = ['nearmiss', 'tbm', 'voice', 'legalmeet', 'accident', 'msds', 'health', 'edu', 'ppe', 'appoint', 'contractor', 'equipment', 'process', 'loto', 'workenv', 'ergonomic', 'stress', 'inspection'];
// 2026-08-28 후속조치(출시전 점검보고서 3절 "12개 모듈 PATCH API 부재"): create/read/delete_any
// 3종뿐이라 등록 후 오타 하나도 고칠 방법이 없었다. update를 추가한다 - delete_any를 가진
// 역할과 동일한 신뢰 등급이라고 보고 같은 목록에 묶었다(수정이 삭제보다 파괴적이지 않으므로
// 별도로 더 엄격하게 만들 이유가 없다).
const simplePerms = (prefix) => [`${prefix}.create`, `${prefix}.read`, `${prefix}.update`, `${prefix}.delete_any`];
// PTW는 CAPA처럼 승인 워크플로우가 있어 create/read/update/approve/delete_any 5종이 필요하다.
const ptwPerms = ['ptw.create', 'ptw.read', 'ptw.update', 'ptw.approve', 'ptw.delete_any'];
const ptwPermsNoApprove = ['ptw.create', 'ptw.read', 'ptw.update'];

const PERMISSIONS = [
  'risk.create', 'risk.read', 'risk.update', 'risk.delete_own', 'risk.delete_any',
  'capa.read', 'capa.update', 'capa.approve',
  'user.manage', 'org.settings',
  'compliance.read', 'compliance.update',
  ...SIMPLE_MODULES.flatMap(simplePerms),
  ...ptwPerms,
];

// 중대재해처벌법 체크리스트는 경영책임자·안전관리자 의무 성격이라, 일반 근로자/감독자에게는
// 열어주지 않았습니다(worker/supervisor/contractor_*/dept_manager에는 compliance.* 없음).
const GRANTS = {
  worker: ['risk.create', 'risk.read', 'capa.read', 'ptw.create', 'ptw.read', ...SIMPLE_MODULES.flatMap(p => [`${p}.create`, `${p}.read`])],
  supervisor: ['risk.create', 'risk.read', 'risk.update', 'risk.delete_own', 'capa.read', 'capa.update', ...ptwPermsNoApprove, ...SIMPLE_MODULES.flatMap(simplePerms)],
  safety_manager: ['risk.create', 'risk.read', 'risk.update', 'risk.delete_any', 'capa.read', 'capa.update', 'capa.approve', 'compliance.read', 'compliance.update', ...ptwPerms, ...SIMPLE_MODULES.flatMap(simplePerms)],
  health_manager: ['risk.read', 'capa.read', 'ptw.read', ...SIMPLE_MODULES.flatMap(p => [`${p}.read`])],
  dept_manager: ['risk.create', 'risk.read', 'capa.read', ...ptwPermsNoApprove, ...SIMPLE_MODULES.flatMap(simplePerms)],
  site_admin: ['risk.create', 'risk.read', 'risk.update', 'risk.delete_any', 'capa.read', 'capa.update', 'capa.approve', 'user.manage', 'compliance.read', 'compliance.update', ...ptwPerms, ...SIMPLE_MODULES.flatMap(simplePerms)],
  company_admin: ['risk.create', 'risk.read', 'risk.update', 'risk.delete_any', 'capa.read', 'capa.update', 'capa.approve', 'user.manage', 'org.settings', 'compliance.read', 'compliance.update', ...ptwPerms, ...SIMPLE_MODULES.flatMap(simplePerms)],
  super_admin: ['risk.create', 'risk.read', 'risk.update', 'risk.delete_any', 'capa.read', 'capa.update', 'capa.approve', 'user.manage', 'org.settings', 'compliance.read', 'compliance.update', ...ptwPerms, ...SIMPLE_MODULES.flatMap(simplePerms)],
  viewer: ['risk.read', 'capa.read', 'ptw.read', 'compliance.read', ...SIMPLE_MODULES.flatMap(p => [`${p}.read`])],
  auditor: ['risk.read', 'capa.read', 'ptw.read', 'compliance.read', ...SIMPLE_MODULES.flatMap(p => [`${p}.read`])],
  contractor_admin: ['risk.read', 'capa.read', 'ptw.read', ...SIMPLE_MODULES.flatMap(p => [`${p}.read`])],
  contractor_worker: ['risk.create', 'risk.read', 'ptw.create', 'ptw.read', ...SIMPLE_MODULES.flatMap(p => [`${p}.create`, `${p}.read`])],
};

function ensureSeed() {
  const roleId = {};
  for (const code of ROLES) {
    let row = db.prepare('SELECT id FROM roles WHERE code = ?').get(code);
    if (!row) {
      const id = generateId('ROLE');
      db.prepare('INSERT INTO roles (id, code, name) VALUES (?, ?, ?)').run(id, code, code);
      row = { id };
    }
    roleId[code] = row.id;
  }

  const permId = {};
  for (const code of PERMISSIONS) {
    let row = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code);
    if (!row) {
      const id = generateId('PERM');
      db.prepare('INSERT INTO permissions (id, code) VALUES (?, ?)').run(id, code);
      row = { id };
    }
    permId[code] = row.id;
  }

  for (const [roleCode, permCodes] of Object.entries(GRANTS)) {
    for (const p of permCodes) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .run(roleId[roleCode], permId[p]);
    }
  }

  // 2026-08-30: "여러 고객사를 위한 SaaS로 간다"는 결정 이후, 서버 최초 기동 시 특정
  // 회사(DB그룹-DB월드)를 자동으로 만들어두던 로직을 제거했다. 그 방식은 이 서버가
  // 이선기님 회사 하나만을 위한 것이었을 때 맞던 방식이고, 지금은 모든 고객사(이선기님
  // 회사 포함)가 동일하게 /setup 화면 또는 POST /organizations로 회사를 등록하는 게 맞다.
  // 역할·권한 시딩(위쪽)은 특정 조직에 속하지 않는 전역 설정이라 그대로 매 기동 시 유지한다.
}

module.exports = { ensureSeed };
