// 2026-08-30: SaaS 전환으로 서버가 더 이상 기동 시 기본 조직을 자동생성하지 않는다
// (src/seed.js 참고 - 이제 조직은 실제 가입 절차로만 생긴다). 테스트마다 필요한 조직을
// 실제 API로 직접 만들도록 통일한 공용 헬퍼.
async function bootstrapTestOrg(baseUrl, orgName, siteName) {
  const res = await fetch(`${baseUrl}/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: orgName || `테스트조직-${Date.now()}`, siteName: siteName || '테스트사업장' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('테스트 조직 생성 실패: ' + (data.error || res.status));
  return { orgId: data.orgId, siteId: data.siteId };
}

module.exports = { bootstrapTestOrg };
