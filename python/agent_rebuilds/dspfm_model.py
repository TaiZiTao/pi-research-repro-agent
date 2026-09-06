# -*- coding: utf-8 -*-
"""
DSPFM - Directional Structure Perception and Frequency Modulation
(Evidence-based Agent reconstruction, NOT official code; no official repo exists.)

Paper (anonymous submission): "Lightweight Image Super-Resolution through
Directional Structure Perception and Spatial-Frequency Cooperation"

Every module below follows the equations / descriptions found in the paper's
evidence chunks (page · chunkId):
  * Overall pipeline / DSPFMB blocks .......... [p.3 · p3-c2]  (Eq.1-2)
  * Attentive-layer dual units, scales lambda [p.3 · p3-c3]  (Eq.3-4)
      lambda_1, lambda_2 init = 1e-4 ; MS-MLP = parallel 1x1/3x3/5x5 DW convs
  * DirMSA window attention ................... [p.4 · p4-c1]  (Eq.5)
  * DirRPB cosine bases & bias table .......... [p.4 · p4-c2], [p.4 · p4-c3] (Eq.6-8)
  * SFCA channel affinity ..................... [p.4 · p4-c3], [p.5 · p5-c5] (Eq.17-20)
  * SMM spectral modulation ................... [p.4 · p4-c4], [p.5 · p5-c4] (Eq.9-16)
  * Default config ............................ [p.6 · p6-c2], [p.6 · p6-c5]
      n=4 DSPFMBs, C=48, m=5 attentive layers, Ha=4 heads,
      Kd=4 cosine bases, window size M=16x16

Assumptions (NOT stated in retrieved evidence, made explicit so you can adjust):
  * Successive attentive layers alternate window / shifted-window (cyclic shift
    M//2 + standard attention mask).  Evidence text is truncated at
    "successive attentive layers alternate betwee..."  [p.3 · p3-c3].
  * Input LR is padded to a multiple of the window size (border handling).
  * GroupNorm groups = 8 inside SMM (Eq.16 "GN"); MS-MLP adds a GELU after
    concatenating the parallel DW-conv branches.
  * SMM uses a full 2D FFT (torch.fft.fft2) so Z in C^{HxWxC} (Eq.9).
These constants only affect engineering details, not the module semantics above.

Dependencies: torch>=1.9 (torch.fft).  Smoke test:  python dspfm_model.py
"""

from __future__ import annotations

import math
from typing import Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F


