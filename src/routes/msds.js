const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function msdsRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'msds',
    table: 'msds_items',
    permissionPrefix: 'msds',
    requiredField: { body: 'name', label: '물질명' },
    fields: [
      { body: 'name', column: 'name' },
      { body: 'cas', column: 'cas_no' },
      { body: 'maker', column: 'maker' },
      { body: 'grade', column: 'hazard_grade' },
      { body: 'location', column: 'location' },
      { body: 'dept', column: 'department' },
      { body: 'memo', column: 'memo' },
    ],
  });
};
