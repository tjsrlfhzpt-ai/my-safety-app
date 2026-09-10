const express = require('express');
const { resolveIdForSite } = require('../ids');
const { writeAudit } = require('../audit');
const { authenticate, requirePermission, requireHomeSite, resolveTargetSiteId, accessibleSiteIds } = require('../auth-middleware');
const { queryPaginatedList } = require('../pagination');
const { resolveContractorLink } = require('../contractor-link');

// 위험성평가처럼 특별한 부가로직(고위험 시 CAPA 자동생성 등)이 있는 모듈은 이 팩토리를
// 쓰지 않고 risk.js/capa.js처럼 직접 작성합니다. 이 팩토리는 "생성 + 목록조회 + 소프트삭제"만
// 필요한 아차사고/TBM/소리함/법정회의점검 같은 모듈을 위한 것입니다 - 네 곳에 똑같은
// 코드를 복붙하는 대신 설정(config)만 다르게 주입합니다.
//
// config:
//   domainType: IdGenerator 접두어 키 (예: 'nearmiss') - src/ids.js의 DOMAIN_PREFIX와 일치해야 함
//   table: 테이블명
//   permissionPrefix: 권한 코드 접두어 (예: 'nearmiss' → nearmiss.create/read/delete_any)
//   requiredField: { body, label } 또는 [{ body, label }, ...] - 없으면 400을 내는 필수 필드(camelCase 기준).
//     2026-08-28 점검(출시전 점검보고서 3절): appoint.js/contractor.js가 이 필드를 하나만
//     선언해뒀는데 실제 스키마의 NOT NULL 컬럼은 2개라, 두 번째 값이 비면 400 대신 알 수 없는
//     500이 났다(DB 제약 위반이 그대로 노출). 배열도 받을 수 있게 확장해서 고쳤다.
//   fields: [{ body: 'content', column: 'content' }, ...] insert에 포함할 필드 매핑
function createSimpleCrudRoutes(db, config) {
  const router = express.Router();
  router.use(authenticate);

  const requiredFields = Array.isArray(config.requiredField)
    ? config.requiredField
    : (config.requiredField ? [config.requiredField] : []);

  const insertCols = ['id', 'site_id', ...config.fields.map(f => f.column), 'created_by'];
  const placeholders = insertCols.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${config.table} (${insertCols.join(', ')}) VALUES (${placeholders})`;

  router.post('/', requirePermission(db, `${config.permissionPrefix}.create`), requireHomeSite, (req, res) => {
    const b = req.body || {};
    for (const rf of requiredFields) {
      if (!b[rf.body]) return res.status(400).json({ error: `${rf.label}은(는) 필수입니다.` });
    }

    // v5.9에서 risk.js에 적용했던 것과 동일한 이유: SyncQueue 재시도로 같은 id가 두 번
    // 올 수 있으므로, 같은 사업장이 재시도한 것이면 에러 대신 성공(alreadyExisted)으로 응답해
    // 멱등하게 처리한다. 단, 2026-08-28 점검에서 이 확인이 site_id로 구분되지 않아 서로 다른
    // 사업장이 우연히 같은 id를 보내면 나중 사업장 데이터가 조용히 유실되는 것을 재현·확인했다
    // (출시전 점검보고서 2-2절). resolveIdForSite가 다른 사업장 소유 id는 재사용하지 않고
    // 새로 채번해 이 문제를 막는다.
    // 2026-09-02: 본문에 siteId가 오면 권한검증 후 그 사업장으로 등록한다(본사 관리자가
    // 여러 현장 데이터를 대신 입력할 수 있게 함). 권한 밖이면 resolveTargetSiteId가 403 응답.
    const targetSiteId = resolveTargetSiteId(db, req, res);
    if (targetSiteId === null) return;

    const { id, alreadyExisted, idReassigned } = resolveIdForSite(db, config.domainType, config.table, b.id, targetSiteId);
    if (alreadyExisted) return res.status(200).json({ id, alreadyExisted: true });

    // 2026-09-02(45-4절): 협력업체를 실제 업체와 연결합니다. 목록에서 골랐으면 그 id를,
    // 이름만 적었으면 같은 이름의 업체를 찾아 연결합니다. 원본 텍스트는 그대로 보존됩니다.
    let contractorId = null;
    if (config.fields.some((f) => f.column === 'related_contractor')) {
      const link = resolveContractorLink(db, accessibleSiteIds(db, req), b);
      if (link.error) return res.status(400).json({ error: link.error });
      contractorId = link.contractorId;
    }

    const values = [id, targetSiteId, ...config.fields.map(f => (b[f.body] !== undefined ? b[f.body] : null)), req.user.sub];
    db.prepare(insertSql).run(...values);

    if (contractorId) {
      db.prepare(`UPDATE ${config.table} SET contractor_id = ? WHERE id = ?`).run(contractorId, id);
    }

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: config.table, entityId: id, after: b, ip: req.ip,
    });

    // 2026-08-28 후속조치(출시전 점검보고서 3절 "CAPA 자동연계가 위험성평가에만 존재"):
    // 이 팩토리는 원래 "생성+조회+삭제"만 있는 단순 모듈용이라 특별한 부가로직을 넣지
    // 않는 게 설계 의도였지만(위 6~9행 주석), 사고(accident) 모듈만은 예외로 등록 즉시
    // CAPA를 자동생성해야 한다(산업안전보건법상 원인조사·재발방지대책 수립 의무 성격이라
    // 위험성평가처럼 "고위험일 때만"이 아니라 신고 즉시 필요). 이 경우에도 파일 전체를
    // risk.js처럼 새로 작성하지 않고, 훅 하나만 선택적으로 열어준다.
    let extra = {};
    if (typeof config.afterCreate === 'function') {
      extra = config.afterCreate({ db, id, siteId: targetSiteId, userId: req.user.sub, userName: req.user.name, body: b }) || {};
    }

    res.status(201).json({ id, ...(idReassigned ? { idReassigned: true } : {}), ...extra });
  });

  router.get('/', requirePermission(db, `${config.permissionPrefix}.read`), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    const { rows, total } = queryPaginatedList(db, config.table, siteIds, req.query);
    res.set('X-Total-Count', String(total));
    res.json(rows);
  });

  // 2026-08-28 후속조치(출시전 점검보고서 3절 "12개 모듈 PATCH API 부재" - 가장 체감 영향이
  // 크다고 판단해 최우선 처리): 등록 후 오타 하나 고치려 해도 delete_any(생성보다 높은 권한)로
  // 지우고 다시 만드는 것 외에 방법이 없었다. PATCH 본문에 실제로 들어온 필드만 부분수정한다.
  router.patch('/:id', requirePermission(db, `${config.permissionPrefix}.update`), (req, res) => {
    const b = req.body || {};
    const touched = config.fields.filter((f) => Object.prototype.hasOwnProperty.call(b, f.body));
    if (touched.length === 0) {
      return res.status(400).json({ error: '수정할 값이 없습니다.' });
    }
    // 생성 때와 동일한 필수값 규칙: 필수 필드를 건드리면서 빈 값으로 만드는 것은 막는다.
    for (const rf of requiredFields) {
      if (touched.some((f) => f.body === rf.body) && !b[rf.body]) {
        return res.status(400).json({ error: `${rf.label}은(는) 필수입니다.` });
      }
    }

    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const existing = db.prepare(`SELECT * FROM ${config.table} WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .get(req.params.id, ...siteIds);
    if (!existing) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const setClause = touched.map((f) => `${f.column} = ?`).join(', ');
    db.prepare(
      `UPDATE ${config.table} SET ${setClause}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`
    ).run(...touched.map((f) => b[f.body]), req.user.sub, req.params.id);

    // 협력업체를 바꿨다면 연결도 다시 계산합니다(텍스트만 바뀌고 연결이 옛 업체에
    // 남아있으면 집계가 어긋나기 때문입니다).
    if (touched.some((f) => f.column === 'related_contractor') || b.contractorId !== undefined) {
      const link = resolveContractorLink(db, siteIds, b);
      if (link.error) return res.status(400).json({ error: link.error });
      db.prepare(`UPDATE ${config.table} SET contractor_id = ? WHERE id = ?`).run(link.contractorId, req.params.id);
    }

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'update',
      entityType: config.table, entityId: req.params.id, before: existing, after: b,
    });

    res.json({ ok: true });
  });

  router.delete('/:id', requirePermission(db, `${config.permissionPrefix}.delete_any`), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const existing = db.prepare(`SELECT * FROM ${config.table} WHERE id = ? AND site_id IN (${sitePh})`)
      .get(req.params.id, ...siteIds);
    if (!existing) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    db.prepare(
      `UPDATE ${config.table} SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`
    ).run(req.user.sub, req.params.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'delete',
      entityType: config.table, entityId: req.params.id, before: existing,
    });

    res.json({ ok: true });
  });

  return router;
}

module.exports = { createSimpleCrudRoutes };
