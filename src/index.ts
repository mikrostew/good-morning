#!/usr/bin/env ts-node

import { spawn } from 'child_process';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import tempy from 'tempy';

import chalk from 'chalk';
import execa from 'execa';
import Listr, { ListrContext, ListrTask, ListrTaskResult } from 'listr';

// TODO - special task type for this? all stdout is saved I guess?
// add things to this, to display after the tasks are run
//const FINAL_OUTPUT: string[] = [];

// TODO: test all this shit

// TODO: move all these types into ./types.ts

export enum TaskType {
  KILL_PROC = 'kill-proc',
  START_APP = 'start-app',
  HOMEBREW = 'homebrew',
  VOLTA_PACKAGE = 'volta-package',
  EXEC = 'exec',
  EXEC_AND_SAVE = 'exec-and-save',
  GROUP = 'group',
  FUNCTION = 'function',
  REPO_UPDATE = 'repo-update',
  OPEN_URL = 'open-url',
}

export interface Config {
  // any environment vars to set for this
  environment?: {
    [key: string]: string;
  };
  // matching machine names
  machines: MachineMatchConfig;
  // the actual tasks to run, based on machine config
  tasks: ConfigTask[];
}

// specify a list of machine names, or inherit from parent task
export type MachineSpec = string[] | 'inherit';

export type ConfigTask =
  | KillProcessTask
  | StartAppTask
  | HomebrewTask
  | VoltaPackageTask
  | ExecTask
  | ExecAndSaveTask
  | TaskGroup
  | FunctionTask
  | RepoUpdateTask
  | OpenUrlTask;

interface KillProcessTask {
  name: string;
  type: TaskType.KILL_PROC;
  machines: MachineSpec;
  processes: string[];
}

interface StartAppTask {
  name: string;
  type: TaskType.START_APP;
  machines: MachineSpec;
  appPaths: string[];
}

interface HomebrewTask {
  name: string;
  type: TaskType.HOMEBREW;
  machines: MachineSpec;
  // just list of the package names
  packages: string[];
}

interface VoltaPackageTask {
  type: TaskType.VOLTA_PACKAGE;
  machines: MachineSpec;
  packages: VoltaPackage[];
}

export interface VoltaPackage {
  name: string;
}

