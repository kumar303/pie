/**
 * Pure state machine for the `/vs-code-but-chill logs` overlay.
 *
 * Extracted from `index.ts::showLogs` so the scroll/pause/resume
 * behavior can be unit-tested without driving the real TUI.
 * The overlay owns the `Text` component and input plumbing; this
 * module just answers "given the current state and an action, what's
 * the next state?".
 */

export interface LogViewerState {
  /** First visible line index, 0-based. */
  offset: number;
  /** `true` when new lines pin the window to the bottom. */
  followMode: boolean;
  /** Number of lines received while paused. Reset on resume. */
  pendingCount: number;
}

export function initialState(): LogViewerState {
  return { offset: 0, followMode: true, pendingCount: 0 };
}

/** Clamp `offset` to a valid range given buffer and body height. */
export function clampOffset(
  state: LogViewerState,
  bufferLength: number,
  bodyHeight: number,
): LogViewerState {
  const max = Math.max(0, bufferLength - bodyHeight);
  let offset = state.offset;
  if (offset > max) offset = max;
  if (offset < 0) offset = 0;
  return { ...state, offset };
}

/**
 * Recompute offset when follow mode is on. In follow mode the view
 * always pins to the bottom and pending is zero.
 */
export function applyFollow(
  state: LogViewerState,
  bufferLength: number,
  bodyHeight: number,
): LogViewerState {
  const next = clampOffset(state, bufferLength, bodyHeight);
  if (!next.followMode) return next;
  return {
    ...next,
    offset: Math.max(0, bufferLength - bodyHeight),
    pendingCount: 0,
  };
}

/** A new log line arrived. */
export function onNewLine(state: LogViewerState): LogViewerState {
  return state.followMode
    ? state
    : { ...state, pendingCount: state.pendingCount + 1 };
}

/** Up arrow: pause and scroll up one line. */
export function onScrollUp(state: LogViewerState): LogViewerState {
  return {
    ...state,
    followMode: false,
    offset: Math.max(0, state.offset - 1),
  };
}

/**
 * Down arrow: scroll down one line. Snaps back to follow mode when
 * the user hits the bottom.
 */
export function onScrollDown(
  state: LogViewerState,
  bufferLength: number,
  bodyHeight: number,
): LogViewerState {
  const nextOffset = state.offset + 1;
  const max = Math.max(0, bufferLength - bodyHeight);
  if (nextOffset >= max) {
    return { ...state, followMode: true, offset: max, pendingCount: 0 };
  }
  return { ...state, offset: nextOffset };
}

/** `g`: pause and jump to the top. */
export function onJumpTop(state: LogViewerState): LogViewerState {
  return { ...state, followMode: false, offset: 0 };
}

/** `G`: resume follow and jump to the bottom. */
export function onJumpBottom(
  state: LogViewerState,
  bufferLength: number,
  bodyHeight: number,
): LogViewerState {
  return {
    ...state,
    followMode: true,
    offset: Math.max(0, bufferLength - bodyHeight),
    pendingCount: 0,
  };
}
