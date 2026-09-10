const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { nextDomainId } = require('../ids');

// 2026-09-02(마스터 프롬프트 6·29절, 스마플 보유 기능): 작업환경측정.
//
// 산업안전보건법은 소음·분진·유기용제 등 유해인자를 취급하는 사업장에 대해 정기적으로
// 작업환경을 측정하도록 정하고 있습니다. 건강진단이 "사람"을 보는 것이라면 이건
// "장소·공정"을 봅니다.
//
// 이 모듈에서 가장 중요한 것은 "노출기준을 넘었을 때 그냥 기록만 남고 끝나지 않게"
// 하는 것입니다. 측정만 하고 개선하지 않으면 측정할 이유가 없기 때문입니다.
// 그래서 기준 초과로 표시하면 상태를 자동으로 '개선필요'로 바꿔, 개선 조치를 입력하기
// 전까지는 완료로 넘어가지 않게 했습니다.
//
// 노출기준(TWA/STEL) 값 자체는 물질마다 다르고 고시 개정으로 바뀌므로 코드에 넣지
// 않았습니다(마스터 프롬프트 83절). 측정기관이 통보한 값을 그대로 입력받습니다.
module.exports = function workenvRoutes(db) {
  const router = express.Router();

  router.post('/', (req, res, next) => {
    if (req.body) {
      if (req.body.exceeded === undefined || req.body.exceeded === null) req.body.exceeded = 0;
      // 기준을 넘었다고 표시하면 '측정완료'로 끝내지 못하게 합니다.
      // 사용자가 status를 직접 보냈더라도, 초과인데 개선 내용이 없으면 '개선필요'로 둡니다.
      if (!req.body.status || (Number(req.body.exceeded) === 1 && !req.body.improvement)) {
        req.body.status = Number(req.body.exceeded) === 1 ? '개선필요' : '측정완료';
      }
    }
    next();
  });

  router.use(createSimpleCrudRoutes(db, {
    domainType: 'workenv',
    table: 'work_env_measurements',
    permissionPrefix: 'workenv',
    requiredField: [
      { body: 'location', label: '측정 지점' },
      { body: 'factorName', label: '유해인자명' },
    ],
    fields: [
      { body: 'processId', column: 'process_id' },
      { body: 'measureDate', column: 'measure_date' },
      { body: 'roundNo', column: 'round_no' },
      { body: 'location', column: 'location' },
      { body: 'factorType', column: 'factor_type' },
      { body: 'factorName', column: 'factor_name' },
      { body: 'resultValue', column: 'result_value' },
      { body: 'unit', column: 'unit' },
      { body: 'exposureLimit', column: 'exposure_limit' },
      { body: 'exceeded', column: 'exceeded' },
      { body: 'workerCount', column: 'worker_count' },
      { body: 'agency', column: 'agency' },
      { body: 'improvement', column: 'improvement' },
      { body: 'nextMeasureDate', column: 'next_measure_date' },
      { body: 'status', column: 'status' },
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'memo', column: 'memo' },
    ],
    // 노출기준을 넘었으면 개선조치(CAPA)를 자동으로 엽니다(마스터 프롬프트 21절:
    // 여러 곳에서 발견된 개선사항을 하나의 시정조치 체계로 연결). 측정만 하고 넘어가면
    // 측정할 이유가 없기 때문에, 담당자가 잊지 않도록 시스템이 걸어둡니다.
    afterCreate: ({ db, id, siteId, userId, body }) => {
      if (Number(body.exceeded) !== 1) return {};
      const capaId = nextDomainId(db, 'capa');
      db.prepare(`
        INSERT INTO capa_actions (id, site_id, source_type, source_id, title, description, created_by)
        VALUES (?, ?, 'workenv', ?, ?, ?, ?)
      `).run(
        capaId, siteId, id,
        `[자동생성] 작업환경 노출기준 초과 - ${body.factorName || ''} (${body.location || ''})`,
        `측정값 ${body.resultValue || ''}${body.unit || ''} / 노출기준 ${body.exposureLimit || ''}. 개선 대책을 수립하고 재측정 계획을 세우세요.`,
        userId
      );
      return { autoCapaId: capaId };
    },
  }));

  return router;
};
