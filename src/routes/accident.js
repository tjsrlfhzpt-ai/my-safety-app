const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { nextDomainId } = require('../ids');
const { writeAudit } = require('../audit');

module.exports = function accidentRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'accident',
    table: 'incidents',
    permissionPrefix: 'accident',
    requiredField: { body: 'description', label: '사고경위' },
    fields: [
      { body: 'date', column: 'occurred_date' },
      { body: 'time', column: 'occurred_time' },
      { body: 'location', column: 'location' },
      { body: 'victimName', column: 'victim_name' },
      { body: 'injuryType', column: 'injury_type' },
      { body: 'bodyPart', column: 'body_part' },
      { body: 'severity', column: 'severity' },
      { body: 'lostDays', column: 'lost_days' },
      { body: 'description', column: 'description' },
      { body: 'rootCause', column: 'root_cause' },
      { body: 'correctiveAction', column: 'corrective_plan' },
      { body: 'reportStatus', column: 'report_status' },
      { body: 'relatedContractor', column: 'related_contractor' },
      { body: 'memo', column: 'memo' },
    ],
    // 2026-08-28 후속조치(출시전 점검보고서 3절): 산업재해는 산업안전보건법상 원인조사·
    // 재발방지대책 수립이 사실상 의무이므로, 위험성평가처럼 "고위험일 때만"이 아니라
    // 신고 즉시 CAPA를 자동생성한다.
    afterCreate: ({ db, id, siteId, userId, userName, body }) => {
      const capaId = nextDomainId(db, 'capa');
      const summary = (body.description || '').slice(0, 40);
      db.prepare(`
        INSERT INTO capa_actions (id, site_id, source_type, source_id, title, status, created_by)
        VALUES (?, ?, 'incident', ?, ?, '등록', ?)
      `).run(capaId, siteId, id, `[자동생성] 사고 원인조사 및 재발방지대책 - ${summary}`, userId);

      writeAudit(db, {
        actorUserId: userId, actorName: userName, action: 'create',
        entityType: 'capa_action', entityId: capaId,
        after: { sourceType: 'incident', sourceId: id },
      });

      return { autoCapaId: capaId };
    },
  });
};
