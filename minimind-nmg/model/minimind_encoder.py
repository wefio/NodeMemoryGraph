"""
MiniMind-NMG Encoder — bidirectional transformer encoder for NMG embedding.

Key changes from MiniMindForCausalLM:
  - is_causal = False (bidirectional attention)
  - No KV cache / past_key_value
  - LM head → embedding head + optional activation head
  - Masked mean pooling over valid tokens
  - L2-normalized output

Architecture: 6 layers, hidden=512, GQA (8 q_heads / 4 kv_heads), SwiGLU FFN.
"""

import math
import torch
import torch.nn.functional as F
from torch import nn
from transformers import PreTrainedModel, PretrainedConfig
from transformers.activations import ACT2FN


# ═══════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════

class MiniMindEncoderConfig(PretrainedConfig):
    model_type = "minimind_encoder"

    def __init__(self, hidden_size=512, num_hidden_layers=6, **kwargs):
        super().__init__(**kwargs)
        self.hidden_size = hidden_size
        self.num_hidden_layers = num_hidden_layers
        self.dropout = kwargs.get("dropout", 0.0)
        self.vocab_size = kwargs.get("vocab_size", 152064)  # Qwen tokenizer default
        self.num_attention_heads = kwargs.get("num_attention_heads", 8)
        self.num_key_value_heads = kwargs.get("num_key_value_heads", 4)
        self.head_dim = kwargs.get(
            "head_dim", self.hidden_size // self.num_attention_heads
        )
        self.hidden_act = kwargs.get("hidden_act", "silu")
        self.intermediate_size = kwargs.get(
            "intermediate_size",
            math.ceil(hidden_size * math.pi / 64) * 64,  # ~1536 for 512
        )
        self.max_position_embeddings = kwargs.get("max_position_embeddings", 2048)
        self.rms_norm_eps = kwargs.get("rms_norm_eps", 1e-6)
        self.rope_theta = kwargs.get("rope_theta", 1e6)

        # Output
        self.output_dim = kwargs.get("output_dim", 256)
        self.use_activation_head = kwargs.get("use_activation_head", True)


# ═══════════════════════════════════════════════════════════════════
# Building blocks (same as MiniMind, minus KV cache)
# ═══════════════════════════════════════════════════════════════════

class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def _norm(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)

    def forward(self, x):
        return (self.weight * self._norm(x.float())).type_as(x)


def precompute_freqs_cis(dim: int, end: int, rope_base: float = 1e6):
    freqs = 1.0 / (rope_base ** (torch.arange(0, dim, 2).float() / dim))
    t = torch.arange(end)
    freqs = torch.outer(t, freqs).float()
    freqs_cos = torch.cat([torch.cos(freqs), torch.cos(freqs)], dim=-1)
    freqs_sin = torch.cat([torch.sin(freqs), torch.sin(freqs)], dim=-1)
    return freqs_cos, freqs_sin