interface ExecTask {
  name: string;
  type: TaskType.EXEC;
  machines: MachineSpec;
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

// exec a command and save the output in the configured variable in the context
interface ExecAndSaveTask {
  type: TaskType.EXEC_AND_SAVE;
  name: string;
  machines: MachineSpec;
  varName: string;
  command: string;
  args: string[];
}

// group tasks together
interface TaskGroup {
  name: string;
  type: TaskType.GROUP;
  machines: MachineSpec;
  tasks: ConfigTask[];
}

export type ListrFunction = (ctx?: ListrContext) => void | ListrTaskResult<any>;

// run a JS function
interface FunctionTask {
  name: string;
  type: TaskType.FUNCTION;
  machines: MachineSpec;
  function: ListrFunction;
}

// update a repository
interface RepoUpdateTask {
  name: string;
  type: TaskType.REPO_UPDATE;
  machines: MachineSpec;
  directory: string;
  options: RepoOptions[];
}

export type RepoOptions = 'pull&rebase' | 'push' | 'yarn';

// open a URL
interface OpenUrlTask {
  name: string;
  type: TaskType.OPEN_URL;
  machines: MachineSpec;
  url_config: {
    // map description to the URL
    [description: string]: string;
  };
}

// machine names map to the keys of this object
// (so that adding a task is easy, because it's done often,
//  but adding a machine is harder, and is done less often)
interface MachineMatchConfig {
  [key: string]: RegExp;
}

// for checking file names
interface FileCheck {
  // I could maybe simplify this to just be string | RegExp, but that' not expressive enough
  match: ((fileName: string) => boolean) | RegExp | string;
  // string with '{}' placeholder, like "{} bad characters" (like what Rust does)
  errorMsg: `${any}{}${any}`;
}

// sleep for the input number of milliseconds
export function sleep(millis: number) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

// return if the input package is installed or not
function isHomebrewPackageInstalled(packageName: string): Promise<boolean> {
  // that command will return non-zero if not installed, and execa will reject
  return execa('brew', ['ls', '--versions', packageName])
    .then(() => true)
    .catch(() => false);
}

// convert process name into a task to kill that process
function killProcessToTask(processName: string): ListrTask {
  return {
    title: `kill process '${processName}'`,
    task: async () => {
      // if the process doesn't exist, that's fine
      return execa('pkill', [processName]).catch(() => true);
    },
  };
}

// convert app path into a task to start the app
function startAppToTask(appPath: string): ListrTask {
  return {
    title: `start '${appPath}'`,
    task: async () => {
      // spawn a detached child job for this
      // https://nodejs.org/api/child_process.html#optionsdetached
      const subprocess = spawn(appPath, { detached: true, stdio: 'ignore' });
      subprocess.unref();
      // not checking if the app is running, just assuming it will be fine
    },
  };
}

// convert homebrew packages to list of tasks for install/upgrade
function homebrewPackageToTask(packageName: string): ListrTask {
  return {
    title: `install or upgrade ${packageName}`,
    task: async () => {
      if (await isHomebrewPackageInstalled(packageName)) {
        return execa('brew', ['upgrade', packageName]);
      } else {
        return execa('brew', ['install', packageName]);
      }
    },
  };
}

// first need to update homebrew
function mainHomebrewTask(): ListrTask {
  return {
    title: 'brew update',
    task: () => execa('brew', ['update']),
  };
}

// just install missing packages - don't automatically upgrade
function voltaPackageToTask(pkg: VoltaPackage): ListrTask {
  return {
    title: `ensure '${pkg.name}' is installed`,
    task: async () => {
      const isInstalled = await isVoltaPackageInstalled(pkg.name);
      if (!isInstalled) {
        return execa('npm', ['i', '-g', pkg.name]);
      }
    },
  };
}

async function isVoltaPackageInstalled(name: string): Promise<boolean> {
  const { stdout } = await execa('volta', ['list', name]);
  if (stdout === undefined || stdout === '' || /No tools or packages installed/.test(stdout)) {
    return false;
  }
  return true;
}

async function repoTask(directory: string, options: RepoOptions[]): Promise<void> {
  // what is the default branch for the repo?
  const defaultBranch = await getRepoDefaultBranch(directory);

  // save current branch
  const originalBranch = await currentGitBranch(directory);
  try {
    // run these tasks on the default branch
    if (originalBranch !== defaultBranch) {
      await gitCheckout(directory, defaultBranch);
    }

    // do things based on the options
    // (using contains should be fine here, these options are <5 things)
    if (options.includes('pull&rebase')) {
      await gitPullRebase(directory, defaultBranch);
    }
    if (options.includes('push')) {
      await gitPush(directory);
    }
    if (options.includes('yarn')) {
      await yarnInstall(directory);
    }
  } finally {
    // try to get back to the original branch
    if (originalBranch !== defaultBranch) {
      await gitCheckout(directory, originalBranch);
    }
  }
}

// is the default branch 'main' or 'master'?
async function getRepoDefaultBranch(directory: string): Promise<string> {
  const refsToCheck = [
    'refs/heads/main',
    'refs/heads/master',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
  ];

  for (const ref of refsToCheck) {
    try {
      await execa('git', ['show-ref', '--verify', '--quiet', ref], { cwd: directory });
      const branchName = path.basename(ref);
      return branchName;
    } catch {
      // if that fails, it's ok, try the next one
    }
  }
  throw new Error(`Error: ${directory} default branch is not 'main' or 'master'`);
}

async function currentGitBranch(directory: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: directory,
    });
    return stdout.trim();
  } catch (err) {
    // short message is not helpful (just shows command failed), but stderr has useful info
    const msg = err.stderr
      .split('\n')
      .map((s: string) => s.trim())
      .join(' ');
    throw new Error(`Error getting current branch: ${msg}`);
  }
}

