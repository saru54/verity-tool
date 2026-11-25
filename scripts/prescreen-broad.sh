#!/bin/bash
# Broad pre-screen: test each country with 3 truly random sessions using rotating port 823
# Also adds more countries: us,de,gb,ca,fr,nl,jp,au,it,es,se,br,in
# Credentials come from config/sheerid.local.json (dataimpulse section), with
# DI_USER/DI_PASS environment variables taking precedence.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_JSON="${SCRIPT_DIR}/../config/sheerid.local.json"
if [[ -z "${DI_USER:-}" && -f "$LOCAL_JSON" ]]; then
  DI_USER="$(node -e "const c=require('${LOCAL_JSON}');process.stdout.write(c.dataimpulse?.username||'')" 2>/dev/null)"
  DI_PASS="$(node -e "const c=require('${LOCAL_JSON}');process.stdout.write(c.dataimpulse?.password||'')" 2>/dev/null)"
fi
: "${DI_USER:?set DI_USER or add dataimpulse.username to config/sheerid.local.json}"
: "${DI_PASS:?set DI_PASS or add dataimpulse.password to config/sheerid.local.json}"
DI_HOST="${DI_HOST:-gw.dataimpulse.com}"
DI_PORT="${DI_PORT:-10000}"

COUNTRIES="us de gb ca fr nl jp au it es se br"

echo "========== BROAD PRE-SCREEN (rotating, 3 random per country) =========="
echo "Country | Attempt | Exit IP | Proxy | Hosting | ISP | Geo"
echo "--------|---------|---------|-------|---------|-----|-----"

for country in $COUNTRIES; do
  for i in 1 2 3; do
    # Use rotating port + random sessid for maximum IP variety
    sessid="${country}_$(date +%s)_$RANDOM"
    proxy_url="http://${DI_USER}__cr.${country};sessid.${sessid}:${DI_PASS}@${DI_HOST}:${DI_PORT}"
    exit_ip=$(curl -s --max-time 15 --proxy "$proxy_url" "http://api.ipify.org/" 2>/dev/null)
    if [ -z "$exit_ip" ]; then
      echo "$country | $i | FAILED | - | - | - | -"
      continue
    fi
    ip_info=$(curl -s --max-time 10 "http://ip-api.com/json/${exit_ip}?fields=query,country,isp,proxy,hosting" 2>/dev/null)
    proxy_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('proxy','?'))" 2>/dev/null)
    hosting_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hosting','?'))" 2>/dev/null)
    isp=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isp','?'))" 2>/dev/null | cut -c1-35)
    geo=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('country','?'))" 2>/dev/null)
    echo "$country | $i | $exit_ip | $proxy_flag | $hosting_flag | $isp | $geo"
    sleep 1
  done
done

echo ""
echo "DONE - $(date)"
