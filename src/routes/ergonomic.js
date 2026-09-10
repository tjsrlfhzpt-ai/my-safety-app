const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { nextDomainId } = require('../ids');

// 2026-09-02(마스터 프롬프트 6·45-2절): 근골격계 유해요인 조사.
//
// 반복작업·중량물 취급·부적절한 자세가 많은 사업장은 근골격계 부담작업을 조사하고
// 개선해야 합니다. 제조업에서 가장 흔한 직업병 영역입니다.
//
// 두 갈래로 나눠 다룹니다:
//   /surveys  = 작업 단위 평가 ("이 작업이 얼마나 부담을 주는가")
//   /symptoms = 사람 단위 증상 ("누가 어디가 아픈가" — 개인 건강정보)
//
// 평가 기법(OWAS·RULA·REBA)의 점수 계산은 시스템이 하지 않습니다. 기법마다 산식이 다르고
// 잘못 계산하면 위험을 과소평가하게 되는데, 그건 이 도메인에서 가장 위험한 실패입니다
// (마스터 프롬프트 44절). 어떤 기법으로 평가했고 결과가 무엇이었는지를 입력받습니다.
module.exports = function ergonomicRoutes(db) {
  const router = express.Router();

  // ---- 작업 단위 조사 ----
  router.post('/surveys', (req, res, next) => {
    if (req.body) {
      // 위험도가 높게 나왔는데 개선 대책이 없으면 '조사완료'로 끝내지 못하게 합니다.
      // 작업환경측정과 같은 이유 - 조사만 하고 넘어가면 조사할 이유가 없습니다.
      const high = req.body.riskLevel === '높음';
      if (!req.body.status || (high && !req.body.improvement)) {
        req.body.status = high ? '개선필요' : '조사완료';
      }
    }
    next();
  });

  router.use('/surveys', createSimpleCrudRoutes(db, {
    domainType: 'ergo',
    table: 'ergonomic_surveys',
    permissionPrefix: 'ergonomic',
    requiredField: { body: 'taskName', label: '조사 대상 작업' },
    fields: [
      { body: 'processId', column: 'process_id' },
      { body: 'surveyDate', column: 'survey_date' },
      { body: 'roundNo', column: 'round_no' },
      { body: 'taskName', column: 'task_name' },
      { body: 'location', column: 'location' },
      { body: 'burdenType', column: 'burden_type' },
      { body: 'workerCount', column: 'worker_count' },
      { body: 'method', column: 'method' },
      { body: 'riskLevel', column: 'risk_level' },
      { body: 'finding', column: 'finding' },
      { body: 'improvement', column: 'improvement' },
      { body: 'nextSurveyDate', column: 'next_survey_date' },
      { body: 'status', column: 'status' },
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'memo', column: 'memo' },
    ],
    // 위험도가 높으면 개선조치를 자동으로 엽니다(마스터 프롬프트 21절).
    afterCreate: ({ db, id, siteId, userId, body }) => {
      if (body.riskLevel !== '높음') return {};
      const capaId = nextDomainId(db, 'capa');
      db.prepare(`
        INSERT INTO capa_actions (id, site_id, source_type, source_id, title, description, created_by)
        VALUES (?, ?, 'ergonomic', ?, ?, ?, ?)
      `).run(
        capaId, siteId, id,
        `[자동생성] 근골격계 부담작업 개선 - ${body.taskName || ''}`,
        `${body.burdenType ? body.burdenType + ' / ' : ''}${body.finding || '유해요인 확인됨'}. 작업 방법·설비·작업대 높이 등의 개선 방안을 검토하세요.`,
        userId
      );
      return { autoCapaId: capaId };
    },
  }));

  // ---- 증상 호소자 (개인 건강정보) ----
  // 건강진단과 마찬가지로 민감정보라, AI 비서의 전체 검색 대상에서도 제외됩니다.
  // 팩토리가 빈 값에 null을 넣기 때문에 DB의 DEFAULT가 적용되지 않습니다 - 다른 모듈과
  // 같은 이유로 기본값은 여기서 채웁니다.
  router.post('/symptoms', (req, res, next) => {
    if (req.body && !req.body.status) req.body.status = '접수';
    next();
  });

  router.use('/symptoms', createSimpleCrudRoutes(db, {
    domainType: 'ergosym',
    table: 'ergonomic_symptoms',
    permissionPrefix: 'ergonomic',
    requiredField: { body: 'workerName', label: '대상자 성명' },
    fields: [
      { body: 'surveyId', column: 'survey_id' },
      { body: 'workerName', column: 'worker_name' },
      { body: 'reportDate', column: 'report_date' },
      { body: 'bodyPart', column: 'body_part' },
      { body: 'symptomLevel', column: 'symptom_level' },
      { body: 'workRelated', column: 'work_related' },
      { body: 'actionTaken', column: 'action_taken' },
      { body: 'followupDate', column: 'followup_date' },
      { body: 'status', column: 'status' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