def apply_rotary_pos_emb(q, k, cos, sin):
    def rotate_half(x):
        return torch.cat((-x[..., x.shape[-1] // 2:], x[..., : x.shape[-1] // 2]), dim=-1)
    q_embed = ((q * cos.unsqueeze(1)) + (rotate_half(q) * sin.unsqueeze(1))).to(q.dtype)
    k_embed = ((k * cos.unsqueeze(1)) + (rotate_half(k) * sin.unsqueeze(1))).to(k.dtype)
    return q_embed, k_embed


def repeat_kv(x: torch.Tensor, n_rep: int) -> torch.Tensor:
    bs, slen, n_kv_heads, head_dim = x.shape
    if n_rep == 1:
        return x
    return (
        x[:, :, :, None, :]
        .expand(bs, slen, n_kv_heads, n_rep, head_dim)
        .reshape(bs, slen, n_kv_heads * n_rep, head_dim)
    )


class BidirectionalAttention(nn.Module):
    """GQA attention with `is_causal=False` — encoder-style."""

    def __init__(self, config: MiniMindEncoderConfig):
        super().__init__()
        self.n_local_heads = config.num_attention_heads
        self.n_local_kv_heads = config.num_key_value_heads
        self.n_rep = self.n_local_heads // self.n_local_kv_heads
        self.head_dim = config.head_dim
        self.dropout = config.dropout
        self.flash = hasattr(F, "scaled_dot_product_attention")

        self.q_proj = nn.Linear(config.hidden_size, config.num_attention_heads * self.head_dim, bias=False)
        self.k_proj = nn.Linear(config.hidden_size, config.num_key_value_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(config.hidden_size, config.num_key_value_heads * self.head_dim, bias=False)
        self.o_proj = nn.Linear(config.num_attention_heads * self.head_dim, config.hidden_size, bias=False)
        self.q_norm = RMSNorm(self.head_dim, eps=config.rms_norm_eps)
        self.k_norm = RMSNorm(self.head_dim, eps=config.rms_norm_eps)
        self.attn_dropout = nn.Dropout(config.dropout)
        self.resid_dropout = nn.Dropout(config.dropout)

    def forward(self, x, position_embeddings, attention_mask=None):
        bsz, seq_len, _ = x.shape
        xq = self.q_proj(x).view(bsz, seq_len, self.n_local_heads, self.head_dim)
        xk = self.k_proj(x).view(bsz, seq_len, self.n_local_kv_heads, self.head_dim)
        xv = self.v_proj(x).view(bsz, seq_len, self.n_local_kv_heads, self.head_dim)
        xq, xk = self.q_norm(xq), self.k_norm(xk)

        cos, sin = position_embeddings
        xq, xk = apply_rotary_pos_emb(xq, xk, cos, sin)

        # [B, H, S, D]
        xq = xq.transpose(1, 2)
        xk = repeat_kv(xk, self.n_rep).transpose(1, 2)
        xv = repeat_kv(xv, self.n_rep).transpose(1, 2)

        # During ONNX tracing we must NOT use the mask-less flash path, because
        # torch.all(attention_mask == 1) gets traced as a constant True and the
        # exported graph ignores the attention mask (collapsing all embeddings).
        tracing = torch.jit.is_tracing()
        if self.flash and not tracing and (attention_mask is None or torch.all(attention_mask == 1)):
            output = F.scaled_dot_product_attention(
                xq, xk, xv,
                dropout_p=self.dropout if self.training else 0.0,
                is_causal=False,
            )
        else:
            scores = (xq @ xk.transpose(-2, -1)) / math.sqrt(self.head_dim)
            if attention_mask is not None:
                scores += (1.0 - attention_mask.unsqueeze(1).unsqueeze(2)) * -1e9
            output = self.attn_dropout(F.softmax(scores.float(), dim=-1).type_as(xq)) @ xv

        output = output.transpose(1, 2).reshape(bsz, seq_len, -1)
        return self.resid_dropout(self.o_proj(output))


class FeedForward(nn.Module):
    """SwiGLU FFN (same as MiniMind)."""

    def __init__(self, config: MiniMindEncoderConfig, intermediate_size: int = None):
        super().__init__()
        intermediate_size = intermediate_size or config.intermediate_size
        self.gate_proj = nn.Linear(config.hidden_size, intermediate_size, bias=False)
        self.down_proj = nn.Linear(intermediate_size, config.hidden_size, bias=False)
        self.up_proj = nn.Linear(config.hidden_size, intermediate_size, bias=False)
        self.act_fn = ACT2FN[config.hidden_act]

    def forward(self, x):
        return self.down_proj(self.act_fn(self.gate_proj(x)) * self.up_proj(x))


class EncoderBlock(nn.Module):
    """Pre-norm transformer block with bidirectional attention."""

    def __init__(self, layer_id: int, config: MiniMindEncoderConfig):
        super().__init__()
        self.self_attn = BidirectionalAttention(config)
        self.input_layernorm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.post_attention_layernorm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.mlp = FeedForward(config)

    def forward(self, hidden_states, position_embeddings, attention_mask=None):
        residual = hidden_states
        hidden_states = self.self_attn(
            self.input_layernorm(hidden_states),
            position_embeddings,
            attention_mask,
        )
        hidden_states = hidden_states + residual
        hidden_states = hidden_states + self.mlp(self.post_attention_layernorm(hidden_states))
        return hidden_states


# ═══════════════════════════════════════════════════════════════════
# Full encoder
# ═══════════════════════════════════════════════════════════════════

class MiniMindEncoderModel(nn.Module):
    """Bidirectional encoder that outputs L2-normalized embedding + optional activation."""

    def __init__(self, config: MiniMindEncoderConfig):
        super().__init__()
        self.config = config
        self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size)
        self.dropout = nn.Dropout(config.dropout)
        self.layers = nn.ModuleList([
            EncoderBlock(l, config) for l in range(config.num_hidden_layers)
        ])
        self.norm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)

        # Output heads
        self.embedding_head = nn.Linear(config.hidden_size, config.output_dim, bias=False)
        self.activation_head = (
            nn.Sequential(
                nn.Linear(config.hidden_size, config.hidden_size // 4, bias=False),
                nn.SiLU(),
                nn.Linear(config.hidden_size // 4, 1, bias=False),
                nn.Sigmoid(),
            )
            if config.use_activation_head
            else None
        )

        # RoPE frequencies
        freqs_cos, freqs_sin = precompute_freqs_cis(
            dim=config.head_dim,
            end=config.max_position_embeddings,
            rope_base=config.rope_theta,
        )
        self.register_buffer("freqs_cos", freqs_cos, persistent=False)
        self.register_buffer("freqs_sin", freqs_sin, persistent=False)

    def forward(self, input_ids, attention_mask=None):
        batch_size, seq_length = input_ids.shape
        hidden_states = self.dropout(self.embed_tokens(input_ids))

        position_embeddings = (
            self.freqs_cos[:seq_length],
            self.freqs_sin[:seq_length],
        )

        for layer in self.layers:
            hidden_states = layer(hidden_states, position_embeddings, attention_mask)

        hidden_states = self.norm(hidden_states)

        # Masked mean pooling
        if attention_mask is not None:
            mask = attention_mask.unsqueeze(-1).float()
            pooled = (hidden_states * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
        else:
            pooled = hidden_states.mean(dim=1)

        # L2-normalized embedding
        embedding = F.normalize(self.embedding_head(pooled), p=2, dim=-1)

        # Optional activation prior
        activation = self.activation_head(pooled) if self.activation_head is not None else None

        return {
            "embedding": embedding,      # [B, output_dim] L2
            "activation": activation,    # [B, 1] or None
            "hidden_states": hidden_states,
        }


class MiniMindEncoder(PreTrainedModel):
    """HuggingFace-compatible wrapper for MiniMind-NMG Encoder."""

    config_class = MiniMindEncoderConfig

    def __init__(self, config: MiniMindEncoderConfig = None):
        self.config = config or MiniMindEncoderConfig()
        super().__init__(self.config)
        self.encoder = MiniMindEncoderModel(self.config)
        self.post_init()

    def forward(self, input_ids, attention_mask=None):
        return self.encoder(input_ids, attention_mask)

    def encode(self, input_ids, attention_mask=None):
        """Convenience: return just the embedding tensor."""
        return self.forward(input_ids, attention_mask)["embedding"]
