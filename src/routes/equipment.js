const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');

// 2026-09-02(경쟁사 격차 해소): 유해·위험 기계기구 안전검사 관리.
// 무사퇴근의 "기계/기구 관리", 스마플의 "안전검사"에 대응하는 모듈이며, 산업안전보건법상
// 프레스·크레인·리프트 등의 주기적 안전검사 의무를 관리하기 위한 것입니다.
//
// 기존 simple-crud-factory를 그대로 씁니다 - 이렇게 하면 다른 13개 모듈이 이미 갖고 있는
// 사업장 지정 등록, PATCH 수정, soft delete, 감사로그, 첨부파일 연동, ID 재채번이 전부
// 자동으로 따라옵니다(합격증명서 사진을 첨부하는 흐름이 바로 동작합니다).
//
// 검사 주기는 기계 종류·설치연도·사용조건에 따라 다르고 법령 개정으로 바뀌기도 하므로
// (마스터 프롬프트 83절: 법규를 코드에 하드코딩하지 말 것), 주기를 시스템이 계산하지 않고
// 사업장이 직접 입력한 "다음 검사일"을 기준으로 관리합니다.
module.exports = function equipmentRoutes(db) {
  const router = express.Router();

  // simple-crud-factory는 값이 없는 필드에 명시적으로 null을 넣기 때문에, DB에 DEFAULT를
  // 걸어둬도 적용되지 않습니다(실제로 NOT NULL 제약 위반 500 오류를 재현해 확인했습니다).
  // 그래서 기본값은 팩토리에 넘기기 전에 여기서 채웁니다. 안전검사 대상 여부는 대부분
  // "대상"이고, 새로 등록하는 기계는 대부분 "사용중"이라 그렇게 잡았습니다.
  router.post('/', (req, res, next) => {
    if (req.body) {
      if (req.body.inspectionRequired === undefined || req.body.inspectionRequired === null) {
        req.body.inspectionRequired = 1;
      }
      if (!req.body.status) req.body.status = '사용중';
    }
    next();
  });

  router.use(createSimpleCrudRoutes(db, {
    domainType: 'equipment',
    table: 'equipment',
    permissionPrefix: 'equipment',
    requiredField: [
      { body: 'name', label: '기계기구명' },
      { body: 'category', label: '종류' },
    ],
    fields: [
      { body: 'name', column: 'name' },
      { body: 'category', column: 'category' },
      { body: 'assetNo', column: 'asset_no' },
      { body: 'maker', column: 'maker' },
      { body: 'modelNo', column: 'model_no' },
      { body: 'location', column: 'location' },
      { body: 'processId', column: 'process_id' },
      { body: 'installDate', column: 'install_date' },
      { body: 'inspectionRequired', column: 'inspection_required' },
      { body: 'inspectionCycle', column: 'inspection_cycle' },
      { body: 'lastInspectionDate', column: 'last_inspection_date' },
      { body: 'nextInspectionDate', column: 'next_inspection_date' },
      { body: 'inspectionResult', column: 'inspection_result' },
      { body: 'inspectionAgency', column: 'inspection_agency' },
      { body: 'certNo', column: 'cert_no' },
      { body: 'operator', column: 'operator' },
      { body: 'status', column: 'status' },
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'memo', column: 'memo' },
    ],
  }));

  return router;
};
