const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function voiceRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'voice',
    table: 'voice_reports',
    permissionPrefix: 'voice',
    requiredField: { body: 'content', label: '신고(의견) 내용' },
    fields: [
      { body: 'date', column: 'report_date' },
      { body: 'time', column: 'report_time' },
      { body: 'location', column: 'location' },
      { body: 'category', column: 'category' },
      { body: 'content', column: 'content' },
      { body: 'reporterType', column: 'reporter_type' },
      { body: 'reporterName', column: 'reporter_name' },
      { body: 'action', column: 'action_taken' },
      { body: 'memo', column: 'memo' },
    ],
  });
};
