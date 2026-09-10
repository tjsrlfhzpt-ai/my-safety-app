const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { generateId } = require('../ids');
const { writeAudit } = require('../audit');
const { JWT_SECRET, authenticate } = require('../auth-middleware');

// 2026-09-10: 정책 버전은 src/policy.js에서만 관리한다(bootstrap-admin.js도 같은 값을
// 쓰기 때문에 양쪽에 적어두면 어긋날 수 있다).
// ⚠️ 이 문서는 사업자등록번호 등 실제 정보 없이 "임의설정"으로 작성된 초안입니다.
// 실제 서비스 전에 반드시 법률 검토를 거쳐야 합니다 - 프론트엔드 정책 전문 상단에도
// 동일하게 명시해뒀습니다.
const { CURRENT_POLICY_VERSION } = require('../policy');

function needsConsent(user) {
  return !user.consent_privacy_at || !user.consent_terms_at || !user.consent_sensitive_at
    || user.consent_policy_version !== CURRENT_POLICY_VERSION;
}

module.exports = function authRoutes(db) {
  const router = express.Router();

  // ⚠️ 2026-08-28 점검(출시전 점검보고서 2-1절): 이 엔드포인트는 인증 없이 열려있는데,
  // 예전 코드는 클라이언트가 보낸 roleCode(예: 'super_admin')를 검증 없이 그대로 부여했다.
  // JWT payload의 orgId는 서명만 되고 암호화되지 않아 누구나 디코딩할 수 있으므로, 최하위
  // worker 계정 하나만 있어도 인증 없이 최고권한 계정을 자가등록할 수 있었다(실제 재현 확인).
  //
  // 수정: roleCode는 더 이상 클라이언트를 신뢰하지 않는다. 해당 조직에 사용자가 한 명도
  // 없을 때(=조직을 처음 세팅하는 최초 가입)만 그 사람을 조직 관리자(company_admin)로
  // 자동 부여하고, 그 외에는 무조건 최하위 권한(worker)으로 시작한다. 상위 권한이 필요하면
  // 이후 관리자가 PATCH /users/:id/role (requirePermission user.manage)로만 부여할 수 있다.
  router.post('/register', async (req, res) => {
    const { orgId, siteId, loginId, password, name } = req.body || {};
    if (!orgId || !loginId || !password || !name) {
      return res.status(400).json({ error: 'orgId, loginId, password, name은 필수입니다.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
    }

    const org = db.prepare('SELECT id FROM organizations WHERE id = ? AND deleted = 0').get(orgId);
    if (!org) return res.status(400).json({ error: '존재하지 않는 조직입니다.' });

    const existingUserCount = db.prepare('SELECT COUNT(*) c FROM users WHERE org_id = ?').get(orgId).c;
    const isBootstrap = existingUserCount === 0;

    // 부트스트랩(최초 가입)이 아니면 반드시 유효한 사업장을 지정해야 한다 - 그래야 이후
    // 위험성평가 등 실제 데이터 등록 시 site_id NOT NULL 제약에 걸리지 않는다.
    if (!isBootstrap) {
      if (!siteId) return res.status(400).json({ error: 'siteId는 필수입니다.' });
      const site = db.prepare('SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted = 0').get(siteId, orgId);
      if (!site) return res.status(400).json({ error: '해당 조직에 속하지 않는 사업장입니다.' });
    } else if (siteId) {
      const site = db.prepare('SELECT id FROM sites WHERE id = ? AND org_id = ? AND deleted = 0').get(siteId, orgId);
      if (!site) return res.status(400).json({ error: '해당 조직에 속하지 않는 사업장입니다.' });
    }

    const dup = db.prepare('SELECT id FROM users WHERE login_id = ? AND deleted = 0').get(loginId);
    if (dup) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = generateId('USER');
    db.prepare(`
      INSERT INTO users (id, org_id, site_id, login_id, password_hash, name, account_status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(userId, orgId, siteId || null, loginId, passwordHash, name);

    const roleCode = isBootstrap ? 'company_admin' : 'worker';
    const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode);
    // 부트스트랩 관리자는 이 조직 전체를 관장해야 하므로 site_id를 NULL(조직 전역 범위)로 부여한다.
    db.prepare('INSERT INTO user_roles (user_id, role_id, site_id) VALUES (?, ?, ?)')
      .run(userId, role.id, isBootstrap ? null : siteId);

    writeAudit(db, {
      actorUserId: userId, actorName: name, action: 'create',
      entityType: 'user', entityId: userId, after: { loginId, name, roleCode, bootstrap: isBootstrap },
    });

    res.status(201).json({ id: userId, loginId, name, roleCode, bootstrap: isBootstrap });
  });

  router.post('/login', async (req, res) => {
    const { loginId, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE login_id = ? AND deleted = 0').get(loginId);
    if (!user) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    if (user.account_status === 'locked') {
      return res.status(423).json({ error: '5회 이상 로그인 실패로 계정이 잠겼습니다. 관리자에게 문의하세요.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const failCount = (user.failed_login_count || 0) + 1;
      const nextStatus = failCount >= 5 ? 'locked' : user.account_status;
      db.prepare('UPDATE users SET failed_login_count = ?, account_status = ? WHERE id = ?')
        .run(failCount, nextStatus, user.id);
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    db.prepare("UPDATE users SET failed_login_count = 0, last_login_at = datetime('now') WHERE id = ?").run(user.id);

    const roleRows = db.prepare(`
      SELECT r.code, ur.site_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?
    `).all(user.id);
    const roles = roleRows.map(r => r.code);

    // user_roles에 site_id가 NULL인 행(조직 전역 범위 권한)이 하나라도 있으면 그 조직의
    // 전체 사업장을 접근 가능 범위로 확장한다(README가 "권한상 가능"이라 언급했던 관리자
    // 전체 사업장 조회를 실제로 동작하게 함 - 출시전 점검보고서 2-4절 연계).
    const isOrgWide = roleRows.some(r => r.site_id === null);
    const siteIds = isOrgWide
      ? db.prepare('SELECT id FROM sites WHERE org_id = ? AND deleted = 0').all(user.org_id).map(s => s.id)
      : (user.site_id ? [user.site_id] : []);

    const token = jwt.sign(
      { sub: user.id, loginId: user.login_id, name: user.name, orgId: user.org_id, siteId: user.site_id, siteIds, roles },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    writeAudit(db, { actorUserId: user.id, actorName: user.name, action: 'login', entityType: 'user', entityId: user.id, ip: req.ip });

    res.json({ token, user: { id: user.id, name: user.name, roles, siteId: user.site_id, siteIds, needsConsent: needsConsent(user), mustChangePassword: user.must_change_password === 1 } });
  });

  // 2026-09-02(비밀번호 복구): 사용자가 스스로 비밀번호를 바꾼다. 두 가지 상황에서 쓰인다.
  //  (1) 임시 비밀번호를 받은 직후 - 반드시 바꿔야 계속 쓸 수 있다.
  //  (2) 평소에 자발적으로 바꿀 때.
  // 어느 경우든 "현재 비밀번호"를 다시 확인한다 - 자리를 비운 사이 남이 만지는 것을 막기 위함이다.
  router.post('/change-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다.' });
    }
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ? AND deleted = 0').get(req.user.sub);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });

    const same = await bcrypt.compare(newPassword, user.password_hash);
    if (same) return res.status(400).json({ error: '이전과 다른 비밀번호를 사용해 주세요.' });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);

    writeAudit(db, {
      actorUserId: user.id, actorName: req.user.name, action: 'update',
      entityType: 'user', entityId: user.id, after: { passwordChanged: true },
    });

    res.json({ ok: true });
  });

  // 2026-08-28 후속조치(출시전 점검보고서 2-3절): 개인정보보호법상 이용자는 언제든 자신의
  // 개인정보 삭제(회원탈퇴)를 요구할 수 있어야 한다. 완전 물리삭제 대신 익명화를 택한 이유:
  // 위험성평가·사고기록 등은 산업안전보건법상 일정 기간 보존 의무가 있는 "회사의 안전관리
  // 기록"이라 이용자 개인정보와 성격이 다르다 - 작성자가 탈퇴했다고 그 기록 자체를 지우면
  // 오히려 법정 기록보존 의무 위반이 될 수 있다. 그래서 로그인 자격증명과 연락처(개인정보)만
  // 익명화하고, 안전기록의 작성자 추적성(누가 작성했는지)은 "탈퇴한 사용자"로 유지한다.
  // 2026-08-28(2-3절): 로그인 응답의 needsConsent가 true면 프론트엔드가 동의 화면을 띄우고,
  // 세 항목 모두 동의를 받으면 이 API를 호출해 기록한다. 세 동의를 각각 별도 컬럼/시각으로
  // 남기는 이유는, 나중에 "언제 무엇에 동의했는지"를 증빙해야 할 수 있기 때문이다(2-3절
  // 개인정보보호법 대응의 핵심 - 동의 자체를 증명할 수 있어야 함).
  router.post('/consent', authenticate, (req, res) => {
    const { agreePrivacy, agreeTerms, agreeSensitive } = req.body || {};
    if (!agreePrivacy || !agreeTerms || !agreeSensitive) {
      return res.status(400).json({ error: '개인정보 처리방침·이용약관·민감정보 처리 동의는 모두 필수입니다.' });
    }
    db.prepare(`
      UPDATE users SET consent_privacy_at = datetime('now'), consent_terms_at = datetime('now'),
        consent_sensitive_at = datetime('now'), consent_policy_version = ?
      WHERE id = ?
    `).run(CURRENT_POLICY_VERSION, req.user.sub);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'user_consent', entityId: req.user.sub, after: { policyVersion: CURRENT_POLICY_VERSION },
    });

    res.json({ ok: true });
  });

  router.post('/withdraw', authenticate, async (req, res) => {
    const { password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted = 0').get(req.user.sub);
    if (!user) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });

    // 조직의 유일한 조직전역 관리자가 탈퇴하면 아무도 조직을 관리할 수 없게 되므로 막는다.
    const isSoleOrgAdmin = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ? AND ur.site_id IS NULL AND r.code IN ('company_admin','super_admin')) AS mine,
        (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u2 ON u2.id = ur.user_id
          WHERE ur.site_id IS NULL AND r.code IN ('company_admin','super_admin') AND ur.user_id != ? AND u2.deleted = 0) AS others
    `).get(user.id, user.id);
    if (isSoleOrgAdmin.mine > 0 && isSoleOrgAdmin.others === 0) {
      return res.status(400).json({ error: '조직의 유일한 관리자는 탈퇴할 수 없습니다. 다른 관리자를 먼저 지정한 뒤 다시 시도하세요.' });
    }

    const anonLoginId = `withdrawn-${user.id}`;
    db.prepare(`
      UPDATE users SET deleted = 1, deleted_at = datetime('now'), deleted_by = ?, account_status = 'disabled',
        login_id = ?, name = '탈퇴한 사용자', phone = NULL, email = NULL
      WHERE id = ?
    `).run(user.id, anonLoginId, user.id);
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(user.id);

    writeAudit(db, {
      actorUserId: user.id, actorName: '탈퇴한 사용자', action: 'delete',
      entityType: 'user', entityId: user.id, before: { loginId: user.login_id, name: user.name },
    });

    res.json({ ok: true });
  });

  return router;
};
