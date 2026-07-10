export type SourceInfo = {
  readonly path: string;
  readonly source: string;
  readonly scope: "user" | "project" | "temporary";
  readonly origin: "package" | "top-level";
  readonly baseDir?: string;
};

export type CommandInfo = {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo: SourceInfo;
};

export type ToolInfo = {
  readonly name: string;
  readonly sourceInfo: SourceInfo;
};

export type DoctorCommandContext = {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
};

export type RegisteredHandler = (
  args: string,
  context: DoctorCommandContext,
) => Promise<void>;

type RegisteredCommand = {
  readonly name: string;
  readonly description?: string;
  readonly handler: RegisteredHandler;
};

export interface DoctorPiApi {
  registerCommand(
    name: string,
    options: {
      readonly description?: string;
      readonly handler: RegisteredHandler;
    },
  ): void;
  getCommands(): readonly CommandInfo[];
  getAllTools(): readonly ToolInfo[];
  getActiveTools(): readonly string[];
}

export class FakePi implements DoctorPiApi {
  readonly registeredCommands: RegisteredCommand[] = [];
  readonly notifications: string[] = [];
  private readonly commands: readonly CommandInfo[];
  private readonly tools: readonly ToolInfo[];
  private readonly activeTools: readonly string[];

  constructor(
    commands: readonly CommandInfo[] = [],
    tools: readonly ToolInfo[] = [],
    activeTools: readonly string[] = [],
  ) {
    this.commands = commands;
    this.tools = tools;
    this.activeTools = activeTools;
  }

  registerCommand(
    name: string,
    options: {
      readonly description?: string;
      readonly handler: RegisteredHandler;
    },
  ): void {
    this.registeredCommands.push({ name, ...options });
  }

  getCommands(): readonly CommandInfo[] {
    return this.commands;
  }

  getAllTools(): readonly ToolInfo[] {
    return this.tools;
  }

  getActiveTools(): readonly string[] {
    return this.activeTools;
  }

  async invoke(name: string, args = ""): Promise<void> {
    const command = this.registeredCommands.find(
      (candidate) => candidate.name === name,
    );
    if (!command) {
      throw new Error(`Unknown test command: ${name}`);
    }
    await command.handler(args, {
      cwd: "/fixture/project",
      ui: { notify: (message) => this.notifications.push(message) },
    });
  }
}
