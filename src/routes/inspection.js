const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { authenticate, requirePermission, accessibleSiteIds, resolveTargetSiteId } = require('../auth-middleware');
const { nextDomainId, resolveIdForSite } = require('../ids');
const { writeAudit } = require('../audit');
const { resolveContractorLink } = require('../contractor-link');

// 2026-09-05(경쟁사 대조 - 무사퇴근 "안전점검"): 순회·정기 안전점검.
//
// 지금까지는 법정회의점검(legalmeet)의 kind에 "순회점검"을 넣어 쓰고 있었는데, 그 표는
// 회의 구조라(참석자·안건·의결) 체크리스트를 담을 수 없었습니다. 지적사항이 자유 텍스트
// 한 칸이라 "15개 항목 중 3개 부적합" 같은 관리가 불가능했습니다.
//
// 이 모듈의 핵심은 두 가지입니다:
//  (1) 점검표를 한 번 만들어 매번 재사용 — 매번 문항을 다시 적게 하면 현장에서 안 씁니다.
//  (2) 부적합이 나오면 개선조치(CAPA)로 자동 연결 — 점검만 하고 넘어가면 점검할 이유가 없습니다.
module.exports = function inspectionRoutes(db) {
  const router = express.Router();

  // ---- 점검표(재사용 체크리스트) ----
  router.post('/templates', (req, res, next) => {
    if (req.body && !req.body.status) req.body.status = '사용중';
    next();
  });

  router.use('/templates', createSimpleCrudRoutes(db, {
    domainType: 'insptpl',
    table: 'inspection_templates',
    permissionPrefix: 'inspection',
    requiredField: { body: 'name', label: '점검표 이름' },
    fields: [
      { body: 'name', column: 'name' },
      { body: 'kind', column: 'kind' },
      { body: 'description', column: 'description' },
      { body: 'status', column: 'status' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  // ---- 점검표 문항 ----
  // 문항은 점검표에 종속되므로 별도 목록 API 대신 점검표 기준으로 다룹니다.
  router.get('/templates/:id/items', authenticate, requirePermission(db, 'inspection.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const tpl = db.prepare(`SELECT id FROM inspection_templates WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!tpl) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    res.json(db.prepare('SELECT * FROM inspection_template_items WHERE template_id = ? AND deleted = 0 ORDER BY seq, rowid').all(req.params.id));
  });

  router.post('/templates/:id/items', authenticate, requirePermission(db, 'inspection.update'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const tpl = db.prepare(`SELECT id FROM inspection_templates WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!tpl) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ error: '추가할 점검 문항을 입력해 주세요.' });

    const insert = db.prepare('INSERT INTO inspection_template_items (id, template_id, seq, content, legal_basis, memo) VALUES (?, ?, ?, ?, ?, ?)');
    const base = db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM inspection_template_items WHERE template_id = ?').get(req.params.id).s;
    const created = [];
    db.transaction(() => {
      items.forEach((it, i) => {
        if (!it || !it.content) return;
        const id = `INSPI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        insert.run(id, req.params.id, base + i + 1, it.content, it.legalBasis || null, it.memo || null);
        created.push(id);
      });
    })();
    if (!created.length) return res.status(400).json({ error: '문항 내용(content)이 비어 있습니다.' });
    res.status(201).json({ added: created.length, ids: created });
  });

  router.delete('/templates/:tplId/items/:itemId', authenticate, requirePermission(db, 'inspection.update'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    const sitePh = siteIds.map(() => '?').join(',');
    const tpl = siteIds.length
      ? db.prepare(`SELECT id FROM inspection_templates WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(req.params.tplId, ...siteIds)
      : null;
    if (!tpl) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const r = db.prepare('UPDATE inspection_template_items SET deleted = 1 WHERE id = ? AND template_id = ?')
      .run(req.params.itemId, req.params.tplId);
    if (!r.changes) return res.status(404).json({ error: '문항을 찾을 수 없습니다.' });
    res.json({ ok: true });
  });

  // ---- 점검 실시 ----
  // 점검표를 지정하면 그 문항들이 자동으로 결과표에 펼쳐집니다(매번 다시 적지 않게).
  router.post('/', authenticate, requirePermission(db, 'inspection.create'), (req, res) => {
    const b = req.body || {};
    const targetSiteId = resolveTargetSiteId(db, req, res);
    if (targetSiteId === null) return;
    if (!targetSiteId) return res.status(400).json({ error: '등록할 사업장을 선택해 주세요.' });

    const siteIds = accessibleSiteIds(db, req);
    const sitePh = siteIds.map(() => '?').join(',');

    let templateItems = [];
    if (b.templateId) {
      const tpl = db.prepare(`SELECT id FROM inspection_templates WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
        .get(b.templateId, ...siteIds);
      if (!tpl) return res.status(400).json({ error: '지정한 점검표를 찾을 수 없습니다. 점검표를 먼저 만들어 주세요.' });
      templateItems = db.prepare('SELECT * FROM inspection_template_items WHERE template_id = ? AND deleted = 0 ORDER BY seq, rowid').all(b.templateId);
    }

    // 결과는 (1) 점검표에서 펼치거나 (2) 요청에 직접 담아 보낼 수 있습니다.
    const bodyResults = Array.isArray(b.results) ? b.results : [];
    const rows = bodyResults.length
      ? bodyResults
      : templateItems.map((it) => ({ itemId: it.id, seq: it.seq, itemContent: it.content, result: null }));
    if (!rows.length) return res.status(400).json({ error: '점검표를 지정하거나 점검 문항을 직접 입력해 주세요.' });

    const { id, alreadyExisted, idReassigned } = resolveIdForSite(db, 'inspection', 'inspections', b.id, targetSiteId);
    if (alreadyExisted) return res.status(200).json({ id, alreadyExisted: true });

    const ngCount = rows.filter((r) => r.result === '부적합').length;
    // 부적합이 있는데 조치가 없으면 '점검완료'로 끝내지 못하게 합니다(다른 모듈과 같은 원칙).
    const status = b.status && !(ngCount > 0) ? b.status : (ngCount > 0 ? '개선필요' : '점검완료');

    const link = resolveContractorLink(db, siteIds, b);
    if (link.error) return res.status(400).json({ error: link.error });

    let autoCapaId = null;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO inspections (id, site_id, template_id, process_id, inspect_date, kind, location,
          inspector, accompanied, total_count, ng_count, summary, status, related_contractor, contractor_id, memo, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, targetSiteId, b.templateId || null, b.processId || null, b.inspectDate || null,
        b.kind || null, b.location || null, b.inspector || null, b.accompanied || null,
        rows.length, ngCount, b.summary || null, status,
        b.relatedContractor || null, link.contractorId, b.memo || null, req.user.sub);

      const ins = db.prepare('INSERT INTO inspection_results (id, inspection_id, item_id, seq, item_content, result, finding, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      rows.forEach((r, i) => {
        ins.run(`INSPR-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          id, r.itemId || null, r.seq != null ? r.seq : i + 1,
          r.itemContent || '(문항 없음)', r.result || null, r.finding || null, r.action || null);
      });

      // 부적합이 있으면 개선조치를 자동으로 엽니다(마스터 프롬프트 21절).
      if (ngCount > 0) {
        autoCapaId = nextDomainId(db, 'capa');
        const ngList = rows.filter((r) => r.result === '부적합')
          .map((r) => `· ${r.itemContent}${r.finding ? ` — ${r.finding}` : ''}`).join('\n');
        db.prepare(`
          INSERT INTO capa_actions (id, site_id, source_type, source_id, title, description, created_by)
          VALUES (?, ?, 'inspection', ?, ?, ?, ?)
        `).run(autoCapaId, targetSiteId, id,
          `[자동생성] 안전점검 부적합 ${ngCount}건 - ${b.location || b.kind || '점검'}`,
          `아래 항목이 부적합으로 확인되었습니다.\n${ngList}`, req.user.sub);
      }
    })();

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: 'inspection', entityId: id, after: { ngCount, total: rows.length }, ip: req.ip,
    });

    const out = { id, ngCount, totalCount: rows.length, status };
    if (autoCapaId) out.autoCapaId = autoCapaId;
    if (idReassigned) out.idReassigned = true;
    res.status(201).json(out);
  });

  router.get('/', authenticate, requirePermission(db, 'inspection.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.json([]);
    const sitePh = siteIds.map(() => '?').join(',');
    res.json(db.prepare(`SELECT * FROM inspections WHERE site_id IN (${sitePh}) AND deleted = 0 ORDER BY created_at DESC LIMIT 200`).all(...siteIds));
  });

  // 점검 한 건의 항목별 결과
  router.get('/:id/results', authenticate, requirePermission(db, 'inspection.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const insp = db.prepare(`SELECT * FROM inspections WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(req.params.id, ...siteIds);
    if (!insp) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    res.json({
      inspection: insp,
      results: db.prepare('SELECT * FROM inspection_results WHERE inspection_id = ? AND deleted = 0 ORDER BY seq, rowid').all(req.params.id),
    });
  });

  // 자주 부적합이 나오는 문항 — 어디를 고쳐야 하는지 알려줍니다(반복 위험요인 분석과 같은 취지).
  router.get('/stats/frequent-ng', authenticate, requirePermission(db, 'inspection.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.json([]);
    const sitePh = siteIds.map(() => '?').join(',');
    res.json(db.prepare(`
      SELECT r.item_content AS 문항, COUNT(*) AS 부적합횟수
      FROM inspection_results r
      JOIN inspections i ON i.id = r.inspection_id
      WHERE i.site_id IN (${sitePh}) AND i.deleted = 0 AND r.deleted = 0 AND r.result = '부적합'
      GROUP BY r.item_content
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `).all(...siteIds));
  });

  router.delete('/:id', authenticate, requirePermission(db, 'inspection.delete_any'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const r = db.prepare(`UPDATE inspections SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .run(req.user.sub, req.params.id, ...siteIds);
    if (!r.changes) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    res.json({ ok: true });
  });

  return router;
};
