const express = require('express');
const { createSimpleCrudRoutes } = require('./simple-crud-factory');
const { authenticate, requirePermission, accessibleSiteIds, resolveTargetSiteId } = require('../auth-middleware');
const { nextDomainId, resolveIdForSite } = require('../ids');
const { writeAudit } = require('../audit');

// 2026-09-05(중대재해처벌법 대응): 반기점검 / 안전보건수준 자가진단.
//
// 중대재해처벌법은 경영책임자가 안전보건 확보 의무 이행을 반기 1회 이상 점검하도록
// 정하고 있습니다. 이 모듈의 핵심은 "점검했다"는 기록이 아니라 회차 간 비교입니다 —
// 상반기에 미이행이던 항목이 하반기에 개선됐는지가 실제로 의미 있는 정보이기 때문입니다.
//
// 기존 법정 체크리스트(85개 법규 항목)를 다시 만들지 않습니다. 그 표의 현재 상태를
// 그대로 떠서 회차 기록으로 남깁니다 — 항목을 매번 다시 입력하게 하면 현장에서 안 씁니다.
module.exports = function complianceReviewRoutes(db) {
  const router = express.Router();

  // 반기점검 실시: 현재 법정 체크리스트 상태를 스냅샷으로 떠서 회차를 만듭니다.
  router.post('/', authenticate, requirePermission(db, 'compliance.update'), (req, res) => {
    const b = req.body || {};
    if (!b.reviewPeriod) return res.status(400).json({ error: '점검 대상 기간을 입력해 주세요. (예: 2026년 상반기)' });

    const targetSiteId = resolveTargetSiteId(db, req, res);
    if (targetSiteId === null) return;
    if (!targetSiteId) return res.status(400).json({ error: '점검할 사업장을 선택해 주세요.' });

    // 결과를 직접 보내면 그걸 쓰고, 아니면 현재 법정 체크리스트 상태를 그대로 뜹니다.
    const provided = Array.isArray(b.results) ? b.results : null;
    const rows = provided || db.prepare(
      'SELECT item_no, tag, title, checked, note FROM legal_checklist_items WHERE site_id = ? ORDER BY rowid'
    ).all(targetSiteId).map((r) => ({
      itemNo: String(r.item_no), tag: r.tag, itemTitle: r.title,
      result: r.checked ? '이행' : '미이행', note: r.note,
    }));

    if (!rows.length) {
      return res.status(400).json({
        error: '점검할 항목이 없습니다. 법정 체크리스트 화면을 한 번 열어 항목을 준비한 뒤 다시 시도해 주세요.',
      });
    }

    const { id, alreadyExisted, idReassigned } = resolveIdForSite(db, 'review', 'compliance_reviews', b.id, targetSiteId);
    if (alreadyExisted) return res.status(200).json({ id, alreadyExisted: true });

    const okCount = rows.filter((r) => r.result === '이행').length;
    const ngCount = rows.filter((r) => r.result === '미이행').length;
    // 해당없음을 뺀 실질 항목 기준으로 이행률을 냅니다(해당없음을 미이행처럼 세면 부당하게 낮아짐).
    const denom = okCount + ngCount;
    const rate = denom > 0 ? String(Math.round((okCount / denom) * 1000) / 10) : null;
    const status = ngCount > 0 && !b.improvement ? '개선필요' : (b.status || (ngCount > 0 ? '개선필요' : '점검완료'));

    let autoCapaId = null;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO compliance_reviews (id, site_id, review_period, review_date, reviewer, scope,
          total_count, ok_count, ng_count, compliance_rate, finding, improvement, next_review_date, status, memo, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, targetSiteId, b.reviewPeriod, b.reviewDate || null, b.reviewer || null, b.scope || null,
        rows.length, okCount, ngCount, rate, b.finding || null, b.improvement || null,
        b.nextReviewDate || null, status, b.memo || null, req.user.sub);

      const ins = db.prepare('INSERT INTO compliance_review_results (id, review_id, item_no, item_title, tag, result, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
      rows.forEach((r, i) => {
        // ⚠️ item_no를 반드시 문자열로 맞춥니다. 원본 체크리스트의 item_no는 숫자(1, 2, …)인데
        // 이 컬럼은 TEXT라, 숫자를 그대로 넣으면 "1.0"처럼 저장됩니다. 그러면 회차 간 비교에서
        // 같은 항목인데도 다른 항목으로 취급되어 "개선됐는지"를 알 수 없게 됩니다.
        // (실제로 이 문제를 재현해 확인했습니다)
        const itemNo = r.itemNo === undefined || r.itemNo === null ? null : String(r.itemNo);
        ins.run(`CRR-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          id, itemNo, r.itemTitle || '(항목 없음)', r.tag || null, r.result || null, r.note || null);
      });

      // 미이행이 있으면 개선조치를 자동으로 엽니다(마스터 프롬프트 21절).
      if (ngCount > 0) {
        autoCapaId = nextDomainId(db, 'capa');
        const ngList = rows.filter((r) => r.result === '미이행').slice(0, 10)
          .map((r) => `· ${r.itemTitle}`).join('\n');
        const more = ngCount > 10 ? `\n(외 ${ngCount - 10}건)` : '';
        db.prepare(`
          INSERT INTO capa_actions (id, site_id, source_type, source_id, title, description, created_by)
          VALUES (?, ?, 'review', ?, ?, ?, ?)
        `).run(autoCapaId, targetSiteId, id,
          `[자동생성] ${b.reviewPeriod} 반기점검 미이행 ${ngCount}건`,
          `아래 항목이 미이행으로 확인되었습니다.\n${ngList}${more}`, req.user.sub);
      }
    })();

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: 'compliance_review', entityId: id,
      after: { period: b.reviewPeriod, okCount, ngCount, rate }, ip: req.ip,
    });

    const out = { id, totalCount: rows.length, okCount, ngCount, complianceRate: rate, status };
    if (autoCapaId) out.autoCapaId = autoCapaId;
    if (idReassigned) out.idReassigned = true;
    res.status(201).json(out);
  });

  router.get('/', authenticate, requirePermission(db, 'compliance.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.json([]);
    const sitePh = siteIds.map(() => '?').join(',');
    res.json(db.prepare(`SELECT * FROM compliance_reviews WHERE site_id IN (${sitePh}) AND deleted = 0 ORDER BY created_at DESC`).all(...siteIds));
  });

  router.get('/:id/results', authenticate, requirePermission(db, 'compliance.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const review = db.prepare(`SELECT * FROM compliance_reviews WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(req.params.id, ...siteIds);
    if (!review) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    res.json({
      review,
      results: db.prepare('SELECT * FROM compliance_review_results WHERE review_id = ? AND deleted = 0 ORDER BY rowid').all(req.params.id),
    });
  });

  // 회차 간 비교 — 이 모듈의 존재 이유입니다.
  // "지난번에 미이행이던 것이 이번에 나아졌는가"를 항목 단위로 보여줍니다.
  router.get('/compare', authenticate, requirePermission(db, 'compliance.read'), (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: '비교할 두 회차(from, to)를 지정해 주세요.' });

    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const get = (id) => db.prepare(`SELECT * FROM compliance_reviews WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`).get(id, ...siteIds);
    const a = get(from), bRev = get(to);
    if (!a || !bRev) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const rowsOf = (id) => db.prepare('SELECT * FROM compliance_review_results WHERE review_id = ? AND deleted = 0').all(id);
    const aMap = {}; rowsOf(from).forEach((r) => { if (r.item_no) aMap[r.item_no] = r; });
    const bMap = {}; rowsOf(to).forEach((r) => { if (r.item_no) bMap[r.item_no] = r; });

    const improved = [], worsened = [], stillNg = [];
    Object.keys(bMap).forEach((no) => {
      const before = aMap[no], after = bMap[no];
      if (!before) return;
      if (before.result === '미이행' && after.result === '이행') improved.push({ itemNo: no, title: after.item_title });
      else if (before.result === '이행' && after.result === '미이행') worsened.push({ itemNo: no, title: after.item_title });
      else if (before.result === '미이행' && after.result === '미이행') stillNg.push({ itemNo: no, title: after.item_title });
    });

    res.json({
      from: { id: a.id, period: a.review_period, okCount: a.ok_count, ngCount: a.ng_count, rate: a.compliance_rate },
      to: { id: bRev.id, period: bRev.review_period, okCount: bRev.ok_count, ngCount: bRev.ng_count, rate: bRev.compliance_rate },
      improved, worsened, stillNg,
      note: stillNg.length
        ? `${stillNg.length}건은 지난 회차에도 미이행이었습니다. 반복 미이행 항목은 개선이 실제로 이뤄지지 않고 있다는 신호이므로 우선 확인하세요.`
        : '지난 회차의 미이행 항목이 모두 해소되었거나, 비교 가능한 반복 미이행 항목이 없습니다.',
    });
  });

  router.delete('/:id', authenticate, requirePermission(db, 'compliance.update'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    const sitePh = siteIds.map(() => '?').join(',');
    const r = db.prepare(`UPDATE compliance_reviews SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND site_id IN (${sitePh}) AND deleted = 0`)
      .run(req.user.sub, req.params.id, ...siteIds);
    if (!r.changes) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });
    res.json({ ok: true });
  });

  return router;
};
