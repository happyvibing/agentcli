import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
const { version } = pkg;
import { greet } from "./commands/greet.js";
import { time } from "./commands/time.js";
import { hash } from "./commands/hash.js";

export function run(argv) {
  const program = new Command();

  program
    .name("agentcli")
    .description("A simple Node.js CLI with multiple subcommands.")
    .version(version);

  program
    .command("greet <name>")
    .description("Greet someone by name.")
    .option("-u, --upper", "Print the greeting in uppercase.")
    .action((name, opts) => greet(name, opts));

  program
    .command("time")
    .description("Print the current time in ISO format.")
    .option("-f, --format <format>", "Date format: iso | locale | unix", "iso")
    .action((opts) => time(opts));

  program
    .command("hash <text>")
    .description("Hash text with SHA-256 and print the hex digest.")
    .action((text) => hash(text));

  program.parse(argv, { from: "user" });
}
