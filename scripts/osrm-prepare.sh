#!/usr/bin/env sh
# Build the OSRM car routing graph for the Philippines (travel times, driving directions). One time, about 2 minutes
# here, ~5 GB RAM. It uses Philippine speed limits (scripts/osrm/car-ph.lua); after rebuilding it, run
# `npm run travel:build` and `npm run simulate`.
#   1. download:  curl -L -o data/osm/philippines.osm.pbf https://download.geofabrik.de/asia/philippines-latest.osm.pbf
#   2. run this:  sh scripts/osrm-prepare.sh
#   3. serve it:  docker compose --profile routing up -d --force-recreate osrm
# Re-run after downloading a newer extract or changing car-ph.lua.
set -eu
cd "$(dirname "$0")/.."
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v6.0.0}"
PBF="philippines.osm.pbf"
test -f "data/osm/$PBF" || { echo "data/osm/$PBF not found (see step 1 above)"; exit 1; }
run() { docker run --rm -t -v "$PWD/data/osm:/data" -v "$PWD/scripts/osrm:/profiles:ro" "$IMAGE" "$@"; }
# car graph: philippines.osrm.*
run osrm-extract -p /profiles/car-ph.lua "/data/$PBF"
run osrm-partition "/data/${PBF%.osm.pbf}.osrm"
run osrm-customize "/data/${PBF%.osm.pbf}.osrm"
echo "Done. Start or restart the server: docker compose --profile routing up -d --force-recreate osrm"
