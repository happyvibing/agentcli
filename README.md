# agentcli

A simple Node.js CLI with multiple subcommands, built with [commander](https://github.com/tj/commander.js).

## Install

```bash
pnpm add -g agentcli
# or
npm install -g agentcli
```

## Usage

```bash
agentcli --version
agentcli --help

# Greet someone
agentcli greet world
agentcli greet world --upper

# Print current time
agentcli time
agentcli time --format locale
agentcli time --format unix

# SHA-256 hash text
agentcli hash "hello"
```

## Commands

| Command        | Description                                  |
| -------------- | -------------------------------------------- |
| `greet <name>` | Greet someone by name. `--upper` for upper.  |
| `time`         | Print current time. `--format iso\|locale\|unix` (default `iso`). |
| `hash <text>`  | SHA-256 hex digest of the given text.        |

## License

MIT