# --------------------------------------------------------------------------- #
#  DirRPB: directional relative position bias (Eq.6-8, Fig.3)                 #
# --------------------------------------------------------------------------- #
class DirRPB(nn.Module):
    """Generate a relative-position-bias table from fixed directional cosine
    bases (axis-aligned H/V + two diagonals D/A) and learnable head-wise
    coefficients Theta in R^{4*Kd x Ha}.

    B_dir = Phi . Theta  in  R^{(2M-1)^2 x Ha}          (Eq.8)
    Phi built from, for k in 1..Kd (Eq.7):
        cos(k*pi*dh_), cos(k*pi*(dh_+dw_)/sqrt2),
        cos(k*pi*dw_),  cos(k*pi*(dh_-dw_)/sqrt2)
    with normalized offsets dh_=dh/(M-1), dw_=dw/(M-1)   (Eq.6)
    """

    def __init__(self, window_size: int = 16, num_heads: int = 4, kd: int = 4):
        super().__init__()
        assert window_size > 1
        self.window_size = window_size
        self.num_heads = num_heads
        self.kd = kd

        m = window_size
        table_len = (2 * m - 1) ** 2

        # ---- fixed cosine basis matrix Phi: (table_len, 4*Kd) ------------ #
        idx = torch.arange(-(m - 1), m)                     # signed offsets
        dh, dw = torch.meshgrid(idx, idx, indexing="ij")    # (2m-1, 2m-1)
        dh, dw = dh.reshape(-1), dw.reshape(-1)
        dh_ = dh.float() / (m - 1)
        dw_ = dw.float() / (m - 1)
        cols = []
        for k in range(1, kd + 1):
            cols += [
                torch.cos(k * math.pi * dh_),
                torch.cos(k * math.pi * (dh_ + dw_) / math.sqrt(2.0)),
                torch.cos(k * math.pi * dw_),
                torch.cos(k * math.pi * (dh_ - dw_) / math.sqrt(2.0)),
            ]
        phi = torch.stack(cols, dim=1)                      # (table_len, 4Kd)
        self.register_buffer("phi", phi, persistent=False)

        # ---- learnable head-wise coefficients Theta (the ONLY DirRPB params)
        self.theta = nn.Parameter(torch.zeros(4 * kd, num_heads))

        # ---- relative position index table inside an MxM window ---------- #
        coords = torch.stack(
            torch.meshgrid(
                torch.arange(m), torch.arange(m), indexing="ij"
            )).flatten(1)                                   # (2, M^2)
        rel = coords[:, :, None] - coords[:, None, :]       # (2, M^2, M^2)
        rel[0] += m - 1
        rel[1] += m - 1
        rel_index = rel[0] * (2 * m - 1) + rel[1]           # (M^2, M^2)
        self.register_buffer("relative_position_index", rel_index, persistent=False)

    def bias_table(self) -> torch.Tensor:
        """Return per-head bias table of shape (2M-1, 2M-1, Ha)."""
        b = self.phi @ self.theta                           # (table_len, Ha)
        side = 2 * self.window_size - 1
        return b.reshape(side, side, self.num_heads)

    def forward(self, num_windows: int) -> torch.Tensor:
        """Per-window bias: (1, Ha, M^2, M^2) broadcastable to scores."""
        bias = self.bias_table().reshape(-1, self.num_heads)[self.relative_position_index]  # (M^2, M^2, Ha)
        bias = bias.permute(2, 0, 1).unsqueeze(0)               # (1, Ha, M^2, M^2)
        return bias


