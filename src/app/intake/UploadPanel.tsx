"use client";

import React, { useState, useEffect } from "react";
import { PreparedUpload, prepareUpload, UploadChoice } from "./prepareFiles";
import { ReaderOutput } from "../../core/readerContract";
import { intakeConfig } from "../../core/intakeConfig";
import { DocKind } from "../../core/pdfText";

export type UploadResult = {
  prepared: PreparedUpload;
  output: ReaderOutput;
  mode: "fake" | "claude";
};

type ReaderStatus = {
  mode: "off" | "fake" | "claude";
  reason?: string;
  callsRemaining?: number;
};

export default function UploadPanel(props: {
  onLoaded: (result: UploadResult) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [choices, setChoices] = useState<UploadChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Fetch reader status on mount
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const resp = await fetch("/api/reader-status", { cache: "no-store" });
        const data = (await resp.json()) as ReaderStatus;
        setStatus(data);
      } catch (err) {
        setStatus({ mode: "off", reason: "Could not check reader status" });
      } finally {
        setStatusLoading(false);
      }
    };

    fetchStatus();
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const guessedKind = guessKindFromFileName(file.name);
      setChoices((prev) => [...prev, { file, kind: guessedKind }]);
    }

    // Reset input
    e.currentTarget.value = "";
  };

  const handleKindChange = (index: number, kind: DocKind) => {
    setChoices((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], kind };
      return updated;
    });
  };

  const handleRemove = (index: number) => {
    setChoices((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRead = async () => {
    setLoading(true);
    setMessage("Preparing documents...");

    try {
      const result = await prepareUpload(choices, intakeConfig, (msg) => {
        setMessage(msg);
      });

      if (!result.ok) {
        setMessage(result.reason);
        setLoading(false);
        return;
      }

      const prepared = result.value;
      setMessage("Sending to reader...");

      const resp = await fetch("/api/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(prepared.input),
      });

      const json = (await resp.json()) as {
        ok?: boolean;
        message?: string;
        output?: ReaderOutput;
        mode?: "fake" | "claude";
      };

      if (!json.ok) {
        const msg = json.message || `The AI reader did not answer (status ${resp.status}).`;
        setMessage(msg);
        setLoading(false);
        return;
      }

      if (!json.output || !json.mode) {
        setMessage("Invalid response from reader.");
        setLoading(false);
        return;
      }

      props.onLoaded({
        prepared,
        output: json.output,
        mode: json.mode,
      });
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setLoading(false);
    }
  };

  const canRead = choices.length > 0 && !loading && status?.mode !== "off";

  return (
    <section data-testid="upload-panel" className="upload-panel">
      <div className="upload-header">
        <h2>Upload documents</h2>
        <button
          data-testid="upload-close"
          className="btn btn-small"
          onClick={props.onClose}
        >
          Close
        </button>
      </div>

      <div data-testid="upload-notice" className="upload-notice">
        Do not upload real confidential documents. This demo sends page text and page
        images to an AI model and keeps nothing.
      </div>

      <div data-testid="upload-status" className="upload-status">
        {statusLoading
          ? "Checking the AI reader..."
          : status?.mode === "off"
            ? `AI reader: off (${status.reason || "disabled"}). The sample bundle still works.`
            : status?.mode === "fake"
              ? "Test mode: recorded answers, no AI call."
              : `AI reader on: ${status?.callsRemaining ?? 0} reads left today.`}
      </div>

      <input
        data-testid="upload-input"
        type="file"
        multiple
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={handleFileSelect}
      />

      <div className="upload-rows">
        {choices.map((choice, i) => (
          <div key={i} data-testid={`upload-row-${i}`} className="upload-row">
            <span className="upload-filename">{choice.file.name}</span>
            <span className="upload-size">{formatFileSize(choice.file.size)}</span>
            <select
              data-testid={`upload-kind-${i}`}
              value={choice.kind}
              onChange={(e) => handleKindChange(i, e.currentTarget.value as DocKind)}
              className="upload-kind-select"
            >
              <option value="invoice">Commercial invoice</option>
              <option value="packingList">Packing list</option>
              <option value="billOfLading">Bill of lading</option>
            </select>
            <button
              className="btn btn-small btn-danger"
              onClick={() => handleRemove(i)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="upload-limits">
        Up to {intakeConfig.maxFiles} files, {formatFileSize(intakeConfig.maxFileBytes)},
        {intakeConfig.maxPdfPages} PDF pages each, {intakeConfig.maxImagePages} image pages in total.
        An Excel (.xlsx) file is read as text, one page per sheet (up to 4 sheets).
        At most {intakeConfig.maxInvoiceLines} invoice lines are read. HTS numbers are checked
        against a {33}-row subset of the 2026 tariff schedule.
      </div>

      <button
        data-testid="upload-read"
        className="btn btn-primary"
        disabled={!canRead}
        onClick={handleRead}
      >
        Read documents
      </button>

      <p data-testid="upload-message" role="status" className="upload-message">
        {message}
      </p>
    </section>
  );
}

function guessKindFromFileName(fileName: string): DocKind {
  const lower = fileName.toLowerCase();
  if (/lading|\bbol\b|b-l/.test(lower)) return "billOfLading";
  if (/pack|\bpl\b/.test(lower)) return "packingList";
  return "invoice";
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (bytes / 1024).toFixed(0) + " KB";
}
