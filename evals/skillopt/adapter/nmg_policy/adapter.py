from __future__ import annotations

from skillopt.envs.base import EnvAdapter

from .dataloader import NmgPolicyDataLoader
from .rollout import run_batch


class NmgPolicyAdapter(EnvAdapter):
    """Offline policy-decision probe; never reads or rewrites NMG facts."""

    def __init__(self, split_dir: str = "", workers: int = 4,
                 analyst_workers: int = 4, failure_only: bool = False,
                 minibatch_size: int = 8, edit_budget: int = 4,
                 seed: int = 42, limit: int = 0,
                 max_completion_tokens: int = 256) -> None:
        self.workers = workers
        self.analyst_workers = analyst_workers
        self.failure_only = failure_only
        self.minibatch_size = minibatch_size
        self.edit_budget = edit_budget
        self.max_completion_tokens = max_completion_tokens
        self.dataloader = NmgPolicyDataLoader(
            split_dir=split_dir, split_mode="split_dir", seed=seed, limit=limit
        )

    def setup(self, cfg: dict) -> None:
        super().setup(cfg)
        self.dataloader.setup(cfg)

    def get_dataloader(self):
        return self.dataloader

    def build_env_from_batch(self, batch, **kwargs):
        return list(batch.payload or [])

    def build_train_env(self, batch_size: int, seed: int, **kwargs):
        return self.build_env_from_batch(
            self.dataloader.build_train_batch(batch_size=batch_size, seed=seed, **kwargs)
        )

    def build_eval_env(self, env_num: int, split: str, seed: int, **kwargs):
        return self.build_env_from_batch(
            self.dataloader.build_eval_batch(env_num=env_num, split=split, seed=seed, **kwargs)
        )

    def rollout(self, env_manager, skill_content: str, out_dir: str, **kwargs):
        return run_batch(
            items=list(env_manager),
            skill_content=skill_content,
            out_root=out_dir,
            workers=self.workers,
            max_completion_tokens=self.max_completion_tokens,
        )

    def get_task_types(self) -> list[str]:
        values = self.dataloader.train_items + self.dataloader.val_items + self.dataloader.test_items
        return sorted({str(item.get("task_type") or "nmg_policy") for item in values}) or [
            "nmg_policy"
        ]
