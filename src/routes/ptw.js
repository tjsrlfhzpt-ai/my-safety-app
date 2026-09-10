const express = require('express');
const { resolveIdForSite } = require('../ids');
const { writeAudit } = require('../audit');
const { authenticate, requirePermission, hasPermission, requireHomeSite, resolveTargetSiteId, accessibleSiteIds } = require('../auth-middleware');
const { queryPaginatedList } = require('../pagination');
const { resolveContractorLink } = require('../contractor-link');

// 프론트엔드(app.html)의 PTW_STATUSES/PTW_NEXT_STATUS를 서버 쪽에서 그대로 강제합니다.
// 프론트의 PTW_NEXT_STATUS는 정상 진행 경로만 정의하고 있어("등록→위험확인중→...→종료"),
// 반려 경로는 CAPA(검증중→반려→조치중 재작업)와 동일한 패턴으로 합리적으로 설계했습니다:
// 위험확인중/승인대기 단계에서 반려될 수 있고, 반려되면 등록 단계로 돌아가 재작업합니다.
// ⚠️ 확인 필요: 이 반려 경로는 실제 화면 동작을 보고 확정한 것이 아니라 CAPA 패턴을
// 참고해 합리적으로 설계한 것이므로, 실제 사용해보시고 다르게 동작해야 하면 알려주세요.
const PTW_TRANSITIONS = {
  '등록': ['위험확인중'],
  '위험확인중': ['승인대기', '반려'],
  '승인대기': ['승인됨', '반려'],
  '승인됨': ['작업중'],
  '작업중': ['종료'],
  '반려': ['등록'],
};

module.exports = function ptwRoutes(db) {
  const router = express.Router();
  router.use(authenticate);

  router.post('/', requirePermission(db, 'ptw.create'), requireHomeSite, (req, res) => {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: '작업명은 필수입니다.' });
    if (!b.location) return res.status(400).json({ error: '작업장소는 필수입니다.' });
    if (!b.time) return res.status(400).json({ error: '작업시간은 필수입니다.' });

    // 2026-08-28 점검: 다른 sync-enabled 모듈과 동일하게 site 간 id충돌로 인한 데이터유실을
    // 막기 위해 resolveIdForSite 사용 (출시전 점검보고서 2-2절)
    // 2026-09-02: 본문 siteId 지정 시 권한검증 후 해당 사업장으로 등록.
    const targetSiteId = resolveTargetSiteId(db, req, res);
    if (targetSiteId === null) return;

    const { id, alreadyExisted, idReassigned } = resolveIdForSite(db, 'ptw', 'permits', b.id, targetSiteId);
    if (alreadyExisted) return res.status(200).json({ id, alreadyExisted: true });

    db.prepare(`
      INSERT INTO permits (id, site_id, title, location, work_time, work_date, manager, worker, hazard, measure, related_contractor, memo, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, targetSiteId, b.title, b.location, b.time, b.date || null, b.manager || null,
           b.worker || null, b.hazard || null, b.measure || null, b.relatedContractor || null,
           b.memo || null, req.user.sub);

    // 2026-09-02(45-4절): 협력업체 실제 연결(원본 텍스트는 위에 그대로 보존됨).
    const ptwLink = resolveContractorLink(db, accessibleSiteIds(db, req), b);
    if (ptwLink.error) return res.status(400).json({ error: ptwLink.error });
    if (ptwLink.contractorId) {
      db.prepare('UPDATE permits SET contractor_id = ? WHERE id = ?').run(ptwLink.contractorId, id);
    }

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: 'permit', entityId: id, after: b, ip: req.ip,
    });

    res.status(201).json(idReassigned ? { id, idReassigned: true } : { id });
  });

  router.get('/', requirePermission(db, 'ptw.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    const { rows, total } = queryPaginatedList(db, 'permits', siteIds, req.query);
    res.set('X-Total-Count', String(total));
    res.json(rows);
  });

  router.patch('/:id/status', requirePermission(db, 'ptw.update'), (req, res) => {
    const { status: nextStatus } = req.body || {};
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const permit = db.prepare(`SELECT * FROM permits WHERE id = ? AND site_id IN (${sitePh})`)
      .get(req.params.id, ...siteIds);
    if (!permit) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const allowed = PTW_TRANSITIONS[permit.status] || [];
    if (!allowed.includes(nextStatus)) {
      return res.status(422).json({ error: `${permit.status} → ${nextStatus} 전환은 허용되지 않습니다.`, allowed });
    }
    if (nextStatus === '승인됨' && !hasPermission(db, req.user.sub, 'ptw.approve')) {
      return res.status(403).json({ error: '승인 권한이 없습니다.' });
    }

    const timestampCol = { '승인됨': 'approved_at', '작업중': 'work_started_at', '종료': 'closed_at' }[nextStatus];
    const setTimestamp = timestampCol ? `, ${timestampCol} = datetime('now')` : '';
    db.prepare(
      `UPDATE permits SET status = ?, updated_by = ?, updated_at = datetime('now')${setTimestamp} WHERE id = ?`
    ).run(nextStatus, req.user.sub, req.params.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'status_change',
      entityType: 'permit', entityId: req.params.id,
      before: { status: permit.status }, after: { status: nextStatus },
    });

    res.json({ ok: true, from: permit.status, to: nextStatus });
  });

  router.delete('/:id', requirePermission(db, 'ptw.delete_any'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const existing = db.prepare(`SELECT * FROM permits WHERE id = ? AND site_id IN (${sitePh})`)
      .get(req.params.id, ...siteIds);
    if (!existing) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    db.prepare(
      `UPDATE permits SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`
    ).run(req.user.sub, req.params.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'delete',
      entityType: 'permit', entityId: req.params.id, before: existing,
    });

    res.json({ ok: true });
  });

  return router;
};
