const express = require('express');
const { generateId } = require('../ids');
const { writeAudit } = require('../audit');
const { makeJoinCode } = require('../db');
const { authenticate, requirePermission } = require('../auth-middleware');

// 2026-08-28 후속조치: "여러 고객사를 위한 SaaS로 간다"는 결정에 따라 조직 생성 API를
// 추가한다. auth.js의 /register와 정확히 같은 이유로 인증을 걸 수 없다 - 이 API를 호출하는
// 시점엔 그 조직에 사용자가 단 한 명도 없다(회사가 이제 막 가입하는 순간). 인증 대신
// app.js의 authLimiter(같은 rate limit)를 이 라우트에도 적용해 남용을 억제한다.
//
// 보안 관점에서 이 API 자체는 2-1절 취약점과 리스크 프로필이 다르다: 조직을 만드는 것만으로는
// 누구의 권한도 획득하지 못한다(빈 조직 껍데기만 생김). 실제 권한(company_admin)은 이어서
// POST /auth/register를 호출해야 생기고, 그 경로는 이미 "조직 내 최초 가입자만 자동 승격"
// 규칙으로 막혀있다(auth.js 참고). 즉 이 API의 최악의 남용 시나리오는 "빈 조직 스팸 생성"
// 정도이며, rate limit로 충분히 억제된다.
module.exports = function organizationsRoutes(db) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const { name, bizRegNo, siteName } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name(회사/조직명)은 필수입니다.' });

    const orgId = generateId('ORG');

    // 2026-09-10: 근로자가 이 회사에 합류할 때 쓸 가입코드를 함께 발급한다.
    // UNIQUE 인덱스가 걸려 있어 중복이면 INSERT가 실패하므로, 빈 코드를 미리 확인하고
    // 넣는다(경합이 나도 인덱스가 최종 방어선이 된다).
    let joinCode = makeJoinCode();
    for (let i = 0; i < 20 && db.prepare('SELECT 1 FROM organizations WHERE join_code = ?').get(joinCode); i += 1) {
      joinCode = makeJoinCode();
    }

    db.prepare('INSERT INTO organizations (id, name, biz_reg_no, join_code) VALUES (?, ?, ?, ?)')
      .run(orgId, name, bizRegNo || null, joinCode);

    // 최초 사업장까지 한 번에 만들 수 있게 해준다(선택) - 그래야 가입 직후 바로
    // POST /auth/register 한 번으로 부트스트랩 관리자 + 사업장 배정까지 끝난다.
    let siteId = null;
    if (siteName) {
      siteId = generateId('SITE');
      db.prepare('INSERT INTO sites (id, org_id, name) VALUES (?, ?, ?)').run(siteId, orgId, siteName);
    }

    writeAudit(db, {
      actorUserId: null, actorName: name, action: 'create',
      entityType: 'organization', entityId: orgId, after: { name, bizRegNo, siteName }, ip: req.ip,
    });

    res.status(201).json({ orgId, siteId, joinCode });
  });

  // ==========================================================================
  // 2026-09-10: 가입코드로 회사 찾기 (인증 없음)
  // --------------------------------------------------------------------------
  // 근로자 회원가입 화면에서 쓴다. 코드를 입력하면 회사명과 사업장 목록을 돌려주고,
  // 근로자는 그 중 자기 사업장을 골라 가입한다.
  //
  // 인증을 걸 수 없는 이유는 /auth/register와 같다 - 가입하기 전이라 계정이 없다.
  // 대신 app.js의 authLimiter가 이 라우트에도 걸려 있어 무작위 코드 대입을 억제한다.
  //
  // 노출되는 정보를 의도적으로 최소화했다: 회사명 + 사업장명만 돌려주고, 사용자
  // 목록·데이터·내부 설정은 전혀 포함하지 않는다. 즉 코드를 맞히더라도 얻을 수 있는
  // 것은 "그 회사가 존재한다"는 사실뿐이다. 실제 데이터 접근은 가입 후 worker
  // 권한을 받아야 가능하다.
  // ==========================================================================
  router.get('/lookup', (req, res) => {
    const code = String(req.query.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: '가입코드를 입력해주세요.' });

    const org = db.prepare('SELECT id, name FROM organizations WHERE join_code = ? AND deleted = 0').get(code);
    // 존재하지 않는 코드와 삭제된 회사를 같은 문구로 처리한다(코드 존재 여부를 흘리지 않음).
    if (!org) return res.status(404).json({ error: '해당 가입코드의 회사를 찾을 수 없습니다.' });

    const sites = db.prepare('SELECT id, name FROM sites WHERE org_id = ? AND deleted = 0 ORDER BY name').all(org.id);
    res.json({ orgId: org.id, orgName: org.name, sites });
  });

  // 2026-09-10: 로그인한 사용자가 자기 회사 정보(가입코드 포함)를 확인한다.
  // 관리자가 근로자에게 알려줄 코드를 관제센터/웹 화면에서 볼 수 있어야 하기 때문이다.
  // 가입코드는 사실상 "우리 회사에 들어올 수 있는 열쇠"이므로 조직 설정 권한
  // (org.settings)을 가진 사람에게만 보여준다 - 일반 근로자에게는 필요 없는 정보다.
  router.get('/me', authenticate, requirePermission(db, 'org.settings'), (req, res) => {
    const org = db.prepare('SELECT id, name, biz_reg_no, join_code, created_at FROM organizations WHERE id = ? AND deleted = 0')
      .get(req.user.orgId);
    if (!org) return res.status(404).json({ error: '조직을 찾을 수 없습니다.' });
    res.json({
      id: org.id, name: org.name, bizRegNo: org.biz_reg_no,
      joinCode: org.join_code, createdAt: org.created_at,
    });
  });

  return router;
};
