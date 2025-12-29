import type { FC } from 'hono/jsx';
import type { SyncStatus } from './types.js';

type Props = {
  syncStatus: SyncStatus;
};

/**
 * Pause/Resume button for the Controls page, styled as a card to match the Shut Down section.
 * Returns empty string when disconnected (hidden alongside stop section).
 */
export const ControlsPauseButton: FC<Props> = ({ syncStatus }) => {
  if (syncStatus === 'disconnected') {
    return (
      <div id="controls-pause-button" hx-swap-oob="true" sse-swap="controls-pause-button"></div>
    );
  }

  if (syncStatus === 'paused') {
    return (
      <div
        id="controls-pause-button"
        hx-swap-oob="true"
        sse-swap="controls-pause-button"
        class="bg-gray-800 rounded-xl border border-gray-700 p-6 h-[88px]"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold text-white">Sync Paused</h3>
          <button
            hx-post="/api/toggle-pause"
            hx-target="#controls-pause-button"
            hx-swap="outerHTML"
            class="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            <i data-lucide="play" class="w-4 h-4"></i>
            Resume
          </button>
        </div>
      </div>
    );
  }

  // syncing state
  return (
    <div
      id="controls-pause-button"
      hx-swap-oob="true"
      sse-swap="controls-pause-button"
      class="bg-gray-800 rounded-xl border border-gray-700 p-6 h-[88px]"
    >
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold text-white">Pause Sync</h3>
        <button
          hx-post="/api/toggle-pause"
          hx-target="#controls-pause-button"
          hx-swap="outerHTML"
          class="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm font-medium rounded-lg border border-gray-500 transition-colors cursor-pointer"
        >
          <i data-lucide="pause" class="w-4 h-4"></i>
          Pause
        </button>
      </div>
    </div>
  );
};
