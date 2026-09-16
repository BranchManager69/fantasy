"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { readAnalystStream } from "@/lib/analyst-stream";

type Availability = {
  enabled: boolean;
  remaining: number;
  dailyLimit: number;
  busy: boolean;
  activity?: { stage: string; elapsedMs: number } | null;
};

type AnalystAnswer = {
  answer: string;
  sources: { label: string; url: string }[];
  runId: string;
  toolsUsed: string[];
};

const suggestions = [
  "What decided this matchup?",
  "Was my bench decision costly?",
  "How unlucky was my schedule?",
];

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function LeagueAnalyst({
  season, week, teamId, teamName,
}: {
  season: number; week: number; teamId: number; teamName: string;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AnalystAnswer | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityError, setAvailabilityError] = useState("");
  const [checkingAvailability, setCheckingAvailability] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [statusVersion, setStatusVersion] = useState(0);
  const [progress, setProgress] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const id = `analyst-${season}-${week}-${teamId}`;

  useEffect(() => {
    const controller = new AbortController();
    setCheckingAvailability(true);
    setAvailabilityError("");
    fetch("/api/analyst", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Availability check failed");
        const payload: Availability = await response.json();
        if (typeof payload.enabled !== "boolean" || typeof payload.busy !== "boolean"
          || !Number.isFinite(payload.remaining) || !Number.isFinite(payload.dailyLimit)) {
          throw new Error("Invalid availability response");
        }
        if (!controller.signal.aborted) setAvailability(payload);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAvailability(null);
          setAvailabilityError("We could not check the analyst's availability.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCheckingAvailability(false);
      });
    return () => controller.abort();
  }, [statusVersion]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    if (pending || !availability?.busy) return;
    const timer = setTimeout(() => setStatusVersion((version) => version + 1), 3000);
    return () => clearTimeout(timer);
  }, [availability, pending, statusVersion]);

  const canAsk = availability?.enabled && availability.remaining > 0 && !availability.busy;
  const blocked = pending || checkingAvailability || !canAsk;
  const sources = answer?.sources.flatMap((source) => {
    const url = safeSourceUrl(source.url);
    return url ? [{ ...source, url }] : [];
  }) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (blocked || !trimmed || trimmed.length > 1200 || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setElapsed(0);
    setProgress("Preparing your league evidence...");
    setError("");
    setAnswer(null);
    try {
      const response = await fetch("/api/analyst", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ season, week, teamId, question: trimmed }),
        signal: controller.signal,
      });
      const payload = response.ok && response.headers.get("content-type")?.includes("text/event-stream")
        ? await readAnalystStream(response, setProgress)
        : await response.json().catch(() => { throw new Error("The answer could not be read. Please try again."); });
      if (!response.ok || typeof payload.error === "string") {
        throw new Error(typeof payload.error === "string" ? payload.error : "The analyst could not answer. Please try again.");
      }
      if (typeof payload.answer !== "string" || !payload.answer.trim() || !Array.isArray(payload.sources)) {
        throw new Error("The answer could not be read. Please try again.");
      }
      if (!controller.signal.aborted) {
        setAnswer({
          answer: payload.answer,
          sources: payload.sources.filter((source: { label?: unknown; url?: unknown } | null) =>
            source && typeof source.label === "string" && typeof source.url === "string"),
          runId: typeof payload.runId === "string" ? payload.runId : "",
          toolsUsed: Array.isArray(payload.toolsUsed) ? payload.toolsUsed : [],
        });
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof TypeError
          ? "The analyst could not be reached. Check your connection and try again."
          : cause instanceof Error ? cause.message : "The analyst could not answer. Please try again.");
      }
    } finally {
      if (!controller.signal.aborted) {
        activeRequest.current = null;
        setPending(false);
        setStatusVersion((version) => version + 1);
      }
    }
  }

  return <section className="week-analyst" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Ask about {teamName}</h3>
    <p className="week-analyst-intro">Plays, lineup decisions, or how your week could have gone differently.</p>
    <form onSubmit={submit} aria-busy={pending}>
      <div className="week-analyst-suggestions" aria-label="Suggested questions">
        {suggestions.map((suggestion) => <button key={suggestion} type="button" disabled={pending} onClick={() => {
          setQuestion(suggestion); setError(""); textarea.current?.focus();
        }}>{suggestion}</button>)}
      </div>
      <label className="week-field" htmlFor={`${id}-question`}>Your question</label>
      <textarea
        ref={textarea}
        id={`${id}-question`}
        name="question"
        rows={3}
        maxLength={1200}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        disabled={pending}
        aria-describedby={`${id}-limit`}
        autoComplete="off"
        placeholder="What would you like to understand about this week?"
        required
      />
      <div className="week-analyst-actions">
        <button className="week-analyst-submit" type="submit" disabled={blocked || !question.trim()}>{pending ? `Working · ${elapsed}s` : "Ask the analyst"}</button>
        <span id={`${id}-limit`}>{question.length > 1000 ? `${1200 - question.length} characters left` : ""}</span>
      </div>
    </form>
    <div className="week-analyst-status" role="status">
      {pending ? <p>{progress}{elapsed >= 45 && <span> Taking longer than usual; the request is still open.</span>}</p>
        : checkingAvailability ? <p>Checking analyst availability...</p>
          : availabilityError ? <p>{availabilityError}</p>
            : !availability?.enabled ? <p>The analyst is unavailable right now.</p>
              : availability.remaining <= 0 ? <p>Today&apos;s question limit has been reached. Please come back tomorrow.</p>
                : availability.busy ? <p>{availability.activity?.stage === "cleaning_up"
                  ? "The previous request is closing. Availability refreshes automatically."
                  : "An analysis is already running. Availability refreshes automatically."}</p>
                  : <p>{availability.remaining} of {availability.dailyLimit} questions remaining today.</p>}
      {!pending && !checkingAvailability && (availabilityError || !availability?.enabled || availability?.busy) && <button className="week-analyst-recheck" type="button" onClick={() => setStatusVersion((version) => version + 1)}>Check availability</button>}
    </div>
    {error && <p className="week-analyst-error" role="alert">{error} Your question has been kept above.</p>}
    {answer && <div className="week-analyst-answer" aria-live="polite">
      <p>{answer.answer}</p>
      {sources.length > 0 && <nav className="week-analyst-sources" aria-label="Answer sources"><h4>Sources</h4><ul>{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></li>)}</ul></nav>}
    </div>}
  </section>;
}