async function gitCheckout(directory: string, branch: string): Promise<void> {
  try {
    const { stdout } = await execa('git', ['checkout', branch], {
      cwd: directory,
    });
  } catch (err) {
    // short message is not helpful (just shows command failed), but stderr has useful info
    const msg = err.stderr
      .split('\n')
      .map((s: string) => s.trim())
      .join(' ');
    throw new Error(`Error checking out branch ${branch}: ${msg}`);
  }
}

async function gitPullRebase(directory: string, branch: string): Promise<void> {
  try {
    await execa('git', ['fetch', '--all', '--prune'], { cwd: directory });
    await execa('git', ['rebase', `origin/${branch}`], { cwd: directory });
  } catch (err) {
    // short message is not helpful (just shows command failed), but stderr has useful info
    // show the last line, and put the rest in a file
    const stderrLines = err.stderr.split('\n');
    const lastLine = stderrLines[stderrLines.length - 1];
    const errorFile = tempy.file({extension: 'log'});
    await fsPromises.writeFile(errorFile, `stdout:\n${err.stdout}\n\nstderr:\n${err.stderr}`, 'utf8');
    throw new Error(`Repo ${directory}\n(Full error message saved to ${errorFile})\nError pulling and rebasing branch ${branch}: ${lastLine}`);
  }
}

async function gitPush(directory: string): Promise<void> {
  try {
    await execa('git', ['push'], { cwd: directory });
  } catch (err) {
    // short message is not helpful (just shows command failed), but stderr has useful info
    const msg = err.stderr
      .split('\n')
      .map((s: string) => s.trim())
      .join(' ');
    throw new Error(`Error pushing: ${msg}`);
  }
}

async function yarnInstall(directory: string): Promise<void> {
  try {
    await execa('yarn', ['install'], { cwd: directory });
  } catch (err) {
    // short message is not helpful (just shows command failed), but stderr has useful info
    const msg = err.stderr
      .split('\n')
      .map((s: string) => s.trim())
      .join(' ');
    throw new Error(`Error running 'yarn install': ${msg}`);
  }
}

// should this task run on this machine?
function shouldRunForMachine(
  task: ConfigTask,
  machineConfig: MachineMatchConfig,
  currentMachine: string
): boolean {
  return (
    task.machines === 'inherit' ||
    task.machines.some((machineName) => machineConfig[machineName]?.test(currentMachine))
  );
}

// rename files containing '(rename)'
export function renameRenameFiles(machineSpec: MachineSpec, syncDir: string): ConfigTask {
  return {
    name: 'remove (rename) from file names',
    type: TaskType.FUNCTION,
    machines: machineSpec,
    function: async () => {
      const dirPath = path.join(process.env['BASE_SYNC_DIR']!, syncDir);
      const fileNames = (
        await fsPromises.readdir(dirPath, {
          withFileTypes: true,
        })
      )
        .filter((f) => !f.isDirectory())
        .map((dirent) => dirent.name);
      for (const fileName of fileNames) {
        if (/rename/i.test(fileName)) {
          // remove the ' (rename)' from the file, which I guess will throw if this doesn't work?
          const newName = fileName.replace(' (rename)', '');
          await fsPromises.rename(path.join(dirPath, fileName), path.join(dirPath, newName));
        }
      }
    },
  };
}

