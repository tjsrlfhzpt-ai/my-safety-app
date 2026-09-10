const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { nextDomainId } = require('../ids');

// 2026-09-02(마스터 프롬프트 6·44절): 직무스트레스 평가.
//
// ⚠️ 이 모듈은 개인의 정신건강에 관한 정보를 다루므로, 다른 모듈과 원칙을 다르게 잡았습니다.
//
//  (1) 기본 단위가 "집단"입니다. 목적이 "누가 스트레스를 받는지 찾아내는 것"이 아니라
//      "어떤 작업환경이 스트레스를 유발하는지 찾아 고치는 것"이기 때문입니다.
//      고위험군은 인원수(집계)만 다루고 명단은 저장하지 않습니다.
//
//  (2) 응답 인원이 너무 적으면 집단 결과라도 개인이 특정될 수 있습니다. 3명 이하 집단은
//      경고를 함께 돌려주어, 관리자가 결과를 그대로 공유하지 않도록 알립니다.
//
//  (3) 상담 기록은 익명이 기본입니다. 상담받았다는 사실 자체가 노출되면 근로자가 상담을
//      기피하게 되기 때문입니다.
//
//  (4) 점수 계산·판정은 하지 않습니다. KOSS 등 도구마다 문항과 환산이 다르고, 정신건강
//      판정을 자동화하는 것은 위험합니다(44절). 평가기관 통보값을 입력받습니다.
const SMALL_GROUP_THRESHOLD = 3;

module.exports = function stressRoutes(db) {
  const router = express.Router();

  router.post('/assessments', (req, res, next) => {
    if (req.body) {
      // 고위험군이 있는데 개선 대책이 없으면 '평가완료'로 끝내지 못하게 합니다.
      // 평가만 하고 넘어가면 평가할 이유가 없습니다.
      const hasHighRisk = Number(req.body.highRiskCount) > 0;
      if (!req.body.status || (hasHighRisk && !req.body.improvement)) {
        req.body.status = hasHighRisk ? '개선필요' : '평가완료';
      }
    }
    next();
  });

  router.use('/assessments', createSimpleCrudRoutes(db, {
    domainType: 'stress',
    table: 'stress_assessments',
    permissionPrefix: 'stress',
    requiredField: { body: 'targetGroup', label: '평가 대상 집단' },
    fields: [
      { body: 'processId', column: 'process_id' },
      { body: 'assessDate', column: 'assess_date' },
      { body: 'roundNo', column: 'round_no' },
      { body: 'targetGroup', column: 'target_group' },
      { body: 'targetCount', column: 'target_count' },
      { body: 'respondCount', column: 'respond_count' },
      { body: 'method', column: 'method' },
      { body: 'highRiskCount', column: 'high_risk_count' },
      { body: 'mainFactor', column: 'main_factor' },
      { body: 'finding', column: 'finding' },
      { body: 'improvement', column: 'improvement' },
      { body: 'nextAssessDate', column: 'next_assess_date' },
      { body: 'agency', column: 'agency' },
      { body: 'status', column: 'status' },
      { body: 'memo', column: 'memo' },
    ],
    afterCreate: ({ db, id, siteId, userId, body }) => {
      const extra = {};

      // 응답 인원이 너무 적으면 집단 결과로도 개인이 특정될 수 있습니다.
      // 막지는 않되(작은 사업장은 어쩔 수 없으므로) 반드시 알려줍니다.
      const respond = Number(body.respondCount);
      if (respond > 0 && respond <= SMALL_GROUP_THRESHOLD) {
        extra.privacyWarning = `응답 인원이 ${respond}명으로 적어 결과에서 개인이 특정될 수 있습니다. 이 결과를 집단에 공유할 때 각별히 주의하시고, 가능하면 더 큰 단위로 묶어 평가하세요.`;
      }

      // 고위험군이 있으면 개선조치를 자동으로 엽니다(마스터 프롬프트 21절).
      // 다만 CAPA 내용에는 개인을 특정할 수 있는 정보를 넣지 않습니다.
      if (Number(body.highRiskCount) > 0) {
        const capaId = nextDomainId(db, 'capa');
        db.prepare(`
          INSERT INTO capa_actions (id, site_id, source_type, source_id, title, description, created_by)
          VALUES (?, ?, 'stress', ?, ?, ?, ?)
        `).run(
          capaId, siteId, id,
          `[자동생성] 직무스트레스 개선 - ${body.targetGroup || ''}`,
          `${body.mainFactor ? '주요 요인: ' + body.mainFactor + '. ' : ''}작업량·자율성·인간관계 등 조직 차원의 개선 방안을 검토하고, 대상자에게는 상담을 안내하세요.`,
          userId
        );
        extra.autoCapaId = capaId;
      }
      return extra;
    },
  }));

  // ---- 개인 상담 기록 (익명이 기본) ----
  router.post('/counselings', (req, res, next) => {
    if (req.body) {
      if (!req.body.status) req.body.status = '상담완료';
      // 실명 여부를 명시하지 않으면 익명으로 간주합니다(안전한 쪽이 기본값).
      if (req.body.isAnonymous === undefined || req.body.isAnonymous === null) {
        req.body.isAnonymous = 1;
      }
    }
    next();
  });

  router.use('/counselings', createSimpleCrudRoutes(db, {
    domainType: 'stresscns',
    table: 'stress_counselings',
    permissionPrefix: 'stress',
    requiredField: { body: 'subjectCode', label: '대상자 코드' },
    fields: [
      { body: 'assessmentId', column: 'assessment_id' },
      { body: 'subjectCode', column: 'subject_code' },
      { body: 'isAnonymous', column: 'is_anonymous' },
      { body: 'counselDate', column: 'counsel_date' },
      { body: 'counselor', column: 'counselor' },
      { body: 'actionTaken', column: 'action_taken' },
      { body: 'followupDate', column: 'followup_date' },
      { body: 'status', column: 'status' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
