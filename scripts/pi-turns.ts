/** Parse one legacy free-form prompt or repeated conventional --turn flags. */
export function parsePiPromptTurns(args: string[]): string[] {
  if (args.length === 0) throw new Error("The prompt message must not be empty.");

  if (args[0] !== "--turn") {
    const message = args.join(" ").trim();
    if (!message) throw new Error("The prompt message must not be empty.");
    return [message];
  }

  const turns: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--turn") {
      throw new Error(`Unexpected argument ${JSON.stringify(args[index])}; expected --turn.`);
    }
    const message = args[index + 1]?.trim();
    if (!message) throw new Error("Each --turn requires a non-empty message.");
    turns.push(message);
  }
  return turns;
}
