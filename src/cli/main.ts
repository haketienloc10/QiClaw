export type Cli = {
  run(): Promise<number>;
};

export function buildCli(): Cli {
  return {
    async run() {
      return 0;
    }
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const cli = buildCli();

  void cli.run().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
