#!/bin/bash
# Quick IP pre-screen: get exit IP per country proxy, check proxy/datacenter flags
# via ip-api.com (free, no key needed, 45 req/min limit)
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

COUNTRIES="us de gb ca fr nl jp au"

echo "========== IP PRE-SCREEN =========="
echo "Country | Exit IP | Proxy | Hosting | Mobile | ISP | Org | Country(geo)"
echo "--------|---------|-------|---------|--------|-----|-----|------------"

for country in $COUNTRIES; do
  sessid="ps$RANDOM"
  proxy_url="http://${DI_USER}__cr.${country};sessid.${sessid}:${DI_PASS}@${DI_HOST}:${DI_PORT}"

  # Get exit IP through proxy
  exit_ip=$(curl -s --max-time 15 --proxy "$proxy_url" "http://api.ipify.org/" 2>/dev/null)

  if [ -z "$exit_ip" ]; then
    echo "$country | FAILED | - | - | - | - | - | -"
    continue
  fi

  # Check IP reputation via ip-api.com (through proxy, so ip-api sees the proxy IP)
  # Actually use direct connection to check the IP
  ip_info=$(curl -s --max-time 10 "http://ip-api.com/json/${exit_ip}?fields=query,country,isp,org,as,proxy,hosting,mobile" 2>/dev/null)

  proxy_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('proxy','?'))" 2>/dev/null)
  hosting_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hosting','?'))" 2>/dev/null)
  mobile_flag=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('mobile','?'))" 2>/dev/null)
  isp=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isp','?'))" 2>/dev/null)
  org=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('org','?'))" 2>/dev/null)
  geo_country=$(echo "$ip_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('country','?'))" 2>/dev/null)

  # Clean up for display
  isp=$(echo "$isp" | cut -c1-40)
  org=$(echo "$org" | cut -c1-30)

  echo "$country | $exit_ip | $proxy_flag | $hosting_flag | $mobile_flag | $isp | $org | $geo_country"
done

echo ""
echo "========== LEGEND =========="
echo "Proxy=false Hosting=false = BEST (clean residential)"
echo "Proxy=true = detected as proxy (BAD for SheerID)"
echo "Hosting=true = datacenter IP (BAD for SheerID)"
echo "Mobile=true = mobile IP (GOOD, often passes)"
