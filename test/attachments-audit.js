// 첨부파일 업로드(출시전 점검보고서 3절) 검증 스크립트 - 리뷰/회귀테스트 전용
const BASE = 'http://localhost:4000';
const Database = require('better-sqlite3');
const path = require('path');
const { bootstrapTestOrg } = require('./_helpers');
const fs = require('fs');

async function apiJson(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function upload(entityType, entityId, fileBuffer, fileName, token) {
  const form = new FormData();
  form.append('entityType', entityType);
  form.append('entityId', entityId);
  form.append('file', new Blob([fileBuffer]), fileName);
  const res = await fetch(BASE + '/attachments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label, '-> 실제:', JSON.stringify(cond)); }
}

(async () => {
  const orgResult = await bootstrapTestOrg(BASE);
  const org = { id: orgResult.orgId };
  const site = { id: orgResult.siteId };

  await apiJson('POST', '/auth/register', { orgId: org.id, siteId: site.id, loginId: 'file.admin', password: 'Test1234!', name: '관리자' });
  const adminLogin = await apiJson('POST', '/auth/login', { loginId: 'file.admin', password: 'Test1234!' });
  const adminToken = adminLogin.data.token;
  await apiJson('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, adminToken);

  await apiJson('POST', '/auth/register', { orgId: org.id, siteId: site.id, loginId: 'file.worker', password: 'Test1234!', name: '근로자' });
  const workerLogin = await apiJson('POST', '/auth/login', { loginId: 'file.worker', password: 'Test1234!' });
  const workerToken = workerLogin.data.token;
  await apiJson('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, workerToken);

  const nm = await apiJson('POST', '/nearmiss', { content: '첨부파일 테스트용 아차사고' }, adminToken);

  console.log('=== 1. 정상 업로드/조회/다운로드 ===');
  const fakeImage = Buffer.from('가짜 이미지 바이트열입니다 - 실제 이미지 포맷은 아니지만 확장자/화이트리스트 테스트에는 문제없음');
  const up1 = await upload('near_miss', nm.data.id, fakeImage, 'photo.jpg', adminToken);
  assert(up1.status === 201 && !!up1.data.id, 'update 권한이 있으면 파일 업로드 성공');

  const list1 = await apiJson('GET', `/attachments?entityType=near_miss&entityId=${nm.data.id}`, null, adminToken);
  assert(list1.status === 200 && list1.data.length === 1 && list1.data[0].file_name === 'photo.jpg', '목록조회에 방금 올린 파일이 원본 파일명 그대로 보임');

  const dl1 = await fetch(`${BASE}/attachments/${up1.data.id}/download`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const dlBuf = Buffer.from(await dl1.arrayBuffer());
  assert(dl1.status === 200 && dlBuf.equals(fakeImage), '다운로드한 내용이 업로드한 원본과 바이트 단위로 동일함');
  assert(dl1.headers.get('content-type') === 'image/jpeg', 'Content-Type이 확장자에 맞게 설정됨');

  console.log('\n=== 2. 권한/검증 ===');
  const upDenied = await upload('near_miss', nm.data.id, fakeImage, 'photo2.jpg', workerToken);
  assert(upDenied.status === 403, 'worker(update 권한 없음)는 업로드할 수 없다');

  const upBadType = await upload('near_miss', nm.data.id, Buffer.from('#!/bin/sh\necho pwned'), 'evil.sh', adminToken);
  assert(upBadType.status === 400, '허용되지 않은 확장자(.sh)는 거부된다');

  const upBadEntity = await upload('not_a_real_entity', nm.data.id, fakeImage, 'photo.jpg', adminToken);
  assert(upBadEntity.status === 400, '화이트리스트에 없는 entityType은 거부된다');

  const upNoSuchId = await upload('near_miss', 'NM-2026-NOTEXIST', fakeImage, 'photo.jpg', adminToken);
  assert(upNoSuchId.status === 404, '존재하지 않는 entityId는 거부된다');

  console.log('\n=== 3. 사업장 경계 ===');
  const rw = new Database(path.join(__dirname, '..', 'data.sqlite'));
  const siteBId = 'SITE-2026-FILETEST';
  rw.prepare('INSERT INTO sites (id, org_id, name) VALUES (?, ?, ?)').run(siteBId, org.id, '파일테스트 제2현장');
  rw.close();
  await apiJson('POST', '/auth/register', { orgId: org.id, siteId: siteBId, loginId: 'file.workerb', password: 'Test1234!', name: 'B현장근로자' });
  const workerBLogin = await apiJson('POST', '/auth/login', { loginId: 'file.workerb', password: 'Test1234!' });
  const workerBToken = workerBLogin.data.token;
  await apiJson('POST', '/auth/consent', { agreePrivacy: true, agreeTerms: true, agreeSensitive: true }, workerBToken);

  const dlCrossSite = await fetch(`${BASE}/attachments/${up1.data.id}/download`, { headers: { Authorization: `Bearer ${workerBToken}` } });
  assert(dlCrossSite.status === 404, 'B현장 사용자는 A현장 첨부파일을 다운로드할 수 없다 (404)');

  console.log('\n=== 4. 삭제 ===');
  const delDenied = await apiJson('DELETE', `/attachments/${up1.data.id}`, null, workerToken);
  assert(delDenied.status === 403, 'worker는 첨부파일을 삭제할 수 없다');

  const del1 = await apiJson('DELETE', `/attachments/${up1.data.id}`, null, adminToken);
  assert(del1.status === 200, 'update 권한이 있으면 삭제 성공');
  const listAfterDelete = await apiJson('GET', `/attachments?entityType=near_miss&entityId=${nm.data.id}`, null, adminToken);
  assert(listAfterDelete.data.length === 0, '삭제 후 목록에서 사라짐');

  console.log('\n=== 5. 소프트 삭제 확인 (2026-09-02) ===');
  // 사고 현장사진·전자서명 같은 법정 증빙이 첨부되므로, 실수로 삭제해도 되돌릴 수 있어야 합니다.
  const dlAfterDelete = await fetch(`${BASE}/attachments/${up1.data.id}/download`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert(dlAfterDelete.status === 404, '삭제된 첨부파일은 다운로드도 차단됨');

  const dbCheck = new Database(path.join(__dirname, '..', 'data.sqlite'), { readonly: true });
  const row = dbCheck.prepare('SELECT id, file_name, file_key, deleted, deleted_by FROM attachments WHERE id = ?').get(up1.data.id);
  dbCheck.close();
  assert(row && row.deleted === 1, 'DB 레코드가 지워지지 않고 deleted 표시만 됨(복구 가능)');
  assert(row && !!row.deleted_by, '누가 삭제했는지 기록이 남음(지침 10 - 변경이력)');
  assert(row && !!row.file_name, '원본 파일명이 보존됨');

  const uploadDir = path.join(path.dirname(require('../src/db').DB_PATH), 'uploads');
  assert(fs.existsSync(path.join(uploadDir, row.file_key)), '실제 파일도 디스크에 그대로 보존됨(예전엔 즉시 삭제되어 복구 불가였음)');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
