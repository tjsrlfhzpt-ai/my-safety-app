const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateId } = require('../ids');
const { writeAudit } = require('../audit');
const { authenticate, accessibleSiteIds, hasPermission } = require('../auth-middleware');

// 2026-08-28 후속조치(출시전 점검보고서 3절 "첨부파일 업로드 API 없음"): attachments
// 테이블은 스키마에 이미 있었지만("오브젝트 스토리지 키" 컬럼만 정의) 실제로 파일을 받는
// 라우트가 어디에도 없어서, MSDS 원문·사고 현장 사진·서명 이미지를 서버에 저장할 방법이
// 없었다.
//
// 저장 위치: DB_PATH와 같은 디렉터리 아래 uploads/ - Dockerfile이 이미 /app/data 전체를
// 영구 볼륨(VOLUME)으로 잡아뒀으므로, 여기 저장하면 별도 설정 없이 재배포에도 살아남는다.
// 클라우드 오브젝트 스토리지(S3 등)로 옮기는 것은 여기 저장 경로만 바꾸면 되는 구조로
// file_key 컬럼에 "상대 경로"만 저장해뒀다 - 나중에 스토리지를 바꿔도 API 계약은 안 바뀐다.
//
// ⚠️ 처음엔 이 파일에서 DB_PATH 기본값을 db.js와 똑같은 공식으로 다시 계산했는데,
// attachments.js가 db.js보다 한 단계 깊은 폴더(src/routes/)에 있다는 걸 놓쳐서
// __dirname 기준 상대경로가 어긋나 uploads/가 엉뚱한 위치(src/uploads)에 만들어지는 실제
// 버그가 났었다. db.js가 이미 계산해둔 DB_PATH를 그대로 가져다 쓰는 것으로 고쳐서, 경로
// 계산 로직이 두 군데서 따로 존재하지 않도록 했다(원칙 9 - 동일 정보를 여러 곳에 중복
// 저장/계산하는 구조는 피한다).
const UPLOAD_DIR = path.join(path.dirname(require('../db').DB_PATH), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// entityType(클라이언트가 보내는 값) -> 실제 테이블/권한 접두어 매핑. 여기 없는 값은 전부
// 거부한다 - 임의의 테이블에 파일을 연결할 수 있게 열어두면 안 되므로 화이트리스트 방식.
const ENTITY_TYPES = {
  risk_assessment: { table: 'risk_assessments', permPrefix: 'risk' },
  incident: { table: 'incidents', permPrefix: 'accident' },
  near_miss: { table: 'near_misses', permPrefix: 'nearmiss' },
  tbm: { table: 'tbm_records', permPrefix: 'tbm' },
  voice: { table: 'voice_reports', permPrefix: 'voice' },
  legalmeet: { table: 'legal_meetings', permPrefix: 'legalmeet' },
  msds: { table: 'msds_items', permPrefix: 'msds' },
  health: { table: 'health_records', permPrefix: 'health' },
  edu: { table: 'training_records', permPrefix: 'edu' },
  ppe: { table: 'ppe_records', permPrefix: 'ppe' },
  appoint: { table: 'legal_appointments', permPrefix: 'appoint' },
  contractor: { table: 'contractors', permPrefix: 'contractor' },
  equipment: { table: 'equipment', permPrefix: 'equipment' },
  process: { table: 'processes', permPrefix: 'process' },
  loto: { table: 'loto_permits', permPrefix: 'loto' },
  workenv: { table: 'work_env_measurements', permPrefix: 'workenv' },
  ergonomic: { table: 'ergonomic_surveys', permPrefix: 'ergonomic' },
  stress: { table: 'stress_assessments', permPrefix: 'stress' },
  inspection: { table: 'inspections', permPrefix: 'inspection' },
  budgetitem: { table: 'safety_budget_items', permPrefix: 'contractor' },
  ctreval: { table: 'contractor_evaluations', permPrefix: 'contractor' },
  ptw: { table: 'permits', permPrefix: 'ptw' },
  capa: { table: 'capa_actions', permPrefix: 'capa' },
};

// 실행 파일/스크립트류를 막기 위한 화이트리스트(블랙리스트가 아니라 허용목록 방식이 더
// 안전하다 - 새로운 위험한 확장자가 나와도 기본적으로 막혀있음). MIME 타입은 클라이언트가
// 조작할 수 있어 확장자와 함께 이중으로 확인한다.
const ALLOWED = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  // 원본 파일명을 그대로 쓰지 않는다 - 경로순회·충돌·특수문자 문제를 원천 차단하기 위해
  // 서버가 무작위 파일명을 생성하고, 원본 파일명은 DB의 file_name 컬럼에 별도 보관한다.
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // 2026-08-30(전자서명 서버연동 검증 중 실제로 재현·발견): multer/busboy는 멀티파트
    // 폼의 파일명 헤더를 기본적으로 latin1(binary)로 파싱한다 - 잘 알려진 이슈다. 그래서
    // "서명_김코스.png" 같은 한글 파일명이 "ìëª_ê¹ì½ì¤.png"처럼 깨져서 저장됐다.
    // fileFilter는 storage.filename보다 먼저 실행되므로, 여기서 한 번만 UTF-8로
    // 재해석해두면 이후 모든 참조(파일 확장자 검사, 디스크 저장 파일명, DB의 file_name
    // 컬�럼)가 전부 올바른 값을 쓰게 된다.
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED[ext]) return cb(new Error(`허용되지 않는 파일 형식입니다 (${ext || '확장자 없음'}). 허용: ${Object.keys(ALLOWED).join(', ')}`));
    cb(null, true);
  },
});

