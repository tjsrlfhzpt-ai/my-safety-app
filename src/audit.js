const { generateId } = require('./ids');

function writeAudit(db, { actorUserId, actorName, action, entityType, entityId, before, after, ip }) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_name, action, entity_type, entity_id, before_json, after_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId('AUD'),
    actorUserId || null,
    actorName || null,
    action,
    entityType,
    entityId || null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    ip || null
  );
}

module.exports = { writeAudit };
