const express = require('express');
const { authenticate, requirePermission, accessibleSiteIds } = require('../auth-middleware');

// 2026-09-05(마스터 프롬프트 14·32·33절, 경쟁사 "통합/사업장 대시보드" 대응): 서버측 집계.
//
// 지금까지 관제센터·웹은 25개 모듈의 목록을 전부 내려받아 브라우저에서 세는 방식이었습니다.
// 사업장이 1~2개, 데이터가 수십 건일 때는 문제가 없지만, 사업장 5개에 각 수천 건이 쌓이면
// 수만 건을 브라우저로 끌어와야 해서 화면이 멎습니다(마스터 프롬프트 14절 위반 소지).
//
// 집계는 DB가 훨씬 잘하는 일이므로 서버에서 COUNT로 처리합니다. 내려가는 것은 숫자
// 몇십 개뿐이라 데이터가 아무리 늘어도 응답 크기가 변하지 않습니다.
//
// 사업장별로 끊어서 돌려주는 이유: 여러 현장을 운영하는 회사가 "어느 현장이 문제인지"
// 비교할 수 있어야 하기 때문입니다. 합계만 주면 문제 현장이 평균에 묻힙니다.
const COUNT_TABLES = [
  ['risk', 'risk_assessments', '위험성평가'],
  ['capa', 'capa_actions', '개선조치'],
  ['ptw', 'permits', '작업허가'],
  ['accident', 'incidents', '산업재해'],
  ['nearmiss', 'near_misses', '아차사고'],
  ['tbm', 'tbm_records', 'TBM'],
  ['edu', 'training_records', '안전교육'],
  ['inspection', 'inspections', '안전점검'],
  ['legalmeet', 'legal_meetings', '법정회의점검'],
  ['equipment', 'equipment', '기계기구'],
  ['loto', 'loto_permits', 'LOTO'],
  ['workenv', 'work_env_measurements', '작업환경측정'],
  ['ergo', 'ergonomic_surveys', '근골격계조사'],
  ['stress', 'stress_assessments', '직무스트레스'],
  ['contractor', 'contractors', '협력업체'],
];

module.exports = function dashboardRoutes(db) {
  const router = express.Router();

  router.get('/', authenticate, requirePermission(db, 'risk.read'), (req, res) => {
    const siteIds = accessibleSiteIds(db, req);
    if (!siteIds.length) return res.json({ sites: [], totals: {} });

    const sitePh = siteIds.map(() => '?').join(',');
    const sites = db.prepare(`SELECT id, name FROM sites WHERE id IN (${sitePh}) AND deleted = 0 ORDER BY name`).all(...siteIds);
    const today = new Date().toISOString().slice(0, 10);

    // 사업장별 모듈 건수 — 테이블당 한 번의 GROUP BY로 끝냅니다(사업장 수만큼 쿼리하지 않음).
    const countsBySite = {};
    sites.forEach((s) => { countsBySite[s.id] = {}; });
    for (const [key, table] of COUNT_TABLES) {
      const rows = db.prepare(
        `SELECT site_id, COUNT(*) c FROM ${table} WHERE site_id IN (${sitePh}) AND deleted = 0 GROUP BY site_id`
      ).all(...siteIds);
      rows.forEach((r) => { if (countsBySite[r.site_id]) countsBySite[r.site_id][key] = r.c; });
    }

    // 주의가 필요한 지표 — 단순 건수보다 이게 관리자에게 훨씬 중요합니다.
    const alertQuery = (sql) => {
      const out = {};
      db.prepare(sql).all(...siteIds).forEach((r) => { out[r.site_id] = r.c; });
      return out;
    };

    const overdueCapa = alertQuery(
      `SELECT site_id, COUNT(*) c FROM capa_actions
       WHERE site_id IN (${sitePh}) AND deleted = 0 AND due_date IS NOT NULL AND due_date < '${today}'
         AND status NOT IN ('종결', '승인') GROUP BY site_id`
    );
    const highRisk = alertQuery(
      `SELECT site_id, COUNT(*) c FROM risk_assessments
       WHERE site_id IN (${sitePh}) AND deleted = 0 AND risk_score >= 15
         AND (status IS NULL OR status != '완료') GROUP BY site_id`
    );
    const inspectionNg = alertQuery(
      `SELECT site_id, COUNT(*) c FROM inspections
       WHERE site_id IN (${sitePh}) AND deleted = 0 AND status = '개선필요' GROUP BY site_id`
    );
    const overdueInspection = alertQuery(
      `SELECT site_id, COUNT(*) c FROM equipment
       WHERE site_id IN (${sitePh}) AND deleted = 0 AND next_inspection_date IS NOT NULL
         AND next_inspection_date < '${today}' GROUP BY site_id`
    );
    const accidents = alertQuery(
      `SELECT site_id, COUNT(*) c FROM incidents
       WHERE site_id IN (${sitePh}) AND deleted = 0 GROUP BY site_id`
    );

    const result = sites.map((s) => ({
      siteId: s.id,
      siteName: s.name,
      counts: countsBySite[s.id],
      alerts: {
        기한초과_개선조치: overdueCapa[s.id] || 0,
        미완료_고위험: highRisk[s.id] || 0,
        개선필요_점검: inspectionNg[s.id] || 0,
        검사기한_초과설비: overdueInspection[s.id] || 0,
        산업재해: accidents[s.id] || 0,
      },
    }));

    // 회사 전체 합계도 함께 — 경영진은 합계를, 현장소장은 자기 현장을 봅니다.
    const totals = { counts: {}, alerts: {} };
    result.forEach((r) => {
      Object.entries(r.counts).forEach(([k, v]) => { totals.counts[k] = (totals.counts[k] || 0) + v; });
      Object.entries(r.alerts).forEach(([k, v]) => { totals.alerts[k] = (totals.alerts[k] || 0) + v; });
    });

    res.json({
      asOf: today,
      moduleLabels: Object.fromEntries(COUNT_TABLES.map(([k, , label]) => [k, label])),
      sites: result,
      totals,
    });
  });

  return router;
};