# --------------------------------------------------------------------------- #
#  Window partition helpers (channels-first)                                  #
# --------------------------------------------------------------------------- #
def window_partition(x: torch.Tensor, window_size: int) -> torch.Tensor:
    """(B, C, H, W) -> (num_windows, window_size^2, C)."""
    B, C, H, W = x.shape
    ws = window_size
    x = x.view(B, C, H // ws, ws, W // ws, ws)
    x = x.permute(0, 2, 4, 3, 5, 1).contiguous()
    return x.view(-1, ws * ws, C)


def window_reverse(windows: torch.Tensor, window_size: int,
                   H: int, W: int) -> torch.Tensor:
    """(num_windows, window_size^2, C) -> (B, C, H, W)."""
    ws = window_size
    B = windows.shape[0] // (H // ws * W // ws)
    x = windows.view(B, H // ws, W // ws, ws, ws, -1)
    x = x.permute(0, 1, 3, 2, 4, 5).contiguous()
    return x.view(B, H, W, -1).permute(0, 3, 1, 2)


def window_attention_mask(H: int, W: int, window_size: int,
                          shift_size: int, device, dtype) -> Optional[torch.Tensor]:
    """Standard shifted-window mask (Swin-style): 0 inside a real window cell,
    -100 across cyclic-shift borders.  Shape (1, nW, M^2, M^2)."""
    if shift_size <= 0:
        return None
    ws = window_size
    img = torch.zeros((1, H, W, 1), device=device, dtype=dtype)
    h_slices = (slice(0, -ws), slice(-ws, -shift_size), slice(-shift_size, None))
    w_slices = (slice(0, -ws), slice(-ws, -shift_size), slice(-shift_size, None))
    cnt = 0
    for hs in h_slices:
        for ws_ in w_slices:
            img[:, hs, ws_, :] = cnt
            cnt += 1
    mask_windows = window_partition(img.permute(0, 3, 1, 2), ws)   # (nW, M^2, 1)
    mask_windows = mask_windows.squeeze(-1)
    attn = mask_windows.unsqueeze(1) - mask_windows.unsqueeze(2)    # (nW, M^2, M^2)
    attn = attn.masked_fill(attn != 0, float(-100.0)).masked_fill(attn == 0, 0.0)
    return attn.unsqueeze(0)


# --------------------------------------------------------------------------- #
#  DirMSA: window attention + DirRPB (Eq.5)                                   #
# --------------------------------------------------------------------------- #
class DirMSA(nn.Module):
    """Directional multi-head self attention over non-overlapping windows.

    DirMSA(Q, K, V) = Softmax(Q K^T / sqrt(d_h) + B_dir) V      (Eq.5)
    with a linear projection to 3C split evenly into Q, K, V, and a final
    linear projection after concatenating the heads.
    """

    def __init__(self, dim: int = 48, window_size: int = 16,
                 num_heads: int = 4, kd: int = 4, shift_size: int = 0):
        super().__init__()
        assert dim % num_heads == 0
        self.dim = dim
        self.window_size = window_size
        self.num_heads = num_heads
        self.head_dim = dim // num_heads
        self.shift_size = shift_size
        assert 0 <= shift_size < window_size

        self.qkv = nn.Linear(dim, 3 * dim, bias=True)
        self.dir_rpb = DirRPB(window_size, num_heads, kd)
        self.proj = nn.Linear(dim, dim, bias=True)
        self.scale = self.head_dim ** -0.5
        self._mask_cache: dict = {}

    def _get_mask(self, H: int, W: int, device, dtype):
        key = (H, W, self.shift_size)
        if key not in self._mask_cache:
            self._mask_cache[key] = window_attention_mask(
                H, W, self.window_size, self.shift_size, device, dtype)
        return self._mask_cache[key]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (B, C, H, W)  (LayerNorm already applied outside)."""
        B, C, H, W = x.shape
        ws = self.window_size
        sh = self.shift_size

        # ---- pad to a multiple of the window size ------------------------- #
        Hp = ((H + ws - 1) // ws) * ws
        Wp = ((W + ws - 1) // ws) * ws
        pad_r, pad_b = Wp - W, Hp - H
        if pad_r or pad_b:
            x = F.pad(x, (0, pad_r, 0, pad_b))

        # ---- cyclic shift for the shifted configuration ------------------- #
        if sh > 0:
            x = torch.roll(x, shifts=(-sh, -sh), dims=(2, 3))

        # ---- tokenize windows --------------------------------------------- #
        nW = (Hp // ws) * (Wp // ws)
        x_w = window_partition(x, ws)                     # (B*nW, M^2, C)

        qkv = self.qkv(x_w).reshape(x_w.shape[0], ws * ws, 3, self.num_heads,
                                    self.head_dim)
        qkv = qkv.permute(2, 0, 3, 1, 4)                  # (3, B*nW, Ha, M^2, dh)
        q, k, v = qkv[0], qkv[1], qkv[2]

        attn = (q @ k.transpose(-2, -1)) * self.scale     # (B*nW, Ha, M^2, M^2)
        attn = attn + self.dir_rpb(nW)
        mask = self._get_mask(Hp, Wp, x.device, x.dtype)
        if mask is not None:
            # mask: (1, nW, M^2, M^2) -> align to attn (B*nW, Ha, M^2, M^2):
            # reshape attn to (B, nW, Ha, M^2, M^2) and broadcast mask along batch.
            batch = attn.shape[0] // nW
            attn = attn.view(batch, nW, self.num_heads, ws * ws, ws * ws)
            attn = attn + mask[0].unsqueeze(0).unsqueeze(2)   # (1, nW, 1, M^2, M^2)
            attn = attn.view(batch * nW, self.num_heads, ws * ws, ws * ws)
        attn = attn.softmax(dim=-1)

        out = attn @ v                                    # (B*nW, Ha, M^2, dh)
        out = out.transpose(1, 2).reshape(x_w.shape[0], ws * ws, C)
        out = self.proj(out)

        x = window_reverse(out, ws, Hp, Wp)               # (B, C, Hp, Wp)

        if sh > 0:
            x = torch.roll(x, shifts=(sh, sh), dims=(2, 3))
        if pad_r or pad_b:
            x = x[:, :, :H, :W]
        return x


# --------------------------------------------------------------------------- #
#  MS-MLP: multi-scale MLP (parallel 1x1/3x3/5x5 depth-wise convs)            #
# --------------------------------------------------------------------------- #
class MSMLP(nn.Module):
    """Channel-split into 3 groups; each group goes through a depth-wise conv
    of kernel 1x1 / 3x3 / 5x5; outputs are concatenated and mixed by a 1x1
    point-wise conv ([p.3 · p3-c3]: "parallel 1x1, 3x3 and 5x5 depth-wise
    convolutions").  GELU nonlinearity: engineering assumption."""

    def __init__(self, dim: int = 48):
        super().__init__()
        assert dim % 3 == 0
        g = dim // 3
        self.branches = nn.ModuleList([
            nn.Conv2d(g, g, 1, groups=g),
            nn.Conv2d(g, g, 3, padding=1, groups=g),
            nn.Conv2d(g, g, 5, padding=2, groups=g),
        ])
        self.gelu = nn.GELU()
        self.pw = nn.Conv2d(dim, dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        parts = torch.chunk(x, 3, dim=1)
        out = torch.cat([b(p) for b, p in zip(self.branches, parts)], dim=1)
        return self.pw(self.gelu(out))


# --------------------------------------------------------------------------- #
#  SMM: spectral modulation module (Eq.9-16, Fig.4)                           #
# --------------------------------------------------------------------------- #
class SMM(nn.Module):
    """Content-adaptive real-valued spectral modulation.

      Z  = FFT(X)                                   (Eq.9)
      G  = Gate(Concat(|Z|, angle_normalized))      (Eq.10-11)
           Gate: PWConv 2C->C/8 -> GeLU -> PWConv C/8->C -> Sigmoid
      fx, fy = normalized |freq coords|;  r2 = fx^2 + fy^2   (Eq.12)
      Pi = alpha*fx + beta*fy + gamma*r2            (Eq.13)  channel-wise weights
      |Z~| = (1 + G*Pi) * |Z|                       (Eq.14)
      X~  = IFFT(|Z~|, angle Z)                     (Eq.15)
      X^  = GN(X~) + X                              (Eq.16)
    """

    def __init__(self, dim: int = 48, num_groups: int = 8):
        super().__init__()
        self.dim = dim
        assert dim % num_groups == 0
        self.num_groups = num_groups

        self.gate = nn.Sequential(
            nn.Conv2d(2 * dim, max(dim // 8, 1), 1),
            nn.GELU(),
            nn.Conv2d(max(dim // 8, 1), dim, 1),
            nn.Sigmoid(),
        )
        # channel-wise spectral-prior weights (Eq.13)
        self.alpha = nn.Parameter(torch.zeros(1, dim, 1, 1))
        self.beta = nn.Parameter(torch.zeros(1, dim, 1, 1))
        self.gamma = nn.Parameter(torch.zeros(1, dim, 1, 1))
        self.gn = nn.GroupNorm(num_groups, dim)

    @staticmethod
    def _freq_magnitude_map(H: int, W: int, device, dtype) -> Tuple[torch.Tensor, torch.Tensor]:
        """Symmetric-abs normalized frequency-coordinate magnitude maps fx, fy
        of shape (1, 1, H, W) used as the DFM spectral prior (Eq.12)."""
        y = torch.arange(H, device=device, dtype=dtype)
        x = torch.arange(W, device=device, dtype=dtype)
        fy = torch.minimum(y, H - y) / max(H - 1, 1)
        fx = torch.minimum(x, W - x) / max(W - 1, 1)
        return fx.view(1, 1, 1, W), fy.view(1, 1, H, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (B, C, H, W) -> X^ of Eq.16, fused with input by residual add."""
        B, C, H, W = x.shape

        z = torch.fft.fft2(x, dim=(-2, -1))             # (B, C, H, W) complex
        amp = z.abs()
        phase = z.angle()

        # content-adaptive gate from amplitude + normalized phase (Eq.10-11)
        phase_norm = (phase + math.pi) / (2.0 * math.pi)
        g = self.gate(torch.cat([amp, phase_norm], dim=1))   # (B, C, H, W)

        # explicit spectral prior from frequency coordinates (Eq.12-13)
        fx, fy = self._freq_magnitude_map(H, W, x.device, x.dtype)
        r2 = fx * fx + fy * fy
        pi = self.alpha * fx + self.beta * fy + self.gamma * r2   # (B, C, H, W)

        amp_tilde = (1.0 + g * pi) * amp                 # Eq.14
        x_tilde = torch.fft.ifft2(
            torch.polar(amp_tilde, phase), dim=(-2, -1)).real   # Eq.15
        return self.gn(x_tilde) + x                      # Eq.16


# --------------------------------------------------------------------------- #
#  SFCA: spatial-frequency cooperative attention (Eq.17-20)                   #
# --------------------------------------------------------------------------- #
class SFCA(nn.Module):
    """Channel-wise affinity from a spatial-frequency representation, with a
    value path retained from the input spatial feature.

      X^  = SMM(X)
      Q = Proj(X^), K = Proj(X^), V = Proj(X)            (Eq.17)
      M = ReLU(R(Q) R(K)^T),  M in R^{C x C}             (Eq.18)
      V' = R^-1(M R(V))                                  (Eq.19)
      Y  = V + omega * (V - V')                          (Eq.20)
    Proj = 1x1 conv + 3x3 depth-wise conv; omega init = 0.
    """

    def __init__(self, dim: int = 48, num_groups: int = 8):
        super().__init__()
        self.dim = dim

        def _proj():
            return nn.Sequential(
                nn.Conv2d(dim, dim, 1),
                nn.Conv2d(dim, dim, 3, padding=1, groups=dim),
            )

        self.proj_q = _proj()
        self.proj_k = _proj()
        self.proj_v = _proj()
        self.smm = SMM(dim, num_groups)
        # learnable channel-wise weight of Eq.20, init to zero
        self.omega = nn.Parameter(torch.zeros(1, dim, 1, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, C, H, W = x.shape
        x_hat = self.smm(x)                     # spectral enhancement

        q = self.proj_q(x_hat)                  # query/key from spatial-frequency rep
        k = self.proj_k(x_hat)
        v = self.proj_v(x)                      # value path from input spatial feature

        qf = q.view(B, C, -1)                   # C x HW  (Eq.18)
        kf = k.view(B, C, -1)
        m = torch.relu(qf @ kf.transpose(1, 2))     # (B, C, C) affinity

        vp = (m @ v.view(B, C, -1)).view(B, C, H, W)    # Eq.19
        return v + self.omega * (v - vp)         # Eq.20


# --------------------------------------------------------------------------- #
#  Attentive layer + DSPFMB block (Eq.1-4)                                    #
# --------------------------------------------------------------------------- #
class AttentiveLayer(nn.Module):
    """Two successive feature-interaction units (Eq.4):

      Y_t = DirMSA(LN(X_t)) + X_t
      X_s = MS-MLP1(LN(Y_t)) + Y_t + lambda_1 * X_t
      Y_s = SFCA(LN(X_s)) + X_s
      X_{t+1} = MS-MLP2(LN(Y_s)) + Y_s + lambda_2 * X_s
    lambda_1, lambda_2 in R^C, initialized to 1e-4.
    """

    def __init__(self, dim: int = 48, window_size: int = 16,
                 num_heads: int = 4, kd: int = 4, shift_size: int = 0):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.dir_msa = DirMSA(dim, window_size, num_heads, kd, shift_size)
        self.norm2 = nn.LayerNorm(dim)
        self.ms_mlp1 = MSMLP(dim)
        self.lambda1 = nn.Parameter(torch.full((dim,), 1e-4))
        self.norm3 = nn.LayerNorm(dim)
        self.sfca = SFCA(dim)
        self.norm4 = nn.LayerNorm(dim)
        self.ms_mlp2 = MSMLP(dim)
        self.lambda2 = nn.Parameter(torch.full((dim,), 1e-4))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # ---- unit 1: DirMSA + MS-MLP ------------------------------------- #
        y_t = self.dir_msa(self._to_nchw(self.norm1(self._to_nhwc(x)))) + x
        x_s = self.ms_mlp1(self._to_nchw(self.norm2(self._to_nhwc(y_t)))) \
            + y_t + self.lambda1.view(1, -1, 1, 1) * x
        # ---- unit 2: SFCA + MS-MLP --------------------------------------- #
        y_s = self.sfca(self._to_nchw(self.norm3(self._to_nhwc(x_s)))) + x_s
        out = self.ms_mlp2(self._to_nchw(self.norm4(self._to_nhwc(y_s)))) \
            + y_s + self.lambda2.view(1, -1, 1, 1) * x_s
        return out

    @staticmethod
    def _to_nhwc(x: torch.Tensor) -> torch.Tensor:
        return x.permute(0, 2, 3, 1)

    @staticmethod
    def _to_nchw(x: torch.Tensor) -> torch.Tensor:
        return x.permute(0, 3, 1, 2)


class DSPFMB(nn.Module):
    """Directional Structure Perception and Frequency Modulation Block.

    Xi = Conv3x3( A_{i,m}( ... A_{i,1}(Xi-1) ... ) ) + Xi-1     (Eq.1-3)
    Successive attentive layers alternate window / shifted window.
    """

    def __init__(self, dim: int = 48, num_layers: int = 5, window_size: int = 16,
                 num_heads: int = 4, kd: int = 4):
        super().__init__()
        half = window_size // 2
        self.layers = nn.ModuleList([
            AttentiveLayer(dim, window_size, num_heads, kd,
                           shift_size=(0 if j % 2 == 0 else half))
            for j in range(num_layers)
        ])
        self.conv = nn.Conv2d(dim, dim, 3, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        res = x
        for layer in self.layers:
            x = layer(x)
        return self.conv(x) + res


# --------------------------------------------------------------------------- #
#  DSPFM network (Eq.1-2)                                                     #
# --------------------------------------------------------------------------- #
class DSPFM(nn.Module):
    """Shallow feature extraction -> n DSPFMBs -> reconstruction.

      X0 = Conv3x3(ILR)                                 shallow feature
      Xi = DSPFMBi(Xi-1), i = 1..n                      deep feature (Eq.1)
      ISR = U_r( Conv3x3(Xn) )                          (Eq.2)
            U_r = point-wise conv + pixel shuffle (scale r)
    Default config (paper experiments [p.6 · p6-c2]):
      n = 4, C = 48, m = 5, Ha = 4, Kd = 4, window = 16.
    """

    def __init__(self, dim: int = 48, num_blocks: int = 4, num_layers: int = 5,
                 num_heads: int = 4, kd: int = 4, window_size: int = 16,
                 upscale: int = 4, in_chans: int = 3, num_groups: int = 8):
        super().__init__()
        self.dim = dim
        self.upscale = upscale
        self.window_size = window_size

        self.conv_first = nn.Conv2d(in_chans, dim, 3, padding=1)
        self.blocks = nn.ModuleList([
            DSPFMB(dim, num_layers, window_size, num_heads, kd)
            for _ in range(num_blocks)
        ])
        self.conv_after = nn.Conv2d(dim, dim, 3, padding=1)
        # U_r : point-wise conv to 3*r^2 + pixel shuffle (Eq.2)
        self.conv_upsample = nn.Conv2d(dim, in_chans * upscale * upscale, 1)
        self.pixel_shuffle = nn.PixelShuffle(upscale)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, _, H, W = x.shape
        f = self.conv_first(x)
        for block in self.blocks:
            f = block(f)
        f = self.conv_after(f)
        out = self.pixel_shuffle(self.conv_upsample(f))     # (B, 3, H*r, W*r)
        return out[:, :, :H * self.upscale, :W * self.upscale]


# --------------------------------------------------------------------------- #
#  Smoke test                                                                 #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    model = DSPFM(dim=48, num_blocks=4, num_layers=5, num_heads=4,
                  kd=4, window_size=16, upscale=4)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[DSPFM] parameters: {n_params / 1e3:.1f} K")
    lr = torch.randn(1, 3, 48, 48)      # 48x48 LR (multiple of window 16)
    with torch.no_grad():
        sr = model(lr)
    print("[DSPFM] LR", tuple(lr.shape), "-> SR", tuple(sr.shape))
    assert sr.shape == (1, 3, 192, 192)
    print("[DSPFM] forward OK")
