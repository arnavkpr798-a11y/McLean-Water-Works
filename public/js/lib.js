import { h, render } from '../vendor/preact.mjs';
import htm from '../vendor/htm.mjs';

export { h, render };
export { useState, useEffect, useRef, useMemo, useCallback } from '../vendor/hooks.mjs';
export const html = htm.bind(h);
