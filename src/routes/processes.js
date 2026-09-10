const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { authenticate, requirePermission, accessibleSiteIds } = require('../auth-middleware');

// 2026-09-02(마스터 프롬프트 45-1·45-5·45-6절): 공정/공종 마스터데이터.
//
// 제조업의 "공정"과 건설업의 "공종"을 하나의 표로 다룹니다(kind로 구분). 계층 구조를
// 지원해서 "가공라인 > 프레스공정"이나 "골조공사 > 철근작업"처럼 묶을 수 있습니다.
//
// 이 마스터데이터가 생기면서 달라지는 것: 지금까지 위험성평가·TBM의 공정명이 자유입력
// 텍스트라 "가공라인"과 "가공 라인"이 다른 것으로 취급됐는데, 이제 목록에서 골라 쓸 수
// 있어 집계와 반복 위험요인 분석의 정확도가 올라갑니다.
module.exports = function processesRoutes(db) {
  const router = express.Router();

  router.post('/', (req, res, next) => {
    // 팩토리가 빈 값에 null을 넣기 때문에 기본값은 여기서 채웁니다(equipment와 동일한 이유).
    if (req.body) {
      if (!req.body.kind) req.body.kind = 'process';
      if (!req.body.status) req.body.status = '운영중';
      if (req.body.sortOrder === undefined || req.body.sortOrder === null) req.body.sortOrder = 0;
    }
    next();
  });

  // 계층 구조라 삭제가 까다롭습니다. 상위 공정을 지우면 하위 공정이 부모 없는 고아가 되고,
  // 그 공정을 참조하던 설비도 갈 곳을 잃습니다(마스터 프롬프트 2절: 관련 데이터 구조를
  // 고려하지 않는 단순 삭제 금지 / 72절: 고아 데이터 방지).
  // 그래서 하위 공정이나 연결된 설비가 남아있으면 삭제를 막고, 무엇이 걸려있는지 알려줍니다.
  router.delete('/:id', authenticate, requirePermission(db, 'process.delete_any'), (req, res, next) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');

    const target = db.prepare(`SELECT id FROM processes WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!target) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const childCount = db.prepare('SELECT COUNT(*) c FROM processes WHERE parent_id = ? AND deleted = 0').get(req.params.id).c;
    const equipCount = db.prepare('SELECT COUNT(*) c FROM equipment WHERE process_id = ? AND deleted = 0').get(req.params.id).c;

    if (childCount > 0 || equipCount > 0) {
      const parts = [];
      if (childCount) parts.push(`하위 공정 ${childCount}건`);
      if (equipCount) parts.push(`연결된 기계기구 ${equipCount}건`);
      return res.status(409).json({
        error: `${parts.join(', ')}이(가) 남아있어 삭제할 수 없습니다. 먼저 옮기거나 정리한 뒤 다시 시도해 주세요.`,
        blockedBy: { children: childCount, equipment: equipCount },
      });
    }
    next();  // 걸리는 게 없으면 팩토리의 기본 삭제(soft delete)로 넘깁니다.
  });

  router.use(createSimpleCrudRoutes(db, {
    domainType: 'process',
    table: 'processes',
    permissionPrefix: 'process',
    requiredField: { body: 'name', label: '공정(공종)명' },
    fields: [
      { body: 'parentId', column: 'parent_id' },
      { body: 'kind', column: 'kind' },
      { body: 'code', column: 'code' },
      { body: 'name', column: 'name' },
      { body: 'description', column: 'description' },
      { body: 'manager', column: 'manager' },
      { body: 'hazardSummary', column: 'hazard_summary' },
      { body: 'status', column: 'status' },
      { body: 'sortOrder', column: 'sort_order' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
