const express = require('express');
const cors = require('cors');
const db = require('./db');
const authRoutes = require('./routes/auth')(db);
const riskRoutes = require('./routes/risk')(db);
const capaRoutes = require('./routes/capa')(db);
const nearmissRoutes = require('./routes/nearmiss')(db);
const tbmRoutes = require('./routes/tbm')(db);
const voiceRoutes = require('./routes/voice')(db);
const legalmeetRoutes = require('./routes/legalmeet')(db);
const accidentRoutes = require('./routes/accident')(db);
const msdsRoutes = require('./routes/msds')(db);
const healthRoutes = require('./routes/health')(db);
const eduRoutes = require('./routes/edu')(db);
const ppeRoutes = require('./routes/ppe')(db);
const appointRoutes = require('./routes/appoint')(db);
const contractorRoutes = require('./routes/contractor')(db);
const ptwRoutes = require('./routes/ptw')(db);
const legalChecklistRoutes = require('./routes/legal-checklist')(db);
const usersRoutes = require('./routes/users')(db);
const sitesRoutes = require('./routes/sites')(db);
const attachmentsRoutes = require('./routes/attachments')(db);
const organizationsRoutes = require('./routes/organizations')(db);
const equipmentRoutes = require('./routes/equipment')(db);
const processesRoutes = require('./routes/processes')(db);
const lotoRoutes = require('./routes/loto')(db);
const workenvRoutes = require('./routes/workenv')(db);
const ergonomicRoutes = require('./routes/ergonomic')(db);
const stressRoutes = require('./routes/stress')(db);
const inspectionRoutes = require('./routes/inspection')(db);
const dashboardRoutes = require('./routes/dashboard')(db);
const contractingRoutes = require('./routes/contracting')(db);
const complianceReviewRoutes = require('./routes/compliance-review')(db);
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { runBackup, latestBackupPath } = require('./backup');

const app = express();

// 2026-08-28 후속조치: 헬스체크는 어떤 경우에도 막히면 안 되므로(로드밸런서 + Docker +
// 외부 uptime 모니터링이 동시에 찔러도) CORS/rate limit/인증 전부보다 앞에 둔다.
app.get('/health', (req, res) => res.json({ ok: true, service: 'safety-meerkat-server' }));

