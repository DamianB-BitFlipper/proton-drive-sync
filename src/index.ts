/**
 * Proton Drive Sync CLI
 */

import { program } from 'commander';
import { authCommand } from './cli/auth.js';
import { configCommand } from './cli/config.js';
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
import { stopCommand } from './cli/stop.js';
import { startCommand } from './cli/start.js';
import { dashboardCommand } from './cli/dashboard.js';

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
  .action(authCommand);

program.command('config').description('Open config file in nano').action(configCommand);

program
  .command('reset')
  .description('Reset sync state')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--signals', 'Clear only the signals table')
  .option('--retries', 'Remove only sync jobs pending retry')
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
  .action(serviceInstallCommand);

serviceCommand
  .command('uninstall')
  .description('Stop and uninstall the system service')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action((options) => serviceUninstallCommand(!options.yes));

serviceCommand.command('load').description('Load the service').action(serviceLoadCommand);

serviceCommand
  .command('unload')
  .description('Unload the service (will reload on next boot)')
  .action(serviceUnloadCommand);

program.parse();
