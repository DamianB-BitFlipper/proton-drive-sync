import type { FC } from 'hono/jsx';
import type { JobCounts } from './types.js';
import { Icon } from './Icon.js';

export const Stats: FC<{ counts: JobCounts }> = ({ counts }) => {
  return (
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
      {/* Pending */}
      <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-amber-500/50 transition-colors group relative overflow-hidden">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="clock" class="w-12 h-12 text-amber-500" />
        </div>
        <dt class="text-sm font-medium text-gray-400">Pending</dt>
        <dd class="mt-2 text-3xl font-bold text-white group-hover:text-amber-400 transition-colors">
          {counts.pending}
        </dd>
      </div>

      {/* Processing */}
      <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-blue-500/50 transition-colors group relative overflow-hidden">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="refresh-cw" class="w-12 h-12 text-blue-500" />
        </div>
        <dt class="text-sm font-medium text-gray-400">Processing</dt>
        <dd class="mt-2 text-3xl font-bold text-white group-hover:text-blue-400 transition-colors">
          {counts.processing}
        </dd>
      </div>

      {/* Recently Synced */}
      <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-green-500/50 transition-colors group relative overflow-hidden">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="check" class="w-12 h-12 text-green-500" />
        </div>
        <dt class="text-sm font-medium text-gray-400">Recently Synced</dt>
        <dd class="mt-2 text-3xl font-bold text-white group-hover:text-green-400 transition-colors">
          {counts.synced}
        </dd>
      </div>

      {/* Blocked */}
      <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-red-500/50 transition-colors group relative overflow-hidden">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="triangle-alert" class="w-12 h-12 text-red-500" />
        </div>
        <dt class="text-sm font-medium text-gray-400">Blocked</dt>
        <dd class="mt-2 text-3xl font-bold text-white group-hover:text-red-400 transition-colors">
          {counts.blocked}
        </dd>
      </div>

      {/* Conflicts */}
      <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-orange-500/50 transition-colors group relative overflow-hidden">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="git-compare-arrows" class="w-12 h-12 text-orange-500" />
        </div>
        <dt class="text-sm font-medium text-gray-400">Conflicts</dt>
        <dd class="mt-2 text-3xl font-bold text-white group-hover:text-orange-400 transition-colors">
          {counts.conflicts}
        </dd>
      </div>
    </div>
  );
};