// check the files in the input directory, setting the contextPropName in the context to true on error
export async function fileNameChecks(
  ctx: ListrContext,
  dirPath: string,
  contextPropName: string
): Promise<void> {
  const dirContents = await fsPromises.readdir(dirPath, {
    withFileTypes: true,
  });
  const fileNames = dirContents
    .filter((f) => !f.isDirectory())
    .map((f) => f.name)
    .filter((name) => name !== '.DS_Store');

  const fileChecks: FileCheck[] = [
    {
      match: /official.*(video|audio)/i,
      errorMsg: '{} official audio/video',
    },
    {
      match: /rename/i,
      errorMsg: '{} (rename)',
    },
    {
      match: /remix/i,
      errorMsg: '{} remix',
    },
    {
      match: /lyric/i,
      errorMsg: '{} lyric',
    },
    {
      match: /\(audio\)/i,
      errorMsg: '{} (audio)',
    },
    {
      match: /visuali[sz]er/i,
      errorMsg: '{} visualizer',
    },
    {
      match: /hq/i,
      errorMsg: '{} hq',
    },
    // https://www.grammarly.com/blog/capitalization-in-the-titles/
    // (prepositions, articles, and conjunctions are not capitalized)
    {
      match: (fname: string) =>
        fname
          .split('-')
          .some(
            (part) =>
              / (Of|A|And|To|The|For|Or|In|On|Out|Up) /.test(part.trim()) &&
              !/The A/.test(part.trim())
          ),
      errorMsg: '{} Of/A/And/To/The/For/Or/In/On/Out/Up',
    },
    {
      match: (fname: string) =>
        fname.split(' ').some((word) => /^[A-Z]{2,}$/.test(word) && !/II/.test(word)),
      errorMsg: '{} all caps',
    },
    {
      // could negate this regex with negative look-ahead, like /^(?!.* - )/, but I will definitely forget that syntax
      // (see https://stackoverflow.com/a/1538524 for instance)
      match: (fname: string) => !/ - /.test(fname),
      errorMsg: '{} no dashes',
    },
    {
      match: /best quality/i,
      errorMsg: '{} best quality',
    },
    {
      match: '  ',
      errorMsg: '{} extra spaces',
    },
    {
      match: (fname: string) =>
        fname.split('-').some((part) => /^[']/.test(part.trim()) || /[']$/.test(part.trim())),
      errorMsg: '{} start/end with quote mark',
    },
  ];

  const failedFiles: Record<string, boolean> = {};
  const errors = fileChecks
    .map((check: FileCheck) => {
      let matchingFiles;
      // what will we use to match?
      const howToMatch = check.match;
      if (typeof howToMatch === 'function') {
        matchingFiles = fileNames.filter(howToMatch);
      } else if (typeof howToMatch === 'string') {
        matchingFiles = fileNames.filter((fname: string) => fname.indexOf(howToMatch) >= 0);
      } else if (howToMatch instanceof RegExp) {
        matchingFiles = fileNames.filter((fname: string) => howToMatch.test(fname));
      } else {
        throw new Error(`unknown type of file check: ${JSON.stringify(check)}`);
      }

      if (matchingFiles.length > 0) {
        // add matching files to set
        for (const fileName of matchingFiles) {
          failedFiles[fileName] = true;
        }
        return check.errorMsg.replace('{}', `${matchingFiles.length}`);
      }
    })
    .filter((error) => error !== undefined);

  if (errors.length > 0) {
    ctx[contextPropName] = true;
    // open the directory in Finder to fix these
    await execa('open', [dirPath]);
    // show error summary, along with file names
    // (show error at end because Listr only shows the last line)
    throw new Error(
      [
        'Some file names had issues',
        Object.keys(failedFiles).sort().join('\n'),
        `Error(s): ${errors.join(', ')}`,
      ].join('\n')
    );
  }
}

// generate task to check for sync-conflict files in the input sync dir
export function syncConflictCheck(syncDirName: string): FunctionTask {
  return {
    name: `check ${syncDirName} files`,
    type: TaskType.FUNCTION,
    machines: 'inherit',
    function: async () => {
      const syncDirPath = path.join(process.env['BASE_SYNC_DIR']!, syncDirName);
      const { stdout } = await execa('find', [syncDirPath, '-iname', '*sync-conflict*']);
      if (stdout.length > 0) {
        throw new Error(`Found ${stdout.split('\n').length} sync-conflict files`);
      }
    },
  };
}

