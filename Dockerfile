# better-sqlite3는 플랫폼별 프리빌드 바이너리를 받아오는 방식이라, glibc 기반인 slim
# 이미지를 사용합니다. alpine(musl)으로 바꾸면 소스 컴파일이 필요해질 수 있어 피했습니다.
FROM node:22-slim

WORKDIR /app

# 의존성 레이어를 소스 코드와 분리해 캐시 효율을 높임
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 2026-08-28 후속조치(출시전 점검보고서 3절): root로 컨테이너를 실행하고 있었다.
# node:22-slim에는 UID 1000의 'node' 유저가 이미 들어있으므로 그걸 쓴다.
# /app/data(VOLUME)에 비루트 유저가 쓸 수 있도록 소유권을 먼저 넘겨준다.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# SQLite 파일은 이 경로에 저장됩니다. 컨테이너 자체는 재배포 때마다 새로 만들어지므로,
# 이 경로에 플랫폼의 영구 볼륨(Railway Volume, Fly Volume 등)을 마운트해야
# 재배포/재시작 후에도 데이터가 살아남습니다 (README 3절 "배포 준비" 참고).
# 2026-08-28: 첨부파일 업로드(uploads/)도 이 경로 아래(DB_PATH와 같은 디렉터리)에 저장되므로
# 같은 볼륨 마운트 하나로 DB와 업로드 파일이 함께 보존됩니다 - 별도 설정이 필요 없습니다.
ENV DB_PATH=/app/data/data.sqlite
VOLUME ["/app/data"]

ENV PORT=4000
EXPOSE 4000

# curl/wget 없이 Node 자체로 헬스체크 (slim 이미지 용량을 늘리지 않기 위함)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4000)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
