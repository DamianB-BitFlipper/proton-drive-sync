import type { FC } from 'hono/jsx';
import { Icon } from './Icon.js';

export const AddDirectoryModal: FC = () => {
  return (
    <div id="add-dir-modal" class="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div class="absolute inset-0 bg-black/60"></div>

      {/* Modal */}
      <div class="relative bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-xl">
        <h3 class="text-lg font-semibold text-white mb-4">Add Sync Directory</h3>

        <form
          hx-post="/api/add-directory"
          hx-target="#sync-dirs-list"
          hx-swap="innerHTML"
          {...{
            'hx-on::after-request':
              "if(event.detail.successful) showToast('Config updated', 'success')",
          }}
        >
          {/* Local Path */}
          <div class="mb-4">
            <label class="block text-xs text-gray-500 mb-1">Local Path</label>
            <input
              type="text"
              name="source_path"
              placeholder="/path/to/local/directory"
              class="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-proton"
              required
            />
          </div>

          {/* Remote Root */}
          <div class="mb-6">
            <div class="flex items-center gap-1 mb-1">
              <label class="block text-xs text-gray-500">Remote Root</label>
              <div class="relative group">
                <Icon name="info" class="w-3 h-3 text-gray-500 cursor-help" />
                <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-96 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                  The destination folder in Proton Drive. Must start with / indicating the base of
                  the Proton Drive filesystem.
                </div>
              </div>
            </div>
            <input
              type="text"
              name="remote_root"
              placeholder="/"
              class="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-proton"
            />
          </div>

          <label class="mb-6 flex items-center gap-3 text-sm text-gray-300">
            <input
              type="checkbox"
              name="two_way"
              value="true"
              class="h-4 w-4 rounded border-gray-600 bg-gray-900 text-proton focus:ring-proton"
            />
            <span>Enable two-way sync for this folder</span>
          </label>

          {/* Buttons */}
          <div class="flex justify-end gap-3">
            <button
              type="button"
              onclick="document.getElementById('add-dir-modal').remove()"
              class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              class="px-4 py-2 bg-proton hover:bg-proton-dark text-white text-sm font-medium rounded-lg transition-colors"
            >
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
