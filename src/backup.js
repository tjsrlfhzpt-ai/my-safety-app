const path = require('path');
const fs = require('fs');

// 2026-08-30(출시단계 업그레이드 - 가장 시급한 공백): 지금까지 데이터베이스 백업이 전혀
// 없었다. 여러 회사의 실제 데이터가 쌓이기 시작한 지금, 디스크 문제·실수·버그로 인한
// 데이터 손실은 이 서비스에서 일어날 수 있는 가장 심각한 사고다.
//
// better-sqlite3의 .backup()은 SQLite의 온라인 백업 API를 그대로 쓴다 - 서버가 요청을
// 처리하는 도중에도 안전하게(WAL 모드에서 파일을 직접 복사하면 깨질 수 있는 것과 달리)
// 일관된 스냅샷을 뜬다.
const BACKUP_DIR = path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite')), 'backups');
const RETENTION_DAYS = 7;

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function runBackup(db) {
  ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(BACKUP_DIR, `backup-${stamp}.sqlite`);
  await db.backup(filePath);

  // 같은 볼륨 안의 스냅샷이라 "디스크 자체가 통째로 사라지는" 사고까지는 못 막지만,
  // "실수로 지웠다/마이그레이션이 잘못됐다/앱 버그로 데이터가 깨졌다" 같은 훨씬 흔한
  // 사고는 이걸로 충분히 되돌릴 수 있다. RETENTION_DAYS보다 오래된 것은 자동 삭제해서
  // 디스크가 무한정 차지 않게 한다.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('backup-') || !f.endsWith('.sqlite')) continue;
    const full = path.join(BACKUP_DIR, f);
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
  }

  console.log(`[backup] 스냅샷 생성 완료: ${filePath}`);
  return filePath;
}

function latestBackupPath() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.sqlite'))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(BACKUP_DIR, files[0].f) : null;
}

// 서버 기동 시 1회 + 이후 24시간마다 자동 실행한다. 실패해도 서버 자체는 계속 돌아야
// 하므로(백업 실패가 서비스 중단으로 이어지면 안 됨) 에러를 여기서 잡아 로그만 남긴다.
function scheduleAutoBackup(db) {
  const run = () => runBackup(db).catch((e) => console.error('[backup] 자동 백업 실패:', e.message));
  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}

module.exports = { runBackup, latestBackupPath, scheduleAutoBackup, BACKUP_DIR };
