const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function nearmissRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'nearmiss',
    table: 'near_misses',
    permissionPrefix: 'nearmiss',
    requiredField: { body: 'content', label: '발생내용' },
    fields: [
      { body: 'title', column: 'title' },
      { body: 'content', column: 'content' },
      { body: 'occurredDate', column: 'occurred_date' },
      { body: 'location', column: 'location' },
      { body: 'cause', column: 'cause' },
      { body: 'measure', column: 'measure' },
      { body: 'manager', column: 'manager' },
      { body: 'dueDate', column: 'due_date' },
      { body: 'memo', column: 'memo' },
      { body: 'relatedContractor', column: 'related_contractor' },
    ],
  });
};
