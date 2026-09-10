const { createSimpleCrudRoutes } = require('./simple-crud-factory');

module.exports = function legalmeetRoutes(db) {
  return createSimpleCrudRoutes(db, {
    domainType: 'legalmeet',
    table: 'legal_meetings',
    permissionPrefix: 'legalmeet',
    requiredField: { body: 'content', label: '주요내용' },
    fields: [
      { body: 'date', column: 'meeting_date' },
      { body: 'time', column: 'meeting_time' },
      { body: 'location', column: 'location' },
      { body: 'kind', column: 'kind' },
      { body: 'attendees', column: 'attendees' },
      { body: 'content', column: 'content' },
      { body: 'finding', column: 'finding' },
      { body: 'measure', column: 'measure' },
      { body: 'nextDate', column: 'next_date' },
      { body: 'manager', column: 'manager' },
      { body: 'memo', column: 'memo' },
      { body: 'relatedContractor', column: 'related_contractor' },
    ],
  });
};
