const express = require('express');
const { nextDomainId, resolveIdForSite } = require('../ids');
const { writeAudit } = require('../audit');
const { authenticate, requirePermission, requireHomeSite, resolveTargetSiteId, accessibleSiteIds } = require('../auth-middleware');
const { queryPaginatedList } = require('../pagination');
const { resolveContractorLink } = require('../contractor-link');

// 어떤 점수부터 "고위험"으로 보고 CAPA를 자동 생성할지 - 기존 앱의 위험도 등급 감각과
// 맞추기 위해 5x5 매트릭스 기준 15점(=3x5, 4x4 근처) 이상을 임계값으로 둠.
const AUTO_CAPA_THRESHOLD = 15;

module.exports = function riskRoutes(db) {
  const router = express.Router();
  router.use(authenticate);

  router.post('/', requirePermission(db, 'risk.create'), requireHomeSite, (req, res) => {
    const b = req.body || {};
    if (!b.hazard) return res.status(400).json({ error: 'hazard는 필수입니다.' });

    // v5.9: 프론트엔드(IdGenerator)가 오프라인 중에 이미 RISK-2026-000042 형식으로
    // 채번해뒀다면 그 id를 그대로 신뢰해서 씁니다. 그래야 나중에 로컬 데이터와 서버
    // 데이터를 같은 id로 대조할 수 있습니다. id가 없거나 형식이 안 맞으면 서버가 새로 채번.
    //
    // v5.9: SyncQueue는 실패 시 재시도하므로, 같은 id로 두 번 POST될 수 있습니다(예: 서버는
    // 저장에 성공했는데 응답이 오다가 끊긴 경우). "같은 사업장"의 재시도면 에러 대신 "이미
    // 반영됨"으로 응답해야 재시도가 안전합니다(멱등). 단 2026-08-28 점검에서, 이 확인이
    // site_id로 구분되지 않아 (a) 다른 사업장이 우연히 같은 id를 쓰면 데이터가 유실되고
    // (b) 그 사업장의 실제 risk_score가 응답에 그대로 노출되는 것을 재현·확인했다(출시전
    // 점검보고서 2-2절). resolveIdForSite로 사업장 경계를 지킨다.
    // 2026-09-02: 본문 siteId 지정 시 권한검증 후 해당 사업장으로 등록(본사 관리자 대리입력).
    const targetSiteId = resolveTargetSiteId(db, req, res);
    if (targetSiteId === null) return;

    const { id, alreadyExisted, idReassigned } = resolveIdForSite(db, 'risk', 'risk_assessments', b.id, targetSiteId);
    if (alreadyExisted) {
      const mine = db.prepare('SELECT id, risk_score FROM risk_assessments WHERE id = ? AND site_id = ?').get(id, targetSiteId);
      return res.status(200).json({ id: mine.id, riskScore: mine.risk_score, autoCapaId: null, alreadyExisted: true });
    }

    const score = (Number(b.likelihood) || 0) * (Number(b.severity) || 0);

    db.prepare(`
      INSERT INTO risk_assessments
        (id, site_id, process_name, task_name, hazard, existing_measures, likelihood, severity,
         risk_score, reduction_measures, status, assignee_id, due_date, related_contractor, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, targetSiteId, b.processName || null, b.taskName || null, b.hazard,
           b.existingMeasures || null, b.likelihood || null, b.severity || null, score,
           b.reductionMeasures || null, b.assigneeId || null, b.dueDate || null,
           b.relatedContractor || null, req.user.sub);

    // 2026-09-02(45-4절): 협력업체 실제 연결(원본 텍스트는 위에 그대로 보존됨).
    const riskLink = resolveContractorLink(db, accessibleSiteIds(db, req), b);
    if (riskLink.error) return res.status(400).json({ error: riskLink.error });
    if (riskLink.contractorId) {
      db.prepare('UPDATE risk_assessments SET contractor_id = ? WHERE id = ?').run(riskLink.contractorId, id);
    }

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: 'risk_assessment', entityId: id, after: b, ip: req.ip,
    });

    // 위험성평가 -> CAPA 자동 연결 (지시서 12/17/18번)
    let autoCapaId = null;
    if (score >= AUTO_CAPA_THRESHOLD) {
      autoCapaId = nextDomainId(db, 'capa');
      db.prepare(`
        INSERT INTO capa_actions (id, site_id, source_type, source_id, title, status, created_by)
        VALUES (?, ?, 'risk_assessment', ?, ?, '등록', ?)
      `).run(autoCapaId, targetSiteId, id, `[자동생성] 고위험 개선조치 - ${b.hazard}`, req.user.sub);

      writeAudit(db, {
        actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
        entityType: 'capa_action', entityId: autoCapaId,
        after: { sourceType: 'risk_assessment', sourceId: id },
      });
    }

    res.status(201).json(idReassigned ? { id, riskScore: score, autoCapaId, idReassigned: true } : { id, riskScore: score, autoCapaId });
  });

  // 2026-08-28 후속조치(출시전 점검보고서 3절): 등록 후 수정할 방법이 없었다. likelihood/
  // severity가 바뀌면 risk_score를 재계산하고, 새로 임계값을 넘었는데 아직 이 항목에서
  // 자동생성된 CAPA가 없으면 생성 로직과 동일하게 하나 만든다(이미 있으면 건드리지 않음 -
  // CAPA 자체의 생애주기는 capa.js가 별도로 관리한다).
  const EDITABLE_FIELDS = {
    processName: 'process_name', taskName: 'task_name', hazard: 'hazard',
    existingMeasures: 'existing_measures', likelihood: 'likelihood', severity: 'severity',
    reductionMeasures: 'reduction_measures', assigneeId: 'assignee_id', dueDate: 'due_date',
    relatedContractor: 'related_contractor',
  };

  router.patch('/:id', requirePermission(db, 'risk.update'), (req, res) => {
    const b = req.body || {};
    const touchedKeys = Object.keys(EDITABLE_FIELDS).filter((k) => Object.prototype.hasOwnProperty.call(b, k));
    if (touchedKeys.length === 0) {
      return res.status(400).json({ error: '수정할 값이 없습니다.' });
    }
    if (touchedKeys.includes('hazard') && !b.hazard) {
      return res.status(400).json({ error: 'hazard는 필수입니다.' });
    }

    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const existing = db.prepare(`SELECT * FROM risk_assessments WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!existing) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const setParts = touchedKeys.map((k) => `${EDITABLE_FIELDS[k]} = ?`);
    const values = touchedKeys.map((k) => b[k]);

    let newScore = existing.risk_score;
    if (touchedKeys.includes('likelihood') || touchedKeys.includes('severity')) {
      const nextLikelihood = touchedKeys.includes('likelihood') ? (Number(b.likelihood) || 0) : (existing.likelihood || 0);
      const nextSeverity = touchedKeys.includes('severity') ? (Number(b.severity) || 0) : (existing.severity || 0);
      newScore = nextLikelihood * nextSeverity;
      setParts.push('risk_score = ?');
      values.push(newScore);
    }

    // 2026-09-02(20절 버전관리): 덮어쓰기 전에 지금 상태를 그대로 보관한다.
    // 이렇게 해두면 "이 위험성평가가 처음엔 어땠고 언제 어떻게 바뀌었는지"를 되짚을 수 있다.
    const nextVersion = (db.prepare('SELECT COALESCE(MAX(version_no), 0) AS v FROM risk_assessment_versions WHERE assessment_id = ?')
      .get(req.params.id).v) + 1;
    db.prepare(`INSERT INTO risk_assessment_versions (assessment_id, version_no, snapshot_json, changed_fields, changed_by)
                VALUES (?, ?, ?, ?, ?)`)
      .run(req.params.id, nextVersion, JSON.stringify(existing), touchedKeys.join(','), req.user.sub);

    db.prepare(
      `UPDATE risk_assessments SET ${setParts.join(', ')}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`
    ).run(...values, req.user.sub, req.params.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'risk_assessment', entityId: req.params.id, before: existing, after: b,
    });

    let autoCapaId = null;
    if (newScore >= AUTO_CAPA_THRESHOLD) {
      const alreadyCapa = db.prepare(
        "SELECT id FROM capa_actions WHERE source_type = 'risk_assessment' AND source_id = ? AND deleted = 0"
      ).get(req.params.id);
      if (!alreadyCapa) {
        autoCapaId = nextDomainId(db, 'capa');
        db.prepare(`
          INSERT INTO capa_actions (id, site_id, source_type, source_id, title, status, created_by)
          VALUES (?, ?, 'risk_assessment', ?, ?, '등록', ?)
        `).run(autoCapaId, existing.site_id, req.params.id, `[자동생성] 고위험 개선조치 - ${b.hazard || existing.hazard}`, req.user.sub);

        writeAudit(db, {
          actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
          entityType: 'capa_action', entityId: autoCapaId,
          after: { sourceType: 'risk_assessment', sourceId: req.params.id },
        });
      }
    }

    res.json({ ok: true, riskScore: newScore, autoCapaId });
  });

  // 2026-09-02(20절): 특정 위험성평가가 어떻게 변해왔는지 조회한다.
  // 최신 상태는 원본 레코드에 있고, 여기서는 과거 버전들만 최신순으로 돌려준다.
  router.get('/:id/versions', requirePermission(db, 'risk.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const current = db.prepare(`SELECT * FROM risk_assessments WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    // 다른 사업장 자료의 존재 여부까지 알려주지 않도록 404로 통일한다.
    if (!current) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const rows = db.prepare('SELECT version_no, snapshot_json, changed_fields, changed_by, changed_at FROM risk_assessment_versions WHERE assessment_id = ? ORDER BY version_no DESC')
      .all(req.params.id);
    res.json({
      id: req.params.id,
      current,
      versions: rows.map((r) => ({
        versionNo: r.version_no,
        changedFields: r.changed_fields ? r.changed_fields.split(',') : [],
        changedBy: r.changed_by,
        changedAt: r.changed_at,
        snapshot: JSON.parse(r.snapshot_json),
      })),
    });
  });

  router.get('/', requirePermission(db, 'risk.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    const { rows, total } = queryPaginatedList(db, 'risk_assessments', siteIds, req.query);
    res.set('X-Total-Count', String(total));
    res.json(rows);
  });

  router.delete('/:id', requirePermission(db, 'risk.delete_any'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const existing = db.prepare(`SELECT * FROM risk_assessments WHERE id = ? AND site_id IN (${sitePh})`)
      .get(req.params.id, ...siteIds);
    if (!existing) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    db.prepare(
      "UPDATE risk_assessments SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?"
    ).run(req.user.sub, req.params.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'delete',
      entityType: 'risk_assessment', entityId: req.params.id, before: existing,
    });

    res.json({ ok: true });
  });

  return router;
};
