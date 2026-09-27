"""The model server.

One process, one URL: `POST /embed`, `POST /classify`, `GET /healthz`. It serves
the two models `models.lock.json` pins — the code embedder and the injection
classifier — from the `models/` directory the application already builds, on
Metal, CUDA or CPU. Nothing is fetched at runtime: every file is read from
disk after its SHA-256 matches the lock (SEC-24), and the embedder's
architecture code is the pinned copy, imported from disk, never
`trust_remote_code` against the hub.

`/healthz` reports the identity the adapters check (model id, revision,
backend) so a server holding another revision is refused by the application.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(os.environ.get("MODELS_DIR", "models")).resolve()
LOCK = Path(os.environ.get("MODELS_LOCK", "models.lock.json")).resolve()
EMBED_MAX_TOKENS = int(os.environ.get("EMBED_MAX_TOKENS", "2048"))
CLASSIFY_MAX_TOKENS = 512
CLASSIFY_MAX_CHARS = 2000
POSITIVE_LABELS = {"INJECTION", "JAILBREAK"}


def pick_device() -> tuple[str, torch.dtype]:
    forced = os.environ.get("MODEL_SERVER_DEVICE")
    if forced:
        return forced, torch.float16 if forced != "cpu" else torch.float32
    if torch.cuda.is_available():
        return "cuda", torch.float16
    if torch.backends.mps.is_available():
        return "mps", torch.float16
    return "cpu", torch.float32


def lock_entry(purpose: str) -> dict:
    lock = json.loads(LOCK.read_text())
    for model in lock["models"]:
        if model["purpose"].startswith(purpose):
            return model
    raise SystemExit(f"models.lock.json has no model whose purpose starts with {purpose!r}")


def verify_files(entry: dict) -> Path:
    """Every pinned file of the entry is on disk with the pinned hash; the directory is returned."""
    directory = ROOT / entry["id"]
    for file in entry["files"]:
        path = directory / file["path"]
        if not path.exists():
            raise SystemExit(f"{path}: missing; run `make models`")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        if digest.hexdigest() != file["sha256"]:
            raise SystemExit(f"{path}: SHA-256 {digest.hexdigest()} does not match the pin")
    return directory


def import_pinned(directory: Path, package: str, module: str):
    """Imports `<package>.<module>` from the pinned directory: the files import each other relatively."""
    if package not in sys.modules:
        parent = types.ModuleType(package)
        parent.__path__ = [str(directory)]
        sys.modules[package] = parent
    return importlib.import_module(f"{package}.{module}")


class Models:
    def __init__(self) -> None:
        self.device, self.dtype = pick_device()
        self.backend = f"torch-{'fp16' if self.dtype == torch.float16 else 'fp32'}-{self.device}"
        self.lock = Lock()  # one inference at a time per model: the GPU is not shared

        embedder = lock_entry("code embeddings (")
        code = lock_entry("code embeddings, torch implementation")
        embedder_dir = verify_files(embedder)
        code_dir = verify_files(code)
        modeling = import_pinned(code_dir, "jina_bert_v2", "modeling_bert")
        self.embed_tokenizer = AutoTokenizer.from_pretrained(embedder_dir, local_files_only=True)
        self.embed_model = (
            modeling.JinaBertModel.from_pretrained(
                embedder_dir, local_files_only=True, torch_dtype=self.dtype
            )
            .to(self.device)
            .eval()
        )
        self.embedder_identity = {"id": embedder["id"], "revision": embedder["revision"], "backend": self.backend}

        classifier = lock_entry("injection detector")
        classifier_dir = verify_files(classifier)
        self.classify_tokenizer = AutoTokenizer.from_pretrained(classifier_dir, local_files_only=True)
        self.classify_model = (
            AutoModelForSequenceClassification.from_pretrained(
                classifier_dir, local_files_only=True, torch_dtype=self.dtype
            )
            .to(self.device)
            .eval()
        )
        self.labels = self.classify_model.config.id2label
        self.classifier_identity = {"id": classifier["id"], "revision": classifier["revision"], "backend": self.backend}

    def sync(self) -> None:
        if self.device == "mps":
            torch.mps.synchronize()
        elif self.device == "cuda":
            torch.cuda.synchronize()

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        with self.lock, torch.no_grad():
            inputs = self.embed_tokenizer(
                texts, padding=True, truncation=True, max_length=EMBED_MAX_TOKENS, return_tensors="pt"
            ).to(self.device)
            hidden = self.embed_model(**inputs).last_hidden_state
            mask = inputs["attention_mask"].unsqueeze(-1).to(hidden.dtype)
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1)
            vectors = torch.nn.functional.normalize(pooled.float(), dim=1)
            self.sync()
            return vectors.cpu().tolist()

    def classify(self, texts: list[str]) -> list[dict]:
        if not texts:
            return []
        with self.lock, torch.no_grad():
            inputs = self.classify_tokenizer(
                [t[:CLASSIFY_MAX_CHARS] for t in texts],
                padding=True,
                truncation=True,
                max_length=CLASSIFY_MAX_TOKENS,
                return_tensors="pt",
            ).to(self.device)
            logits = self.classify_model(**inputs).logits.float()
            probabilities = torch.softmax(logits, dim=-1)
            self.sync()
            scores, indices = probabilities.max(dim=-1)
            return [
                {"label": self.labels[int(i)], "score": float(s)}
                for s, i in zip(scores.cpu(), indices.cpu())
            ]


class Server(ThreadingHTTPServer):
    # The default backlog of 5 stalled connections behind a busy model: the proxy's connect timed
    # out after a minute and an ingest run was retried from the start (2026-09-15).
    request_queue_size = 128
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    models: Models

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        sys.stderr.write(json.dumps({"level": 30, "time": int(time.time() * 1000), "msg": format % args}) + "\n")

    def send_json(self, status: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        if self.path != "/healthz":
            return self.send_json(404, {"error": "no such route"})
        self.send_json(
            200,
            {
                "device": self.models.device,
                "models": {"embedder": self.models.embedder_identity, "classifier": self.models.classifier_identity},
            },
        )

    def do_POST(self) -> None:  # noqa: N802 - stdlib name
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            texts = body.get("texts")
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                return self.send_json(400, {"error": "texts: a list of strings"})
            if self.path == "/embed":
                return self.send_json(200, {"vectors": self.models.embed(texts), "maxTokens": EMBED_MAX_TOKENS})
            if self.path == "/classify":
                return self.send_json(200, {"results": self.models.classify(texts)})
            return self.send_json(404, {"error": "no such route"})
        except Exception as error:  # noqa: BLE001 - every failure is reported with its class, never swallowed
            self.log_message("%s %s failed: %s: %s", self.command, self.path, type(error).__name__, error)
            return self.send_json(500, {"error": type(error).__name__, "message": str(error)[:500]})


def main() -> None:
    started = time.time()
    Handler.models = Models()
    host = os.environ.get("MODEL_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("MODEL_SERVER_PORT", "8765"))
    server = Server((host, port), Handler)
    sys.stderr.write(
        json.dumps(
            {
                "level": 30,
                "time": int(time.time() * 1000),
                "msg": f"model server ready on http://{host}:{port} ({Handler.models.backend}) in {time.time() - started:.1f}s",
            }
        )
        + "\n"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
