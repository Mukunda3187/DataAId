import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Database, Download, Send, Sparkles, Lightbulb, HelpCircle } from 'lucide-react';
import { AnalysisResult, ChatMessage, ConfidenceLevel } from '../types/dataQuality';
import { ActivePage } from '../components/Sidebar';

interface DatamatePageProps {
  currentAnalysis: AnalysisResult | null;
  onNavigate: (page: ActivePage) => void;
  messages: ChatMessage[];
  onSend: (message: string, mode: 'ask' | 'build') => Promise<void>;
  onRequestHistory: (jobId: string) => Promise<void>;
}

export const DatamatePage: React.FC<DatamatePageProps> = ({
  currentAnalysis,
  onNavigate,
  messages,
  onSend,
  onRequestHistory
}) => {
  const [chatQuestion, setChatQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const chatMode: 'ask' = 'ask';

  // Helper: confidence badge color
  function confidenceBadgeClass(level: ConfidenceLevel): string {
    switch (level) {
      case 'High': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'Medium': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'Low': return 'bg-rose-100 text-rose-700 border-rose-200';
    }
  }

  // Load server-persisted history once per job so a browser reload restores the
  // full conversation. We only fetch when local history is empty: App state keeps
  // the conversation across page switches, and an in-flight optimistic message
  // (length > 0) must not be clobbered by a server reload.
  const loadedJobIdRef = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const jobId = currentAnalysis?.jobId;
    if (!jobId) return;
    // Don't reload for the same job twice in one mount, and don't overwrite
    // history already held in App state (prior visit or in-flight send).
    if (loadedJobIdRef.current === jobId) return;
    loadedJobIdRef.current = jobId;
    if (messages.length === 0) {
      onRequestHistory(jobId);
    }
    // Re-evaluate only when the active job changes. `messages` and
    // `onRequestHistory` are intentionally read from the closure at that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAnalysis?.jobId]);

  // Keep the conversation scrolled to the newest message as it grows.
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!chatQuestion.trim() || sending) return;
    const question = chatQuestion.trim();
    setSending(true);
    setError('');
    try {
      await onSend(question, chatMode);
      setChatQuestion('');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not process that message. Please try again.'
      );
    } finally {
      setSending(false);
    }
  };

  if (!currentAnalysis) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center max-w-md mx-auto shadow-xs my-10">
        <Bot className="w-12 h-12 text-slate-300 mx-auto mb-3" />
        <h3 className="text-base font-bold text-slate-900">No Dataset Loaded</h3>
        <p className="text-xs text-slate-500 mt-1 mb-5">
          Upload a dataset to start a conversation with Datamate about its structure and quality.
        </p>
        <button
          onClick={() => onNavigate('overview')}
          className="px-4 py-2 rounded-lg bg-[#086288] text-white text-xs font-bold hover:bg-[#053b53] transition cursor-pointer"
        >
          Go to Home
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6 shadow-xs">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#97D7FF]/20 text-[#086288] text-xs font-semibold">
            <Bot className="w-3.5 h-3.5 text-[#086288]" />
            <span>Datamate</span>
          </span>
          <span className="text-xs text-slate-300">•</span>
          <span className="text-xs text-slate-600 font-medium">
            {currentAnalysis.summary.columnCount} Columns Available
          </span>
        </div>

        <h2 className="text-xl font-bold text-slate-900 tracking-tight">
          Datamate
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Ask questions about your dataset and get answers based on its actual contents.
        </p>
      </div>

      {/* Conversation */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs flex flex-col overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center gap-2">
          <Bot className="w-5 h-5 text-[#086288]" />
          <h3 className="font-bold text-slate-900">Conversation</h3>
          <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-[#97D7FF]/30 text-[#086288] font-bold">
            {currentAnalysis.summary.name}
          </span>
        </div>

        <div ref={messagesRef} className="flex-1 overflow-y-auto p-5 space-y-4 max-h-[55vh] bg-slate-50/60">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-12 text-slate-400">
              <Sparkles className="w-8 h-8 text-[#086288] mb-3" />
              <p className="text-sm font-semibold text-slate-600">Ask Datamate a question</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                In <strong>Ask AI</strong> mode, ask questions like "What is the average salary?" or "Which city has most customers?"<br />
              </p>
            </div>
          ) : (
            messages.map((message, index) => {
              // Assistant message carrying a built subset: render a preview card
              // with Download CSV and Download Excel buttons.
              if (message.role === 'assistant' && message.subset) {
                const subset = message.subset;
                return (
                  <div key={index} className="flex justify-start">
                    <div className="w-full max-w-[92%] rounded-xl border border-slate-200 bg-white shadow-xs p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Database className="w-4 h-4 text-[#086288]" />
                        <span className="text-sm font-bold text-slate-900">
                          Dataset: {subset.rowCount} rows × {subset.columns.length} columns — via {subset.provider}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mb-3">{message.content}</p>

                      {/* Scrollable preview table over the output columns */}
                      <div className="overflow-x-auto max-h-[40vh] rounded-lg border border-slate-200">
                        <table className="min-w-full text-xs border-collapse">
                          <thead className="bg-slate-50 sticky top-0">
                            <tr>
                              {subset.columns.map(col => (
                                <th
                                  key={col}
                                  className="px-2 py-1.5 text-left font-bold text-slate-600 border-b border-slate-200 whitespace-nowrap"
                                >
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {subset.previewRows.length === 0 ? (
                              <tr>
                                <td colSpan={subset.columns.length} className="px-2 py-4 text-center text-slate-400">
                                  No rows match this subset.
                                </td>
                              </tr>
                            ) : (
                              subset.previewRows.map((row, ri) => (
                                <tr key={ri} className={ri % 2 === 1 ? 'bg-slate-50/50' : ''}>
                                  {subset.columns.map(col => (
                                    <td
                                      key={col}
                                      className="px-2 py-1.5 text-slate-700 border-b border-slate-100 max-w-[200px] truncate align-top"
                                      title={String(row[col] ?? '')}
                                    >
                                      {String(row[col] ?? '')}
                                    </td>
                                  ))}
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* Warnings (e.g. unknown columns / unsupported operators) */}
                      {subset.warnings && subset.warnings.length > 0 && (
                        <ul className="mt-3 bg-amber-50 text-amber-700 rounded-lg p-2 text-xs space-y-0.5 list-none">
                          {subset.warnings.map((w, wi) => (
                            <li key={wi}>⚠ {w}</li>
                          ))}
                        </ul>
                      )}

                      {/* Download buttons */}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <a
                          href={
                            '/api/subset/download/' +
                            encodeURIComponent(currentAnalysis.jobId) +
                            '/' +
                            encodeURIComponent(subset.subsetId)
                          }
                          download
                          className="inline-flex items-center gap-2 rounded-lg bg-[#086288] hover:bg-[#053b53] px-4 py-2 text-sm font-bold text-white transition"
                        >
                          <Download className="w-4 h-4" />
                          Download CSV
                        </a>
                        <a
                          href={
                            '/api/subset/download-excel/' +
                            encodeURIComponent(currentAnalysis.jobId) +
                            '/' +
                            encodeURIComponent(subset.subsetId)
                          }
                          download
                          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition"
                        >
                          <Download className="w-4 h-4" />
                          Download Excel
                        </a>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={index}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap ${
                      message.role === 'user'
                        ? 'bg-[#086288] text-white rounded-br-sm'
                        : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm shadow-xs'
                    }`}
                  >
                    {message.role === 'assistant' && (
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-[#086288]">Datamate</span>
                        {/* Confidence badge — only on new structured messages */}
                        {message.structured && (
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${confidenceBadgeClass(message.structured.confidence)}`}>
                            {message.structured.confidence} confidence
                          </span>
                        )}
                        {/* Clarification pill */}
                        {message.structured?.clarificationNeeded && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200 flex items-center gap-1">
                            <HelpCircle className="w-3 h-3" />
                            Clarification needed
                          </span>
                        )}
                      </div>
                    )}
                    {/* Main answer content */}
                    <span className={message.structured?.clarificationNeeded ? 'italic' : ''}>{message.content}</span>

                    {/* Structured fields — only on new messages with structured data */}
                    {message.role === 'assistant' && message.structured && (
                      <div className="mt-2 space-y-2">
                        {/* Evidence */}
                        {message.structured.evidence.length > 0 && (
                          <div className="bg-[#97D7FF]/10 border border-[#97D7FF]/30 rounded-lg p-2">
                            <div className="text-[10px] font-bold uppercase tracking-wide text-[#086288] mb-1">Evidence</div>
                            <ul className="space-y-0.5">
                              {message.structured.evidence.map((ev, ei) => (
                                <li key={ei} className="text-xs text-slate-600 flex items-start gap-1.5">
                                  <span className="text-[#086288] font-bold mt-0.5">•</span>
                                  {ev}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Recommendation */}
                        {message.structured.recommendation && (
                          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 flex items-start gap-1.5">
                            <Lightbulb className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                            <div>
                              <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 mb-0.5">Recommendation</div>
                              <p className="text-xs text-emerald-700">{message.structured.recommendation}</p>
                            </div>
                          </div>
                        )}

                        {/* Warnings */}
                        {message.structured.warnings.length > 0 && (
                          <ul className="bg-amber-50 text-amber-700 rounded-lg p-2 text-xs space-y-0.5 list-none">
                            {message.structured.warnings.map((w, wi) => (
                              <li key={wi} className="flex items-start gap-1.5">
                                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                {w}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {error && (
          <div className="px-5 py-2 bg-rose-50 border-t border-rose-200 text-sm text-rose-700">{error}</div>
        )}

        {/* Pinned input form */}
        <form onSubmit={handleSubmit} className="border-t border-slate-200 p-4 bg-white">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={chatQuestion}
              onChange={e => setChatQuestion(e.target.value)}
              maxLength={2000}
              placeholder='Ask anything about your dataset, e.g. average salary, missing values, row count, column details...' 
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#086288]"
            />
            <button
              type="submit"
              disabled={sending || !chatQuestion.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#086288] hover:bg-[#053b53] px-4 py-2 text-sm font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
            >
              <Send className="w-4 h-4" />
              {sending ? 'Thinking...' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
