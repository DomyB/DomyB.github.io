"""Alternative learners for the relative forecast, all behind one small interface.

Every learner here takes the same inputs as the production boosted trees (a
float32 feature matrix, the rank target, and the per-date group sizes of the
training rows, which are sorted by date) and returns scores for new rows. The
production model is `hgb`; the others exist so the experiment harness can put
them through the same walk-forward test:

* `lgbm`, `xgb`, `cat`: LightGBM, XGBoost and CatBoost regressors with
  parameters chosen for a noisy cross-sectional target (shallow trees, large
  leaves, strong regularisation, feature and row subsampling).
* `lgbm_rank`: LightGBM's LambdaRank objective with each trading day as a query
  group and the rank target cut into ten relevance grades, so the loss is the
  ranking itself rather than a squared error.
* `mlp`, `mlp_rank`: a small multilayer perceptron in PyTorch (median
  imputation and standardisation fitted on the training rows only, GELU,
  dropout, weight decay, AdamW, a fixed number of epochs: no early stopping on
  anything the model will be scored on), trained on the squared error of the
  rank target, or with a ListNet softmax loss over each day's stocks added.
"""
from __future__ import annotations

import os

import numpy as np

THREADS = int(os.environ.get("OMP_NUM_THREADS", "3"))

LGBM_PARAMS = dict(n_estimators=500, learning_rate=0.02, num_leaves=31, min_child_samples=300, subsample=0.7,
                   subsample_freq=1, colsample_bytree=0.6, reg_lambda=5.0, max_bin=127, verbose=-1)
LGBM_RANK_PARAMS = dict(n_estimators=500, learning_rate=0.02, num_leaves=31, min_child_samples=300, subsample=0.7,
                        subsample_freq=1, colsample_bytree=0.6, reg_lambda=5.0, max_bin=127, verbose=-1,
                        label_gain=list(range(10)), lambdarank_truncation_level=60)
XGB_PARAMS = dict(n_estimators=500, learning_rate=0.02, max_depth=5, min_child_weight=300, subsample=0.7,
                  colsample_bytree=0.6, reg_lambda=5.0, tree_method="hist", max_bin=127)
CAT_PARAMS = dict(iterations=500, learning_rate=0.03, depth=6, l2_leaf_reg=5.0, rsm=0.6, subsample=0.7,
                  bootstrap_type="Bernoulli", border_count=127, verbose=0, allow_writing_files=False)
MLP_PARAMS = dict(hidden=(256, 128), dropout=0.15, epochs=6, batch=4096, lr=1e-3, weight_decay=1e-4, listnet=0.0)
RANK_GRADES = 10
# LightGBM with the production trees' own settings: the control that shows the port itself changes nothing
LGBM_PORT_PARAMS = dict(n_estimators=250, learning_rate=0.03, num_leaves=15, min_child_samples=300, reg_lambda=3.0,
                        colsample_bytree=0.6, subsample=1.0, max_bin=255, verbose=-1)
# Per-horizon regularised sets: leaves grow rarer and shrink harder as the horizon lengthens, because
# overlapping labels make neighbouring strided dates near-duplicates and the effective sample shrinks
LGBM_REG_BY_H = {
    1: dict(n_estimators=500, learning_rate=0.02, num_leaves=15, min_child_samples=4000, colsample_bytree=0.4, subsample=0.7,
            subsample_freq=1, reg_lambda=10.0, path_smooth=10.0, max_bin=255, verbose=-1),
    5: dict(n_estimators=500, learning_rate=0.02, num_leaves=15, min_child_samples=4000, colsample_bytree=0.4, subsample=0.7,
            subsample_freq=1, reg_lambda=10.0, path_smooth=10.0, max_bin=255, verbose=-1),
    21: dict(n_estimators=400, learning_rate=0.02, num_leaves=7, min_child_samples=3000, colsample_bytree=0.4, subsample=0.7,
             subsample_freq=1, reg_lambda=20.0, path_smooth=20.0, max_bin=255, verbose=-1),
    63: dict(n_estimators=300, learning_rate=0.02, num_leaves=7, min_child_samples=2000, colsample_bytree=0.4, subsample=0.7,
             subsample_freq=1, reg_lambda=30.0, path_smooth=20.0, max_bin=255, verbose=-1),
}
LGBM_HUBER_PARAMS = dict(objective="huber", alpha=1.0, n_estimators=400, learning_rate=0.02, num_leaves=15, min_child_samples=2000,
                         colsample_bytree=0.5, subsample=0.7, subsample_freq=1, reg_lambda=10.0, max_bin=255, verbose=-1)


class _LGBM:
    def __init__(self, seed, rank=False, params=None):
        import lightgbm as lgb
        self.rank = rank
        params = dict(params if params is not None else (LGBM_RANK_PARAMS if rank else LGBM_PARAMS), random_state=seed, n_jobs=THREADS)
        self.model = lgb.LGBMRanker(**params) if rank else lgb.LGBMRegressor(**params)

    def fit(self, X, y, groups=None):
        if self.rank:
            grades = np.clip(np.floor((y + 0.5) * RANK_GRADES), 0, RANK_GRADES - 1).astype(int)
            self.model.fit(X, grades, group=groups)
        else:
            self.model.fit(X, y)
        return self

    def predict(self, X):
        return self.model.predict(X)


