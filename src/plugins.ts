import { TaskType, MachineSpec, ListrFunction, ConfigTask, VoltaPackage, RepoOptions } from './index';

// things to make the config a little cleaner

export function exec(name: string, machines: MachineSpec, command: string, args: string[], options?: Record<string, unknown>): ConfigTask {
  return {
    name,
    type: TaskType.EXEC,
    machines,
    command,
    args,
    options: options || {},
  };
}

export function func(name: string, machines: MachineSpec, fn: ListrFunction): ConfigTask {
  return {
    type: TaskType.FUNCTION,
    name,
    machines,
    function: fn,
  };
}

export function group(name: string, machines: MachineSpec, tasks: ConfigTask[]): ConfigTask {
  return {
    name,
    type: TaskType.GROUP,
    machines,
    tasks,
  };
}

export function homebrew(name: string, machines: MachineSpec, packages: string[]): ConfigTask {
  return {
    name,
    type: TaskType.HOMEBREW,
    machines,
    packages,
  };
}

export function kill_proc(name: string, machines: MachineSpec, processes: string[]): ConfigTask {
  return {
    name,
    type: TaskType.KILL_PROC,
    machines,
    processes,
  };
}

export function open_url(name: string, machines: MachineSpec, url_config: { [description: string]: string }): ConfigTask {
  return {
    name,
    type: TaskType.OPEN_URL,
    machines,
    url_config,
  };
}

export function repo_update(name: string, machines: MachineSpec, directory: string, options: RepoOptions[]): ConfigTask {
  return {
    name,
    type: TaskType.REPO_UPDATE,
    machines,
    directory,
    options,
  };
}

export function start_app(name: string, machines: MachineSpec, appPaths: string[]): ConfigTask {
  return {
    name,
    type: TaskType.START_APP,
    machines,
    appPaths,
  };
}

export function volta(machines: MachineSpec, packages: VoltaPackage[]): ConfigTask {
  return {
    type: TaskType.VOLTA_PACKAGE,
    machines,
    packages,
  };
}