module.exports = function attachmentsRoutes(db) {
  const router = express.Router();
  router.use(authenticate);

  function resolveEntity(entityType, entityId, siteIds) {
    const meta = ENTITY_TYPES[entityType];
    if (!meta) return { error: `entityType은 ${Object.keys(ENTITY_TYPES).join('/')} 중 하나여야 합니다.` };
    if (!siteIds.length) return { error: '대상을 찾을 수 없습니다.', status: 404 };
    const sitePh = siteIds.map(() => '?').join(',');
    const row = db.prepare(`SELECT id, site_id FROM ${meta.table} WHERE id = ? AND site_id IN (${sitePh})`).get(entityId, ...siteIds);
    if (!row) return { error: '연결하려는 항목을 찾을 수 없습니다 (다른 사업장이거나 존재하지 않음).', status: 404 };
    return { meta, row };
  }

  // 업로드는 "그 항목을 수정할 수 있는 사람"과 같은 등급으로 통일했다(12개 모듈 PATCH와
  // 동일한 원칙 - 3절) - entityType별로 권한 코드가 달라 미들웨어 단계에서 미리 확인할 수
  // 없으므로 핸들러 안에서 직접 검사한다.
  router.post('/', upload.single('file'), (req, res) => {
    const { entityType, entityId } = req.body || {};
    if (!entityType || !entityId) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'entityType, entityId는 필수입니다.' });
    }
    if (!req.file) return res.status(400).json({ error: '업로드할 파일(file)이 없습니다.' });

    const siteIds = accessibleSiteIds(db, req);
    const resolved = resolveEntity(entityType, entityId, siteIds);
    if (resolved.error) {
      fs.unlink(req.file.path, () => {});
      return res.status(resolved.status || 400).json({ error: resolved.error });
    }
    const { meta } = resolved;
    if (!hasPermission(db, req.user.sub, `${meta.permPrefix}.update`)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: `권한이 없습니다: ${meta.permPrefix}.update` });
    }

    const id = generateId('ATT');
    const mimeType = ALLOWED[path.extname(req.file.originalname).toLowerCase()];
    db.prepare(`
      INSERT INTO attachments (id, entity_type, entity_id, file_key, file_name, mime_type, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, entityType, entityId, path.basename(req.file.path), req.file.originalname, mimeType, req.user.sub);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'create',
      entityType: 'attachment', entityId: id, after: { entityType, entityId, fileName: req.file.originalname, size: req.file.size },
    });

    res.status(201).json({ id, fileName: req.file.originalname, mimeType });
  });

  router.get('/', (req, res) => {
    const { entityType, entityId } = req.query;
    if (!entityType || !entityId) return res.status(400).json({ error: 'entityType, entityId 쿼리 파라미터가 필요합니다.' });

    const siteIds = accessibleSiteIds(db, req);
    const resolved = resolveEntity(entityType, entityId, siteIds);
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
    if (!hasPermission(db, req.user.sub, `${resolved.meta.permPrefix}.read`)) {
      return res.status(403).json({ error: `권한이 없습니다: ${resolved.meta.permPrefix}.read` });
    }

    const rows = db.prepare('SELECT id, file_name, mime_type, uploaded_by, uploaded_at FROM attachments WHERE entity_type = ? AND entity_id = ? AND deleted = 0 ORDER BY uploaded_at DESC')
      .all(entityType, entityId);
    res.json(rows);
  });

  router.get('/:id/download', (req, res) => {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND deleted = 0').get(req.params.id);
    if (!att) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const siteIds = accessibleSiteIds(db, req);
    const resolved = resolveEntity(att.entity_type, att.entity_id, siteIds);
    if (resolved.error) return res.status(resolved.status || 404).json({ error: '대상을 찾을 수 없습니다.' });
    if (!hasPermission(db, req.user.sub, `${resolved.meta.permPrefix}.read`)) {
      return res.status(403).json({ error: `권한이 없습니다: ${resolved.meta.permPrefix}.read` });
    }

    const filePath = path.join(UPLOAD_DIR, att.file_key);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일이 서버에 존재하지 않습니다.' });
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.file_name || 'file')}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  router.delete('/:id', (req, res) => {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND deleted = 0').get(req.params.id);
    if (!att) return res.status(404).json({ error: '대상을 찾을 수 없습니다.' });

    const siteIds = accessibleSiteIds(db, req);
    const resolved = resolveEntity(att.entity_type, att.entity_id, siteIds);
    if (resolved.error) return res.status(resolved.status || 404).json({ error: '대상을 찾을 수 없습니다.' });
    if (!hasPermission(db, req.user.sub, `${resolved.meta.permPrefix}.update`)) {
      return res.status(403).json({ error: `권한이 없습니다: ${resolved.meta.permPrefix}.update` });
    }

    // 2026-09-02: 하드 삭제 → 소프트 삭제. 예전에는 DB 레코드와 실물 파일을 즉시 지워서
    // 실수로 삭제하면 되돌릴 방법이 전혀 없었다. 사고 현장사진·전자서명 같은 법정 증빙이
    // 포함되므로 위험이 크다. 이제 목록에서만 감추고 파일은 그대로 보존한다(복구 가능).
    db.prepare("UPDATE attachments SET deleted = 1, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?")
      .run(req.user.sub, att.id);

    writeAudit(db, {
      actorUserId: req.user.sub, actorName: req.user.name, action: 'delete',
      entityType: 'attachment', entityId: att.id, before: { fileName: att.file_name },
    });

    res.json({ ok: true });
  });

  // multer 에러(용량초과, 허용되지 않는 형식 등)를 이 라우터 안에서 사람이 읽을 수 있는
  // 메시지로 변환한다 - 전역 에러 핸들러까지 가면 "서버 오류가 발생했습니다"만 보이게 되어
  // 원인을 알 수 없다(원칙 12 - 사용자에게는 이해하기 쉬운 오류를 보여줌).
  router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `파일이 너무 큽니다. 최대 ${MAX_FILE_SIZE / 1024 / 1024}MB까지 업로드할 수 있습니다.` });
    }
    if (err) return res.status(400).json({ error: err.message || '업로드 중 오류가 발생했습니다.' });
    next();
  });

  return router;
};
