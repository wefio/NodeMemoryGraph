#!/bin/bash
# HaluMem 全量评测进度检查（每个环节的信息）
D=".benchmarks/official/OmniMemEval/results/halumem/nmg-supersession_trial18"
LOG="/tmp/hm-t18.log"
NOW=$(date +%H:%M:%S)

echo "════════ 进度检查 $NOW ════════"
# 1. 进程
echo "【进程】$(ps -p 4373 >/dev/null 2>&1 && echo '存活 (PID 4373)' || echo '已结束')"
# 2. 阶段判断（从日志最近非-session 行）
STAGE=$(grep -vE "^\[nmg\] Session" "$LOG" | grep -oE "\[[0-9]/6\] [A-Za-z ]+" | tail -1)
echo "【阶段】${STAGE:-（日志无阶段标记）}"
# 3. ingest 进度
P=$(grep -o "hm_exp_user_supersession_trial18_[0-9a-f-]*" "$LOG" | sort -u | wc -l)
S=$(grep -o "_hm_session_[0-9]*" "$LOG" | tail -1 | grep -o "[0-9]*")
echo "【ingest】persona $P/20，最新 session $S"
# 4. 各阶段状态文件（生成后读内容）
for f in nmg_hm_ingestion_stats.json nmg_hm_search_status.json nmg_hm_response_status.json nmg_hm_judged.json; do
  FP="$D/$f"
  if [ -f "$FP" ]; then
    # json 里找进度字段
    INFO=$(python -c "
import json,sys
try:
    d=json.load(open(r'$FP',encoding='utf-8'))
    if isinstance(d,dict):
        keys=[k for k in ('total','completed','success','failed','status','question_count','records') if k in d]
        parts=[f'{k}={d[k]}' for k in keys]
        print(' '.join(parts) if parts else 'keys='+','.join(list(d.keys())[:6]))
    elif isinstance(d,list):
        print(f'len={len(d)}')
except Exception as e:
    print('读取失败')
" 2>/dev/null)
    echo "【$f】存在 → $INFO"
  else
    echo "【$f】未生成"
  fi
done
# 5. judged 问数（如果 judge 阶段）
J="$D/nmg_hm_judged.json"
if [ -f "$J" ]; then
  N=$(python -c "import json;d=json.load(open(r'$J',encoding='utf-8'));print(len(d) if isinstance(d,(list,dict)) else 0)" 2>/dev/null || echo "?")
  echo "【judge】$N/3467 问"
fi
# 6. 日志最近非-session 3 行（当前正在做什么）
echo "【日志】最近动作："
grep -vE "^\[nmg\] Session" "$LOG" | tail -3 | sed 's/^/    /'
echo "════════════════════════════════"