// 2026-08-30(출시단계 업그레이드): 백업 파일에는 이 서버를 쓰는 모든 회사의 데이터가
// 통째로 들어있다. 그래서 특정 회사에 소속된 어떤 관리자 권한과도 무관하게, 이 서버
// 전체를 운영하는 사람만 아는 별도 비밀키(BACKUP_SECRET)로만 열리는 완전히 독립된
// 통로로 만든다 - 기존 JWT 인증/조직별 권한 체계를 전혀 거치지 않는다.
const backupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.get('/admin/backup', backupLimiter, async (req, res) => {
  const secret = process.env.BACKUP_SECRET;
  if (!secret) return res.status(404).json({ error: '이 기능은 비활성화되어 있습니다.' });

  const provided = req.get('X-Backup-Key') || '';
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  // 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 길이부터 확인한다. 길이가 같을
  // 때만 실제 값을 시간차 공격에 안전한 방식으로 비교한다.
  const matches = secretBuf.length === providedBuf.length && crypto.timingSafeEqual(secretBuf, providedBuf);
  if (!matches) return res.status(403).json({ error: '접근이 거부되었습니다.' });

  try {
    const filePath = await runBackup(db);
    res.download(filePath, `safety-meerkat-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
  } catch (e) {
    console.error('[backup] 다운로드 요청 처리 실패:', e.message);
    res.status(500).json({ error: '백업 생성 중 오류가 발생했습니다.' });
  }
});

// 2026-08-30(운영 모니터링): 백업과 같은 비밀키를 재사용한다 - "이 서버를 운영하는 사람만
// 볼 수 있어야 하는 정보"라는 성격이 같고, Render에 환경변수를 또 하나 더 추가할 필요를
// 없애기 위해 일부러 나눴다. 오류 메시지에 특정 회사 이름 등이 우연히 섞여 나올 수도
// 있으므로(예: 존재하지 않는 조직 id 참조 오류 등) 조직별 권한이 아니라 플랫폼 운영자
// 전용으로 두는 게 맞다.
function checkBackupSecret(req, res) {
  const secret = process.env.BACKUP_SECRET;
  if (!secret) { res.status(404).json({ error: '이 기능은 비활성화되어 있습니다.' }); return false; }
  const provided = req.get('X-Backup-Key') || '';
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  const matches = secretBuf.length === providedBuf.length && crypto.timingSafeEqual(secretBuf, providedBuf);
  if (!matches) { res.status(403).json({ error: '접근이 거부되었습니다.' }); return false; }
  return true;
}

app.get('/admin/errors', backupLimiter, (req, res) => {
  if (!checkBackupSecret(req, res)) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db.prepare('SELECT * FROM system_errors ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.delete('/admin/errors', backupLimiter, (req, res) => {
  if (!checkBackupSecret(req, res)) return;
  db.prepare('DELETE FROM system_errors').run();
  res.json({ ok: true });
});

// 2026-08-30: 터미널 없이 브라우저만으로 첫 회사+관리자 계정을 만들 수 있는 페이지.
// /organizations 자체는 SaaS 특성상 계속 열려있어야 하지만(여러 회사가 계속 가입해야 하므로),
// 이 "화면"은 배포 직후 딱 한 번 쓰라고 만든 것이라 - 이미 회사가 하나라도 있으면 접속 시
// 안내만 보여준다(폼은 숨김). 오해로 인한 중복 회사 생성을 막기 위함이며, /organizations API
// 자체를 막는 것은 아니다(추가 회사 가입은 계속 가능해야 하므로 - 점검보고서 6절 참고).
const { setupPageHtml } = require('./setup-page');
// 2026-08-30(PDF/QR 검증): PTW 출력물에 QR코드를 넣어, 스캔하면 "실제로 이 시스템에
// 등록된 진짜 문서인지"를 누구나(로그인 없이) 확인할 수 있게 한다. 위조된 종이 문서를
// 감독관이 QR로 즉석에서 검증할 수 있는 게 목적이므로 인증을 걸지 않는다 - 대신 노출
// 정보를 최소화한다(근로자 실명·협력업체명 등은 빼고, "이 번호의 허가서가 실제로
// 존재하며 현재 상태가 무엇인지" 정도만 보여준다).
app.get('/verify/ptw/:id', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  const permit = db.prepare(`
    SELECT p.id, p.title, p.location, p.work_date, p.status, p.approved_at, s.name AS site_name
    FROM permits p JOIN sites s ON s.id = p.site_id
    WHERE p.id = ? AND p.deleted = 0
  `).get(req.params.id);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shell = (bodyHtml, ok) => `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>작업허가서 진위확인</title>
    <style>body{background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
    .card{max-width:400px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:20px;padding:28px;text-align:center}
    .badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:800;font-size:13px;margin-bottom:16px;background:${ok ? 'rgba(16,185,129,.15);color:#6ee7b7' : 'rgba(244,63,94,.15);color:#fda4af'}}
    dl{text-align:left;font-size:13px;line-height:2;margin:0}
    dt{color:#94a3b8;display:inline-block;width:90px}dd{display:inline;margin:0}
    </style></head><body><div class="card">${bodyHtml}</div></body></html>`;

  if (!permit) {
    return res.send(shell(`<div class="badge">⚠ 확인 불가</div><p>존재하지 않는 문서번호입니다.<br>위조되었거나 삭제된 문서일 수 있습니다.</p>`, false));
  }
  res.send(shell(`
    <div class="badge">✅ 정상 등록된 문서입니다</div>
    <dl>
      <div><dt>문서번호</dt><dd>${esc(permit.id)}</dd></div>
      <div><dt>사업장</dt><dd>${esc(permit.site_name)}</dd></div>
      <div><dt>작업내용</dt><dd>${esc(permit.title)}</dd></div>
      <div><dt>작업장소</dt><dd>${esc(permit.location)}</dd></div>
      <div><dt>작업일자</dt><dd>${esc(permit.work_date) || '-'}</dd></div>
      <div><dt>현재상태</dt><dd>${esc(permit.status)}</dd></div>
      <div><dt>승인일시</dt><dd>${esc(permit.approved_at) || '미승인'}</dd></div>
    </dl>
  `, true));
});

app.get('/setup', (req, res) => {
  const orgCount = db.prepare('SELECT COUNT(*) c FROM organizations WHERE deleted = 0').get().c;
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (orgCount > 0) {
    res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>안전미어캣 프로</title>
      <style>body{background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
      div{max-width:400px;line-height:1.7}</style></head><body><div>
      <h2>이미 시작된 서버입니다</h2>
      <p style="color:#94a3b8">이 서버는 이미 최소 1개 이상의 회사가 등록되어 있습니다.<br>이 화면은 서버를 맨 처음 딱 한 번 준비할 때만 씁니다.<br>추가로 다른 회사를 등록하려면 관리자에게 문의해 주세요.</p>
      </div></body></html>`);
    return;
  }
  res.send(setupPageHtml());
});

// PWA는 API와 다른 도메인(예: Netlify)에서 서빙되는 경우가 많으므로 CORS가 필요하다.
//
// 2026-08-28 후속조치(출시전 점검보고서 3절): 예전엔 CORS_ORIGIN 미설정 시 "경고만 남기고
// 전체 출처를 허용"했다 - JWT_SECRET은 없으면 기동 자체를 거부하게 만들어놓고 위험도가
// 크게 다르지 않은 CORS는 다른 기준을 적용한 것이라 통일했다. 운영에서는 미설정이면
// 아예 기동을 거부한다.
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedOrigins.length === 0 && process.env.NODE_ENV === 'production') {
  console.error(
    '[치명적 설정 오류] NODE_ENV=production인데 CORS_ORIGIN이 설정되지 않았습니다. ' +
    '이 상태로는 모든 출처를 허용하게 되어 위험하므로 기동을 중단합니다. .env.example을 참고해 ' +
    'CORS_ORIGIN=https://yourapp.example.com 형태로 지정하세요.'
  );
  process.exit(1);
}
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  credentials: true,
}));

