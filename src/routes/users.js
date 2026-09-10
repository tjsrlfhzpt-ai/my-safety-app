const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticate, requirePermission, hasPermission, accessibleSiteIds } = require('../auth-middleware');
const { writeAudit } = require('../audit');

// 2026-08-28 점검(출시전 점검보고서 2-6절): seed.js는 'user.manage' 권한을 정의하고
// site_admin 이상 역할에 부여하지만, 전체 라우트를 grep해도 이 권한을 실제로 검사하는
// 코드가 어디에도 없었다 - "정의만 되고 아무 데서도 쓰이지 않는 죽은 권한"이었다.
// 그 결과 사용자 목록 조회, 역할 부여, 잠금 해제(2-5절) 모두 API 차원에서 불가능했다.
// 이 파일이 그 세 가지를 구현한다.
//
// company_admin/super_admin(=org.settings 보유자)만 부여할 수 있는 상위 역할. site_admin
// 등 user.manage만 가진 관리자가 자신/타인을 이 역할로 올릴 수 없게 막는다 - 그렇지
// 않으면 2-1절과 똑같은 종류의 권한상승 경로가 이 API를 통해 다시 열리게 된다.
const HIGH_PRIVILEGE_ROLES = new Set(['super_admin', 'company_admin', 'site_admin']);
const ORG_WIDE_ROLES = new Set(['super_admin', 'company_admin']);

