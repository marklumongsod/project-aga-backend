#!/usr/bin/env sh
# Build the OSRM routing graphs for the Philippines: car (travel times, driving directions) and foot (walking
# directions). One time, about 2 minutes each here, ~5 GB RAM. The car graph uses Philippine speed limits
# (scripts/osrm/car-ph.lua); after rebuilding it, run `npm run travel:build` and `npm run simulate`.
#   sh scripts/osrm-prepare.sh car   rebuilds only the car graph
#   1. download:  curl -L -o data/osm/philippines.osm.pbf https://download.geofabrik.de/asia/philippines-latest.osm.pbf
#   2. run this:  sh scripts/osrm-prepare.sh
#   3. serve it:  docker compose --profile routing up -d osrm osrm-foot
# Re-run after downloading a newer extract.
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
[ "${1:-}" = "car" ] && { echo "Done (car only). Restart it: docker compose --profile routing up -d --force-recreate osrm"; exit 0; }

# foot graph: the same map under another name so the two sets of files don't overwrite each other
ln -sf "$PBF" "data/osm/philippines-foot.osm.pbf"
run osrm-extract -p /opt/foot.lua /data/philippines-foot.osm.pbf
run osrm-partition /data/philippines-foot.osrm
run osrm-customize /data/philippines-foot.osrm
echo "Done. Start the servers: docker compose --profile routing up -d osrm osrm-foot"