class _XGB:
    def __init__(self, seed):
        import xgboost as xgb
        self.model = xgb.XGBRegressor(**XGB_PARAMS, random_state=seed, n_jobs=THREADS)

    def fit(self, X, y, groups=None):
        self.model.fit(X, y)
        return self

    def predict(self, X):
        return self.model.predict(X)


class _Cat:
    def __init__(self, seed):
        from catboost import CatBoostRegressor
        self.model = CatBoostRegressor(**CAT_PARAMS, random_seed=seed, thread_count=THREADS)

    def fit(self, X, y, groups=None):
        self.model.fit(X, y)
        return self

    def predict(self, X):
        return self.model.predict(X)


class _MLP:
    """A small feed-forward network on standardised features."""

    def __init__(self, seed, listnet=None):
        self.seed = seed
        self.p = dict(MLP_PARAMS)
        if listnet is not None:
            self.p["listnet"] = listnet

    def _prep(self, X, fit=False):
        X = np.asarray(X, dtype=np.float32)
        if fit:
            self.median_ = np.nanmedian(X, axis=0)
            self.median_[~np.isfinite(self.median_)] = 0.0
            Xf = np.where(np.isnan(X), self.median_, X)
            self.mu_ = Xf.mean(axis=0)
            self.sd_ = Xf.std(axis=0) + 1e-6
        else:
            Xf = np.where(np.isnan(X), self.median_, X)
        return np.clip((Xf - self.mu_) / self.sd_, -5, 5).astype(np.float32)

    def fit(self, X, y, groups=None):
        import torch
        from torch import nn
        torch.set_num_threads(THREADS)
        torch.manual_seed(self.seed)
        Xs = torch.from_numpy(self._prep(X, fit=True))
        ys = torch.from_numpy(np.asarray(y, dtype=np.float32))
        n, d = Xs.shape
        layers, last = [], d
        for h in self.p["hidden"]:
            layers += [nn.Linear(last, h), nn.GELU(), nn.Dropout(self.p["dropout"])]
            last = h
        layers.append(nn.Linear(last, 1))
        self.net = nn.Sequential(*layers)
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.p["lr"], weight_decay=self.p["weight_decay"])
        listnet = float(self.p["listnet"])
        g = torch.Generator().manual_seed(self.seed)
        self.net.train()
        if listnet > 0 and groups is not None:
            # Batches are whole trading days; the ListNet term is a softmax over each day's
            # stocks, computed for every day in the batch at once with segment reductions
            gid_all = torch.from_numpy(np.repeat(np.arange(len(groups)), groups))
            starts = np.concatenate([[0], np.cumsum(groups)[:-1]])
            per_batch = max(1, self.p["batch"] // max(int(np.mean(groups)), 1))
            for _ in range(self.p["epochs"]):
                order = torch.randperm(len(groups), generator=g).numpy()
                for i in range(0, len(order), per_batch):
                    days = order[i:i + per_batch]
                    idx = np.concatenate([np.arange(starts[j], starts[j] + groups[j]) for j in days])
                    xb, yb = Xs[idx], ys[idx]
                    local = torch.from_numpy(np.repeat(np.arange(len(days)), [groups[j] for j in days]))
                    out = self.net(xb).squeeze(-1)
                    loss = nn.functional.mse_loss(out, yb)
                    G = len(days)
                    def log_softmax_seg(v):
                        m = torch.full((G,), -1e9).index_reduce_(0, local, v.detach(), "amax", include_self=True)
                        z = (v - m[local]).exp()
                        den = torch.zeros(G).index_add_(0, local, z)
                        return v - m[local] - den[local].log()
                    logp = log_softmax_seg(out)
                    q = log_softmax_seg(yb * 4.0).exp()
                    loss = loss + listnet * (-(q * logp).sum() / G)
                    opt.zero_grad(); loss.backward(); opt.step()
        else:
            for _ in range(self.p["epochs"]):
                perm = torch.randperm(n, generator=g)
                for i in range(0, n, self.p["batch"]):
                    idx = perm[i:i + self.p["batch"]]
                    out = self.net(Xs[idx]).squeeze(-1)
                    loss = nn.functional.mse_loss(out, ys[idx])
                    opt.zero_grad(); loss.backward(); opt.step()
        self.net.eval()
        return self

    def predict(self, X):
        import torch
        with torch.no_grad():
            Xs = torch.from_numpy(self._prep(X))
            out = []
            for i in range(0, len(Xs), 65536):
                out.append(self.net(Xs[i:i + 65536]).squeeze(-1).numpy())
        return np.concatenate(out) if out else np.zeros(0)


def make(kind: str, seed: int, hzn: int | None = None):
    """A learner of the given kind: hgb is made by models.make_gbm; the rest live here."""
    if kind == "lgbm":
        return _LGBM(seed)
    if kind == "lgbm_port":
        return _LGBM(seed, params=LGBM_PORT_PARAMS)
    if kind == "lgbm_reg":
        return _LGBM(seed, params=LGBM_REG_BY_H.get(hzn, LGBM_REG_BY_H[21]))
    if kind == "lgbm_huber":
        return _LGBM(seed, params=LGBM_HUBER_PARAMS)
    if kind == "lgbm_rank":
        return _LGBM(seed, rank=True)
    if kind == "xgb":
        return _XGB(seed)
    if kind == "cat":
        return _Cat(seed)
    if kind == "mlp":
        return _MLP(seed)
    if kind == "mlp_rank":
        return _MLP(seed, listnet=1.0)
    raise ValueError(f"unknown learner kind {kind!r}")
