const express = require('express');
const { generateId } = require('../ids');
const { writeAudit } = require('../audit');
const { authenticate, requirePermission } = require('../auth-middleware');

// 2026-08-28 점검(출시전 점검보고서 2-4절): 조직/사업장은 src/seed.js가 서버 최초 기동 시
// 딱 한 번만 만들었고, 이후 두 번째 현장을 추가할 API가 전혀 없었다(전체 라우트 grep으로
// 확인). 여러 현장을 관리하는 것이 이 제품의 핵심 가치인데 구조적으로 현장 1개만
// 지원하고 있었던 것 - 이 파일이 그 공백을 메운다.
//
// 조직(organizations) 자체를 새로 만드는 API는 의도적으로 넣지 않았다. 지금은 이선기님의
// 회사(DB그룹) 하나를 위한 서버로 운영되고, 여러 "고객사"를 위한 멀티테넌트 SaaS로 팔지는
// 아직 결정되지 않았다(출시전 점검보고서 6절 "결정이 필요한 사항" 참고) - 그 결정이 서면
// org.settings 권한자에게 조직 생성 권한을 여는 것은 이 파일에 쉽게 추가할 수 있다.
module.exports = function sitesRoutes(db) {
  const router = express.Router();
  router.use(authenticate);

  // 새 현장 추가는 회사 단위 의사결정으로 보고 org.settings(company_admin/super_admin)만 허용.
  // site_admin(user.manage만 보유)은 기존 현장을 관리할 뿐 새 현장을 만들 권한까지는 주지 않는다.
  router.post('/', requirePermission(db, 'org.settings'), (req, res) => {
    const { name, address } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name(사업장명)은 필수입니다.' });

    const id = generateId('SITE');
    db.prepare('INSERT INTO sites (id, org_id, name, address) VALUES (?, ?, ?, ?)')
      .run(id, req.user.orgId, name, address || null);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: 'site', entityId: id, after: { name, address },
    });

    res.status(201).json({ id, name });
  });

  // 목록조회는 회원가입 화면의 사업장 선택 드롭다운 등에서 널리 필요하고 민감도가 낮아
  // (사업장명만 노출) 같은 조직 소속이면 role 구분 없이 허용한다.
  router.get('/', (req, res) => {
    res.json(db.prepare(
      'SELECT id, name, address, created_at FROM sites WHERE org_id = ? AND deleted = 0 ORDER BY created_at ASC'
    ).all(req.user.orgId));
  });

  return router;
};
