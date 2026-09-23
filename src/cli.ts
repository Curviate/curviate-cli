import { main } from "./main.js";
import { dispatch } from "./dispatch.js";

// Custom dispatcher (see src/dispatch.ts), works around citty 0.1.6's
// positional+subCommand routing collision so bare intent-shaped forms
// (`connect <slug>`, `profile <url>`, `message <chat> "text"`) and subcommands
// both route correctly. Do NOT replace with a plain `runMain(main)`.
void dispatch(main, process.argv.slice(2));
