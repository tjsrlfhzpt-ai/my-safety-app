const jwt = require('jsonwebtoken');

// 운영 환경에서 JWT_SECRET 없이 개발용 기본값으로 조용히 넘어가는 것은 실제 보안 사고로
// 이어질 수 있어서 일부러 막아둔다 - 배포 전에 반드시 잡아내야 할 실수이므로 여기서 크래시.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error(
    '[치명적 설정 오류] NODE_ENV=production인데 JWT_SECRET이 설정되지 않았습니다. ' +
    '.env.example을 참고해 반드시 실제 비밀키를 설정하세요.'
  );
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me-before-deploy';

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '인증 토큰이 없습니다.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '토큰이 유효하지 않거나 만료되었습니다.' });
  }
}

// 요청자가 실제로 접근 가능한 사업장 id 목록. 조직전역 권한(user_roles에 site_id가 NULL인
// 행)이면 소속 조직의 전 사업장, 아니면 자기 사업장 1개뿐이다.
//
// ⚠️ 2026-08-28 관리자 API 검증 중 발견: 처음엔 로그인 시점에 계산해 JWT에 넣어뒀는데,
// JWT는 발급 후 8시간 동안 내용이 고정되므로 "로그인 → 새 사업장 생성 → 그 사업장 데이터
// 조회"를 같은 세션에서 하면 새 사업장이 반영되지 않는 게 재현됐다(관리자 API 테스트 8건
// 연쇄 실패로 확인). hasPermission이 이미 매 요청마다 DB를 조회하고 있으므로, 여기서도
// JWT 스냅샷 대신 매 요청 실시간 조회로 바꿔 이 문제를 근본적으로 없앤다.
function accessibleSiteIds(db, req) {
  const orgWide = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND site_id IS NULL LIMIT 1').get(req.user.sub);
  if (orgWide) {
    return db.prepare('SELECT id FROM sites WHERE org_id = ? AND deleted = 0').all(req.user.orgId).map(s => s.id);
  }
  return req.user.siteId ? [req.user.siteId] : [];
}

// 2026-08-28 점검: 조직 전역 권한(예: 부트스트랩 company_admin)은 특정 사업장에 소속되지
// 않을 수 있다(users.site_id = NULL). 이런 계정이 위험성평가 등 사업장 데이터를 직접
// 등록하려 하면 site_id NOT NULL 제약 위반으로 알 수 없는 500이 났다 - 생성계열 라우트
// 앞단에서 미리 걸러 이해할 수 있는 400으로 바꾼다.
function requireHomeSite(req, res, next) {
  // 2026-09-02: 본문에 siteId를 명시하면 조직전역 관리자(소속 사업장 없음)도 등록할 수
  // 있어야 하므로, 그 경우는 통과시키고 실제 권한검증은 resolveTargetSiteId가 담당한다.
  if (!req.user.siteId && !(req.body && req.body.siteId)) {
    return res.status(400).json({
      error: '이 계정은 특정 사업장에 소속되어 있지 않아 데이터를 등록할 수 없습니다. 등록할 사업장을 선택하거나, 관리자에게 사업장 배정을 요청하세요.',
    });
  }
  next();
}

// 2026-09-02(마스터 프롬프트 15·17절 대응): 지금까지는 "자기 소속 사업장"에만 데이터를
// 등록할 수 있었다. 그래서 본사 안전관리자가 여러 현장을 순회하며 대신 입력하거나,
// 조직전역 관리자가 특정 현장 데이터를 등록하는 것이 API 레벨에서 아예 불가능했다.
// 이제 요청 본문에 siteId가 오면 "그 사용자가 실제로 접근 가능한 사업장인지"를 서버가
// 검증한 뒤 그 사업장으로 등록한다. 권한 밖 사업장을 지정하면 403으로 막는다.
// (클라이언트가 보낸 값을 그대로 믿지 않는 것이 핵심 - 마스터 프롬프트 16·37절)
function resolveTargetSiteId(db, req, res) {
  const requested = req.body && req.body.siteId;
  if (!requested) return req.user.siteId;
  const allowed = accessibleSiteIds(db, req);
  if (!allowed.includes(requested)) {
    res.status(403).json({ error: '해당 사업장에 데이터를 등록할 권한이 없습니다.' });
    return null;
  }
  return requested;
}

// 라우트가 db를 쥐고 있으므로 클로저로 주입받는다.
function requirePermission(db, permissionCode) {
  return (req, res, next) => {
    if (!hasPermission(db, req.user.sub, permissionCode)) {
      return res.status(403).json({ error: `권한이 없습니다: ${permissionCode}` });
    }
    next();
  };
}

// 2026-08-28 점검: JWT는 자체적으로 폐기(revoke)할 방법이 없어, 관리자가 계정을 잠그거나
// 비활성화해도 이미 발급된 토큰은 만료(8시간)까지 계속 유효했다(출시전 점검보고서 3절).
// 모든 보호된 라우트가 requirePermission -> hasPermission을 거치므로, 여기서 계정 상태를
// 함께 확인하면 authenticate 자체를 손대지 않고도 사실상 즉시 차단 효과를 낼 수 있다.
function hasPermission(db, userId, code) {
  const row = db.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = ? AND p.code = ? AND u.account_status = 'active' AND u.deleted = 0
      AND u.consent_privacy_at IS NOT NULL AND u.consent_terms_at IS NOT NULL AND u.consent_sensitive_at IS NOT NULL
  `).get(userId, code);
  return !!row;
}

module.exports = { authenticate, requirePermission, requireHomeSite, resolveTargetSiteId, hasPermission, accessibleSiteIds, JWT_SECRET };
