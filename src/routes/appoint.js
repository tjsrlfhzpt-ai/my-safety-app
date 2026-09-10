const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function appointRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'appoint',
    table: 'legal_appointments',
    permissionPrefix: 'appoint',
    requiredField: [
      { body: 'name', label: '선임자 성명' },
      { body: 'role', label: '직책' },
    ],
    fields: [
      { body: 'role', column: 'role' },
      { body: 'name', column: 'person_name' },
      { body: 'appointDate', column: 'appoint_date' },
      { body: 'nextEduDate', column: 'next_edu_date' },
      { body: 'certNumber', column: 'cert_number' },
      { body: 'memo', column: 'memo' },
    ],
  });
};
