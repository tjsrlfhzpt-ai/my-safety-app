const crypto = require('crypto');

// v5.7 IdGenerator.PREFIX와 동일한 접두어 표 (그대로 승계)
const DOMAIN_PREFIX = {
  risk: 'RISK', capa: 'CAPA', accident: 'ACC', nearmiss: 'NM', ptw: 'PTW',
  tbm: 'TBM', edu: 'EDU', legalmeet: 'LM', voice: 'VOC', ppe: 'PPE',
  contractor: 'CT', health: 'HLT', appoint: 'APT', msds: 'MSDS', reports: 'RPT',
  compliance: 'SAF', equipment: 'EQP', process: 'PRC', loto: 'LOTO', lotosource: 'LOTOS', workenv: 'WENV', ergo: 'ERG', ergosym: 'ERGS', stress: 'STR', stresscns: 'STRC', inspection: 'INSP', insptpl: 'INSPT', budget: 'BDG', budgetitem: 'BDGI', ctreval: 'CTEV', review: 'REV',
};

// 안전관리 도메인 id: RISK-2026-000001 형식 (기존 앱과 동일한 규칙).
// State.idCounters 였던 것을 id_counters 테이블로 옮겨, 삭제 후에도 번호가
// 재사용되지 않는 성질을 서버에서도 그대로 유지한다.
function nextDomainId(db, type) {
  const prefix = DOMAIN_PREFIX[type] || String(type || 'GEN').toUpperCase();
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;

  const upsert = db.transaction(() => {
    const row = db.prepare('SELECT value FROM id_counters WHERE counter_key = ?').get(key);
    const next = (row ? row.value : 0) + 1;
    if (row) {
      db.prepare('UPDATE id_counters SET value = ? WHERE counter_key = ?').run(next, key);
    } else {
      db.prepare('INSERT INTO id_counters (counter_key, value) VALUES (?, ?)').run(key, next);
    }
    return next;
  });

  const n = upsert();
  return `${key}-${String(n).padStart(6, '0')}`;
}

// 조직/사업장/사용자 등 기존 앱에 없던 신규 관리 엔티티용 - 접두어만 다르게, 형식은 동일하게
function generateId(prefix) {
  return nextDomainIdLike(prefix);
}

function nextDomainIdLike(prefix) {
  const year = new Date().getFullYear();
  return `${prefix.toUpperCase()}-${year}-${crypto.randomBytes(4).toString('hex')}`;
}

// 레거시(v14 이전) id인지 판별: RISK-2026-000001 같은 새 형식이 아니면 구식으로 간주
function isLegacyStyleId(id) {
  return !/^[A-Z]+-\d{4}-\d{6}$/.test(String(id || ''));
}

// 이미 잘 만들어진 신형 id(RISK-2026-000042 등)를 그대로 받아들일 때, 카운터가 그 번호를
// 넘어서도록 미리 맞춰둔다. 이후 서버가 같은 접두어로 새 id를 채번해도 절대 충돌하지 않는다.
// migrate-legacy.js와 클라이언트-제공-id 수용 로직(예: routes/risk.js)이 함께 사용한다.
function bumpCounterIfNewStyle(db, id) {
  const m = /^([A-Z]+)-(\d{4})-(\d{6})$/.exec(id || '');
  if (!m) return;
  const key = `${m[1]}-${m[2]}`;
  const n = parseInt(m[3], 10);
  const row = db.prepare('SELECT value FROM id_counters WHERE counter_key = ?').get(key);
  if (!row || row.value < n) {
    db.prepare(
      'INSERT INTO id_counters (counter_key, value) VALUES (?, ?) ON CONFLICT(counter_key) DO UPDATE SET value = excluded.value'
    ).run(key, n);
  }
}

// 클라이언트(프론트엔드의 IdGenerator)가 이미 서버와 동일한 형식으로 채번해 보낸 id가 있으면
// 그대로 신뢰해서 쓰고, 없거나 형식이 안 맞으면 서버가 새로 채번한다. 프론트가 오프라인 상태에서
// 미리 만든 id를 그대로 서버 레코드의 id로 쓸 수 있어야 나중에 로컬↔서버 데이터를 id로 대조할 수 있다.
//
// ⚠️ 2026-08-28 점검에서 발견: 이 함수는 id 존재 여부를 site_id 구분 없이 전역으로만 확인했다.
// 서로 다른 두 사업장이 각자 오프라인에서 우연히 같은 id(예: 둘 다 첫 기록으로 NM-2026-000001)를
// 채번해 보내면, 두 번째 사업장의 요청이 "이미 존재함(alreadyExisted)"으로 오판되어 실제로는
// 저장되지 않고 조용히 유실됐다(재현 확인됨). resolveIdForSite로 대체한다 - 아래 참고.
function resolveClientOrNewId(db, domainType, clientId) {
  const prefix = DOMAIN_PREFIX[domainType];
  if (clientId && !isLegacyStyleId(clientId) && clientId.startsWith(prefix + '-')) {
    bumpCounterIfNewStyle(db, clientId);
    return clientId;
  }
  return nextDomainId(db, domainType);
}

// resolveClientOrNewId를 대체하는 site-aware 버전. id_counters 자체는 여전히 조직 전체가
// 공유하지만(도메인당 순번이 유일하다는 성질만 필요하고, 사업장별로 번호가 1부터 다시 시작할
// 필요는 없음 - 오히려 전역 유일성이 있는 편이 데이터 대조에 유리하다), "클라이언트가 이미
// 다른 사업장에서 쓰인 id를 실수로 재사용하려는 경우"만 안전하게 걸러낸다.
//
// 반환값의 idReassigned가 true이면, 클라이언트가 보낸 id를 그대로 쓰지 못하고 서버가 새 id를
// 발급했다는 뜻이다 - 응답의 id를 클라이언트가 반드시 확인해서 로컬 레코드에 반영해야 한다.
function resolveIdForSite(db, domainType, table, clientId, siteId) {
  const prefix = DOMAIN_PREFIX[domainType];
  const looksValid = clientId && !isLegacyStyleId(clientId) && clientId.startsWith(prefix + '-');

  if (!looksValid) {
    return { id: nextDomainId(db, domainType), alreadyExisted: false, idReassigned: false };
  }

  const existing = db.prepare(`SELECT site_id FROM ${table} WHERE id = ?`).get(clientId);
  if (!existing) {
    // 전역적으로 아무도 안 쓴 id -> 클라이언트 값을 그대로 신뢰
    bumpCounterIfNewStyle(db, clientId);
    return { id: clientId, alreadyExisted: false, idReassigned: false };
  }
  if (existing.site_id === siteId) {
    // 같은 사업장이 재시도(SyncQueue 재전송 등)로 보낸 것 -> 멱등 처리
    return { id: clientId, alreadyExisted: true, idReassigned: false };
  }
  // 다른 사업장이 이미 이 id를 쓰고 있음 -> 그 레코드를 덮어쓰거나 뒤섞이면 안 되므로
  // 클라이언트가 제안한 id는 버리고 새로 채번한다 (데이터 유실 대신 id 재할당으로 처리)
  return { id: nextDomainId(db, domainType), alreadyExisted: false, idReassigned: true };
}

module.exports = {
  nextDomainId, generateId, isLegacyStyleId, bumpCounterIfNewStyle,
  resolveClientOrNewId, resolveIdForSite, DOMAIN_PREFIX,
};
