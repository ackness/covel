import { CommandError } from "./error.js";
import {
  type SlashCommandAutocompleteMetadata,
  type SlashCommandHelpMetadata,
  type SlashCommandSpec,
  createSlashCommandSpec
} from "./spec.js";

export interface HelpEntry extends SlashCommandHelpMetadata {
  name: string;
  description: string;
}

export interface AutocompleteEntry extends SlashCommandAutocompleteMetadata {
  name: string;
}

export class CommandRegistry {
  readonly #commands = new Map<string, SlashCommandSpec<any, any, any>>();

  register(spec: SlashCommandSpec<any, any, any>): void {
    const validatedSpec = createSlashCommandSpec(spec);

    if (this.#commands.has(validatedSpec.name)) {
      throw new CommandError({
        code: "DUPLICATE_COMMAND",
        message: `Command '${validatedSpec.name}' is already registered.`,
        details: { name: validatedSpec.name }
      });
    }

    this.#commands.set(validatedSpec.name, validatedSpec);
  }

  get(name: string): SlashCommandSpec<any, any, any> | undefined {
    return this.#commands.get(name);
  }

  getOrThrow(name: string): SlashCommandSpec<any, any, any> {
    const spec = this.get(name);

    if (!spec) {
      throw new CommandError({
        code: "COMMAND_NOT_FOUND",
        message: `Command '${name}' was not found.`,
        details: { name }
      });
    }

    return spec;
  }

  listHelp(): HelpEntry[] {
    return this.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      usage: spec.help?.usage ?? `/${spec.name}`,
      ...(spec.help?.examples ? { examples: spec.help.examples } : {})
    }));
  }

  listAutocomplete(): AutocompleteEntry[] {
    return this.list().map((spec) => ({
      name: spec.name,
      ...(spec.autocomplete?.positionalHints
        ? { positionalHints: spec.autocomplete.positionalHints }
        : {}),
      ...(spec.autocomplete?.flagHints
        ? { flagHints: spec.autocomplete.flagHints }
        : {})
    }));
  }

  list(): Array<SlashCommandSpec<any, any, any>> {
    return Array.from(this.#commands.values()).sort((left, right) => left.name.localeCompare(right.name));
  }
}
