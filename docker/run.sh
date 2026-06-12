#!/usr/bin/env bash
# docloom 컨테이너 기동(백그라운드). 브라우저 데모(GET) + HTTP API(POST)를 8002에서 제공.
#   이미지 빌드/갱신: docker build -t docloom:latest .
# 리버스 프록시(cookie-proxy)가 dev.docloom.cookie.ai.kr → 127.0.0.1:8002 로 프록시한다.
set -euo pipefail
cd "$(dirname "$0")/.."

docker rm -f docloom 2>/dev/null || true

# .env 가 있으면 OLLAMA_HOST/MODEL 등을 컨테이너에 주입(없으면 생략).
#   PORT 는 .env 값(로컬용 8080)이 아니라 컨테이너 포트 8002 를 강제(-e 가 --env-file 보다 우선).
#   OLLAMA_HOST 의 10.152.0.3 은 컨테이너→호스트 라우팅(NAT)으로 도달한다.
ENV_ARGS=()
[[ -f .env ]] && ENV_ARGS+=(--env-file .env)

# -p 127.0.0.1:8002:8002: 호스트 루프백에만 바인드(외부 직접 노출 차단, nginx 경유만).
docker run -d \
  --name docloom \
  -p 127.0.0.1:8002:8002 \
  "${ENV_ARGS[@]}" \
  -e PORT=8002 \
  --restart unless-stopped \
  docloom:latest

echo "started. 로그: docker logs -f docloom"
