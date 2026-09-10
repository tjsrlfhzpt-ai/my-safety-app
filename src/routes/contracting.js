const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { authenticate, requirePermission, accessibleSiteIds } = require('../auth-middleware');

// 2026-09-05(마스터 프롬프트 45-9절, 무사퇴근 "도급관리 고급 기능"): 도급 안전보건관리.
//
// 이미 있는 것은 다시 만들지 않았습니다:
//   안전보건협의체 → 법정회의점검(kind='협의체'), 도급 위험성평가/교육 → 각 모듈의 협력업체 연결
// 없던 두 가지만 신설합니다: 안전보건관리비 집행, 수급업체 안전보건 평가 이력.
//
// 금액을 숫자가 아니라 문자열로 다루는 이유: 사업장마다 "3,500,000"처럼 적기도 하고
// "350만원"이라 적기도 합니다. 시스템이 임의로 해석해 계산하면 실제와 다른 숫자가
// 나오는데, 안전보건관리비는 감독 대상이라 그 오차가 문제가 됩니다. 그래서 입력값을
// 그대로 보관하고, 집계는 "숫자로 읽히는 것만" 더해 참고값임을 명시합니다.
function parseAmount(v) {
  if (v == null) return null;
  const digits = String(v).replace(/[^0-9.-]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

module.exports = function contractingRoutes(db) {
  const router = express.Router();

  // ---- 안전보건관리비 (계상) ----
  router.post('/budgets', (req, res, next) => {
    if (req.body && !req.body.status) req.body.status = '집행중';
    next();
  });

  router.use('/budgets', createSimpleCrudRoutes(db, {
    domainType: 'budget',
    table: 'safety_budgets',
    permissionPrefix: 'contractor',
    requiredField: { body: 'fiscalYear', label: '대상 연도/공사기간' },
    fields: [
      { body: 'fiscalYear', column: 'fiscal_year' },
      { body: 'projectName', column: 'project_name' },
      { body: 'contractAmount', column: 'contract_amount' },
      { body: 'plannedAmount', column: 'planned_amount' },
      { body: 'status', column: 'status' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  // ---- 집행 내역 ----
  router.use('/budget-items', createSimpleCrudRoutes(db, {
    domainType: 'budgetitem',
    table: 'safety_budget_items',
    permissionPrefix: 'contractor',
    requiredField: { body: 'content', label: '집행 내용' },
    fields: [
      { body: 'budgetId', column: 'budget_id' },
      { body: 'spendDate', column: 'spend_date' },
      { body: 'category', column: 'category' },
      { body: 'content', column: 'content' },
      { body: 'amount', column: 'amount' },
      { body: 'vendor', column: 'vendor' },
      { body: 'evidenceNo', column: 'evidence_no' },
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  // 계상액 대비 집행 현황 — 도급관리에서 실제로 궁금한 건 "얼마나 썼는가"입니다.
  router.get('/budgets/:id/summary', authenticate, requirePermission(db, 'contractor.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const budget = db.prepare(`SELECT * FROM safety_budgets WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!budget) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const items = db.prepare('SELECT * FROM safety_budget_items WHERE budget_id = ? AND deleted = 0 ORDER BY spend_date').all(req.params.id);

    // 숫자로 읽히는 금액만 합산합니다. 읽지 못한 건수를 함께 알려줘서, 사용자가
    // 합계를 그대로 신뢰하지 않고 확인할 수 있게 합니다.
    let spent = 0, unreadable = 0;
    items.forEach((it) => {
      const n = parseAmount(it.amount);
      if (n === null) unreadable += 1; else spent += n;
    });
    const planned = parseAmount(budget.planned_amount);

    const byCategory = {};
    items.forEach((it) => {
      const k = it.category || '미분류';
      const n = parseAmount(it.amount);
      byCategory[k] = (byCategory[k] || 0) + (n || 0);
    });

    res.json({
      budget,
      itemCount: items.length,
      spentSum: spent,
      plannedAmount: planned,
      executionRate: planned && planned > 0 ? Math.round((spent / planned) * 1000) / 10 : null,
      byCategory,
      unreadableAmountCount: unreadable,
      note: unreadable > 0
        ? `금액을 숫자로 읽지 못한 항목이 ${unreadable}건 있어 합계에서 빠졌습니다. 해당 항목의 금액 표기를 확인해 주세요.`
        : '집행 금액을 모두 합산했습니다. 감독 제출용으로 쓰실 때는 증빙과 대조해 확인해 주세요.',
      items,
    });
  });

  // ---- 수급업체 안전보건 평가 이력 ----
  router.post('/evaluations', (req, res, next) => {
    if (req.body && !req.body.status) req.body.status = '평가완료';
    next();
  });

  router.use('/evaluations', createSimpleCrudRoutes(db, {
    domainType: 'ctreval',
    table: 'contractor_evaluations',
    permissionPrefix: 'contractor',
    requiredField: { body: 'relatedContractor', label: '평가 대상 업체' },
    fields: [
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'evalDate', column: 'eval_date' },
      { body: 'period', column: 'period' },
      { body: 'evaluator', column: 'evaluator' },
      { body: 'grade', column: 'grade' },
      { body: 'strength', column: 'strength' },
      { body: 'weakness', column: 'weakness' },
      { body: 'improvement', column: 'improvement' },
      { body: 'followupDate', column: 'followup_date' },
      { body: 'status', column: 'status' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
