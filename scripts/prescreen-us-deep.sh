#!/bin/bash
# Deep US pre-screen: test 10 different US sessions to find clean US IPs
# Also test de, gb, ca with 5 sessions each for comparison
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

echo "========== DEEP US PRE-SCREEN (10 sessions) =========="
echo "Sess | Exit IP | Proxy | Hosting | ISP | Org"
echo "-----|---------|-------|---------|-----|-----"

for i in $(seq 1 10); do
  sessid="us_deep_$i"
  proxy_url="http://${DI_USER}__cr.us;sessid.${sessid}:${DI_PASS}@${DI_HOST}:${DI_PORT}"
  exit_ip=$(curl -s --max-time 15 --proxy "$proxy_url" "http://api.ipify.org/" 2>/dev/null)
  if [ -z "$exit_ip" ]; then
    echo "$sessid | FAILED | - | - | - | -"
    continue
  fi
  ip_info=$(curl -s --max-time 10 "http://ip-api.com/json/${exit_ip}?fields=query,isp,org,proxy,hosting" 2>/dev/null)
  proxy_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('proxy','?'))" 2>/dev/null)
  hosting_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hosting','?'))" 2>/dev/null)
  isp=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isp','?'))" 2>/dev/null | cut -c1-40)
  org=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('org','?'))" 2>/dev/null | cut -c1-30)
  echo "$sessid | $exit_ip | $proxy_flag | $hosting_flag | $isp | $org"
done

echo ""
echo "========== CLEAN COUNTRIES COMPARISON (5 sessions each) =========="
for country in de gb ca; do
  echo ""
  echo "--- $country ---"
  echo "Sess | Exit IP | Proxy | Hosting | ISP"
  for i in $(seq 1 5); do
    sessid="${country}_d_$i"
    proxy_url="http://${DI_USER}__cr.${country};sessid.${sessid}:${DI_PASS}@${DI_HOST}:${DI_PORT}"
    exit_ip=$(curl -s --max-time 15 --proxy "$proxy_url" "http://api.ipify.org/" 2>/dev/null)
    if [ -z "$exit_ip" ]; then
      echo "$sessid | FAILED | - | - | -"
      continue
    fi
    ip_info=$(curl -s --max-time 10 "http://ip-api.com/json/${exit_ip}?fields=query,isp,proxy,hosting" 2>/dev/null)
    proxy_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('proxy','?'))" 2>/dev/null)
    hosting_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hosting','?'))" 2>/dev/null)
    isp=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isp','?'))" 2>/dev/null | cut -c1-40)
    echo "$sessid | $exit_ip | $proxy_flag | $hosting_flag | $isp"
  done
done

echo ""
echo "DONE"
