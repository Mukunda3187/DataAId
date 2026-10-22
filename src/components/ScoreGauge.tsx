import React from 'react';
import { QualityScore } from '../types/dataQuality';
import { ShieldCheck, Check, AlertCircle } from 'lucide-react';

interface ScoreGaugeProps {
  score: QualityScore;
  previousScore?: QualityScore;
  size?: 'normal' | 'compact';
}

export const ScoreGauge: React.FC<ScoreGaugeProps> = ({ score, previousScore, size = 'normal' }) => {
  const getScoreColor = (val: number) => {
    if (val >= 85) return 'text-emerald-600';
    if (val >= 70) return 'text-[#086288]';
    if (val >= 50) return 'text-amber-500';
    return 'text-rose-600';
  };

  const getScoreBg = (val: number) => {
    if (val >= 85) return 'bg-emerald-50 border-emerald-200';
    if (val >= 70) return 'bg-[#97D7FF]/20 border-[#4D8DBA]/30';
    if (val >= 50) return 'bg-amber-50 border-amber-200';
    return 'bg-rose-50 border-rose-200';
  };

  const delta = previousScore ? Number((score.overall - previousScore.overall).toFixed(1)) : null;

  return (
    <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-xs">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-slate-800">Overall Data Quality Score</h3>
          <p className="text-xs text-slate-500">Transparent weighted formula (0–100 scale)</p>
        </div>
        <ShieldCheck className="w-5 h-5 text-[#086288]" />
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-6">
        {/* Main Circular / Hero Score */}
        <div className={`flex flex-col items-center justify-center w-32 h-32 rounded-2xl border-2 ${getScoreBg(score.overall)} shrink-0`}>
          <span className={`text-4xl font-extrabold tracking-tight ${getScoreColor(score.overall)}`}>
            {score.overall}
          </span>
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mt-0.5">
            Quality Index
          </span>
          {delta !== null && (
            <span className={`text-[11px] font-bold mt-1 px-2 py-0.5 rounded-full ${
              delta >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
            }`}>
              {delta >= 0 ? `+${delta}%` : `${delta}%`}
            </span>
          )}
        </div>

        {/* 4 Pillars Breakdown */}
        <div className="flex-1 w-full grid grid-cols-2 gap-3">
          {/* Completeness */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200/70">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Completeness</span>
              <span className="font-bold text-[#086288]">{score.completeness}%</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-[#086288] h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min(100, Math.max(0, score.completeness))}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-400 mt-1 block">Weight: {(score.weights.completeness * 100).toFixed(0)}%</span>
          </div>

          {/* Validity */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200/70">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Validity</span>
              <span className="font-bold text-[#4D8DBA]">{score.validity}%</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-[#4D8DBA] h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min(100, Math.max(0, score.validity))}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-400 mt-1 block">Weight: {(score.weights.validity * 100).toFixed(0)}%</span>
          </div>

          {/* Uniqueness */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200/70">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Uniqueness</span>
              <span className="font-bold text-[#086288]">{score.uniqueness}%</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-[#086288] h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min(100, Math.max(0, score.uniqueness))}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-400 mt-1 block">Weight: {(score.weights.uniqueness * 100).toFixed(0)}%</span>
          </div>

          {/* Consistency */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200/70">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-semibold text-slate-700">Consistency</span>
              <span className="font-bold text-[#4D8DBA]">{score.consistency}%</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-[#4D8DBA] h-1.5 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min(100, Math.max(0, score.consistency))}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-400 mt-1 block">Weight: {(score.weights.consistency * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
        <span className="truncate pr-2">{score.explanation}</span>
        <span className="font-semibold text-slate-700 shrink-0">
          {score.unresolvedIssues} Unresolved
        </span>
      </div>
    </div>
  );
};
