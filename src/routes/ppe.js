const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function ppeRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'ppe',
    table: 'ppe_records',
    permissionPrefix: 'ppe',
    requiredField: { body: 'itemType', label: '보호구 종류' },
    fields: [
      { body: 'itemType', column: 'item_type' },
      { body: 'recipient', column: 'recipient' },
      { body: 'issueDate', column: 'issue_date' },
      { body: 'quantity', column: 'quantity' },
      { body: 'nextReplaceDate', column: 'next_replace_date' },
      { body: 'memo', column: 'memo' },
    ],
  });
};
