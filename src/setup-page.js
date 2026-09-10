// 2026-08-30: 첫 회사(조직)+관리자 계정을 만들려면 지금까지 터미널에서 curl 명령을 직접
// 입력해야 했다 - 비개발자에게는 전혀 "쉬운" 절차가 아니다. 서버가 이 정적 페이지 하나를
// 직접 서빙해서, 브라우저로 서버 주소 + "/setup"에 들어가기만 하면 폼 입력만으로 끝나게 한다.
// 별도 호스팅이나 빌드 과정이 필요 없다 - 서버 배포와 동시에 항상 이 주소에서 쓸 수 있다.
function setupPageHtml() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>안전미어캣 프로 — 시작하기</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --border:#334155; --text:#f1f5f9; --dim:#94a3b8; --accent:#f59e0b; --accent-ink:#1e1300; --danger:#f43f5e; --ok:#10b981; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:420px; background:var(--panel); border:1px solid var(--border); border-radius:20px; padding:32px 28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--dim); font-size:13px; margin:0 0 28px; line-height:1.5; }
  label { display:block; font-size:13px; font-weight:700; margin:16px 0 6px; }
  label .opt { font-weight:400; color:var(--dim); }
  input { width:100%; padding:12px 14px; border-radius:12px; border:1px solid var(--border); background:#0b1220; color:var(--text); font-size:15px; }
  input:focus { outline:none; border-color:var(--accent); }
  .hint { font-size:11px; color:var(--dim); margin-top:4px; }
  button { width:100%; margin-top:28px; padding:14px; border-radius:12px; border:none; background:var(--accent); color:var(--accent-ink); font-weight:800; font-size:15px; cursor:pointer; }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  .msg { margin-top:16px; padding:14px; border-radius:12px; font-size:13px; line-height:1.6; display:none; }
  .msg.error { display:block; background:rgba(244,63,94,0.12); border:1px solid rgba(244,63,94,0.35); color:#fda4af; }
  .msg.success { display:block; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.35); color:#6ee7b7; }
  .msg b { color: var(--text); }
  .step { display:none; }
  .step.active { display:block; }
</style>
</head>
<body>
  <div class="card">
    <div id="step-form" class="step active">
      <h1>🦫 안전미어캣 프로 시작하기</h1>
      <p class="sub">이 서버를 처음 쓰기 위한 회사 정보와 관리자 계정을 만듭니다. 딱 한 번만 하면 됩니다.</p>

      <label>회사(조직) 이름 *</label>
      <input id="orgName" type="text" placeholder="예: 대한건설(주)">

      <label>첫 현장(사업장) 이름 <span class="opt">(나중에 추가해도 됩니다)</span></label>
      <input id="siteName" type="text" placeholder="예: 강남 오피스텔 신축현장">

      <label>관리자 아이디 *</label>
      <input id="loginId" type="text" placeholder="로그인할 때 쓸 아이디" autocomplete="username">

      <label>이름 *</label>
      <input id="name" type="text" placeholder="관리자 본인 이름">

      <label>비밀번호 *</label>
      <input id="password" type="password" placeholder="8자 이상" autocomplete="new-password">
      <div class="hint">8자 이상이면 됩니다. 다른 사람이 짐작하기 어려운 값을 쓰세요.</div>

      <label>비밀번호 확인 *</label>
      <input id="password2" type="password" placeholder="한 번 더 입력" autocomplete="new-password">

      <button id="submitBtn" onclick="submitSetup()">시작하기</button>
      <div id="msg" class="msg"></div>
    </div>

    <div id="step-done" class="step">
      <h1>✅ 준비가 끝났습니다</h1>
      <p class="sub">이제 앱(또는 관제센터)에서 아래 정보로 로그인하시면 됩니다.</p>
      <div class="msg success" style="display:block">
        <b>아이디:</b> <span id="doneLoginId"></span><br>
        <b>비밀번호:</b> 방금 입력하신 값 그대로<br><br>
        앱 설정 화면에서 "서버 주소"에 지금 이 사이트 주소를 입력하고, 위 아이디/비밀번호로 로그인하세요.
      </div>
    </div>
  </div>

<script>
async function submitSetup() {
  const orgName = document.getElementById('orgName').value.trim();
  const siteName = document.getElementById('siteName').value.trim();
  const loginId = document.getElementById('loginId').value.trim();
  const name = document.getElementById('name').value.trim();
  const password = document.getElementById('password').value;
  const password2 = document.getElementById('password2').value;
  const msgEl = document.getElementById('msg');
  const btn = document.getElementById('submitBtn');

  function showError(text) {
    msgEl.className = 'msg error';
    msgEl.textContent = text;
  }

  if (!orgName || !loginId || !name || !password) { showError('별표(*) 표시된 항목을 모두 입력해주세요.'); return; }
  if (password.length < 8) { showError('비밀번호는 8자 이상이어야 합니다.'); return; }
  if (password !== password2) { showError('비밀번호가 서로 일치하지 않습니다. 다시 확인해주세요.'); return; }

  btn.disabled = true; btn.textContent = '처리 중…';
  msgEl.className = 'msg';

  try {
    const orgRes = await fetch('/organizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: orgName, siteName: siteName || undefined }),
    });
    const orgData = await orgRes.json();
    if (!orgRes.ok) throw new Error(orgData.error || '회사 정보를 만드는 중 문제가 발생했습니다.');

    const regRes = await fetch('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgData.orgId, siteId: orgData.siteId, loginId, password, name }),
    });
    const regData = await regRes.json();
    if (!regRes.ok) throw new Error(regData.error || '관리자 계정을 만드는 중 문제가 발생했습니다.');

    document.getElementById('doneLoginId').textContent = loginId;
    document.getElementById('step-form').classList.remove('active');
    document.getElementById('step-done').classList.add('active');
  } catch (err) {
    showError(err.message || '알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    btn.disabled = false; btn.textContent = '시작하기';
  }
}
</script>
</body>
</html>`;
}

module.exports = { setupPageHtml };
