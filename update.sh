#!/bin/sh
# Updates Prusaslicer - Web Boss on a server that runs it from a checkout of this repo:
# pulls the latest version from GitHub, rebuilds what changed and restarts the app.
#
#   cd /opt/prusaslicer-web-boss && sudo sh update.sh
#
# BOSS itself is pinned in the Dockerfile, so it's only recompiled when that pin moves (an
# hour or more); other changes rebuild in minutes. The app keeps running during the build.
# BUILD_JOBS sets the parallel compile jobs (default 6; each can take ~2 GB of memory).
set -eu

cd "$(dirname "$0")"
if [ "$(id -u)" -ne 0 ]; then
    echo "run it as root: sudo sh update.sh" >&2
    exit 1
fi

before=$(git rev-parse --short HEAD)
echo "== pulling from GitHub"
git pull --ff-only
after=$(git rev-parse --short HEAD)
if [ "$before" = "$after" ]; then
    echo "already at $after; rebuilding anyway, in case the last build didn't finish"
else
    echo "$before -> $after:"
    git log --oneline "$before..$after"
fi

echo "== building (BOSS $(sed -n 's/^ARG SLICER_COMMIT=\(.......\).*/\1/p' Dockerfile))"
docker compose build --build-arg BUILD_JOBS="${BUILD_JOBS:-6}"

echo "== restarting"
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

# The gateway answers once the app is up (checked from inside: the container has no curl)
i=0
until docker exec prusaslicer-web-boss python3 -c \
        "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health', timeout=5)" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
        echo "the app didn't come up; its log:" >&2
        docker logs --tail 30 prusaslicer-web-boss >&2
        exit 1
    fi
    sleep 2
done
echo "updated to $after: http://$(hostname -I | cut -d' ' -f1):8960"
