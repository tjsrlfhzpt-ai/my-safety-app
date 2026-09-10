const express = require('express');
const { LEGAL_CHECKLIST_CONTENT } = require('../legal-checklist-data');
const { generateId } = require('../ids');
const { writeAudit } = require('../audit');
const { authenticate, requirePermission, accessibleSiteIds } = require('../auth-middleware');

// 로컬 앱(v5.14 tab-checklist)에 이미 있던 "산안법 & 중처법 85개 핵심 법규 DB"를 사업장별로
// 공유합니다. 항목 내용(법령/제목/설명/처벌)은 고정 시드값이고, checked/note만 사업장마다
// 달라집니다. 처음엔 이 데이터를 모르고 12개짜리 별도 체크리스트를 만들었다가(19-3절 README
// 참고), 이미 있던 더 완전한 버전으로 교체했습니다.
module.exports = function legalChecklistRoutes(db) {
  const router = express.Router();
  router.use(authenticate);

  function ensureSeeded(siteId) {
    const existing = db.prepare('SELECT COUNT(*) c FROM legal_checklist_items WHERE site_id = ?').get(siteId);
    if (existing.c >= LEGAL_CHECKLIST_CONTENT.length) return;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO legal_checklist_items (id, site_id, item_no, tag, title, description, penalty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const item of LEGAL_CHECKLIST_CONTENT) {
        insert.run(generateId('SAF'), siteId, item.no, item.tag, item.title, item.desc, item.penalty);
      }
    });
    tx();
  }

  // 법령체크리스트는 항목별 checked/note가 사업장마다 독립적이라 여러 사업장을 하나로 합쳐
  // 보여줄 수 없다(한 체크박스가 여러 사업장의 서로 다른 이행상태를 동시에 나타낼 수 없음).
  // 홈 사업장이 있으면 그 사업장을, 조직전역 관리자처럼 홈 사업장이 없으면 접근 가능한
  // 사업장 중 첫 번째를 기본으로 보여준다. 여러 사업장을 오가며 보려면 ?siteId= 로 지정.
  router.get('/', requirePermission(db, 'compliance.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    const requested = req.query.siteId;
    const targetSiteId = (requested && siteIds.includes(requested)) ? requested : (req.user.siteId || siteIds[0]);
    if (!targetSiteId) return res.status(400).json({ error: '접근 가능한 사업장이 없습니다.' });

    ensureSeeded(targetSiteId);
    const items = db.prepare(
      'SELECT * FROM legal_checklist_items WHERE site_id = ? ORDER BY item_no'
    ).all(targetSiteId);
    res.json(items);
  });

  // 로컬 앱과 동일하게 단일 상태(checked/note)만 있고 반기 개념은 없습니다 - 대신 매 변경이
  // audit_logs에 행위자·시각과 함께 남아 "언제 무엇을 이행했는지" 이력을 확인할 수 있습니다.
  router.patch('/:id', requirePermission(db, 'compliance.update'), (req, res) => {
    const { checked, note } = req.body || {};
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const item = db.prepare(`SELECT * FROM legal_checklist_items WHERE id = ? AND site_id IN (${sitePh})`)
      .get(req.params.id, ...siteIds);
    if (!item) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    db.prepare(`
      UPDATE legal_checklist_items
      SET checked = COALESCE(?, checked), note = COALESCE(?, note),
          checked_by = ?, checked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(checked !== undefined ? (checked ? 1 : 0) : null, note !== undefined ? note : null, req.user.sub, req.params.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'legal_checklist_item', entityId: req.params.id,
      before: { checked: !!item.checked }, after: { checked, note },
    });

    res.json({ ok: true });
  });

  return router;
};
