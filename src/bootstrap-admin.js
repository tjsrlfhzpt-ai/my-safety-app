const bcrypt = require('bcryptjs');
const { generateId } = require('./ids');
const { writeAudit } = require('./audit');
const { CURRENT_POLICY_VERSION } = require('./policy');

// ============================================================================
// 2026-09-10: 최초 관리자 계정 자동 생성 (테스트/최초 셋업용)
// ----------------------------------------------------------------------------
// 배경: 서버를 새로 배포하면 계정이 하나도 없어서 로그인할 방법이 없다. 지금까지는
// /setup 페이지나 POST /organizations + POST /auth/register를 직접 호출해야 했다.
// 이 모듈은 서버가 뜰 때 환경변수가 설정돼 있으면 "회사 + 사업장 + 관리자 계정"을
// 한 번에 만들어준다.
//
// ⚠️ 안전장치가 세 겹으로 걸려 있다. 이건 실수로 운영 데이터를 덮어쓰는 걸 막기 위한
//    것이므로 임의로 완화하면 안 된다.
//
//  (1) 환경변수(BOOTSTRAP_ADMIN_ID + BOOTSTRAP_ADMIN_PASSWORD)가 둘 다 설정된
//      경우에만 동작한다. 설정하지 않으면 이 모듈은 아무 일도 하지 않으며,
//      서버 동작은 이 파일이 없던 때와 완전히 동일하다.
//
//  (2) users 테이블이 완전히 비어 있을 때만 동작한다. 사용자가 한 명이라도 있으면
//      (=이미 누군가 쓰고 있는 서버면) 즉시 건너뛴다. 따라서 실수로 운영 중인
//      서버에 이 환경변수를 켜더라도 기존 계정/데이터에는 아무 영향이 없다.
//
//  (3) 비밀번호를 소스코드에 넣지 않는다. GitHub 저장소가 공개(public)이면 코드에
//      적힌 비밀번호는 전 세계에 공개되는 것과 같다. 환경변수로 두면 Render
//      대시보드 안에만 존재하고, 나중에 코드 수정 없이 값만 바꿀 수 있다.
//      (개발 지침 24번 "하드코딩 최소화"와도 같은 방향)
// ============================================================================

const MIN_SAFE_PASSWORD_LENGTH = 8;

function ensureBootstrapAdmin(db) {
  const loginId = (process.env.BOOTSTRAP_ADMIN_ID || '').trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';

  // (1) 환경변수 미설정 → 아무것도 하지 않음
  if (!loginId || !password) return { created: false, reason: 'env_not_set' };

  // (2) 이미 사용자가 있으면 절대 건드리지 않음
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount > 0) {
    console.log('[bootstrap] 이미 사용자가 존재하므로 최초 관리자 생성을 건너뜁니다.');
    return { created: false, reason: 'users_exist' };
  }

  const orgName = (process.env.BOOTSTRAP_ORG_NAME || '기본 회사').trim();
  const siteName = (process.env.BOOTSTRAP_SITE_NAME || '본사').trim();
  const adminName = (process.env.BOOTSTRAP_ADMIN_NAME || '관리자').trim();

  const role = db.prepare("SELECT id FROM roles WHERE code = 'company_admin'").get();
  if (!role) {
    // ensureSeed()가 먼저 실행되지 않았다는 뜻 - server.js의 호출 순서 문제다.
    console.error('[bootstrap] company_admin 역할이 없습니다. ensureSeed()가 먼저 실행돼야 합니다.');
    return { created: false, reason: 'role_missing' };
  }

  const orgId = generateId('ORG');
  const siteId = generateId('SITE');
  const userId = generateId('USER');
  const passwordHash = bcrypt.hashSync(password, 12);

  // 2026-09-10: 근로자 회원가입에 쓸 가입코드를 함께 발급한다(routes/organizations.js와 동일).
  const { makeJoinCode } = require('./db');
  let joinCode = makeJoinCode();
  for (let i = 0; i < 20 && db.prepare('SELECT 1 FROM organizations WHERE join_code = ?').get(joinCode); i += 1) {
    joinCode = makeJoinCode();
  }

  // 회사·사업장·계정은 셋 중 하나라도 실패하면 전부 없던 일이 돼야 한다.
  // (예: 계정 생성만 실패하면 로그인 불가능한 빈 회사가 남는다)
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, join_code) VALUES (?, ?, ?)').run(orgId, orgName, joinCode);
    db.prepare('INSERT INTO sites (id, org_id, name) VALUES (?, ?, ?)').run(siteId, orgId, siteName);
    db.prepare(`
      INSERT INTO users (id, org_id, site_id, login_id, password_hash, name, account_status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(userId, orgId, siteId, loginId, passwordHash, adminName);

    // 2026-09-10: 마스터 관리자는 동의를 미리 완료 처리한다.
    // 이 계정은 테스트/최초 셋업용이고, 서버 운영자 본인이 환경변수로 직접 만든 것이라
    // "본인이 본인에게 동의를 받는" 절차가 된다. 매 테스트마다 동의 화면을 거치지 않게 한다.
    // 회원가입이나 관리자가 만들어준 일반 계정은 이 처리를 하지 않으므로, 실제 근로자는
    // 예전과 똑같이 최초 로그인 시 동의 화면을 반드시 거친다.
    db.prepare(`
      UPDATE users SET consent_privacy_at = datetime('now'), consent_terms_at = datetime('now'),
        consent_sensitive_at = datetime('now'), consent_policy_version = ?
      WHERE id = ?
    `).run(CURRENT_POLICY_VERSION, userId);
    // 조직 전체를 관장해야 하므로 site_id는 NULL(조직 전역 범위)로 부여한다.
    // auth.js의 부트스트랩 가입 로직과 동일한 규칙이다.
    db.prepare('INSERT INTO user_roles (user_id, role_id, site_id) VALUES (?, ?, ?)')
      .run(userId, role.id, null);
  });
  tx();

  writeAudit(db, {
    actorUserId: userId, actorName: adminName, action: 'create',
    entityType: 'user', entityId: userId,
    after: { loginId, name: adminName, roleCode: 'company_admin', bootstrap: true, source: 'env' },
  });

  console.log(`[bootstrap] 최초 관리자 계정 생성 완료 - 회사="${orgName}" 사업장="${siteName}" 아이디="${loginId}"`);
  console.log(`[bootstrap] 동료 초대코드: ${joinCode}  (회원가입 화면의 \"회사 초대코드\"에 입력)`);

  if (password.length < MIN_SAFE_PASSWORD_LENGTH) {
    console.warn('');
    console.warn('  ============================================================');
    console.warn('  ⚠️  경고: 최초 관리자 비밀번호가 너무 짧습니다.');
    console.warn(`      현재 ${password.length}자 (권장 ${MIN_SAFE_PASSWORD_LENGTH}자 이상)`);
    console.warn('      이 서버는 인터넷에 공개돼 있고, 건강진단·스트레스 상담 등');
    console.warn('      개인정보보호법상 "민감정보"를 저장합니다.');
    console.warn('      실제 근로자 데이터를 입력하기 전에 반드시 비밀번호를');
    console.warn('      변경하세요 (앱 내 비밀번호 변경 기능 사용).');
    console.warn('  ============================================================');
    console.warn('');
  }

  return { created: true, orgId, siteId, userId, loginId, joinCode };
}

module.exports = { ensureBootstrapAdmin };
