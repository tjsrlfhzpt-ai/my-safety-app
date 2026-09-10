const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function tbmRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'tbm',
    table: 'tbm_records',
    permissionPrefix: 'tbm',
    requiredField: { body: 'topic', label: '오늘의 작업내용/TBM 주제' },
    fields: [
      { body: 'date', column: 'tbm_date' },
      { body: 'time', column: 'tbm_time' },
      { body: 'location', column: 'location' },
      { body: 'topic', column: 'topic' },
      { body: 'hazard', column: 'hazard' },
      { body: 'level', column: 'risk_level' },
      { body: 'measure', column: 'measure' },
      { body: 'health', column: 'health_note' },
      { body: 'notice', column: 'notice' },
      { body: 'supervisor', column: 'supervisor' },
      { body: 'relatedContractor', column: 'related_contractor' },
      // 2026-08-30(전자서명 서버 연동): 참석자 명단(이름+서명여부) JSON 문자열을 그대로
      // 저장한다. 서명 이미지 자체는 이 필드가 아니라 /attachments API로 별도 업로드된다.
      { body: 'attendees', column: 'attendees' },
    ],
  });
};
