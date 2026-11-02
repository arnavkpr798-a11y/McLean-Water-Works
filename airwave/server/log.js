import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = [`${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args];
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...line);
}

export function logger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
