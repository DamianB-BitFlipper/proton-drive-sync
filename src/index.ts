/**
 * Proton Drive Sync CLI
 */

import { program } from 'commander';
import { authCommand } from './cli/auth.js';
import { configCommand } from './cli/config.js';
import { logsCommand, logsClearCommand } from './cli/logs.js';
import { resetCommand } from './cli/reset.js';
import {
  serviceInstallCommand,
  serviceUninstallCommand,
  serviceUnloadCommand,
  serviceLoadCommand,
  serviceReloadCommand,
  stopCommand,
} from './cli/service.js';
import { startCommand } from './cli/sync.js';

program.name('proton-drive-sync').description('Sync local files to Proton Drive').version('1.0.0');

program
  .command('auth')
  .description('Authenticate and save credentials to Keychain')
  .action(authCommand);

program.command('config').description('Open config file in nano').action(configCommand);

program
  .command('reset')
  .description('Reset sync state')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(resetCommand);

program
  .command('start')
  .description('Start syncing changes to Proton Drive')
  .option('-n, --dry-run', 'Show what would be synced without making changes')
  .option('-w, --watch', 'Keep running and watch for changes')
  .option('-d, --daemon', 'Run as daemon (requires --watch, enables stop signal handling)')
  .option('--debug', 'Enable debug logging')
  .action(startCommand);

program
  .command('stop')
  .description('Stop any running proton-drive-sync process')
  .action(stopCommand);

const logsCmd = program.command('logs').description('View service logs');

logsCmd.option('-f, --follow', 'Follow logs in real-time').action(logsCommand);

logsCmd.command('clear').description('Clear log file').action(logsClearCommand);

const serviceCommand = program
  .command('service')
  .description('Manage launchd service (macOS only)');

serviceCommand
  .command('install')
  .description('Install and start the launchd service')
  .action(serviceInstallCommand);

serviceCommand
  .command('uninstall')
  .description('Stop and uninstall the launchd service')
  .action(serviceUninstallCommand);

serviceCommand.command('load').description('Load the service').action(serviceLoadCommand);

serviceCommand
  .command('unload')
  .description('Unload the service (will reload on next boot)')
  .action(serviceUnloadCommand);

serviceCommand
  .command('reload')
  .description('Reload the service (restarts to pick up config changes)')
  .action(serviceReloadCommand);

program.parse();
