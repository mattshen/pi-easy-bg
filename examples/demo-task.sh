#!/usr/bin/env bash
# demo-task.sh — easy-bg practice script: "query RTX 5090 prices", ~10s, prints 3 offers
#
# NOTE: the three offers below are illustrative sample data written into this file.
#       The script does not access the network. Do not use these prices for a real purchase.
#
# 用法: bash demo-task.sh [--steps <轮数>] [--gap <每轮秒数>] [--fail] [--spam] [--watchme <标记>]
#   默认 steps=2 gap=5  -> 约 10s
#   旧练习仍可用: --steps 3 --gap 6  -> 约 18s（配 --timeout 8 可验 TIMEOUT）
set -u
GAP=5 STEPS=2 FAIL=0 SPAM=0 WATCHME=""
while [ $# -gt 0 ]; do
	case "$1" in
		--gap) GAP=$2; shift 2 ;;
		--steps) STEPS=$2; shift 2 ;;
		--fail) FAIL=1; shift ;;
		--spam) SPAM=1; shift ;;
		--watchme) WATCHME=$2; shift 2 ;;
		*) shift ;;
	esac
done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
T0=$(date +%s)

[ -n "$WATCHME" ] && log "watch marker: $WATCHME"
log "task start pid=$$ ppid=$PPID query=\"RTX 5090 price\" sources=3 steps=$STEPS gap=${GAP}s"

log "querying AU/NZ retailer stock feeds ..."
i=1
while [ "$i" -le "$STEPS" ]; do
	log "search round $i/$STEPS ..."
	[ "$SPAM" = 1 ] && for n in 1 2 3 4 5; do log "  fetch page $n round $i"; done
	sleep "$GAP"
	i=$((i + 1))
done

for host in centrecom.com.au scorptech.com umart.com.cn; do
	log "source $host ... 1 offer"
done

rows() {
	printf '%s\n' \
		"[result 1/3] ASUS ROG Strix RTX 5090 OC 32GB     | \$2,489 AUD | in stock: yes               | warranty 3y local   | psu rec 1000W | https://www.centrecom.com.au/asus-rog-strix-rtx-5090-32gb" \
		"[result 2/3] Gigabyte Aorus MASTER RTX 5090 32GB | \$2,299 AUD | in stock: only 2 left       | warranty 3y local   | psu rec 1000W | https://www.scorptech.com/gigabyte-aorus-rtx-5090-master-rtx-5090" \
		"[result 3/3] ZOTAC RTX 5090 SOLID DX 32GB        | \$1,999 AUD | in stock: CN warehouse 4-8w | warranty 2y int'l RMA | psu rec 850W | https://www.umart.com.cn/zotac-rtx-5090-soliddx-32gb"
}
rows

ELAPSED=$(( $(date +%s) - T0 ))
log "3 offers collected in ${ELAPSED}s. spread=\$490 (cheapest \$1,999 / highest \$2,489); in-stock-now=\$2,489 ASUS, \$2,299 Gigabyte(2 left); cheapest=\$1,999 ZOTAC(CN warehouse 4-8 weeks)"
[ -n "$WATCHME" ] && log "watch marker repeat: $WATCHME"
if [ "$FAIL" = 1 ]; then log "forced failure"; exit 3; fi
log "task finished ok (exit 0) after ${ELAPSED}s"