module.exports = function usersRoutes(db) {
  const router = express.Router();
  router.use(authenticate);

  function findManageableUser(req, userId) {
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ? AND deleted = 0').get(userId, req.user.orgId);
    if (!target) return null;
    const siteIds = accessibleSiteIds(db, req);
    // site_id가 NULL인 대상(조직전역 관리자 계정)은 그대로 노출/관리 가능. 특정 사업장
    // 소속 대상은 호출자가 접근 가능한 사업장 범위 안에 있을 때만 관리 가능.
    if (target.site_id !== null && !siteIds.includes(target.site_id)) return undefined; // 범위 밖 = 403
    return target;
  }

  // 관리 가능한 범위(자기 조직 + 자기 접근 사업장) 사용자 목록
  router.get('/', requirePermission(db, 'user.manage'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    const rows = db.prepare(`
      SELECT u.id, u.login_id, u.name, u.site_id, u.account_status, u.failed_login_count,
             u.last_login_at, u.created_at,
             (SELECT GROUP_CONCAT(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_codes
      FROM users u
      WHERE u.org_id = ? AND u.deleted = 0
      ORDER BY u.created_at DESC
    `).all(req.user.orgId);

    const visible = rows.filter((r) => r.site_id === null || siteIds.includes(r.site_id));
    res.json(visible.map((r) => ({
      id: r.id, loginId: r.login_id, name: r.name, siteId: r.site_id,
      accountStatus: r.account_status, failedLoginCount: r.failed_login_count,
      lastLoginAt: r.last_login_at, createdAt: r.created_at,
      roles: r.role_codes ? r.role_codes.split(',') : [],
    })));
  });

  // 역할 변경 (승격/강등). 대상 역할이 상위 역할이면 org.settings 보유자만 부여 가능.
  router.patch('/:id/role', requirePermission(db, 'user.manage'), (req, res) => {
    if (req.params.id === req.user.sub) {
      return res.status(400).json({ error: '본인의 역할은 스스로 변경할 수 없습니다. 다른 관리자에게 요청하세요.' });
    }
    const { roleCode } = req.body || {};
    const role = db.prepare('SELECT id, code FROM roles WHERE code = ?').get(roleCode);
    if (!role) return res.status(400).json({ error: '존재하지 않는 역할입니다.' });

    if (HIGH_PRIVILEGE_ROLES.has(roleCode) && !hasPermission(db, req.user.sub, 'org.settings')) {
      return res.status(403).json({ error: `'${roleCode}' 역할은 조직 설정 권한(org.settings) 보유자만 부여할 수 있습니다.` });
    }

    const target = findManageableUser(req, req.params.id);
    if (target === null) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    if (target === undefined) return res.status(403).json({ error: '해당 사용자에 대한 접근 권한이 없습니다.' });

    const beforeRoles = db.prepare(
      'SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?'
    ).all(target.id).map((r) => r.code);

    // 조직 전역 관리자로 승격하면 site_id를 NULL(조직 전체 범위)로, 그 외 역할은 대상의
    // 기존 소속 사업장을 그대로 유지한다.
    const newSiteId = ORG_WIDE_ROLES.has(roleCode) ? null : target.site_id;

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(target.id);
      db.prepare('INSERT INTO user_roles (user_id, role_id, site_id) VALUES (?, ?, ?)').run(target.id, role.id, newSiteId);
    });
    tx();

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'user_role', entityId: target.id,
      before: { roles: beforeRoles }, after: { roles: [roleCode] },
    });

    res.json({ ok: true, id: target.id, roleCode });
  });

  // 잠금 해제(active로 전환 시 실패횟수도 함께 초기화) / 비활성화(퇴사 등).
  // 2026-08-28 점검(2-5절): 계정이 5회 실패로 잠기면 이걸 다시 active로 되돌리는 코드가
  // 프로젝트 전체에 단 한 줄도 없었다 - DB를 직접 열어 고치는 것 외에는 복구 방법이 없었음.
  router.patch('/:id/status', requirePermission(db, 'user.manage'), (req, res) => {
    const { accountStatus } = req.body || {};
    if (!['active', 'disabled'].includes(accountStatus)) {
      return res.status(400).json({ error: "accountStatus는 'active' 또는 'disabled'만 가능합니다." });
    }
    if (req.params.id === req.user.sub && accountStatus === 'disabled') {
      return res.status(400).json({ error: '본인 계정은 스스로 비활성화할 수 없습니다.' });
    }

    const target = findManageableUser(req, req.params.id);
    if (target === null) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    if (target === undefined) return res.status(403).json({ error: '해당 사용자에 대한 접근 권한이 없습니다.' });

    if (accountStatus === 'active') {
      db.prepare("UPDATE users SET account_status = 'active', failed_login_count = 0 WHERE id = ?").run(target.id);
    } else {
      db.prepare("UPDATE users SET account_status = 'disabled' WHERE id = ?").run(target.id);
    }

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'user', entityId: target.id,
      before: { accountStatus: target.account_status }, after: { accountStatus },
    });

    res.json({ ok: true, id: target.id, accountStatus });
  });

  // 2026-09-02(비밀번호 분실 복구): 지금까지 비밀번호를 잊으면 되돌릴 방법이 전혀 없어서
  // 운영자가 DB를 직접 열어 해시를 바꿔야 했다.
  //
  // 이메일 발송 방식(자가 재설정 링크)을 쓰지 않은 이유: 이메일은 가입 시 필수가 아니고,
  // 현장 근로자는 회사 이메일이 없는 경우가 많다. 또 메일 발송 인프라(SMTP/외부 서비스)
  // 의존성이 새로 생긴다. 실제 현장 운영도 "근로자가 안전관리자에게 말하면 관리자가
  // 재설정해주는" 흐름이라, 관리자 발급 방식이 이 서비스에 더 맞다.
  //
  // 안전장치:
  //  - user.manage 권한자만, 그리고 같은 조직 사용자에게만 발급할 수 있다.
  //  - 임시 비밀번호는 서버가 무작위로 만들고 응답에 딱 한 번만 실어 보낸다(DB에 평문 저장 안 함).
  //  - 발급 즉시 must_change_password가 서고, 사용자는 로그인 후 반드시 새 비밀번호로 바꿔야 한다.
  //  - 실패 횟수를 초기화하고 잠금도 함께 풀어준다(대부분 잠긴 상태로 문의가 오므로).
  router.post('/:id/reset-password', requirePermission(db, 'user.manage'), async (req, res) => {
    const target = db.prepare('SELECT id, org_id, login_id, name FROM users WHERE id = ? AND deleted = 0').get(req.params.id);
    if (!target || target.org_id !== req.user.orgId) {
      return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    }

    // 읽기 쉬우면서도 추측이 어려운 임시 비밀번호(12자). 혼동되는 문자(0/O, 1/l/I)는 뺐다 -
    // 관리자가 전화로 불러주거나 종이에 적어 전달하는 상황을 감안한 것이다.
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let temp = '';
    for (let i = 0; i < 12; i++) temp += ALPHABET[crypto.randomInt(ALPHABET.length)];

    const hash = await bcrypt.hash(temp, 12);
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1,
                failed_login_count = 0, account_status = 'active' WHERE id = ?`).run(hash, target.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'user', entityId: target.id,
      after: { passwordReset: true },   // 임시 비밀번호 자체는 감사로그에도 남기지 않는다
    });

    res.json({
      ok: true, loginId: target.login_id, name: target.name,
      temporaryPassword: temp,
      notice: '이 임시 비밀번호는 지금 한 번만 표시됩니다. 본인에게 전달하고, 로그인 후 즉시 새 비밀번호로 변경하도록 안내하세요.',
    });
  });

  return router;
};