app.use(express.json());

// 2026-08-28 후속조치(출시전 점검보고서 3절): 계정당 5회 실패 잠금은 있었지만, 서로 다른
// 여러 계정을 대상으로 한 무차별대입이나 API 스크래핑을 막는 IP 단위 제한이 없었다.
// 인증 관련 엔드포인트는 더 엄격하게, 나머지 API는 완만하게 이중으로 건다.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { error: '요청이 너무 많습니다. 15분 후 다시 시도해주세요.' },
  standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/auth', authLimiter);
app.use('/organizations', authLimiter);
app.use(apiLimiter);

// 배포 직후 트래픽이 실제로 들어오는지 눈으로 바로 확인할 수 있는 최소 로그
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use('/auth', authRoutes);
app.use('/risks', riskRoutes);
app.use('/capa', capaRoutes);
app.use('/nearmiss', nearmissRoutes);
app.use('/tbm', tbmRoutes);
app.use('/voice', voiceRoutes);
app.use('/legalmeet', legalmeetRoutes);
app.use('/accident', accidentRoutes);
app.use('/msds', msdsRoutes);
app.use('/health-records', healthRoutes);
app.use('/edu', eduRoutes);
app.use('/ppe', ppeRoutes);
app.use('/appoint', appointRoutes);
app.use('/contractor', contractorRoutes);
app.use('/equipment', equipmentRoutes);
app.use('/processes', processesRoutes);
app.use('/loto', lotoRoutes);
app.use('/workenv', workenvRoutes);
app.use('/ergonomic', ergonomicRoutes);
app.use('/stress', stressRoutes);
app.use('/inspection', inspectionRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/contracting', contractingRoutes);
app.use('/compliance-review', complianceReviewRoutes);
app.use('/ptw', ptwRoutes);
app.use('/compliance', legalChecklistRoutes);
app.use('/users', usersRoutes);
app.use('/sites', sitesRoutes);
app.use('/attachments', attachmentsRoutes);
app.use('/organizations', organizationsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: '존재하지 않는 경로입니다.' });
});

// 2026-08-30(운영 모니터링): 콘솔 로그만으로는 아무도 안 보고 있으면 그냥 사라진다.
// DB에도 남겨서 나중에 GET /admin/errors로 확인할 수 있게 한다. 요청 본문·헤더는 절대
// 저장하지 않는다(비밀번호·토큰 등이 담겨있을 수 있음) - 오류 자체를 진단하는 데는
// 메시지·스택·경로·메서드만으로 충분하다.
app.use((err, req, res, next) => {
  console.error(err);
  try {
    db.prepare('INSERT INTO system_errors (message, stack, path, method, status_code) VALUES (?, ?, ?, ?, ?)')
      .run(String(err.message || err), String(err.stack || ''), req.path, req.method, 500);
  } catch (logErr) {
    console.error('[system_errors] 기록 실패:', logErr.message);
  }
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

module.exports = app;
