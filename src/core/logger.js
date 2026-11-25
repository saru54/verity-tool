// Only log deliberate event metadata. Never serialize browser errors, URLs or form data.
import { AsyncLocalStorage } from 'node:async_hooks';

const logSinks = new AsyncLocalStorage();

export function withLogSink(sink, operation) {
  return logSinks.run(sink, operation);
}

export function createLogger(runId, stream = process.stderr) {
  return (event, metadata = {}) => {
    const record = { time: new Date().toISOString(), runId, event, ...metadata };
    const sink = logSinks.getStore();
    if (sink) sink(record);
    else stream.write(`${JSON.stringify(record)}\n`);
  };
}
