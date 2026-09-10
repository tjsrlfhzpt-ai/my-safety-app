require('dotenv').config();

// app.js가 require 시점에 JWT_SECRET/NODE_ENV를 읽으므로 dotenv.config()가 반드시 먼저 실행돼야 한다.
const app = require('./src/app');
const db = require('./src/db');
const { ensureSeed } = require('./src/seed');
const { ensureBootstrapAdmin } = require('./src/bootstrap-admin');
const { seedDemoData } = require('./src/demo-data');
const { scheduleAutoBackup } = require('./src/backup');

// 역할/권한 체계가 자동으로 준비되도록 함 (조직/사업장은 2026-08-30부터 /setup 화면
// 또는 POST /organizations를 통해 실제 가입으로만 생성됨 - src/seed.js 참고)
// (ensureSeed 내부가 이미 존재 여부를 확인하고 없을 때만 만들기 때문에 재기동해도 안전함)
try {
  ensureSeed();
} catch (e) {
  console.error('[fatal] 초기 시드 실패:', e);
  process.exit(1);
}

// 2026-09-10: 최초 관리자 계정 자동 생성 (src/bootstrap-admin.js 참고).
// ensureSeed()가 역할(company_admin)을 먼저 만들어야 하므로 반드시 그 뒤에 온다.
// 여기서 실패해도 서버 자체는 정상 기동시킨다 - 계정 생성은 편의 기능이고,
// /setup 페이지라는 대체 경로가 항상 살아있기 때문이다.
try {
  const boot = ensureBootstrapAdmin(db);
  // 2026-09-10: 마스터 관리자가 "이번에 새로 만들어졌을 때만" 예시 데이터를 넣는다.
  // 이미 쓰던 서버를 재기동할 때 예시가 다시 끼어들지 않게 하기 위함이다.
  if (boot && boot.created) {
    try {
      const demo = seedDemoData(db, { siteId: boot.siteId, userId: boot.userId });
      if (demo.seeded) {
        const total = Object.values(demo.counts).reduce((a, b) => a + b, 0);
        console.log(`[demo] 테스트용 예시 데이터 ${total}건 생성 완료 (제목에 "[예시]" 표시)`);
        console.log('[demo] 실제 데이터를 넣기 시작하면 SEED_DEMO_DATA 환경변수를 꺼주세요.');
      }
    } catch (e) {
      // 예시 데이터는 편의 기능일 뿐이므로 실패해도 서버는 정상 기동시킨다.
      console.error('[demo] 예시 데이터 생성 실패 (서버는 계속 기동합니다):', e.message);
    }
  }
} catch (e) {
  console.error('[bootstrap] 최초 관리자 생성 실패 (서버는 계속 기동합니다):', e.message);
  console.error('[bootstrap] 대신 브라우저에서 /setup 페이지로 계정을 만들 수 있습니다.');
}

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`[safety-meerkat-server] listening on http://localhost:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});

// 2026-08-30(출시단계 업그레이드): 매일 자동으로 DB 스냅샷을 뜬다. 백업 실패가 서버 자체를
// 죽여선 안 되므로 scheduleAutoBackup 내부에서 에러를 잡아 로그만 남긴다.
scheduleAutoBackup(db);

// 컨테이너 플랫폼(Fly/Railway 등)은 재배포·스케일 조정 시 SIGTERM을 보낸다.
// 연결을 마무리하고 DB 핸들을 정리한 뒤 종료해야 강제 종료로 인한 데이터 손상을 피할 수 있다.
function shutdown(signal) {
  console.log(`[safety-meerkat-server] ${signal} 수신 - graceful shutdown 시작`);
  server.close(() => {
    db.close();
    console.log('[safety-meerkat-server] 정상 종료 완료');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[safety-meerkat-server] graceful shutdown 시간 초과 - 강제 종료');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 2026-08-30(운영 모니터링): Express 라우트 안의 오류는 app.js의 4-인자 에러 핸들러가
// 잡지만, 그 바깥(비동기 콜백, 타이머 등)에서 나는 오류는 지금까지 전혀 안 잡혔다 -
// uncaughtException은 방치하면 Node 프로세스가 아무 기록 없이 그냥 죽어버린다.
function logSystemError(source, err) {
  try {
    db.prepare('INSERT INTO system_errors (message, stack, path, method, status_code) VALUES (?, ?, ?, ?, ?)')
      .run(String((err && err.message) || err), String((err && err.stack) || ''), source, 'PROCESS', null);
  } catch (e) {
    console.error('[system_errors] 프로세스 레벨 오류 기록 실패:', e.message);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  logSystemError('unhandledRejection', reason);
  // Promise 거부 하나만으로 서버 전체를 내리진 않는다 - 대부분 개별 요청 처리 실패 정도라
  // 기록만 남기고 계속 서비스한다.
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  logSystemError('uncaughtException', err);
  // 이건 다르다 - 프로세스가 어떤 상태인지 보장할 수 없으므로, 기록을 남긴 뒤 정상
  // 종료한다. Render 등 대부분의 플랫폼은 프로세스가 죽으면 자동으로 재시작해준다.
  shutdown('uncaughtException');
});
