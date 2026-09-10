const { generateId } = require('./ids');

// ============================================================================
// 2026-09-10: 테스트용 예시 데이터 (선택)
// ----------------------------------------------------------------------------
// 갓 배포한 서버는 모든 화면이 "데이터 없음"이라, 화면이 제대로 그려지는지조차
// 확인하기 어렵다. SEED_DEMO_DATA=true 를 켜면 마스터 관리자의 작업공간에
// 각 모듈별 예시를 두세 건씩 넣어준다.
//
// 안전장치:
//  (1) SEED_DEMO_DATA=true 일 때만 동작한다. 기본값은 꺼짐이다.
//  (2) 부트스트랩 관리자가 "이번 기동에서 새로 만들어졌을 때"만 동작한다.
//      즉 이미 쓰던 서버를 재기동해도 예시 데이터가 다시 끼어들지 않는다.
//  (3) 실패해도 서버는 정상 기동한다. 예시 데이터는 편의 기능일 뿐이다.
//
// ⚠️ 실제 근로자 데이터를 넣기 시작하면 이 환경변수를 꺼주세요. 예시와 실제가
//    섞이면 나중에 구분하기 어렵습니다. 예시 항목의 제목에는 모두 "[예시]"를
//    붙여두었습니다.
// ============================================================================

const TODAY = () => new Date().toISOString().slice(0, 10);
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function seedDemoData(db, { siteId, userId }) {
  if (String(process.env.SEED_DEMO_DATA || '').toLowerCase() !== 'true') {
    return { seeded: false, reason: 'disabled' };
  }

  const counts = {};
  const ins = (table, cols, values) => {
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    db.prepare(sql).run(...values);
    counts[table] = (counts[table] || 0) + 1;
  };

  const tx = db.transaction(() => {
    // ---- 아차사고 ----
    [
      ['[예시] 계단 손잡이 흔들림', '3층 계단 손잡이가 흔들려 작업자가 균형을 잃을 뻔했습니다.', daysAgo(3), '본관 3층 계단', '고정 볼트 풀림', '볼트 재체결 및 월 1회 점검 추가'],
      ['[예시] 지게차 후진 경보 미작동', '창고 지게차 후진 경보음이 울리지 않아 보행자가 놀랐습니다.', daysAgo(8), '자재창고', '경보 장치 배선 불량', '배선 교체 후 작동 확인'],
    ].forEach(([title, content, date, loc, cause, measure]) => {
      ins('near_misses',
        ['id', 'site_id', 'title', 'content', 'occurred_date', 'location', 'cause', 'measure', 'created_by'],
        [generateId('nearmiss'), siteId, title, content, date, loc, cause, measure, userId]);
    });

    // ---- TBM ----
    [
      [daysAgo(1), '07:30', '본관 앞 집결지', '[예시] 고소작업 안전대 착용 확인', '2m 이상 추락위험', '높음'],
      [TODAY(), '07:30', '본관 앞 집결지', '[예시] 우천 시 미끄럼 주의', '바닥 미끄러움', '보통'],
    ].forEach(([date, time, loc, topic, hazard, level]) => {
      ins('tbm_records',
        ['id', 'site_id', 'tbm_date', 'tbm_time', 'location', 'topic', 'hazard', 'risk_level', 'created_by'],
        [generateId('tbm'), siteId, date, time, loc, topic, hazard, level, userId]);
    });

    // ---- 안전보건교육 ----
    [
      ['[예시] 정기 안전보건교육 (3분기)', daysAgo(20), '전 직원', daysAgo(-70)],
      ['[예시] 신규 채용자 교육', daysAgo(5), '신규 입사자 2명', ''],
    ].forEach(([name, date, target, next]) => {
      ins('training_records',
        ['id', 'site_id', 'name', 'training_date', 'target_audience', 'next_training_date', 'created_by'],
        [generateId('edu'), siteId, name, date, target, next || null, userId]);
    });

    // ---- 보호구 지급 ----
    [
      ['[예시] 안전모', '김철수', daysAgo(15), 1, daysAgo(-350)],
      ['[예시] 안전화', '이영희', daysAgo(15), 1, daysAgo(-350)],
    ].forEach(([type, who, date, qty, next]) => {
      ins('ppe_records',
        ['id', 'site_id', 'item_type', 'recipient', 'issue_date', 'quantity', 'next_replace_date', 'created_by'],
        [generateId('ppe'), siteId, type, who, date, qty, next, userId]);
    });
  });

  tx();
  return { seeded: true, counts };
}

module.exports = { seedDemoData };
