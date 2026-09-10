const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function healthRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'health',
    table: 'health_records',
    permissionPrefix: 'health',
    requiredField: { body: 'name', label: '성명' },
    fields: [
      { body: 'name', column: 'worker_name' },
      { body: 'type', column: 'exam_type' },
      { body: 'date', column: 'exam_date' },
      { body: 'nextDate', column: 'next_date' },
      { body: 'result', column: 'result' },
    ],
  });
};
