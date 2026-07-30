// ============================================================
// 안전관리 시스템 - 정적 파일 서버 + AI 비서 백엔드 프록시
// ------------------------------------------------------------
// 이 서버가 하는 일 2가지:
//   1) index.html 등 정적 파일을 제공합니다.
//   2) /api/ai-assist 요청을 받아, 서버에만 보관된 Anthropic API 키로
//      Claude를 대신 호출하고 결과만 브라우저로 돌려줍니다.
// index.html(브라우저)에는 절대 API 키가 들어가지 않습니다.
// 프론트엔드에 키를 넣으면 누구나 페이지 소스에서 볼 수 있어 도용될 수 있기 때문입니다.
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(__dirname)); // 이 폴더에 index.html을 함께 두면 정적 파일로 서비스됩니다.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

if (!ANTHROPIC_API_KEY) {
    console.warn('[경고] ANTHROPIC_API_KEY 환경변수가 없습니다. .env 파일을 확인하세요. AI 비서 기능이 동작하지 않습니다.');
}

// ------------------------------------------------------------
// 매우 단순한 IP 기반 사용량 제한 (임시 보호장치)
// 아직 로그인/RBAC 시스템이 없으므로, 한 사람(또는 봇)이 과도하게
// 호출해 API 비용이 급증하는 것을 막기 위한 최소한의 안전장치입니다.
// 추후 로그인 기능이 추가되면 사용자 단위 제한으로 교체하는 것을 권장합니다.
// ------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 12; // 1분당 IP 하나에서 최대 12회
const requestLog = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    requestLog.set(ip, timestamps);
    return timestamps.length > RATE_LIMIT_MAX;
}

// ------------------------------------------------------------
// 모드별 시스템 프롬프트
// ------------------------------------------------------------
const SYSTEM_PROMPTS = {
    risk: `당신은 대한민국 산업안전보건법에 정통한 안전관리 전문가입니다. 사용자가 설명하는 작업/공정에 대해 위험성평가 항목을 작성하세요.
반드시 아래 JSON 형식으로만 응답하고, 다른 설명이나 코드블록 표시(백틱)는 절대 포함하지 마세요:
{"process": "공정명", "title": "작업명", "hazard": "구체적인 위험요인", "riskLevel": "상 또는 중 또는 하 중 하나", "measure": "구체적인 개선대책"}`,

    tbm: `당신은 현장 안전관리자입니다. 사용자가 설명하는 오늘의 작업 내용을 바탕으로, 작업 전 10분 안전점검(TBM)에서 실제로 말할 내용을 작성하세요.
오늘의 핵심 주제 1개와 구체적으로 확인해야 할 사항 3~4가지를 한국어로 자연스럽게 작성하세요. JSON이 아닌 일반 텍스트로, 현장 관리자가 그대로 읽고 진행할 수 있는 수준으로 작성하세요.`,

    cause: `당신은 산업재해 원인분석 전문가입니다. 사용자가 설명하는 사고/아차사고 상황에 대해 5-Why 기법으로 근본원인을 분석하세요.
"Why 1"부터 근본원인이 나올 때까지 단계적으로 분석하고, 마지막에 실질적인 재발방지대책을 제시하세요. 일반 텍스트로 작성하세요.`,

    report: `당신은 안전보건 실적 보고서를 작성하는 안전관리자입니다. 제공된 실제 데이터(건수, 완료율 등)만 바탕으로
이번 달 안전보건 실적 요약 보고서를 작성하세요. 제공되지 않은 수치는 절대로 지어내지 마세요.
간결한 개조식 보고서 형식으로 작성하세요. 일반 텍스트로 작성하세요.`
};

function buildUserMessage(mode, input, context) {
    if (mode === 'report') {
        const c = context || {};
        return `다음은 이번 달(${c.month || ''}월) 현재까지 집계된 실제 데이터입니다.
- 위험성평가: 총 ${c.riskTotal || 0}건 (완료 ${c.riskDone || 0}건, 개선진행 ${c.riskInProgress || 0}건)
- 안전교육: ${c.eduCount || 0}건${c.eduList && c.eduList.length ? ' (' + c.eduList.join(', ') + ')' : ''}
- Near Miss(아차사고): 총 ${c.nearmissCount || 0}건 (완료 ${c.nearmissDone || 0}건)
- 작업허가(PTW): ${c.ptwCount || 0}건
- 건강진단 대상: ${c.healthCount || 0}건
위 데이터만 사용해서 이번 달 실적 보고서를 작성해주세요.`;
    }
    return String(input || '').slice(0, 2000);
}

app.post('/api/ai-assist', async (req, res) => {
    try {
        const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
        if (isRateLimited(ip)) {
            return res.status(429).json({ success: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' });
        }

        if (!ANTHROPIC_API_KEY) {
            return res.status(500).json({ success: false, error: '서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다. 관리자에게 문의하세요.' });
        }

        const { mode, input, context } = req.body || {};
        if (!SYSTEM_PROMPTS[mode]) {
            return res.status(400).json({ success: false, error: '지원하지 않는 요청입니다.' });
        }
        if (mode !== 'report' && (!input || String(input).trim().length === 0)) {
            return res.status(400).json({ success: false, error: '입력 내용이 필요합니다.' });
        }

        const userMessage = buildUserMessage(mode, input, context);

        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1024,
                system: SYSTEM_PROMPTS[mode],
                messages: [{ role: 'user', content: userMessage }]
            })
        });

        if (!apiRes.ok) {
            const errText = await apiRes.text();
            console.error('Anthropic API 오류:', apiRes.status, errText);
            return res.status(502).json({ success: false, error: `AI 서버 호출에 실패했습니다 (${apiRes.status})` });
        }

        const apiData = await apiRes.json();
        const textBlock = (apiData.content || []).find(b => b.type === 'text');
        const rawText = textBlock ? textBlock.text : '';

        if (mode === 'risk') {
            let parsed;
            try {
                const cleaned = rawText.replace(/```json|```/g, '').trim();
                parsed = JSON.parse(cleaned);
            } catch (e) {
                console.error('JSON 파싱 실패. 원문:', rawText);
                return res.status(502).json({ success: false, error: 'AI 응답을 해석하지 못했습니다. 다시 시도해주세요.' });
            }
            return res.json({ success: true, mode, result: parsed });
        }

        return res.json({ success: true, mode, result: rawText });

    } catch (err) {
        console.error('AI 비서 처리 오류:', err);
        return res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`안전관리 시스템 서버 실행 중: http://localhost:${PORT}`);
    if (!ANTHROPIC_API_KEY) {
        console.log('※ ANTHROPIC_API_KEY 미설정 - AI 비서 기능은 비활성 상태입니다.');
    }
});

module.exports = { app, buildUserMessage, isRateLimited };