// TODO: make this pluggable, and dynamic, somehow?
// convert a task from config to tasks that listr can use
export function configTaskToListrTask(
  task: ConfigTask,
  machineConfig: MachineMatchConfig,
  currentMachine: string
): ListrTask {
  switch (task.type) {
    case TaskType.KILL_PROC:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => {
          // convert all the process names to tasks
          return new Listr(
            task.processes.map((processName) => killProcessToTask(processName)),
            { exitOnError: false }
          );
        },
      };
    case TaskType.START_APP:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => {
          // convert all the app paths to tasks
          return new Listr(
            task.appPaths.map((appPath) => startAppToTask(appPath)),
            { exitOnError: false }
          );
        },
      };
    case TaskType.HOMEBREW:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => {
          // convert all the configured homebrew packages to tasks
          return new Listr(
            [mainHomebrewTask()].concat(
              task.packages.map((pkgName) => homebrewPackageToTask(pkgName))
            ),
            { exitOnError: false }
          );
        },
      };
    case TaskType.VOLTA_PACKAGE:
      return {
        title: 'Volta Packages',
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => {
          // convert all the configured homebrew packages to tasks
          return new Listr(
            task.packages.map((pkg) => voltaPackageToTask(pkg)),
            { exitOnError: false }
          );
        },
      };
    case TaskType.EXEC:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        // just execa the info from the config
        task: () => execa(task.command, task.args, task.options),
      };
    case TaskType.EXEC_AND_SAVE:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        // execa the command and save the output
        task: async (ctx) => {
          const { stdout } = await execa(task.command, task.args);
          ctx[task.varName] = stdout;
        },
      };
    case TaskType.GROUP:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => {
          return new Listr(
            // convert all the tasks contained in this group
            task.tasks.map((t) => configTaskToListrTask(t, machineConfig, currentMachine)),
            { exitOnError: false }
          );
        },
      };
    case TaskType.FUNCTION:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: task.function,
      };
    case TaskType.REPO_UPDATE:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => repoTask(task.directory, task.options),
      };
    case TaskType.OPEN_URL:
      return {
        title: task.name,
        enabled: () => shouldRunForMachine(task, machineConfig, currentMachine),
        task: () => {
          return new Listr(
            // convert all configured URLs to separate sub-tasks
            Object.keys(task.url_config).map((description: string) => {
              return {
                title: description,
                task: () => execa('open', [task.url_config[description]!]),
              };
            }),
            { exitOnError: false }
          );
        },
      };
  }
}

export function runTasks(config: Config): Promise<void> {
  // this machine's name
  const machineName = os.hostname();
  console.log(`Running for machine '${chalk.green(machineName)}'`);

  // TODO: read and validate config (all machine names match, etc.)

  // set any configured env vars
  if (config.environment) {
    for (const [key, value] of Object.entries(config.environment)) {
      process.env[key] = value;
    }
  }

  const tasks: Listr = new Listr(
    config.tasks.map((task) => configTaskToListrTask(task, config.machines, machineName)),
    { exitOnError: false }
  );

  // TODO: input the initial context with env vars setup
  return tasks
    .run()
    .then(() => {
      console.log();
      console.log('no errors!');
    })
    .catch((err) => {
      // this error has a list of the errors from any failed tasks
      console.log();
      console.log(chalk.red(`${err.errors.length} task(s) had an error!`));
      console.log();
      // reprint the errors
      for (let i = 0; i < err.errors.length; i++) {
        console.log(`Error #${i + 1}`);
        // only print the error message, not the stack trace
        console.log(err.errors[i].message);
        console.log();
      }
    });
}
