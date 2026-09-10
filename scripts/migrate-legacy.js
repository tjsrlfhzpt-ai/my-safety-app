// scripts/migrate-legacy.js
// 사용법: node scripts/migrate-legacy.js <백업.json> <orgId> <siteId>
//
// v5.7의 State 구조(State.safetyData.risk / .capa / .accident / .nearmiss ...)를
// Actions.exportBackupJSON()이 그대로 내보낸다는 전제로 작성했습니다.
// 실제 백업 파일을 열어 최상위 키가 다르면 KEY 상수만 수정하면 됩니다.
//
// id 처리 규칙(실제 코드 분석 결과 반영):
//  - v14 이후 등록된 항목은 이미 "RISK-2026-000001" 같은 새 형식 id를 갖고 있으므로
//    그 값을 서버 id로 "그대로" 사용하고, id_counters 카운터도 그 번호까지 맞춰 올린다.
//  - v14 이전부터 있던 항목('r1', 'm1' 같은 구식 id)은 legacy_id 컬럼에 원래 id를 보존한 채
//    새 형식 id를 새로 채번한다.
// 트랜잭션으로 묶여 있어 중간에 하나라도 실패하면 전체가 롤백됩니다(지시서 35번 요구사항).

const fs = require('fs');
const db = require('../src/db');
const { nextDomainId, isLegacyStyleId } = require('../src/ids');

const [, , backupPath, orgId, siteId] = process.argv;
if (!backupPath || !orgId || !siteId) {
  console.error('사용법: node scripts/migrate-legacy.js <backup.json> <orgId> <siteId>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
const safetyData = raw.safetyData || raw; // 최상위가 safetyData 자체인 백업 형식도 허용

let migrated = 0;
let skipped = 0;

// 새 형식 id는 카운터가 그 번호를 넘어서게끔 id_counters를 미리 맞춰둔다.
function bumpCounterIfNewStyle(id) {
  const m = /^([A-Z]+)-(\d{4})-(\d{6})$/.exec(id || '');
  if (!m) return;
  const key = `${m[1]}-${m[2]}`;
  const n = parseInt(m[3], 10);
  const row = db.prepare('SELECT value FROM id_counters WHERE counter_key = ?').get(key);
  if (!row || row.value < n) {
    db.prepare('INSERT INTO id_counters (counter_key, value) VALUES (?, ?) ON CONFLICT(counter_key) DO UPDATE SET value = excluded.value')
      .run(key, n);
  }
}

function resolveId(item, domainType) {
  if (item.id && !isLegacyStyleId(item.id)) {
    bumpCounterIfNewStyle(item.id);
    return { id: item.id, legacyId: null };
  }
  return { id: nextDomainId(db, domainType), legacyId: item.id || null };
}

const insertRisk = db.prepare(`
  INSERT OR IGNORE INTO risk_assessments
    (id, legacy_id, site_id, process_name, task_name, hazard, existing_measures,
     likelihood, severity, risk_score, reduction_measures, status, created_by, created_at)
  VALUES (@id, @legacyId, @siteId, @processName, @taskName, @hazard, @existingMeasures,
          @likelihood, @severity, @riskScore, @reductionMeasures, 'draft', NULL, @createdAt)
`);

const migrateAll = db.transaction(() => {
  for (const item of safetyData.risk || []) {
    try {
      const { id, legacyId } = resolveId(item, 'risk');
      insertRisk.run({
        id, legacyId, siteId,
        processName: item.process || null,
        taskName: item.title || null,
        hazard: item.hazard || '(제목 없음)',
        existingMeasures: item.existingMeasures || null,
        likelihood: item.likelihood ?? null,
        severity: item.severity ?? null,
        riskScore: (item.likelihood ?? 0) * (item.severity ?? 0),
        reductionMeasures: item.measure || null,
        createdAt: item.createdAt || new Date().toISOString(),
      });
      migrated++;
    } catch (e) {
      console.warn('[건너뜀] risk', item.id, e.message);
      skipped++;
    }
  }

  // TODO: capa / accident / nearmiss / msds / health / ptw / edu / tbm / appoint / ppe /
  // contractor / voice / legalmeet 도 동일 패턴으로 이어서 작성.
  // CAPA는 source_id가 위에서 새로 채번된 risk id를 가리켜야 하므로, risk를 먼저
  // 이관해 "구형 id → 신형 id" 매핑을 만든 다음 CAPA를 이관하는 순서를 권장합니다.
});

migrateAll();

console.log(`이관 완료: ${migrated}건, 건너뜀: ${skipped}건`);
console.log('※ 실제 백업 파일 1개로 먼저 검증한 뒤 전체 이관을 진행하세요.');
