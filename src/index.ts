/**
 * Proton Drive Sync CLI
 */

// Set NODE_ENV to production before any imports to suppress OpenPGP.js debug output.
// OpenPGP.js enables verbose console logging when NODE_ENV === 'development', which
// can occur if users have this set globally in their shell environment.
process.env.NODE_ENV = 'production';

import { program } from 'commander';
import { authCommand } from './cli/auth.js';
import {
  configCommand,
  getCommand,
  dashboardHostCommand,
  dashboardPortCommand,
  concurrencyCommand,
  syncDirCommand,
  excludeCommand,
} from './cli/config.js';
import { enableDebug } from './logger.js';
import { logsCommand, logsClearCommand } from './cli/logs.js';
import { pauseCommand } from './cli/pause.js';
import { resetCommand } from './cli/reset.js';
import { resumeCommand } from './cli/resume.js';
import {
  serviceInstallCommand,
  serviceUninstallCommand,
  serviceUnloadCommand,
  serviceLoadCommand,
} from './cli/service/index.js';
import type { InstallScope } from './cli/service/types.js';
import { stopCommand } from './cli/stop.js';
import { startCommand } from './cli/start.js';
import { statusCommand } from './cli/status.js';
import { dashboardCommand } from './cli/dashboard.js';
import { reconcileCommand } from './cli/reconcile.js';
import { setupCommand } from './cli/setup.js';

const { version } = (await import('../package.json')).default;

program.name('proton-drive-sync').description('Sync local files to Proton Drive').version(version);

program
  .option('--debug', 'Enable debug logging')
  .option('--sdk-debug', 'Enable Proton SDK debug logging (requires --debug)');

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.sdkDebug && !opts.debug) {
    console.error('Error: --sdk-debug requires --debug to be set');
    process.exit(1);
  }
  if (opts.debug) {
    enableDebug();
  }
});

program
  .command('auth')
  .description('Authenticate and save credentials securely')
  .option('--logout', 'Clear stored credentials from keychain')
  .action(authCommand);

const configCmd = program
  .command('config')
  .description('Manage configuration settings')
  .action(configCommand);

configCmd
  .command('get [key]')
  .description('Show config values')
  .option('--json', 'Output as JSON')
  .action(getCommand);

configCmd
  .command('dashboard-host [value]')
  .description('Set dashboard host (interactive if no value)')
  .action(dashboardHostCommand);

configCmd
  .command('dashboard-port [value]')
  .description('Set dashboard port (interactive if no value)')
  .action(dashboardPortCommand);

configCmd
  .command('concurrency [value]')
  .description('Set sync concurrency (interactive if no value)')
  .action(concurrencyCommand);

configCmd
  .command('sync-dir')
  .description('Manage sync directories')
  .option('--list', 'List sync directories')
  .option('--add <path>', 'Add sync directory')
  .option('--remote <remote>', 'Remote root for --add (default: /)')
  .option('--remove <path>', 'Remove sync directory')
  .action(syncDirCommand);

configCmd
  .command('exclude')
  .description('Manage file exclusion patterns')
  .option('--path <path>', 'Target path for exclusions (default: "/" for all sync dirs)')
  .option('--add <patterns...>', 'Add exclusion patterns')
  .option('--remove <patterns...>', 'Remove exclusion patterns')
  .option('--list', 'List exclusion patterns')
  .action(excludeCommand);

program
  .command('reset')
  .description('Reset sync state')
  .option('--purge', 'Delete all data, credentials, and uninstall service')
  .action(resetCommand);

program
  .command('start')
  .description('Start syncing changes to Proton Drive')
  .option('-n, --dry-run', 'Show what would be synced without making changes')
  .option('--no-daemon', 'Run in foreground instead of as daemon')
  .option('--no-watch', 'Sync once and exit (requires --no-daemon)')
  .option('--dashboard', 'Run as dashboard subprocess (internal use)')
  .option('--paused', 'Start with syncing paused (requires watch mode)')
  .action(startCommand);

program
  .command('dashboard')
  .description('Start the dashboard server standalone')
  .action(dashboardCommand);

program
  .command('stop')
  .description('Stop any running proton-drive-sync process')
  .action(stopCommand);

program
  .command('status')
  .description('Check if the sync service is running (JSON output)')
  .action(statusCommand);

program
  .command('pause')
  .description('Pause syncing without stopping the process')
  .action(pauseCommand);

program
  .command('resume')
  .description('Resume syncing after it has been paused')
  .action(resumeCommand);

const logsCmd = program.command('logs').description('View service logs');

logsCmd.option('-f, --follow', 'Follow logs in real-time').action(logsCommand);

logsCmd.command('clear').description('Clear log file').action(logsClearCommand);

const serviceCommand = program
  .command('service')
  .description('Manage system service (macOS launchd / Linux systemd)');

serviceCommand
  .command('install')
  .description('Install and start the system service')
  .option('--install-scope <scope>', 'Install scope: user or system (Linux only)', 'user')
  .action((options) => serviceInstallCommand(true, options.installScope as InstallScope));

serviceCommand
  .command('uninstall')
  .description('Stop and uninstall the system service')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action((options) => serviceUninstallCommand(!options.yes));

serviceCommand
  .command('load')
  .description('Load the service')
  .option('--install-scope <scope>', 'Install scope: user or system (Linux only)', 'user')
  .action((options) => serviceLoadCommand(options.installScope as InstallScope));

serviceCommand
  .command('unload')
  .description('Unload the service (will reload on next boot)')
  .option('--install-scope <scope>', 'Install scope: user or system (Linux only)', 'user')
  .action((options) => serviceUnloadCommand(options.installScope as InstallScope));

program
  .command('reconcile')
  .description('Trigger full filesystem scan on running daemon')
  .action(reconcileCommand);

program
  .command('setup')
  .description('Interactive setup wizard for first-time configuration')
  .action(setupCommand);

program.parse();
