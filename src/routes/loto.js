const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { authenticate, requirePermission, accessibleSiteIds, resolveTargetSiteId } = require('../auth-middleware');
const { writeAudit } = require('../audit');

// 2026-09-02(마스터 프롬프트 45-3절): LOTO(Lockout/Tagout) 관리.
//
// 설비 정비 중 사망사고의 상당수가 "전원을 껐다고 생각했는데 실제로는 에너지가 남아
// 있었던" 상황에서 납니다. 그래서 이 모듈에서 가장 중요한 것은 화면 개수가 아니라
// "잔류에너지를 확인하지 않으면 작업에 들어갈 수 없게 막는 것"입니다.
//
// 상태 흐름(45-3절 그대로):
//   신청 → 차단완료 → 작업중 → 복구완료 → 종료
// 각 단계는 한 칸씩만 이동할 수 있습니다. 특히 '차단완료 → 작업중'은 잔류에너지 확인이
// 끝나야만 넘어갈 수 있습니다 - 이 검사를 서버가 하는 이유는, 화면에서 버튼을 숨기는
// 것만으로는 API를 직접 부르는 경우를 막지 못하기 때문입니다(마스터 프롬프트 16·37절).
const LOTO_TRANSITIONS = {
  '신청': ['차단완료'],
  '차단완료': ['작업중'],
  '작업중': ['복구완료'],
  '복구완료': ['종료'],
};

module.exports = function lotoRoutes(db) {
  const router = express.Router();

  // ---- 설비별 에너지원 목록 (설비의 고정 속성) ----
  // 존재하지 않는 설비를 지정하면 DB의 외래키 제약에 걸려 500("서버 오류")이 납니다.
  // 그러면 사용자는 무엇이 잘못됐는지 알 수 없으므로, 미리 확인해서 명확히 알려줍니다
  // (마스터 프롬프트 12절: 사용자에게는 이해하기 쉬운 오류를 보여줄 것).
  router.post('/sources', authenticate, (req, res, next) => {
    const eqId = req.body && req.body.equipmentId;
    if (eqId) {
      const siteIds = accessibleSiteIds(db, req);
      const sitePh = siteIds.map(() => '?').join(',');
      const found = siteIds.length
        ? db.prepare(`SELECT id FROM equipment WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(eqId, ...siteIds)
        : null;
      if (!found) {
        return res.status(400).json({ error: '지정한 설비를 찾을 수 없습니다. 기계기구 목록에서 먼저 설비를 등록한 뒤 선택해 주세요.' });
      }
    }
    next();
  });

  router.use('/sources', createSimpleCrudRoutes(db, {
    domainType: 'lotosource',
    table: 'loto_energy_sources',
    permissionPrefix: 'loto',
    requiredField: [
      { body: 'equipmentId', label: '대상 설비' },
      { body: 'energyType', label: '에너지 종류' },
      { body: 'sourceName', label: '차단장치명' },
    ],
    fields: [
      { body: 'equipmentId', column: 'equipment_id' },
      { body: 'energyType', column: 'energy_type' },
      { body: 'sourceName', column: 'source_name' },
      { body: 'location', column: 'location' },
      { body: 'isolationMethod', column: 'isolation_method' },
      { body: 'releaseMethod', column: 'release_method' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  // ---- LOTO 작업 상태 전이 ----
  // 팩토리보다 먼저 등록해야 팩토리의 PATCH /:id 에 먹히지 않습니다.
  router.patch('/permits/:id/status', authenticate, requirePermission(db, 'loto.update'), (req, res) => {
    const { status: next } = req.body || {};
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const permit = db.prepare(`SELECT * FROM loto_permits WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!permit) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const allowed = LOTO_TRANSITIONS[permit.status] || [];
    if (!allowed.includes(next)) {
      return res.status(400).json({
        error: `'${permit.status}' 상태에서는 '${next}'로 바꿀 수 없습니다. 가능한 다음 단계: ${allowed.join(', ') || '없음(종료 상태)'}`,
      });
    }

    // ⚠️ 안전의 핵심: 잔류에너지 확인 없이는 작업에 들어갈 수 없습니다.
    if (next === '작업중' && permit.residual_checked !== 1) {
      return res.status(400).json({
        error: '잔류에너지 확인이 완료되지 않았습니다. 압축공기·유압·전기 등이 완전히 해소되었는지 확인하고 기록한 뒤 작업을 시작하세요.',
      });
    }

    const extra = {};
    if (next === '차단완료') extra.isolated_at = "datetime('now')";
    if (next === '복구완료') extra.restored_at = "datetime('now')";
    const extraSql = Object.keys(extra).map((k) => `, ${k} = ${extra[k]}`).join('');

    db.prepare(`UPDATE loto_permits SET status = ?, updated_at = datetime('now'), updated_by = ?${extraSql} WHERE id = ?`)
      .run(next, req.user.sub, permit.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'status_change',
      entityType: 'loto_permit', entityId: permit.id,
      before: { status: permit.status }, after: { status: next },
    });

    res.json({ ok: true, status: next });
  });

  // 잔류에너지 확인 기록 - 누가 확인했는지 남깁니다(사고 조사 시 중요).
  router.patch('/permits/:id/residual-check', authenticate, requirePermission(db, 'loto.update'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const permit = db.prepare(`SELECT * FROM loto_permits WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!permit) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    if (permit.status !== '차단완료') {
      return res.status(400).json({ error: '에너지원을 차단하고 잠근 뒤에 잔류에너지를 확인할 수 있습니다.' });
    }

    const checker = (req.body && req.body.checker) || req.user.name;
    db.prepare("UPDATE loto_permits SET residual_checked = 1, residual_checker = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?")
      .run(checker, req.user.sub, permit.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: 'loto_permit', entityId: permit.id, after: { residualChecked: true, checker },
    });

    res.json({ ok: true, residualChecked: true, checker });
  });

  // ---- LOTO 작업 기록 CRUD ----
  router.post('/permits', authenticate, (req, res, next) => {
    if (req.body && !req.body.status) req.body.status = '신청';
    // 설비 지정은 선택이지만, 지정했다면 실제로 존재하는 설비여야 합니다(에너지원과 동일한 이유).
    const eqId = req.body && req.body.equipmentId;
    if (eqId) {
      const siteIds = accessibleSiteIds(db, req);
      const sitePh = siteIds.map(() => '?').join(',');
      const found = siteIds.length
        ? db.prepare(`SELECT id FROM equipment WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(eqId, ...siteIds)
        : null;
      if (!found) {
        return res.status(400).json({ error: '지정한 설비를 찾을 수 없습니다. 기계기구 목록에서 먼저 설비를 등록한 뒤 선택해 주세요.' });
      }
    }
    next();
  });

  router.use('/permits', createSimpleCrudRoutes(db, {
    domainType: 'loto',
    table: 'loto_permits',
    permissionPrefix: 'loto',
    requiredField: { body: 'workDesc', label: '작업 내용' },
    fields: [
      { body: 'equipmentId', column: 'equipment_id' },
      { body: 'workDesc', column: 'work_desc' },
      { body: 'workDate', column: 'work_date' },
      { body: 'worker', column: 'worker' },
      { body: 'supervisor', column: 'supervisor' },
      { body: 'lockTagNo', column: 'lock_tag_no' },
      { body: 'isolatedSources', column: 'isolated_sources' },
      { body: 'status', column: 'status' },
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
