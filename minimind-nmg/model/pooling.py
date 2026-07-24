"""Pooling strategies for the MiniMind-NMG Encoder."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class MaskedMeanPooling(nn.Module):
    """Mean over valid (non-padding) tokens. Default pooling."""

    def forward(self, hidden_states, attention_mask=None):
        if attention_mask is not None:
            mask = attention_mask.unsqueeze(-1).float()
            return (hidden_states * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
        return hidden_states.mean(dim=1)


class AttentionPooling(nn.Module):
    """Learned attention over token positions (like a learned CLS)."""

    def __init__(self, hidden_size: int):
        super().__init__()
        self.query = nn.Parameter(torch.randn(1, 1, hidden_size) * 0.02)
        self.scale = hidden_size ** -0.5

    def forward(self, hidden_states, attention_mask=None):
        # hidden_states: [B, S, D]
        scores = (self.query @ hidden_states.transpose(-2, -1)) * self.scale  # [1, 1, S]
        if attention_mask is not None:
            scores = scores.masked_fill(attention_mask.unsqueeze(1) == 0, float("-inf"))
        weights = F.softmax(scores, dim=-1)
        return (weights @ hidden_states).squeeze(1)  # [B, D]


class LayerWeightedPooling(nn.Module):
    """Learned weighted combination of multiple layer outputs."""

    def __init__(self, num_layers: int, layer_indices: list[int] = None):
        super().__init__()
        self.layer_indices = layer_indices or list(range(num_layers))
        self.weights = nn.Parameter(torch.ones(len(self.layer_indices)))

    def forward(self, layer_outputs: list[torch.Tensor], attention_mask=None):
        # layer_outputs: list of [B, S, D]
        w = F.softmax(self.weights, dim=0)
        if attention_mask is not None:
            mask = attention_mask.unsqueeze(-1).float()
            pooled = torch.stack([
                (h * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
                for h in [layer_outputs[i] for i in self.layer_indices]
            ])  # [L, B, D]
        else:
            pooled = torch.stack([
                h.mean(dim=1)
                for h in [layer_outputs[i] for i in self.layer_indices]
            ])
        return (w.unsqueeze(-1).unsqueeze(-1) * pooled).sum(dim=0)  # [B, D]


def get_pooling(pooling_type: str, hidden_size: int = 512, num_layers: int = 6):
    """Factory for pooling modules."""
    if pooling_type == "mean":
        return MaskedMeanPooling()
    elif pooling_type == "attention":
        return AttentionPooling(hidden_size)
    elif pooling_type == "layer_weighted":
        return LayerWeightedPooling(num_layers, [2, 4, 5])  # middle + top layers
    else:
        raise ValueError(f"unknown pooling type: {pooling_type}")
