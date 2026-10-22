import {observedStage} from './monitoring.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
const profiles = new AsyncLocalStorage();
function timedMeasure(name, operation) {
  const profile = profiles.getStore();
  if (!profile) return operation();
  return (async()=>{
    const start = performance.now();
    try { return await operation(); }
    finally { profile[name] = (profile[name] || 0) + performance.now() - start; }
  })();
}
function timedMeasureSync(name, operation) {
  const profile = profiles.getStore();
  if (!profile) return operation();
  const start = performance.now();
  try { return operation(); }
  finally { profile[name] = (profile[name] || 0) + performance.now() - start; }
}
export async function profileSearch(operation) {
  const stages = {}, start = performance.now();
  const result = await profiles.run(stages, operation);
  return { result, server_ms: performance.now() - start, stages_ms: stages };
}
const startedAt = Date.now();
const recent = [];
let accepted = 0, active = 0, waiting = 0, failed = 0, lastError = null;
let enabled = false;
export const statisticsEnabled = () => enabled;
export function setStatistics(value) {
  enabled = value;
  recent.length = 0; accepted = 0; failed = 0; lastError = null;
  return runtimeStatus();
}
export function requestAccepted() { accepted++; waiting++; }
export function requestStarted() { waiting--; active++; }
export function requestFinished(status, elapsed, queueMs) {
  active--;
  if (status >= 500) { failed++; lastError = { at: new Date().toISOString(), status }; }
  recent.push({ ms: elapsed, queue_ms: queueMs, at: Date.now(), status });
  if (recent.length > 100) recent.shift();
}
export function runtimeStatus() {
  const now = Date.now(), window = recent.filter(r => now - r.at <= 60000);
  const times = recent.map(r => r.ms).sort((a,b) => a-b);
  return { scope: 'current_isolate', statistics_enabled: enabled, started_at: new Date(startedAt).toISOString(),
    uptime_seconds: Math.floor((now-startedAt)/1000), accepted, active, waiting,
    server_errors: failed, last_error: lastError, requests_last_minute: window.length,
    window_capacity: 100, recent_count: times.length,
    recent_median_ms: times.length ? times[Math.floor((times.length-1)*0.5)] : null,
    recent_p95_ms: times.length ? times[Math.ceil(times.length*0.95)-1] : null,
    host_cpu_percent: null, host_memory_bytes: null };
}

export const measure=(name,operation)=>observedStage(name,()=>timedMeasure(name,operation));
export const measureSync=(name,operation)=>observedStage(name,()=>timedMeasureSync(name,operation));
