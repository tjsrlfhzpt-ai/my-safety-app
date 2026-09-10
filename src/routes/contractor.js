const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { authenticate, requirePermission, accessibleSiteIds } = require('../auth-middleware');

module.exports = function contractorRoutes(db) {
  const router = express.Router();

  // 2026-09-02(마스터 프롬프트 45-4·33절): 협력업체별 안전성과.
  //
  // 협력업체를 실제로 연결해둔 덕분에 이제 "이 업체에서 무슨 일이 있었는지"를 정확히
  // 셀 수 있습니다. 예전에는 업체명이 자유입력이라 "(주)한국기계"와 "한국기계"가 따로
  // 세어져 집계 자체가 믿을 수 없었습니다.
  //
  // ⚠️ 여기서 점수를 매기거나 등급을 자동으로 부여하지는 않습니다. 안전성과를 몇 점으로
  // 환산하는 기준은 회사마다 다르고, 잘못된 점수는 업체에 부당한 불이익을 줄 수 있기
  // 때문입니다(마스터 프롬프트 20·44절: 중요한 판단을 시스템이 단독으로 확정하지 말 것).
  // 시스템은 사실(건수)만 정확히 보여주고, 평가는 사람이 합니다.
  router.get('/:id/performance', authenticate, requirePermission(db, 'contractor.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');

    const contractor = db.prepare(
      `SELECT * FROM contractors WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`
    ).get(req.params.id, ...siteIds);
    if (!contractor) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    // 연결된 기록만 셉니다. 이름만 적혀 아직 연결되지 않은 건은 세지 않습니다 -
    // 추측으로 엮은 숫자를 성과지표에 넣으면 그 자체가 부정확한 판단 근거가 됩니다.
    const countIn = (table) => db.prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE contractor_id = ? AND deleted = 0`
    ).get(req.params.id).c;

    const stats = {
      위험성평가: countIn('risk_assessments'),
      산업재해: countIn('incidents'),
      아차사고: countIn('near_misses'),
      TBM: countIn('tbm_records'),
      법정회의점검: countIn('legal_meetings'),
      안전교육: countIn('training_records'),
      작업허가: countIn('permits'),
      LOTO: countIn('loto_permits'),
      기계기구: countIn('equipment'),
    };

    // 이름만 적히고 아직 연결되지 않은 기록이 얼마나 되는지도 함께 알려줍니다.
    // 이 숫자가 크면 "집계가 실제보다 적게 잡히고 있다"는 뜻이라, 관리자가 정리해야 합니다.
    const unlinked = db.prepare(
      `SELECT COUNT(*) c FROM near_misses WHERE contractor_id IS NULL AND related_contractor IS NOT NULL
       AND related_contractor != '' AND site_id IN (${sitePh}) AND deleted = 0`
    ).get(...siteIds).c;

    res.json({
      contractor: {
        id: contractor.id, companyName: contractor.company_name, repName: contractor.rep_name,
        workType: contractor.work_type, contractEnd: contractor.contract_end,
        safetyEduDate: contractor.safety_edu_date, evaluation: contractor.evaluation,
      },
      stats,
      totalRecords: Object.values(stats).reduce((a, b) => a + b, 0),
      note: '연결이 확인된 기록만 집계한 값입니다. 업체명이 텍스트로만 적힌 기록은 포함되지 않습니다.',
      unlinkedNearmissCount: unlinked,
    });
  });

  router.use(createSimpleCrudRoutes(db, {
    domainType: 'contractor',
    table: 'contractors',
    permissionPrefix: 'contractor',
    requiredField: [
      { body: 'companyName', label: '업체명' },
      { body: 'repName', label: '담당자명' },
    ],
    fields: [
      { body: 'companyName', column: 'company_name' },
      { body: 'repName', column: 'rep_name' },
      { body: 'phone', column: 'phone' },
      { body: 'workType', column: 'work_type' },
      { body: 'contractStart', column: 'contract_start' },
      { body: 'contractEnd', column: 'contract_end' },
      { body: 'insuranceStatus', column: 'insurance_status' },
      { body: 'safetyEduDate', column: 'safety_edu_date' },
      { body: 'evaluation', column: 'evaluation' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
