import json
import os
import sys
import types

# LoCoMo imports bert_score at module load even though its official QA F1 path
# does not use it. Avoid installing torch for an unreachable metric.
bert_score = types.ModuleType("bert_score")
bert_score.score = lambda *args, **kwargs: None
sys.modules["bert_score"] = bert_score

root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sys.path.insert(0, os.path.join(root, ".benchmarks", "official", "LoCoMo"))
from task_eval.evaluation import eval_question_answering

payload = json.load(sys.stdin)
scores, _, recalls = eval_question_answering(payload["qas"], "prediction")
json.dump({"scores": scores, "recalls": recalls}, sys.stdout)
