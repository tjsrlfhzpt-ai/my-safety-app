// /setup 페이지 검증 - 리뷰/회귀테스트 전용
const { JSDOM } = require('jsdom');

const BASE = 'http://localhost:4000';
let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('=== 1. 회사가 없는 상태에서 /setup 접속 -> 폼이 보임 ===');
  const dom1 = await JSDOM.fromURL(BASE + '/setup', { runScripts: 'dangerously', resources: 'usable' });
  const win1 = dom1.window;
  // jsdom 안에서 실행되는 setup-page.js는 fetch('/organizations')처럼 상대경로로 호출한다.
  // 브라우저의 window.fetch는 현재 페이지 주소 기준으로 상대경로를 알아서 풀어주지만,
  // Node의 전역 fetch는 그런 개념이 없어 절대경로가 아니면 그냥 실패한다 - 여기서 직접 풀어준다.
  win1.fetch = (url, opts) => fetch(url.startsWith('http') ? url : BASE + url, opts);
  await wait(300);
  assert(win1.document.getElementById('step-form').classList.contains('active'), '최초 상태에서는 입력 폼이 보인다');
  assert(!win1.document.getElementById('step-done').classList.contains('active'), '완료 화면은 아직 안 보인다');

  console.log('\n=== 2. 실제로 폼을 채우고 제출 ===');
  win1.document.getElementById('orgName').value = '테스트건설(주)';
  win1.document.getElementById('siteName').value = '테스트현장';
  win1.document.getElementById('loginId').value = 'setup.admin';
  win1.document.getElementById('name').value = '셋업관리자';
  win1.document.getElementById('password').value = 'Test1234!';
  win1.document.getElementById('password2').value = 'Test1234!';
  win1.eval('submitSetup()');
  await wait(800);

  assert(win1.document.getElementById('step-done').classList.contains('active'), '제출 성공 시 완료 화면으로 전환된다');
  assert(win1.document.getElementById('doneLoginId').textContent === 'setup.admin', '완료 화면에 방금 만든 아이디가 정확히 표시된다');

  console.log('\n=== 3. 실제로 로그인되는지 확인 ===');
  const login = await (await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'setup.admin', password: 'Test1234!' }),
  })).json();
  assert(login.user && login.user.roles.includes('company_admin'), '방금 폼으로 만든 계정이 실제로 로그인되고, 회사 최고관리자 권한을 갖는다');

  console.log('\n=== 4. 비밀번호 불일치 시 명확히 안내 ===');
  const dom2 = await JSDOM.fromURL(BASE + '/setup', { runScripts: 'dangerously', resources: 'usable' });
  // 이미 회사가 1개 있으므로 이번엔 안내 화면이 나와야 함
  await wait(300);
  assert(dom2.window.document.body.textContent.includes('이미 시작된 서버'), '회사가 이미 있으면 폼 대신 안내 문구만 보인다(중복 생성 방지)');

  console.log('\n==================================================');
  console.log(`결과: ${passed}건 통과, ${failed}건 실패`);
  console.log('==================================================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('스크립트 오류:', e); process.exit(1); });
